/**
 * RI-1 — customer participant management contract (docs/34 §4.1; docs/24
 * §1.2). Real PostgreSQL + real transport.
 *
 * Certifies the bounded backend companion: list own active participants,
 * create a child (DOB required and structurally validated — no invented
 * age POLICY), update the V1-editable fields under version CAS, and the
 * history-safe archive lifecycle (never destructive; self never
 * archivable). Cross-account access is not-found-shaped; a session
 * without a customer account gains nothing; reads emit no audit;
 * mutations are audit-evented.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/participant-routes-pool';

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;

interface HttpCustomer {
  accountId: string;
  selfParticipantId: string;
  bearer: string;
}

async function httpCustomer(): Promise<HttpCustomer> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const selfParticipantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, selfParticipantId, bearer };
}

function inject(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  bearer: string | null,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function auditCount(): Promise<number> {
  const result = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(
    testDb.db,
  );
  return Number(result.rows[0]!.n);
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('route shape and access', () => {
  it('the participant surface is EXACTLY the four routes, all authenticatedCustomer; guests are 401; a session without a customer account is not-found-shaped', async () => {
    const routes = app.routePolicyInventory
      .filter((route) => route.url.startsWith('/customer/participants') && route.method !== 'HEAD')
      .map((route) => `${route.method} ${route.url} → ${route.policy}`)
      .sort();
    expect(routes).toEqual([
      'GET /customer/participants → authenticatedCustomer',
      'PATCH /customer/participants/:participantId → authenticatedCustomer',
      'POST /customer/participants → authenticatedCustomer',
      'POST /customer/participants/:participantId/archive → authenticatedCustomer',
    ]);
    expect((await inject('GET', '/customer/participants', null)).statusCode).toBe(401);
    const bareUser = await createUser(testDb.db); // no customer_account
    const { bearer } = await bearerForUser(ctx, bareUser);
    expect((await inject('GET', '/customer/participants', bearer)).statusCode).toBe(404);
    expect(
      (
        await inject('POST', '/customer/participants', bearer, {
          firstName: 'Ahmed',
          dateOfBirth: '2018-03-01',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the V1 participant lifecycle', () => {
  it('lists self first; creates a child with DOB; the child persists as PostgreSQL truth; mutations are audit-evented and reads emit nothing', async () => {
    const customer = await httpCustomer();
    const initial = await inject('GET', '/customer/participants', customer.bearer);
    expect(initial.statusCode).toBe(200);
    expect(initial.json().participants).toEqual([
      expect.objectContaining({ kind: 'self', status: 'active' }),
    ]);

    const created = await inject('POST', '/customer/participants', customer.bearer, {
      firstName: 'Ahmed',
      dateOfBirth: '2018-03-01',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().participant).toMatchObject({
      kind: 'child',
      firstName: 'Ahmed',
      dateOfBirth: '2018-03-01',
      status: 'active',
      version: 1,
    });

    const audits = await auditCount();
    const listed = await inject('GET', '/customer/participants', customer.bearer);
    expect(listed.json().participants).toHaveLength(2);
    expect(listed.json().participants[0].kind).toBe('self');
    expect(listed.json().participants[1].firstName).toBe('Ahmed');
    // Reads emit nothing.
    expect(await auditCount()).toBe(audits);
    // Audit trail for the create exists.
    const createdAudit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'participant.created'
        AND entity_id = ${created.json().participant.id as string}`.execute(testDb.db);
    expect(Number(createdAudit.rows[0]!.n)).toBe(1);
  });

  it('DOB validation is structural, never an invented age policy: format, real calendar date, past, ≥1900', async () => {
    const customer = await httpCustomer();
    for (const dateOfBirth of ['01-03-2018', '2018-02-30', '2099-01-01', '1899-12-31']) {
      const response = await inject('POST', '/customer/participants', customer.bearer, {
        firstName: 'Test',
        dateOfBirth,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('invalidParticipant');
    }
    // A whitespace-only name is refused typed.
    const blank = await inject('POST', '/customer/participants', customer.bearer, {
      firstName: '   ',
      dateOfBirth: '2018-03-01',
    });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().code).toBe('invalidParticipant');
    // An adult DOB is fine — age POLICY stays with the certified
    // eligibility engine, never this boundary.
    const adult = await inject('POST', '/customer/participants', customer.bearer, {
      firstName: 'Grandparent-Managed',
      dateOfBirth: '1960-05-05',
    });
    expect(adult.statusCode).toBe(201);
  });

  it('updates ride version CAS: rename self, correct a child DOB, refuse stale versions and empty updates', async () => {
    const customer = await httpCustomer();
    const renamed = await inject(
      'PATCH',
      `/customer/participants/${customer.selfParticipantId}`,
      customer.bearer,
      { version: 1, firstName: 'Abdelrahman' },
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().participant).toMatchObject({
      kind: 'self',
      firstName: 'Abdelrahman',
      version: 2,
    });

    const child = await inject('POST', '/customer/participants', customer.bearer, {
      firstName: 'Sara',
      dateOfBirth: '2016-01-01',
    });
    const childId = child.json().participant.id as string;
    const fixed = await inject('PATCH', `/customer/participants/${childId}`, customer.bearer, {
      version: 1,
      dateOfBirth: '2016-01-02',
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().participant.dateOfBirth).toBe('2016-01-02');

    const stale = await inject('PATCH', `/customer/participants/${childId}`, customer.bearer, {
      version: 1,
      firstName: 'Sarah',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    const empty = await inject('PATCH', `/customer/participants/${childId}`, customer.bearer, {
      version: 2,
    });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().code).toBe('invalidParticipant');
  });

  it('archive is history-safe and bounded: child archives out of the list but the ROW persists; replay is idempotent; self can never be archived', async () => {
    const customer = await httpCustomer();
    const child = await inject('POST', '/customer/participants', customer.bearer, {
      firstName: 'Omar',
      dateOfBirth: '2017-06-15',
    });
    const childId = child.json().participant.id as string;

    const archived = await inject(
      'POST',
      `/customer/participants/${childId}/archive`,
      customer.bearer,
      { version: 1 },
    );
    expect(archived.statusCode).toBe(200);
    expect(archived.json().participant.status).toBe('archived');

    // Out of the active list; the row itself is retained (FK history safety).
    const listed = await inject('GET', '/customer/participants', customer.bearer);
    expect(
      listed.json().participants.some((p: { id: string }) => p.id === childId),
    ).toBe(false);
    const row = await sql<{ status: string }>`
      SELECT status FROM participant WHERE id = ${childId}`.execute(testDb.db);
    expect(row.rows[0]!.status).toBe('archived');

    // Replay converges (idempotent-friendly).
    const replay = await inject(
      'POST',
      `/customer/participants/${childId}/archive`,
      customer.bearer,
      { version: 2 },
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().participant.status).toBe('archived');

    // An archived profile refuses edits typed.
    const edit = await inject('PATCH', `/customer/participants/${childId}`, customer.bearer, {
      version: 2,
      firstName: 'O',
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe('participantArchived');

    // Self is structurally unarchivable.
    const self = await inject(
      'POST',
      `/customer/participants/${customer.selfParticipantId}/archive`,
      customer.bearer,
      { version: 1 },
    );
    expect(self.statusCode).toBe(409);
    expect(self.json().code).toBe('cannotArchiveSelf');
  });

  it('cross-account access is not-found-shaped in every direction; arbitrary ids convey nothing', async () => {
    const a = await httpCustomer();
    const b = await httpCustomer();
    const child = await inject('POST', '/customer/participants', a.bearer, {
      firstName: 'Lina',
      dateOfBirth: '2019-09-09',
    });
    const childId = child.json().participant.id as string;

    // B cannot see, edit, or archive A's participant.
    const listed = await inject('GET', '/customer/participants', b.bearer);
    expect(listed.json().participants.some((p: { id: string }) => p.id === childId)).toBe(false);
    expect(
      (
        await inject('PATCH', `/customer/participants/${childId}`, b.bearer, {
          version: 1,
          firstName: 'X',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await inject('POST', `/customer/participants/${childId}/archive`, b.bearer, {
          version: 1,
        })
      ).statusCode,
    ).toBe(404);
    // A random id is indistinguishable from a foreign one.
    expect(
      (
        await inject('PATCH', `/customer/participants/${newId()}`, b.bearer, {
          version: 1,
          firstName: 'X',
        })
      ).statusCode,
    ).toBe(404);
    // A's participant is untouched.
    const still = await inject('GET', '/customer/participants', a.bearer);
    expect(
      still.json().participants.find((p: { id: string }) => p.id === childId),
    ).toMatchObject({ firstName: 'Lina', status: 'active' });
  });
});
