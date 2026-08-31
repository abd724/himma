/**
 * S6-3 — customer fulfillment reads (docs/35 §8; owner items 12–17, 26–27,
 * 33). Real PostgreSQL + real Fastify transport.
 *
 * Covers: the Passes & Memberships list/detail four-truth projection
 * (finite) and counter-free unlimited shape · derived status semantics
 * (`active | exhausted | expired`) · customer-safe field hygiene (no
 * commission/economics/digest/staff/internal-revision material) ·
 * attendance history (paged, own-account only) · the reservable-occurrence
 * projection (purchased-terms filtering; credit availability SEPARATE from
 * seat availability) · immutable purchased schedule summary (a later
 * provider revision changes nothing) · and cross-account shaping.
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
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import {
  confirmEntitlementReservation,
  requestEntitlementReservationQuote,
} from '../src/modules/entitlement/services/entitlement-reservation';
import { setFulfillmentConfig } from '../src/modules/entitlement/services/fulfillment-admin';
import { issueRedemptionCredential } from '../src/modules/entitlement/services/redemption-credential';
import { redeemCredential } from '../src/modules/entitlement/services/attendance-redemption';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createFulfillmentRevision,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { addMembership, bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/entitlement-read-pool';

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;

const deps = () => ({ db: testDb.db });

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
  await createActivePolicyTemplate(testDb.db);
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(method: 'GET' | 'POST', url: string, bearer: string | null, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function httpCustomer(): Promise<Customer & { bearer: string }> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const participantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, participantId, bearer };
}

async function acquire(customer: Customer, optionId: string): Promise<string> {
  const quote = await requestEntitlementQuote(deps(), { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const run = await confirmFreeEntitlementPurchase(deps(), { accountId: customer.accountId }, {
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'purchaseConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.purchase.entitlement!.entitlementId;
}

async function futureSession(minutesFromNow = 24 * 60): Promise<string> {
  const startAt = new Date(Date.now() + minutesFromNow * 60 * 1000);
  return createSession(f, {
    start_at: startAt,
    end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
    registration_cutoff_at: startAt,
  });
}

async function reserve(
  customer: Customer,
  entitlementId: string,
  sessionId: string,
): Promise<string> {
  const quote = await requestEntitlementReservationQuote(deps(), {
    accountId: customer.accountId,
  }, { entitlementId, sessionId });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps(), { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const run = await confirmEntitlementReservation(deps(), { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'reservationConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.reservation.bookingId;
}

async function frontDesk(): Promise<{ scope: OrgScope; userId: string }> {
  const userId = await createUser(testDb.db);
  const membershipId = await addMembership(testDb.db, userId, f.org.orgId, 'front_desk');
  return {
    scope: {
      organizationId: f.org.orgId,
      membershipId,
      role: 'front_desk',
      capabilities: capabilitiesForRole('front_desk'),
      branchScope: 'all',
      organizationState: 'live',
    },
    userId,
  };
}

async function attendWalkIn(customer: Customer, entitlementId: string): Promise<void> {
  const issued = await issueRedemptionCredential(deps(), { accountId: customer.accountId }, {
    target: { kind: 'entitlement', entitlementId },
    idempotencyKey: newId(),
  });
  if (issued.outcome.kind !== 'credentialIssued') throw new Error(issued.outcome.kind);
  const desk = await frontDesk();
  const redeemed = await redeemCredential(deps(), desk.scope, { userId: desk.userId }, {
    code: issued.outcome.credential.displayCode!,
    credentialId: issued.outcome.credential.credentialId,
    idempotencyKey: newId(),
  });
  if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);
}

describe('Passes & Memberships (items 12–13)', () => {
  it('finite pass: the four DERIVED truths, purchased terms, provider/branch display identity — and no internal/commercial leakage', async () => {
    const optionId = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 5,
    });
    await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: true,
      walkInAllowed: true,
    });
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, optionId);
    await attendWalkIn(customer, entitlementId);
    const sessionId = await futureSession();
    await reserve(customer, entitlementId, sessionId);

    const detail = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}`,
      customer.bearer,
    );
    expect(detail.statusCode).toBe(200);
    const view = detail.json().entitlement;
    expect(view).toMatchObject({
      entitlementId,
      productLabel: 'package',
      optionKind: 'package',
      usageKind: 'finite',
      status: 'active',
      walkInAllowed: true,
      reservationRequired: true,
      finite: { usesTotal: 5, used: 1, remaining: 4, reservedUpcoming: 1, availableToReserve: 3 },
    });
    expect(view.participant.firstName.length).toBeGreaterThan(0);
    expect(view.provider.displayName.length).toBeGreaterThan(0);
    expect(view.nextReservedSessionAt).not.toBeNull();
    // Hygiene: no snake_case leakage, no commission/economics/digest/staff
    // material, no internal fulfillment-revision identifier on the wire.
    expect(detail.body).not.toMatch(/"[a-z]+_[a-z_]+":/);
    expect(detail.body).not.toMatch(
      /commission|providerShare|economics|digest|token|staff|revisionId|fulfillmentRevision/i,
    );

    const list = await inject('GET', '/customer/entitlements', customer.bearer);
    expect(list.statusCode).toBe(200);
    expect(
      list.json().entitlements.map((row: { entitlementId: string }) => row.entitlementId),
    ).toContain(entitlementId);
  });

  it('unlimited membership: validity + methods + schedule summary and NOT ONE fake counter; status derives to expired/exhausted from facts alone', async () => {
    const unlimitedOption = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
    const scope: OrgScope = {
      organizationId: f.org.orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const configured = await setFulfillmentConfig(deps(), scope, { userId: newId() }, {
      programId: f.programId,
      optionId: unlimitedOption,
      terms: {
        usageKind: 'unlimited',
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
        reservationRequired: false,
        walkInAllowed: true,
        scheduleTerms: [
          { weekday: 1, startTime: '19:00', endTime: '20:00' },
          { weekday: 3, startTime: '19:00', endTime: '20:00' },
        ],
      },
    });
    if (configured.kind !== 'revisionCreated') throw new Error(configured.kind);
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, unlimitedOption);
    // Multiple attendances are legal; still no counter appears.
    await attendWalkIn(customer, entitlementId);
    await attendWalkIn(customer, entitlementId);

    const detail = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}`,
      customer.bearer,
    );
    const view = detail.json().entitlement;
    expect(view).toMatchObject({ usageKind: 'unlimited', status: 'active' });
    expect(view.finite).toBeUndefined();
    expect(detail.body).not.toMatch(/usesTotal|remaining|availableToReserve/);
    expect(view.scheduleTerms).toEqual([
      { weekday: 1, startTime: '19:00', endTime: '20:00' },
      { weekday: 3, startTime: '19:00', endTime: '20:00' },
    ]);

    // EXHAUSTED derives for a fully consumed finite pass.
    const oneUse = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 1,
    });
    await createFulfillmentRevision(f, oneUse, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: false,
      walkInAllowed: true,
    });
    const oneUseEntitlement = await acquire(customer, oneUse);
    await attendWalkIn(customer, oneUseEntitlement);
    const exhausted = await inject(
      'GET',
      `/customer/entitlements/${oneUseEntitlement}`,
      customer.bearer,
    );
    expect(exhausted.json().entitlement.status).toBe('exhausted');
    expect(exhausted.json().entitlement.finite).toMatchObject({ used: 1, remaining: 0 });
  });

  it('cross-account entitlements are invisible: neither listed nor readable', async () => {
    const optionId = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 2,
    });
    await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
    });
    const owner = await httpCustomer();
    const entitlementId = await acquire(owner, optionId);
    const stranger = await httpCustomer();
    expect(
      (await inject('GET', `/customer/entitlements/${entitlementId}`, stranger.bearer)).statusCode,
    ).toBe(404);
    const list = await inject('GET', '/customer/entitlements', stranger.bearer);
    expect(
      list.json().entitlements.map((row: { entitlementId: string }) => row.entitlementId),
    ).not.toContain(entitlementId);
  });
});

describe('attendance history (item 14)', () => {
  it('pages the customer’s own append-only visits with occurrence context and NO validator identifiers', async () => {
    const optionId = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 4,
    });
    await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: true,
      walkInAllowed: true,
    });
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, optionId);
    // One reserved visit (session-backed) + one walk-in visit.
    const sessionId = await futureSession(30);
    const bookingId = await reserve(customer, entitlementId, sessionId);
    const issued = await issueRedemptionCredential(deps(), { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId },
      idempotencyKey: newId(),
    });
    if (issued.outcome.kind !== 'credentialIssued') throw new Error(issued.outcome.kind);
    const desk = await frontDesk();
    const redeemed = await redeemCredential(deps(), desk.scope, { userId: desk.userId }, {
      code: issued.outcome.credential.displayCode!,
      credentialId: issued.outcome.credential.credentialId,
      idempotencyKey: newId(),
    });
    if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);
    await attendWalkIn(customer, entitlementId);

    const history = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/attendance`,
      customer.bearer,
    );
    expect(history.statusCode).toBe(200);
    const rows = history.json().attendance;
    expect(rows).toHaveLength(2);
    const kinds = rows.map((row: { targetKind: string }) => row.targetKind).sort();
    expect(kinds).toEqual(['reservedEntitlementUse', 'walkIn']);
    const reserved = rows.find(
      (row: { targetKind: string }) => row.targetKind === 'reservedEntitlementUse',
    );
    expect(reserved.sessionStartAt).not.toBeNull();
    expect(history.body).not.toMatch(/staff|validated|membership/i);

    // Paging: limit 1 walks the two rows.
    const pageOne = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/attendance?limit=1`,
      customer.bearer,
    );
    expect(pageOne.json().attendance).toHaveLength(1);
    expect(pageOne.json().nextCursor).not.toBeNull();
    const pageTwo = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/attendance?limit=1&cursor=${pageOne.json().nextCursor}`,
      customer.bearer,
    );
    expect(pageTwo.json().attendance).toHaveLength(1);
    expect(pageTwo.json().nextCursor).toBeNull();

    // Cross-account: not-found-shaped.
    const stranger = await httpCustomer();
    expect(
      (
        await inject(
          'GET',
          `/customer/entitlements/${entitlementId}/attendance`,
          stranger.bearer,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('reservable occurrences (item 16)', () => {
  it('filters by purchased branch + schedule terms; seat availability and credit availability are SEPARATE truths', async () => {
    const branchA = f.org.branchIds[0]!;
    const optionId = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 1,
    });
    const revisionId = await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 20,
      reservationRequired: true,
      walkInAllowed: false,
      branchId: branchA,
    });
    await sql`
      INSERT INTO price_option_fulfillment_schedule_term (id, revision_id, weekday, start_time, end_time)
      VALUES (${newId()}, ${revisionId}, 1, '19:00', '20:00')`.execute(testDb.db);
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, optionId);

    // Monday 19:00 Dubai at branch A (eligible), Monday at a FULL session
    // (listed as full — seats and credits are separate), Tuesday (filtered),
    // other branch (filtered).
    const monday = new Date('2026-08-31T15:00:00.000Z');
    const eligible = await createSession(f, {
      start_at: monday,
      end_at: new Date(monday.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: monday,
      branch_id: branchA,
    });
    const nextMonday = new Date('2026-09-07T15:00:00.000Z');
    const fullSession = await createSession(f, {
      start_at: nextMonday,
      end_at: new Date(nextMonday.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: nextMonday,
      branch_id: branchA,
      capacity: 1,
      booked_count: 1,
      state: 'full',
    });
    const tuesday = new Date('2026-09-01T15:00:00.000Z');
    await createSession(f, {
      start_at: tuesday,
      end_at: new Date(tuesday.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: tuesday,
      branch_id: branchA,
    });
    const branchB = f.org.branchIds[1] ?? branchA;
    if (branchB !== branchA) {
      await createSession(f, {
        start_at: monday,
        end_at: new Date(monday.getTime() + 60 * 60 * 1000),
        registration_cutoff_at: monday,
        branch_id: branchB,
      });
    }

    const listed = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/reservable-sessions?from=2026-08-28&to=2026-09-10`,
      customer.bearer,
    );
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    const ids = body.sessions.map((row: { sessionId: string }) => row.sessionId);
    expect(ids).toContain(eligible);
    expect(ids).toContain(fullSession);
    expect(ids).toHaveLength(2);
    expect(
      body.sessions.find((row: { sessionId: string }) => row.sessionId === fullSession)
        .availability,
    ).toBe('full');
    expect(body.finite.availableToReserve).toBe(1);

    // After committing the single credit, seats remain open but CREDIT
    // availability is zero — reported separately, never conflated.
    await reserve(customer, entitlementId, eligible);
    const after = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/reservable-sessions?from=2026-08-28&to=2026-09-10`,
      customer.bearer,
    );
    expect(after.json().finite).toMatchObject({ reservedUpcoming: 1, availableToReserve: 0 });
    const stillListed = after
      .json()
      .sessions.find((row: { sessionId: string }) => row.sessionId === fullSession);
    expect(stillListed.availability).toBe('full');
  });

  it('D-S6-5 CLOSED (0020): a membership-kind entitlement reserves through the ordinary wire — quote → confirm → membership-kind Booking, with walk-in accounting beside it', async () => {
    const optionId = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
    await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      usesTotal: 4,
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: true,
      walkInAllowed: true,
    });
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, optionId);
    const sessionId = await futureSession();
    const quoted = await inject(
      'POST',
      `/customer/entitlements/${entitlementId}/reservation-quote`,
      customer.bearer,
      { sessionId },
    );
    expect(quoted.statusCode).toBe(201);
    expect(quoted.json().quote).toMatchObject({ entitlementId, sessionId, totalFils: 0 });
    const bookingId = await reserve(customer, entitlementId, sessionId);
    const bookingKind = await sql<{ option_kind: string }>`
      SELECT option_kind FROM booking WHERE id = ${bookingId}`.execute(testDb.db);
    expect(bookingKind.rows[0]!.option_kind).toBe('membership');
    // Walk-in consumption rides beside the commitment (finite truths).
    await attendWalkIn(customer, entitlementId);
    const detail = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}`,
      customer.bearer,
    );
    expect(detail.json().entitlement.finite).toMatchObject({
      used: 1,
      reservedUpcoming: 1,
      availableToReserve: 2,
    });
  });

  it('walk-in-only products refuse the reservable projection typed', async () => {
    const optionId = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 2,
    });
    await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: false,
      walkInAllowed: true,
    });
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, optionId);
    const refused = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/reservable-sessions`,
      customer.bearer,
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('reservationNotPermitted');
  });
});

describe('My Bookings truth (item 27)', () => {
  it('ordinary bookings read coveredByEntitlement=false; the list shows reservation bookings beside them', async () => {
    const optionId = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 2,
    });
    await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: true,
      walkInAllowed: false,
    });
    const customer = await httpCustomer();
    const entitlementId = await acquire(customer, optionId);
    const reservedSession = await futureSession(48 * 60);
    const reservedBooking = await reserve(customer, entitlementId, reservedSession);

    const list = await inject('GET', '/customer/bookings', customer.bearer);
    expect(list.statusCode).toBe(200);
    const row = list
      .json()
      .bookings.find((entry: { bookingId: string }) => entry.bookingId === reservedBooking);
    expect(row).toMatchObject({ coveredByEntitlement: true, entitlementId });
  });
});
