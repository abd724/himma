/**
 * B2-4 — customer identity routes (docs/26 §10 under A1.1): session
 * establishment with token-pair binding, /me, inventory, logouts,
 * link/unlink, and orchestration failure/retry convergence. Fastify
 * injection over real PostgreSQL with deterministic fakes.
 */
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { FakeProviderRevoker } from '../src/modules/identity/providers/fake/fake-provider-revoker';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/routes-pool';
let testDb: TestDb;
let app: FastifyInstance;
let accessVerifier: FakeAccessTokenVerifier;
let idAdapter: FakeAuthProviderAdapter;
let mail: CaptureMailSender;
let revoker: FakeProviderRevoker;
let counter = 0;
let ipCounter = 0;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  accessVerifier = new FakeAccessTokenVerifier();
  idAdapter = new FakeAuthProviderAdapter();
  mail = new CaptureMailSender();
  revoker = new FakeProviderRevoker();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: accessVerifier,
      idTokenAdapter: idAdapter,
      mailSender: mail,
      providerRevoker: revoker,
      rateLimiterStore: new InMemoryRateLimiterStore(),
      enumerationFloorMs: 60,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 200)}.${(ipCounter % 200) + 1}`;
}

function idEvidence(overrides: Partial<ProviderEvidence> = {}): ProviderEvidence {
  counter += 1;
  return {
    provider: 'google',
    issuer: ISSUER,
    subject: `route-sub-${counter}`,
    email: `route${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
    ...overrides,
  };
}

function accessEvidence(
  subject: string,
  overrides: Partial<AccessTokenEvidence> = {},
): AccessTokenEvidence {
  counter += 1;
  return {
    issuer: ISSUER,
    subject,
    originJti: `route-origin-${counter}`,
    scopes: ['openid'],
    assurance: 'single_factor',
    expiresAt: new Date(Date.now() + 3_600_000),
    authTime: new Date(),
    ...overrides,
  };
}

interface Session {
  bearer: string;
  userId: string;
  accountId: string;
  sessionId: string;
  subject: string;
}

