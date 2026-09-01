/**
 * S6-2 — redemption credential + provider validation + attendance
 * certification (docs/35 §9, §10, §14, §16; owner items 5–31, 35, 39).
 * Real PostgreSQL + real Fastify transport + multi-connection races.
 *
 * Covers: issuance eligibility (scheduled window · confirmed-only ·
 * occurrence fail-closed for camp/cohort · walk-in rules incl. the
 * reservation-required bypass ban) · secrets-once idempotency (replays
 * carry no code; regeneration supersedes) · alias collision · provider
 * preview (pure read, org-scoped, generic foreign refusal) · atomic
 * redemption for all three target forms · finite consumption via
 * append-only truth + exhaustion event · unlimited attendance without a
 * counter · branch/coach scope · durable brute-force limiting · the four
 * concurrency proofs · failure injection · secret hygiene across audit/
 * outbox/idempotency stores · the HTTP journey + cross-principal locks.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { confirmFreeBooking, initiateBooking } from '../src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import {
  previewRedemption,
  redeemCredential,
  type RedemptionDeps,
} from '../src/modules/entitlement/services/attendance-redemption';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import {
  getRedemptionCredentialStatus,
  issueRedemptionCredential,
} from '../src/modules/entitlement/services/redemption-credential';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  CAMP_START_DATE,
  FUTURE,
  createActivePolicyTemplate,
  createBookingFixture,
  createCampWeek,
  createCustomer,
  createFulfillmentRevision,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { addMembership, bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import { createRacePool, race } from './helpers/race-harness';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/redemption-attendance-pool';

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let deps: RedemptionDeps;
let ownerScope: OrgScope;
let ownerUserId: string;
let freeCapacityOption: string;
let dropInOption: string;
let pack3Option: string; // walk-in finite, 3 uses, 30 days
let pack1Option: string; // walk-in finite, 1 use
let unlimitedOption: string; // unlimited, fixed end date, walk-in
let reservedOnlyOption: string; // reservation-required ONLY (no walk-in)

function scopeFor(
  membershipId: string,
  role: OrgScope['role'],
  branchScope: 'all' | string[] = 'all',
): OrgScope {
  return {
    organizationId: f.org.orgId,
    membershipId,
    role,
    capabilities: capabilitiesForRole(role),
    branchScope,
    organizationState: 'live',
  };
}

async function makeStaff(
  role: OrgScope['role'],
  branchIds?: string[],
): Promise<{ scope: OrgScope; userId: string; membershipId: string; bearer: string }> {
  const userId = await createUser(testDb.db);
  const membershipId = await addMembership(testDb.db, userId, f.org.orgId, role, branchIds);
  const { bearer } = await bearerForUser(ctx, userId);
  return { scope: scopeFor(membershipId, role, branchIds ?? 'all'), userId, membershipId, bearer };
}

async function makeEntitlement(customer: Customer, optionId: string): Promise<string> {
  const quote = await requestEntitlementQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const run = await confirmFreeEntitlementPurchase(deps, { accountId: customer.accountId }, {
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'purchaseConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.purchase.entitlement!.entitlementId;
}

/** An in-window confirmed session Booking (starts in 30 minutes). */
async function makeInWindowBooking(
  customer: Customer,
  options: { instructorStaffId?: string } = {},
): Promise<{ bookingId: string; sessionId: string }> {
  const startAt = new Date(Date.now() + 30 * 60 * 1000);
  const sessionId = await createSession(f, {
    start_at: startAt,
    end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
    registration_cutoff_at: startAt,
    ...(options.instructorStaffId !== undefined
      ? { instructor_staff_id: options.instructorStaffId }
      : {}),
  });
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freeCapacityOption,
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const confirmed = await confirmFreeBooking(deps, { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  return { bookingId: confirmed.outcome.booking.bookingId, sessionId };
}

async function issue(
  customer: Customer,
  target: Parameters<typeof issueRedemptionCredential>[2]['target'],
  key = newId(),
  overrideDeps: RedemptionDeps = deps,
  regenerateCredentialId?: string,
): Promise<{ credentialId: string; displayCode: string; token: string; expiresAt: string }> {
  const run = await issueRedemptionCredential(overrideDeps, { accountId: customer.accountId }, {
    target,
    idempotencyKey: key,
    ...(regenerateCredentialId !== undefined ? { regenerateCredentialId } : {}),
  });
  if (run.outcome.kind !== 'credentialIssued') throw new Error(run.outcome.kind);
  const credential = run.outcome.credential;
  return {
    credentialId: credential.credentialId,
    displayCode: credential.displayCode!,
    token: credential.token!,
    expiresAt: credential.expiresAt,
  };
}

async function attendanceCount(where: { entitlementId?: string; bookingId?: string }): Promise<number> {
  const row = await sql<{ n: string }>`
    SELECT count(*) AS n FROM attendance_record
    WHERE (${where.entitlementId ?? null}::uuid IS NULL OR entitlement_id = ${where.entitlementId ?? null})
      AND (${where.bookingId ?? null}::uuid IS NULL OR booking_id = ${where.bookingId ?? null})`.execute(
    testDb.db,
  );
  return Number(row.rows[0]!.n);
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
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  deps = { db: testDb.db };
  const owner = await makeStaff('owner');
  ownerScope = owner.scope;
  ownerUserId = owner.userId;
  freeCapacityOption = await createPriceOption(f, { kind: 'free' });
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  pack3Option = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 3 });
  await createFulfillmentRevision(f, pack3Option, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
  });
  pack1Option = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 1 });
  await createFulfillmentRevision(f, pack1Option, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
  });
  unlimitedOption = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
  await createFulfillmentRevision(f, unlimitedOption, {
    usageKind: 'unlimited',
    validityKind: 'fixedEndDate',
    validityEndDate: '2027-12-31',
  });
  reservedOnlyOption = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
  await createFulfillmentRevision(f, reservedOnlyOption, {
    usageKind: 'finite',
    usesTotal: 8,
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
    reservationRequired: true,
    walkInAllowed: false,
  });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Issuance
