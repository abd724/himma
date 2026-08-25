/**
 * RI-2 — the D-RI-4 customer-PUBLIC availability projection
 * (docs/34 §12.1): `GET /listings/:programId/availability`.
 *
 * Proves: guests read the certified derived bands without any
 * authentication; the wire NEVER carries counters/capacity/version/lock
 * internals; `spotsLeft` appears only in the fewLeft band; a
 * lapsed-but-unswept hold cannot present a seat as taken (the effective-
 * truth regression on the PUBLIC surface); unpublished and nonexistent
 * programs are the same not-found; a privileged bearer changes nothing;
 * and the route inventory gains exactly this one public GET.
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
import { claimHold } from '../src/modules/booking/services/hold-claim';
import {
  createBookingFixture,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/public-availability-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let dropInOption: string;

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
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function getPublic(programId: string, kind = 'session') {
  return app.inject({ method: 'GET', url: `/listings/${programId}/availability?kind=${kind}` });
}

describe('D-RI-4 public availability', () => {
  it('a guest reads derived bands with branch/time identity — and NEVER counters or internals', async () => {
    const sessionId = await createSession(f, { capacity: 20 });
    const fewLeftId = await createSession(f, { capacity: 2 });
    const response = await getPublic(f.programId);
    expect(response.statusCode).toBe(200);
    const units: Record<string, unknown>[] = response.json().units;
    const open = units.find((u) => u.unitId === sessionId);
    const fewLeft = units.find((u) => u.unitId === fewLeftId);
    expect(open).toMatchObject({ kind: 'session', availability: 'available' });
    // D-RI-4 allows a low spotsLeft ONLY in the fewLeft band.
    expect(open?.spotsLeft).toBeUndefined();
    expect(fewLeft).toMatchObject({ availability: 'fewLeft', spotsLeft: 2 });
    // Occurrence date/time + branch identity are the selection data.
    expect(typeof open?.startAt).toBe('string');
    expect(open?.branchId).toBe(f.org.branchIds[0]);
    // Structural hygiene: no counter/version/lock/internal field on ANY row.
    for (const unit of units) {
      for (const key of Object.keys(unit)) {
        expect(key).not.toMatch(/held|booked|capacity|version|lock/i);
      }
    }
  });

  it('full units stay VISIBLE with the full band — never hidden, never a number', async () => {
    const fullId = await createSession(f, { capacity: 1 });
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    const { bearer } = await bearerForUser(ctx, userId);
    const quote = await app.inject({
      method: 'POST',
      url: '/customer/quotes',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        programId: f.programId,
        priceOptionId: dropInOption,
        unitKind: 'session',
        unitId: fullId,
        participantId,
      },
    });
    expect(quote.statusCode).toBe(201);
    const claim = await claimHold(
      { db: testDb.db },
      { accountId },
      {
        unit: { kind: 'session', id: fullId },
        participantId,
        quoteId: quote.json().quote.quoteId,
        idempotencyKey: newId(),
      },
    );
    if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
    const view = (await getPublic(f.programId)).json().units.find(
      (u: { unitId: string }) => u.unitId === fullId,
    );
    expect(view).toMatchObject({ availability: 'full' });
    expect(view.spotsLeft).toBeUndefined();
  });

  it('EFFECTIVE-truth regression: a lapsed-but-unswept hold cannot make the public surface claim the seat is taken', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    const { bearer } = await bearerForUser(ctx, userId);
    const quote = await app.inject({
      method: 'POST',
      url: '/customer/quotes',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        programId: f.programId,
        priceOptionId: dropInOption,
        unitKind: 'session',
        unitId: sessionId,
        participantId,
      },
    });
    expect(quote.statusCode).toBe(201);
    // TTL 0: physically `active` with its held seat, expired in domain truth.
    const claim = await claimHold(
      { db: testDb.db, holdTtlSeconds: 0 },
      { accountId },
      {
        unit: { kind: 'session', id: sessionId },
        participantId,
        quoteId: quote.json().quote.quoteId,
        idempotencyKey: newId(),
      },
    );
    if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
    const stored = await sql<{ state: string; held_count: number }>`
      SELECT h.state, s.held_count FROM capacity_hold h
      JOIN session s ON s.id = h.session_id WHERE h.session_id = ${sessionId}
    `.execute(testDb.db);
    expect(stored.rows[0]).toMatchObject({ state: 'active', held_count: 1 }); // unswept
    const view = (await getPublic(f.programId)).json().units.find(
      (u: { unitId: string }) => u.unitId === sessionId,
    );
    // The one remaining seat reads fewLeft — NOT full: reads project
    // effective truth; settlement stays with the authoritative paths.
    expect(view).toMatchObject({ availability: 'fewLeft', spotsLeft: 1 });
  });

  it('unpublished and nonexistent programs are the SAME not-found — an ID conveys nothing', async () => {
    const hidden = await createBookingFixture(testDb.db); // listing never published
    await createSession(hidden, { capacity: 5 });
    const unpublished = await getPublic(hidden.programId);
    const missing = await getPublic(newId());
    expect(unpublished.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(unpublished.json()).toEqual(missing.json());
  });

  it('a privileged bearer changes nothing, and the inventory gains exactly this one public GET', async () => {
    const sessionId = await createSession(f, { capacity: 7 });
    const userId = await createUser(testDb.db);
    const { bearer } = await bearerForUser(ctx, userId);
    const anonymous = await getPublic(f.programId);
    const authed = await app.inject({
      method: 'GET',
      url: `/listings/${f.programId}/availability?kind=session`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual(anonymous.json());
    expect(
      anonymous.json().units.some((u: { unitId: string }) => u.unitId === sessionId),
    ).toBe(true);

    const publicAvailability = app.routePolicyInventory.filter(
      (route) => route.method !== 'HEAD' && route.url.includes('/availability'),
    );
    expect(publicAvailability.map((r) => `${r.method} ${r.url} → ${r.policy}`).sort()).toEqual([
      'GET /customer/programs/:programId/availability → authenticatedCustomer',
      'GET /listings/:programId/availability → public',
    ]);
  });
});