async function loginAndEstablish(): Promise<Session> {
  const identity = idEvidence();
  const access = accessEvidence(identity.subject);
  const response = await app.inject({
    method: 'POST',
    url: '/auth/session',
    remoteAddress: nextIp(),
    payload: {
      idToken: idAdapter.issueToken(identity),
      accessToken: accessVerifier.issueToken(access),
      deviceLabel: 'Test device',
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  return {
    bearer: accessVerifier.issueToken(access),
    userId: body.userId,
    accountId: body.accountId,
    sessionId: body.session.id,
    subject: identity.subject,
  };
}

describe('POST /auth/session', () => {
  it('performs first login + session establishment and returns the typed authenticated envelope', async () => {
    const session = await loginAndEstablish();
    expect(session.userId).toBeDefined();
    expect(session.accountId).toBeDefined();
    const row = await testDb.db
      .selectFrom('login_session')
      .select(['user_id', 'device_label'])
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(session.userId);
    expect(row.device_label).toBe('Test device');
  });

  it('rejects mismatched ID/access token pairs without creating a user or a session', async () => {
    const identity = idEvidence();
    const access = accessEvidence('a-completely-different-subject');
    const response = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: {
        idToken: idAdapter.issueToken(identity),
        accessToken: accessVerifier.issueToken(access),
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('invalidCredentials');
    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('subject', 'in', [identity.subject, access.subject])
      .execute();
    expect(identities).toEqual([]);
  });

  it('re-presents idempotently and, without an ID token, resolves only known identities', async () => {
    const identity = idEvidence();
    const access = accessEvidence(identity.subject);
    const payload = {
      idToken: idAdapter.issueToken(identity),
      accessToken: accessVerifier.issueToken(access),
    };
    const first = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload,
    });
    const repeat = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload,
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().session.id).toBe(first.json().session.id);

    // Access token only, known identity → succeeds (new provider session).
    const tokenOnly = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: { accessToken: accessVerifier.issueToken(accessEvidence(identity.subject)) },
    });
    expect(tokenOnly.statusCode).toBe(200);

    // Access token only, unknown identity → single invalidCredentials class.
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: { accessToken: accessVerifier.issueToken(accessEvidence('never-logged-in')) },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe('invalidCredentials');
  });

  it('converges after a partial orchestration failure: the user exists, a retry completes without duplicates', async () => {
    const identity = idEvidence();
    await sql`
      CREATE FUNCTION test_fail_session_route() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced establishment failure'; END; $$`.execute(
      testDb.db,
    );
    await sql`
      CREATE TRIGGER trg_test_fail_session_route BEFORE INSERT ON login_session
      FOR EACH ROW EXECUTE FUNCTION test_fail_session_route()`.execute(testDb.db);
    let failed;
    try {
      failed = await app.inject({
        method: 'POST',
        url: '/auth/session',
        remoteAddress: nextIp(),
        payload: {
          idToken: idAdapter.issueToken(identity),
          accessToken: accessVerifier.issueToken(accessEvidence(identity.subject)),
        },
      });
    } finally {
      await sql`DROP TRIGGER trg_test_fail_session_route ON login_session`.execute(testDb.db);
      await sql`DROP FUNCTION test_fail_session_route()`.execute(testDb.db);
    }
    // Unexpected DB failure stays an internal error — never a user conflict.
    expect(failed.statusCode).toBe(500);
    expect(failed.json().code).toBe('internalError');
    // Documented failure boundary: the canonical user already exists.
    const users = await testDb.db
      .selectFrom('auth_identity')
      .select(['user_id'])
      .where('subject', '=', identity.subject)
      .execute();
    expect(users).toHaveLength(1);

    const retry = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: {
        idToken: idAdapter.issueToken(identity),
        accessToken: accessVerifier.issueToken(accessEvidence(identity.subject)),
      },
    });
    expect(retry.statusCode).toBe(200);
    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('subject', '=', identity.subject)
      .execute();
    expect(identities).toHaveLength(1);
    const accounts = await testDb.db
      .selectFrom('customer_account')
      .select(['id'])
      .where('user_id', '=', retry.json().userId)
      .execute();
    expect(accounts).toHaveLength(1);
  });

  it('rate limits establishment attempts per IP digest', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/session',
        remoteAddress: ip,
        payload: { accessToken: accessVerifier.issueToken(accessEvidence('rl-unknown')) },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses[10]).toBe(429);
  });

  it('rejects malformed bodies without echoing token-like content', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: { accessToken: 'x' }, // below minLength
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validationError');
    expect(response.body).not.toContain('"x"');
  });
});

describe('GET /me and session inventory', () => {
  it('/me returns only the approved snapshot fields', async () => {
    const session = await loginAndEstablish();
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.bearer}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['account', 'participants', 'roles', 'user']);
    expect(Object.keys(body.user)).toEqual(['id']);
    expect(Object.keys(body.account).sort()).toEqual(['contactEmail', 'displayName', 'id']);
    expect(body.participants).toEqual([
      { id: expect.any(String), kind: 'self', firstName: 'Me' },
    ]);
    expect(body.roles).toEqual([]);
    // No security metadata of any kind.
    expect(response.body).not.toMatch(/locked|ip_digest|origin_jti|version|status/);
  });

  it('session inventory lists only the caller’s sessions and flags the current one', async () => {
    const a = await loginAndEstablish();
    await loginAndEstablish(); // another user's session
    const response = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { authorization: `Bearer ${a.bearer}` },
    });
    expect(response.statusCode).toBe(200);
    const sessions = response.json().sessions as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: a.sessionId, current: true });
  });
});