// ---------------------------------------------------------------------------

describe('credential issuance', () => {
  it('issues a 10-minute 8-digit credential for an in-window booking; same-key replay returns NO secrets; regeneration supersedes', async () => {
    const customer = await createCustomer(testDb.db);
    const { bookingId } = await makeInWindowBooking(customer);
    const key = newId();
    const first = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId },
      idempotencyKey: key,
    });
    if (first.outcome.kind !== 'credentialIssued') throw new Error(first.outcome.kind);
    expect(first.outcome.credential.displayCode).toMatch(/^\d{8}$/);
    expect(first.outcome.credential.token!.length).toBeGreaterThanOrEqual(40);
    const ttlMs =
      new Date(first.outcome.credential.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);
    // Same-key replay: SAME credential, no secrets, nothing superseded.
    const replay = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId },
      idempotencyKey: key,
    });
    if (replay.outcome.kind !== 'credentialIssued') throw new Error(replay.outcome.kind);
    expect(replay.outcome.credential.credentialId).toBe(first.outcome.credential.credentialId);
    expect(replay.outcome.credential.replayed).toBe(true);
    expect(replay.outcome.credential.displayCode).toBeUndefined();
    expect(replay.outcome.credential.token).toBeUndefined();
    // A plain DIFFERENT-key issuance while a credential is effectively
    // live: NOTHING superseded, NOTHING minted, NO secrets (rule A).
    const plain = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId },
      idempotencyKey: newId(),
    });
    if (plain.outcome.kind !== 'credentialAlreadyLive') throw new Error(plain.outcome.kind);
    expect(plain.outcome.credential.credentialId).toBe(first.outcome.credential.credentialId);
    expect('displayCode' in plain.outcome.credential).toBe(false);
    // EXPLICIT regeneration (rule B): names the current credential,
    // supersedes it, exactly one live replacement.
    const regen = await issue(
      customer,
      { kind: 'booking', bookingId },
      newId(),
      deps,
      first.outcome.credential.credentialId,
    );
    expect(regen.credentialId).not.toBe(first.outcome.credential.credentialId);
    const states = await sql<{ id: string; state: string }>`
      SELECT id, state FROM redemption_credential WHERE booking_id = ${bookingId}
      ORDER BY created_at`.execute(testDb.db);
    expect(states.rows.map((row) => row.state)).toEqual(['superseded', 'live']);
    // Customer observation: superseded/live effective states, no secrets.
    const status = await getRedemptionCredentialStatus(deps, { accountId: customer.accountId }, {
      credentialId: first.outcome.credential.credentialId,
    });
    if (status.kind !== 'credentialStatus') throw new Error(status.kind);
    expect(status.credential.state).toBe('superseded');
  });

  it('refuses: outside the ±60-minute window, unconfirmed bookings, missing/misplaced occurrence selection (0020), and foreign bookings', async () => {
    const customer = await createCustomer(testDb.db);
    // The FUTURE fixture anchor (weeks ahead) is outside the ±60-min window.
    const future = await makeInWindowBookingAt(customer, FUTURE);
    const early = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId: future.bookingId },
      idempotencyKey: newId(),
    });
    expect(early.outcome.kind).toBe('outsideCheckInWindow');
    // Unconfirmed (pending_payment) booking.
    const pending = await makePendingBooking(customer);
    const unconfirmed = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId: pending },
      idempotencyKey: newId(),
    });
    expect(unconfirmed.outcome.kind).toBe('bookingNotConfirmed');
    // Camp-week booking WITHOUT an explicit occurrence selection (0020):
    // the customer must name the canonical day/time — nearest-to-now
    // inference never exists (docs/35 §29).
    const campBooking = await makeCampBooking(customer);
    const camp = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId: campBooking },
      idempotencyKey: newId(),
    });
    expect(camp.outcome.kind).toBe('occurrenceRequired');
    // And a SESSION booking with an occurrence selection refuses — the
    // Session IS its canonical occurrence (docs/35 §29).
    const sessionBooking = await makeInWindowBooking(customer);
    const misSelected = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId: sessionBooking.bookingId },
      occurrence: { date: CAMP_START_DATE, startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(misSelected.outcome.kind).toBe('occurrenceNotApplicable');
    // Customer A cannot issue for B's booking (not-found-shaped).
    const stranger = await createCustomer(testDb.db);
    const inWindow = await makeInWindowBooking(customer);
    const foreign = await issueRedemptionCredential(deps, { accountId: stranger.accountId }, {
      target: { kind: 'booking', bookingId: inWindow.bookingId },
      idempotencyKey: newId(),
    });
    expect(foreign.outcome.kind).toBe('bookingNotFound');
  });

  it('walk-in issuance: reservation-required-only products and foreign/exhausted/expired entitlements are refused', async () => {
    const customer = await createCustomer(testDb.db);
    const reservedOnly = await makeEntitlement(customer, reservedOnlyOption);
    const bypass = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'entitlement', entitlementId: reservedOnly },
      idempotencyKey: newId(),
    });
    expect(bypass.outcome.kind).toBe('walkInNotAllowed');
    const stranger = await createCustomer(testDb.db);
    const owned = await makeEntitlement(customer, pack3Option);
    const foreign = await issueRedemptionCredential(deps, { accountId: stranger.accountId }, {
      target: { kind: 'entitlement', entitlementId: owned },
      idempotencyKey: newId(),
    });
    expect(foreign.outcome.kind).toBe('entitlementNotFound');
    // Expired entitlement (direct fixture — validity is immutable).
    const expired = await insertExpiredEntitlement(customer);
    const lapsed = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'entitlement', entitlementId: expired },
      idempotencyKey: newId(),
    });
    expect(lapsed.outcome.kind).toBe('entitlementNotActive');
  });

  it('stale/foreign regeneration ids change NOTHING; lost-response recovery = replay metadata → explicit regeneration (rules B/E/H)', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const key = newId();
    const c1 = await issue(customer, { kind: 'entitlement', entitlementId }, key);
    // Explicit regeneration replaces C1 with C2.
    const c2 = await issue(
      customer,
      { kind: 'entitlement', entitlementId },
      newId(),
      deps,
      c1.credentialId,
    );
    // The STALE C1 id can never supersede its replacement.
    const stale = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'entitlement', entitlementId },
      idempotencyKey: newId(),
      regenerateCredentialId: c1.credentialId,
    });
    expect(stale.outcome.kind).toBe('credentialNotCurrent');
    const liveNow = await sql<{ id: string }>`
      SELECT id FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} AND state = 'live'`.execute(testDb.db);
    expect(liveNow.rows.map((row) => row.id)).toEqual([c2.credentialId]);
    // Foreign-account credential id: not-found-shaped, nothing changed.
    const stranger = await createCustomer(testDb.db);
    const strangerEntitlement = await makeEntitlement(stranger, pack3Option);
    const foreign = await issueRedemptionCredential(deps, { accountId: stranger.accountId }, {
      target: { kind: 'entitlement', entitlementId: strangerEntitlement },
      idempotencyKey: newId(),
      regenerateCredentialId: c2.credentialId,
    });
    expect(foreign.outcome.kind).toBe('credentialNotFound');
    // Lost-response recovery (rule E): the ORIGINAL key replays C1's
    // metadata without secrets…
    const replay = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'entitlement', entitlementId },
      idempotencyKey: key,
    });
    if (replay.outcome.kind !== 'credentialIssued') throw new Error(replay.outcome.kind);
    expect(replay.outcome.credential.replayed).toBe(true);
    expect(replay.outcome.credential.displayCode).toBeUndefined();
    // …and a plain issuance reports the CURRENT live credential id, which
    // an explicit regeneration then replaces with ONE new usable credential.
    const current = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'entitlement', entitlementId },
      idempotencyKey: newId(),
    });
    if (current.outcome.kind !== 'credentialAlreadyLive') throw new Error(current.outcome.kind);
    expect(current.outcome.credential.credentialId).toBe(c2.credentialId);
    const c3 = await issue(
      customer,
      { kind: 'entitlement', entitlementId },
      newId(),
      deps,
      current.outcome.credential.credentialId,
    );
    expect(c3.displayCode).toMatch(/^\d{8}$/);
    const finalLive = await sql<{ id: string }>`
      SELECT id FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} AND state = 'live'`.execute(testDb.db);
    expect(finalLive.rows.map((row) => row.id)).toEqual([c3.credentialId]);
  });

  it('alias collision retries deterministically and fails typed after the bounded limit', async () => {
    const customerA = await createCustomer(testDb.db);
    const customerB = await createCustomer(testDb.db);
    const entitlementA = await makeEntitlement(customerA, pack3Option);
    const entitlementB = await makeEntitlement(customerB, pack3Option);
    const first = await issue(
      customerA,
      { kind: 'entitlement', entitlementId: entitlementA },
      newId(),
      { ...deps, aliasGenerator: () => '13579246' },
    );
    expect(first.displayCode).toBe('13579246');
    // Colliding generator: first candidate collides with the LIVE alias,
    // the bounded retry takes the next.
    const sequence = ['13579246', '86420975'];
    let cursor = 0;
    const second = await issue(
      customerB,
      { kind: 'entitlement', entitlementId: entitlementB },
      newId(),
      { ...deps, aliasGenerator: () => sequence[Math.min(cursor++, 1)]! },
    );
    expect(second.displayCode).toBe('86420975');
    // A generator that can only collide exhausts the strict retry limit
    // with a typed internal failure — never silent reuse.
    const customerC = await createCustomer(testDb.db);
    const entitlementC = await makeEntitlement(customerC, pack3Option);
    await expect(
      issueRedemptionCredential(
        { ...deps, aliasGenerator: () => '13579246' },
        { accountId: customerC.accountId },
        { target: { kind: 'entitlement', entitlementId: entitlementC }, idempotencyKey: newId() },
      ),
    ).rejects.toThrow(/alias generation exhausted/);
  });
});

async function makeInWindowBookingAt(
  customer: Customer,
  startAt: Date,
): Promise<{ bookingId: string; sessionId: string }> {
  const sessionId = await createSession(f, {
    start_at: startAt,
    end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
    registration_cutoff_at: startAt,
  });
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freeCapacityOption,
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const confirmed = await confirmFreeBooking(deps, { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  return { bookingId: confirmed.outcome.booking.bookingId, sessionId };
}

async function makePendingBooking(customer: Customer): Promise<string> {
  const startAt = new Date(Date.now() + 30 * 60 * 1000);
  const sessionId = await createSession(f, {
    start_at: startAt,
    end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
    registration_cutoff_at: startAt,
  });
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: dropInOption,
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const initiated = await initiateBooking(deps, { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (initiated.outcome.kind !== 'bookingPending') throw new Error(initiated.outcome.kind);
  return initiated.outcome.booking.bookingId;
}

async function makeCampBooking(customer: Customer): Promise<string> {
  const campWeekId = await createCampWeek(f);
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freeCapacityOption,
    unit: { kind: 'campWeek', id: campWeekId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps, { accountId: customer.accountId }, {
    unit: { kind: 'campWeek', id: campWeekId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const confirmed = await confirmFreeBooking(deps, { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  return confirmed.outcome.booking.bookingId;
}

/** Direct fixture: a confirmed purchase + ALREADY-EXPIRED entitlement (the
 *  immutable-validity shape no live path can mint). */
async function insertExpiredEntitlement(customer: Customer): Promise<string> {
  const quote = await requestEntitlementQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: pack3Option,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const q = await sql<{ fulfillment_revision_id: string }>`
    SELECT fulfillment_revision_id FROM price_quote WHERE id = ${quote.quote.quoteId}`.execute(
    testDb.db,
  );
  const purchaseId = newId();
  await sql`
    INSERT INTO entitlement_purchase
      (id, account_id, participant_id, organization_id, program_id, price_option_id,
       quote_id, fulfillment_revision_id, state, reference_code, expires_at, confirmed_at)
    VALUES (${purchaseId}, ${customer.accountId}, ${customer.participantId}, ${f.org.orgId},
            ${f.programId}, ${pack3Option}, ${quote.quote.quoteId},
            ${q.rows[0]!.fulfillment_revision_id}, 'confirmed', ${`HMP-${purchaseId}`},
            now(), now() - interval '60 days')`.execute(testDb.db);
  const entitlementId = newId();
  await sql`
    INSERT INTO entitlement
      (id, purchase_id, account_id, participant_id, organization_id, program_id,
       price_option_id, fulfillment_revision_id, usage_kind, uses_total,
       valid_from, valid_until, reservation_required, walk_in_allowed)
    VALUES (${entitlementId}, ${purchaseId}, ${customer.accountId}, ${customer.participantId},
            ${f.org.orgId}, ${f.programId}, ${pack3Option},
            ${q.rows[0]!.fulfillment_revision_id}, 'finite', 3,
            now() - interval '60 days', now() - interval '30 days', false, true)`.execute(
    testDb.db,
  );
  return entitlementId;
}

// ---------------------------------------------------------------------------
// Provider preview + atomic redemption
// ---------------------------------------------------------------------------

describe('provider preview and atomic redemption', () => {
  it('walk-in finite: preview shows context; redeem consumes exactly one use; used/replayed/second-key behavior', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    const preview = await previewRedemption(deps, ownerScope, { code: issued.displayCode });
    if (preview.kind !== 'redemptionPreview') throw new Error(preview.kind);
    expect(preview.preview.targetKind).toBe('walkIn');
    expect(preview.preview.usage).toMatchObject({ usageKind: 'finite', usesTotal: 3, remaining: 3 });
    // Preview granted nothing.
    expect(await attendanceCount({ entitlementId })).toBe(0);

    const key = newId();
    const run = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: key,
    });
    if (run.outcome.kind !== 'attendanceRecorded') throw new Error(run.outcome.kind);
    expect(run.outcome.attendance.remaining).toBe(2);
    expect(await attendanceCount({ entitlementId })).toBe(1);
    // Same-key replay converges without a second attendance.
    const replay = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(await attendanceCount({ entitlementId })).toBe(1);
    // A DIFFERENT key on the used credential: truthful org-visible refusal.
    const second = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    expect(second.outcome.kind).toBe('credentialAlreadyUsed');
    // Audit/outbox emitted exactly once.
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'attendance.redeemed'
        AND payload->>'entitlementId' = ${entitlementId}`.execute(testDb.db);
    expect(Number(events.rows[0]!.n)).toBe(1);
  });

  it('plain session Booking: attendance without consumption; re-issuance after check-in refuses (alreadyCheckedIn)', async () => {
    const customer = await createCustomer(testDb.db);
    const { bookingId } = await makeInWindowBooking(customer);
    const issued = await issue(customer, { kind: 'booking', bookingId });
    const run = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'attendanceRecorded') throw new Error(run.outcome.kind);
    expect(run.outcome.attendance.targetKind).toBe('session');
    expect(run.outcome.attendance.remaining).toBeUndefined();
    const row = await sql<{ entitlement_id: string | null; session_id: string | null }>`
      SELECT entitlement_id, session_id FROM attendance_record
      WHERE booking_id = ${bookingId}`.execute(testDb.db);
    expect(row.rows[0]!.entitlement_id).toBeNull();
    expect(row.rows[0]!.session_id).not.toBeNull();
    const again = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId },
      idempotencyKey: newId(),
    });
    expect(again.outcome.kind).toBe('alreadyCheckedIn');
  });

  it('reserved entitlement use: attendance carries Booking + Entitlement and converts the commitment to consumption', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const { bookingId, sessionId } = await makeInWindowBooking(customer);
    // Bounded S6-2 fixture seam (owner item 4): the reservation row itself —
    // S6-3 owns operational creation.
    await sql`
      INSERT INTO entitlement_reservation
        (booking_id, entitlement_id, account_id, participant_id, organization_id, program_id)
      VALUES (${bookingId}, ${entitlementId}, ${customer.accountId},
              ${customer.participantId}, ${f.org.orgId}, ${f.programId})`.execute(testDb.db);
    const issued = await issue(customer, { kind: 'booking', bookingId });
    const preview = await previewRedemption(deps, ownerScope, { code: issued.displayCode });
    if (preview.kind !== 'redemptionPreview') throw new Error(preview.kind);
    expect(preview.preview.targetKind).toBe('reservedEntitlementUse');
    const run = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'attendanceRecorded') throw new Error(run.outcome.kind);
    expect(run.outcome.attendance.targetKind).toBe('reservedEntitlementUse');
    expect(run.outcome.attendance.remaining).toBe(2);
    const record = await sql<{ entitlement_id: string; booking_id: string; session_id: string }>`
      SELECT entitlement_id, booking_id, session_id FROM attendance_record
      WHERE booking_id = ${bookingId}`.execute(testDb.db);
    expect(record.rows[0]).toEqual({
      entitlement_id: entitlementId,
      booking_id: bookingId,
      session_id: sessionId,
    });
  });

  it('unlimited membership: sequential credentials create MULTIPLE attendances with no counter anywhere', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, unlimitedOption);
    for (let visit = 0; visit < 3; visit += 1) {
      const issued = await issue(customer, { kind: 'entitlement', entitlementId });
      const run = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
        code: issued.displayCode,
        credentialId: issued.credentialId,
        idempotencyKey: newId(),
      });
      if (run.outcome.kind !== 'attendanceRecorded') throw new Error(run.outcome.kind);
      expect(run.outcome.attendance.remaining).toBeUndefined();
    }
    expect(await attendanceCount({ entitlementId })).toBe(3);
  });

  it('final finite use: exhaustion event fires once; further issuance/redemption refuses', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack1Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    const run = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'attendanceRecorded') throw new Error(run.outcome.kind);
    expect(run.outcome.attendance.remaining).toBe(0);
    expect(run.outcome.attendance.entitlementExhausted).toBe(true);
    const exhausted = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'entitlement.exhausted' AND aggregate_id = ${entitlementId}`.execute(
      testDb.db,
    );
    expect(Number(exhausted.rows[0]!.n)).toBe(1);
    const next = await issueRedemptionCredential(deps, { accountId: customer.accountId }, {
      target: { kind: 'entitlement', entitlementId },
      idempotencyKey: newId(),
    });
    expect(next.outcome.kind).toBe('entitlementExhausted');
  });

  it('expiry consumes nothing and is sweeper-free; regeneration after expiry works', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const lapsed = await issue(
      customer,
      { kind: 'entitlement', entitlementId },
      newId(),
      { ...deps, credentialTtlSeconds: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // Effective expiry: preview and redeem refuse on server time alone.
    const preview = await previewRedemption(deps, ownerScope, { code: lapsed.displayCode });
    expect(preview.kind).toBe('credentialExpired');
    const run = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: lapsed.displayCode,
      credentialId: lapsed.credentialId,
      idempotencyKey: newId(),
    });
    expect(run.outcome.kind).toBe('credentialExpired');
    expect(await attendanceCount({ entitlementId })).toBe(0);
    // The customer may simply generate another.
    const fresh = await issue(customer, { kind: 'entitlement', entitlementId });
    expect(fresh.credentialId).not.toBe(lapsed.credentialId);
  });
});

// ---------------------------------------------------------------------------
// Scope + brute force + privacy
// ---------------------------------------------------------------------------

describe('provider scope and code privacy', () => {
  it('branch scope: out-of-scope front desk refused; in-scope front desk succeeds; org-wide walk-in redeemable by branch-scoped staff', async () => {
    const customer = await createCustomer(testDb.db);
    const { bookingId } = await makeInWindowBooking(customer);
    const issued = await issue(customer, { kind: 'booking', bookingId });
    // A branch-scoped front desk whose ACTIVE scope reaches only a foreign
    // branch id (an empty stored scope set is unrepresentable — docs/27 §5;
    // the resolved scope simply lists no matching branch).
    const outOfScopeBase = await makeStaff('front_desk', [f.org.branchIds[0]!]);
    const outOfScope = {
      ...outOfScopeBase,
      scope: { ...outOfScopeBase.scope, branchScope: [newId()] },
    };
    const denied = await redeemCredential(deps, outOfScope.scope, { userId: outOfScope.userId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    expect(denied.outcome.kind).toBe('forbiddenScope');
    const inScope = await makeStaff('front_desk', [f.org.branchIds[0]!]);
    const allowed = await redeemCredential(deps, inScope.scope, { userId: inScope.userId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    expect(allowed.outcome.kind).toBe('attendanceRecorded');
    // Branch-NULL walk-in: any attendance.manage staff of the org may
    // validate (the entitlement carries no branch limitation).
    const walkInCustomer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(walkInCustomer, pack3Option);
    const walkIn = await issue(walkInCustomer, { kind: 'entitlement', entitlementId });
    const branchScoped = await redeemCredential(deps, inScope.scope, { userId: inScope.userId }, {
      code: walkIn.displayCode,
      credentialId: walkIn.credentialId,
      idempotencyKey: newId(),
    });
    expect(branchScoped.outcome.kind).toBe('attendanceRecorded');
  });

  it('coach: assigned session only — unassigned sessions and org-wide walk-ins are refused', async () => {
    const coach = await makeStaff('coach');
    const customer = await createCustomer(testDb.db);
    const assigned = await makeInWindowBooking(customer, {
      instructorStaffId: coach.membershipId,
    });
    const assignedCredential = await issue(customer, { kind: 'booking', bookingId: assigned.bookingId });
    const ok = await redeemCredential(deps, coach.scope, { userId: coach.userId }, {
      code: assignedCredential.displayCode,
      credentialId: assignedCredential.credentialId,
      idempotencyKey: newId(),
    });
    expect(ok.outcome.kind).toBe('attendanceRecorded');
    // Unassigned session → refused.
    const other = await createCustomer(testDb.db);
    const unassigned = await makeInWindowBooking(other);
    const unassignedCredential = await issue(other, { kind: 'booking', bookingId: unassigned.bookingId });
    const deniedSession = await redeemCredential(deps, coach.scope, { userId: coach.userId }, {
      code: unassignedCredential.displayCode,
      credentialId: unassignedCredential.credentialId,
      idempotencyKey: newId(),
    });
    expect(deniedSession.outcome.kind).toBe('forbiddenScope');
    // Walk-in entitlement → refused for coaches, always.
    const walkInCustomer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(walkInCustomer, pack3Option);
    const walkIn = await issue(walkInCustomer, { kind: 'entitlement', entitlementId });
    const deniedWalkIn = await previewRedemption(deps, coach.scope, {
      code: walkIn.displayCode,
    });
    expect(deniedWalkIn.kind).toBe('forbiddenScope');
  });

  it('a foreign-org provider learns NOTHING from a valid code; misses are counted and throttled durably', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    // Organization B staff with a VALID org-A code: generic refusal.
    const orgB = await createBookingFixture(testDb.db);
    const foreignUser = await createUser(testDb.db);
    const foreignMembership = await addMembership(testDb.db, foreignUser, orgB.org.orgId, 'owner');
    const foreignScope: OrgScope = {
      organizationId: orgB.org.orgId,
      membershipId: foreignMembership,
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const foreign = await previewRedemption(deps, foreignScope, { code: issued.displayCode });
    expect(foreign.kind).toBe('credentialNotFound');
    // Bounded attempts: a tight limit throttles the SAME principal + org
    // durably (PostgreSQL windows — instance-independent by construction).
    // A FRESH principal so the count starts at zero.
    const throttleUser = await createUser(testDb.db);
    const throttleMembership = await addMembership(testDb.db, throttleUser, orgB.org.orgId, 'org_manager');
    const throttleScope: OrgScope = {
      ...foreignScope,
      membershipId: throttleMembership,
      role: 'org_manager',
      capabilities: capabilitiesForRole('org_manager'),
    };
    const tight: RedemptionDeps = { ...deps, redemptionAttemptLimit: 3 };
    for (let i = 0; i < 3; i += 1) {
      const miss = await previewRedemption(tight, throttleScope, { code: '00000001' });
      expect(miss.kind).toBe('credentialNotFound');
    }
    const throttled = await previewRedemption(tight, throttleScope, { code: '00000001' });
    expect(throttled.kind).toBe('tooManyAttempts');
    const redeemThrottled = await redeemCredential(tight, throttleScope, { userId: throttleUser }, {
      code: '00000001',
      credentialId: newId(),
      idempotencyKey: newId(),
    });
    expect(redeemThrottled.outcome.kind).toBe('tooManyAttempts');
    // The org-A owner is unaffected (per-principal + org dimension).
    const fine = await previewRedemption(tight, ownerScope, { code: issued.displayCode });
    expect(fine.kind).toBe('redemptionPreview');
  });

  it('no raw code/token ever reaches audit, outbox, or the idempotency store', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    for (const [table, column] of [
      ['audit_event', 'after_digest'],
      ['outbox_event', 'payload'],
      ['idempotency_key', 'response_snapshot'],
    ] as const) {
      const leaked = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ${sql.id(table)}
        WHERE ${sql.id(column)}::text LIKE ${'%' + issued.displayCode + '%'}
           OR ${sql.id(column)}::text LIKE ${'%' + issued.token + '%'}`.execute(testDb.db);
      expect(Number(leaked.rows[0]!.n)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency proofs (owner item 30) — real multi-connection races
// ---------------------------------------------------------------------------

describe('concurrency proofs', () => {
  it('two staff redeem ONE credential simultaneously → exactly one attendance, one consumption', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    const staffA = await makeStaff('owner');
    const staffB = await makeStaff('org_manager');
    const pool = await createRacePool(testDb.config, 4);
    try {
      const results = await race([
        () =>
          redeemCredential({ db: pool.db }, staffA.scope, { userId: staffA.userId }, {
            code: issued.displayCode,
            credentialId: issued.credentialId,
            idempotencyKey: newId(),
          }),
        () =>
          redeemCredential({ db: pool.db }, staffB.scope, { userId: staffB.userId }, {
            code: issued.displayCode,
            credentialId: issued.credentialId,
            idempotencyKey: newId(),
          }),
      ]);
      const kinds = results.map((run) => run.outcome.kind).sort();
      expect(kinds).toContain('attendanceRecorded');
      expect(kinds.filter((kind) => kind === 'attendanceRecorded')).toHaveLength(1);
    } finally {
      await pool.destroy();
    }
    expect(await attendanceCount({ entitlementId })).toBe(1);
    const consumed = await sql<{ state: string; n: string }>`
      SELECT state, count(*) AS n FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} GROUP BY state`.execute(testDb.db);
    expect(consumed.rows).toEqual([{ state: 'used', n: '1' }]);
  });

  it('regenerate races redeem → deterministic legal outcome: never two live credentials, never double attendance', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    const pool = await createRacePool(testDb.config, 4);
    try {
      await race<unknown>([
        () =>
          redeemCredential({ db: pool.db }, ownerScope, { userId: ownerUserId }, {
            code: issued.displayCode,
            credentialId: issued.credentialId,
            idempotencyKey: newId(),
          }),
        () =>
          issueRedemptionCredential({ db: pool.db }, { accountId: customer.accountId }, {
            target: { kind: 'entitlement', entitlementId },
            idempotencyKey: newId(),
            regenerateCredentialId: issued.credentialId,
          }),
      ]);
    } finally {
      await pool.destroy();
    }
    // Invariants, whichever serialization won: at most one LIVE credential
    // for the target; at most one attendance; a superseded credential is
    // never redeemable (proven by state machine — used XOR superseded).
    const states = await sql<{ state: string; n: string }>`
      SELECT state, count(*) AS n FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} GROUP BY state ORDER BY state`.execute(testDb.db);
    const byState = new Map(states.rows.map((row) => [row.state, Number(row.n)]));
    expect(byState.get('live') ?? 0).toBeLessThanOrEqual(1);
    expect(await attendanceCount({ entitlementId })).toBeLessThanOrEqual(1);
    // The used credential (if any) has an attendance; superseded ones none.
    const used = await sql<{ id: string }>`
      SELECT id FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} AND state = 'used'`.execute(testDb.db);
    for (const row of used.rows) {
      const linked = await sql<{ n: string }>`
        SELECT count(*) AS n FROM attendance_record WHERE credential_id = ${row.id}`.execute(
        testDb.db,
      );
      expect(Number(linked.rows[0]!.n)).toBe(1);
    }
  });

  it('two live redemption targets race the FINAL finite use → the entitlement lock serializes to at most one consuming attendance', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack1Option); // ONE use
    // Two legally live redemption targets against the same final unit: a
    // walk-in credential AND a reserved-use booking credential.
    const { bookingId } = await makeInWindowBooking(customer);
    await sql`
      INSERT INTO entitlement_reservation
        (booking_id, entitlement_id, account_id, participant_id, organization_id, program_id)
      VALUES (${bookingId}, ${entitlementId}, ${customer.accountId},
              ${customer.participantId}, ${f.org.orgId}, ${f.programId})`.execute(testDb.db);
    const walkIn = await issue(customer, { kind: 'entitlement', entitlementId });
    const reserved = await issue(customer, { kind: 'booking', bookingId });
    const staffA = await makeStaff('owner');
    const staffB = await makeStaff('org_manager');
    const pool = await createRacePool(testDb.config, 4);
    try {
      const results = await race([
        () =>
          redeemCredential({ db: pool.db }, staffA.scope, { userId: staffA.userId }, {
            code: walkIn.displayCode,
            credentialId: walkIn.credentialId,
            idempotencyKey: newId(),
          }),
        () =>
          redeemCredential({ db: pool.db }, staffB.scope, { userId: staffB.userId }, {
            code: reserved.displayCode,
            credentialId: reserved.credentialId,
            idempotencyKey: newId(),
          }),
      ]);
      const kinds = results.map((run) => run.outcome.kind).sort();
      expect(kinds.filter((kind) => kind === 'attendanceRecorded')).toHaveLength(1);
      // S6-3 owning-slice amendment (docs/35 §7; owner item 32): a live
      // reservation COMMITMENT now holds its credit — the walk-in refuses
      // `entitlementFullyCommitted` when it locks first, or
      // `entitlementExhausted` when the reserved redemption already
      // converted the commitment to consumption. Either way exactly one
      // attendance exists and it is the RESERVED one.
      expect(
        kinds.includes('entitlementExhausted') || kinds.includes('entitlementFullyCommitted'),
      ).toBe(true);
    } finally {
      await pool.destroy();
    }
    expect(await attendanceCount({ entitlementId })).toBe(1);
  });

  it('two concurrent DIFFERENT-key INITIAL issuances → ONE credential; only its creator receives secrets; the loser supersedes nothing (rules A/D)', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const pool = await createRacePool(testDb.config, 4);
    let results: Awaited<ReturnType<typeof issueRedemptionCredential>>[];
    try {
      results = await race([
        () =>
          issueRedemptionCredential({ db: pool.db }, { accountId: customer.accountId }, {
            target: { kind: 'entitlement', entitlementId },
            idempotencyKey: newId(),
          }),
        () =>
          issueRedemptionCredential({ db: pool.db }, { accountId: customer.accountId }, {
            target: { kind: 'entitlement', entitlementId },
            idempotencyKey: newId(),
          }),
      ]);
    } finally {
      await pool.destroy();
    }
    const kinds = results.map((run) => run.outcome.kind).sort();
    expect(kinds).toEqual(['credentialAlreadyLive', 'credentialIssued']);
    const winner = results.find((run) => run.outcome.kind === 'credentialIssued')!;
    const loser = results.find((run) => run.outcome.kind === 'credentialAlreadyLive')!;
    if (winner.outcome.kind !== 'credentialIssued') throw new Error('unreachable');
    if (loser.outcome.kind !== 'credentialAlreadyLive') throw new Error('unreachable');
    // Only the creator holds secrets; the loser got safe recovery metadata
    // for the SAME (still-live) credential — nothing was superseded.
    expect(winner.outcome.credential.displayCode).toMatch(/^\d{8}$/);
    expect(loser.outcome.credential.credentialId).toBe(winner.outcome.credential.credentialId);
    expect('displayCode' in loser.outcome.credential).toBe(false);
    const rows = await sql<{ state: string; n: string }>`
      SELECT state, count(*) AS n FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} GROUP BY state`.execute(testDb.db);
    expect(rows.rows).toEqual([{ state: 'live', n: '1' }]);
  });

  it('two concurrent EXPLICIT regenerations of C1 → one C2, no C3; the loser changes nothing (rule C)', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const c1 = await issue(customer, { kind: 'entitlement', entitlementId });
    const pool = await createRacePool(testDb.config, 4);
    let results: Awaited<ReturnType<typeof issueRedemptionCredential>>[];
    try {
      results = await race([
        () =>
          issueRedemptionCredential({ db: pool.db }, { accountId: customer.accountId }, {
            target: { kind: 'entitlement', entitlementId },
            idempotencyKey: newId(),
            regenerateCredentialId: c1.credentialId,
          }),
        () =>
          issueRedemptionCredential({ db: pool.db }, { accountId: customer.accountId }, {
            target: { kind: 'entitlement', entitlementId },
            idempotencyKey: newId(),
            regenerateCredentialId: c1.credentialId,
          }),
      ]);
    } finally {
      await pool.destroy();
    }
    const kinds = results.map((run) => run.outcome.kind).sort();
    expect(kinds).toEqual(['credentialIssued', 'credentialNotCurrent']);
    const rows = await sql<{ state: string; n: string }>`
      SELECT state, count(*) AS n FROM redemption_credential
      WHERE entitlement_id = ${entitlementId} GROUP BY state ORDER BY state`.execute(testDb.db);
    expect(rows.rows).toEqual([
      { state: 'live', n: '1' },
      { state: 'superseded', n: '1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failure injection (owner item 35)
// ---------------------------------------------------------------------------

describe('failure injection', () => {
  it('a crash between credential consumption and attendance — and after attendance before events — rolls the WHOLE redemption back; retry converges', async () => {
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await issue(customer, { kind: 'entitlement', entitlementId });
    for (const phase of ['credentialConsumed', 'attendanceInserted'] as const) {
      const boom = new Error(`injected: ${phase}`);
      await expect(
        redeemCredential(
          {
            ...deps,
            onRedeemPhase: (at) => {
              if (at === phase) throw boom;
            },
          },
          ownerScope,
          { userId: ownerUserId },
          {
            code: issued.displayCode,
            credentialId: issued.credentialId,
            idempotencyKey: newId(),
          },
        ),
      ).rejects.toThrow(boom.message);
      // Nothing partially committed: the credential is STILL live and no
      // attendance exists — never a consumed credential without attendance,
      // never attendance beside a redeemable credential.
      const state = await sql<{ state: string }>`
        SELECT state FROM redemption_credential WHERE id = ${issued.credentialId}`.execute(
        testDb.db,
      );
      expect(state.rows[0]!.state).toBe('live');
      expect(await attendanceCount({ entitlementId })).toBe(0);
    }
    // The retry converges cleanly afterward.
    const retry = await redeemCredential(deps, ownerScope, { userId: ownerUserId }, {
      code: issued.displayCode,
      credentialId: issued.credentialId,
      idempotencyKey: newId(),
    });
    expect(retry.outcome.kind).toBe('attendanceRecorded');
    expect(await attendanceCount({ entitlementId })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface (owner items 12, 14–15, 31)
// ---------------------------------------------------------------------------

describe('HTTP journey and cross-principal locks', () => {
  function inject(
    method: 'GET' | 'POST',
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

  it('customer issues over HTTP → provider previews → provider redeems (201) → customer observes `used`', async () => {
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    const { bearer } = await bearerForUser(ctx, userId);
    const customer: Customer = { accountId, participantId };
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await inject(
      'POST',
      `/customer/entitlements/${entitlementId}/credential`,
      bearer,
      { idempotencyKey: newId() },
    );
    expect(issued.statusCode).toBe(201);
    const credential = issued.json().credential;
    expect(credential.displayCode).toMatch(/^\d{8}$/);
    const staff = await makeStaff('front_desk', [f.org.branchIds[0]!]);
    const preview = await inject(
      'POST',
      `/provider/organizations/${f.org.orgId}/check-in/preview`,
      staff.bearer,
      { code: credential.displayCode },
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview.usage.remaining).toBe(3);
    const redeem = await inject(
      'POST',
      `/provider/organizations/${f.org.orgId}/check-in/redeem`,
      staff.bearer,
      {
        code: credential.displayCode,
        credentialId: credential.credentialId,
        idempotencyKey: newId(),
      },
    );
    expect(redeem.statusCode).toBe(201);
    expect(redeem.json().attendance.remaining).toBe(2);
    const observed = await inject(
      'GET',
      `/customer/credentials/${credential.credentialId}`,
      bearer,
    );
    expect(observed.statusCode).toBe(200);
    expect(observed.json().credential.state).toBe('used');
    expect(observed.json().credential.redeemedAt).toBeDefined();
  });

  it('principal separation: customer bearers cannot preview/redeem; provider bearers cannot mint customer credentials; foreign org is refused', async () => {
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    const { bearer: customerBearer } = await bearerForUser(ctx, userId);
    const customer: Customer = { accountId, participantId };
    const entitlementId = await makeEntitlement(customer, pack3Option);
    const issued = await inject(
      'POST',
      `/customer/entitlements/${entitlementId}/credential`,
      customerBearer,
      { idempotencyKey: newId() },
    );
    const code = issued.json().credential.displayCode as string;
    // Customer bearer on the provider surface: refused by policy (no org
    // membership → the provider policy shapes it away).
    const customerOnProvider = await inject(
      'POST',
      `/provider/organizations/${f.org.orgId}/check-in/preview`,
      customerBearer,
      { code },
    );
    expect([403, 404]).toContain(customerOnProvider.statusCode);
    // Provider bearer on the customer surface: no customer account → 404.
    const staff = await makeStaff('owner');
    const providerOnCustomer = await inject(
      'POST',
      `/customer/entitlements/${entitlementId}/credential`,
      staff.bearer,
      { idempotencyKey: newId() },
    );
    expect([403, 404]).toContain(providerOnCustomer.statusCode);
    // Foreign organization URL with a valid code: refused before any
    // credential knowledge exists.
    const orgB = await createBookingFixture(testDb.db);
    const orgBStaffUser = await createUser(testDb.db);
    await addMembership(testDb.db, orgBStaffUser, orgB.org.orgId, 'owner');
    const { bearer: orgBBearer } = await bearerForUser(ctx, orgBStaffUser);
    const foreign = await inject(
      'POST',
      `/provider/organizations/${orgB.org.orgId}/check-in/preview`,
      orgBBearer,
      { code },
    );
    expect(foreign.statusCode).toBe(404);
    // Unauthenticated: 401 everywhere.
    expect(
      (
        await inject('POST', `/provider/organizations/${f.org.orgId}/check-in/preview`, null, {
          code,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await inject('POST', `/customer/entitlements/${entitlementId}/credential`, null, {
          idempotencyKey: newId(),
        })
      ).statusCode,
    ).toBe(401);
  });
});