describe('logout routes', () => {
  it('DELETE /auth/sessions/:id enforces ownership, versioning, and step-up freshness', async () => {
    const a = await loginAndEstablish();
    const b = await loginAndEstablish();

    // Foreign session → not-found-shaped.
    const foreign = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${b.sessionId}`,
      headers: { authorization: `Bearer ${a.bearer}` },
      payload: { expectedVersion: 1 },
    });
    expect(foreign.statusCode).toBe(404);

    // Stale version → typed conflict.
    const stale = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${a.sessionId}`,
      headers: { authorization: `Bearer ${a.bearer}` },
      payload: { expectedVersion: 99 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    // Correct version → revoked.
    const ok = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${a.sessionId}`,
      headers: { authorization: `Bearer ${a.bearer}` },
      payload: { expectedVersion: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('loggedOut');
  });

  it('POST /auth/logout is idempotent and local denial survives provider-revocation failure', async () => {
    const session = await loginAndEstablish();
    revoker.setFailure('providerUnavailable');
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${session.bearer}` },
        payload: {},
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe('loggedOut');
    } finally {
      revoker.setFailure(undefined);
    }
    // Local denial is authoritative despite the failed provider call.
    const after = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${session.bearer}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('sessionExpired');
  });

  it('POST /auth/logout-all revokes all of the caller’s sessions and repeats idempotently', async () => {
    const identity = idEvidence();
    const first = accessEvidence(identity.subject);
    await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: {
        idToken: idAdapter.issueToken(identity),
        accessToken: accessVerifier.issueToken(first),
      },
    });
    const second = accessEvidence(identity.subject);
    await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: { accessToken: accessVerifier.issueToken(second) },
    });
    const bearer = accessVerifier.issueToken(second);
    const logoutAll = await app.inject({
      method: 'POST',
      url: '/auth/logout-all',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {},
    });
    expect(logoutAll.statusCode).toBe(200);
    expect(logoutAll.json()).toMatchObject({ status: 'loggedOutAll', revokedCount: 2 });

    // The bearer's own session is revoked → repeat is denied (401), which
    // is the idempotent, safe outcome for an already-logged-out caller.
    const repeat = await app.inject({
      method: 'POST',
      url: '/auth/logout-all',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {},
    });
    expect(repeat.statusCode).toBe(401);
  });
});

describe('identity link/unlink routes', () => {
  it('links a second provider identity, repeats idempotently, and types conflicts', async () => {
    const a = await loginAndEstablish();
    const b = await loginAndEstablish();
    const newIdentity = idEvidence({ emailVerified: false });

    const linked = await app.inject({
      method: 'POST',
      url: '/auth/identities/link',
      headers: { authorization: `Bearer ${a.bearer}` },
      payload: { idToken: idAdapter.issueToken(newIdentity) },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().status).toBe('linked');

    const repeat = await app.inject({
      method: 'POST',
      url: '/auth/identities/link',
      headers: { authorization: `Bearer ${a.bearer}` },
      payload: { idToken: idAdapter.issueToken(newIdentity) },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().status).toBe('alreadyLinked');

    // The same subject presented by another user → typed conflict.
    const stolen = await app.inject({
      method: 'POST',
      url: '/auth/identities/link',
      headers: { authorization: `Bearer ${b.bearer}` },
      payload: { idToken: idAdapter.issueToken(newIdentity) },
    });
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json().code).toBe('identityAlreadyLinked');
  });

  it('unlinks with version CAS and refuses removing the final login method', async () => {
    const session = await loginAndEstablish();
    const linked = await app.inject({
      method: 'POST',
      url: '/auth/identities/link',
      headers: { authorization: `Bearer ${session.bearer}` },
      payload: { idToken: idAdapter.issueToken(idEvidence({ emailVerified: false })) },
    });
    const linkedId = linked.json().identityId as string;
    const unlink = await app.inject({
      method: 'DELETE',
      url: `/auth/identities/${linkedId}`,
      headers: { authorization: `Bearer ${session.bearer}` },
      payload: { expectedVersion: 1 },
    });
    expect(unlink.statusCode).toBe(200);

    const lastRow = await testDb.db
      .selectFrom('auth_identity')
      .select(['id', 'version'])
      .where('user_id', '=', session.userId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const last = await app.inject({
      method: 'DELETE',
      url: `/auth/identities/${lastRow.id}`,
      headers: { authorization: `Bearer ${session.bearer}` },
      payload: { expectedVersion: lastRow.version },
    });
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('lastLoginMethod');
  });
});
