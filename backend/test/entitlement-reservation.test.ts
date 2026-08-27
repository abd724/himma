/**
 * S6-3 — the operational Entitlement reservation authority (docs/35 §7;
 * owner items 2–11, 28–32; proofs 11, 14–18). Real PostgreSQL + real
 * Fastify transport + multi-connection races.
 *
 * Covers: reservation-quote eligibility from the PURCHASED immutable terms
 * (ownership · validity · reservation permission · Program/branch/schedule
 * occurrence rules · participant eligibility · finite advisory) ·
 * `confirmEntitlementReservation` (certified S5 core + entitlement lock
 * LAST + fresh post-lock recount + atomic rollback of provisional capacity
 * on refusal) · the cross-shape structural guards (proofs 14–15) · finite
 * commitment accounting (§7 vocabulary) · the reservation→credential→
 * redemption bridge · no-show derivation · idempotency · the final-credit
 * two-transaction proof (proof 11) · walk-in-versus-reservation final-
 * credit exclusion (item 32) · commission-once (item 28) · security
 * (item 29) · and the HTTP journey with the included-with-pass Booking
 * truth (item 26).
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
import { confirmFreeBooking } from '../src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { startPaidEntitlementCheckout } from '../src/modules/payment/services/checkout-orchestration';
import { processTrustedPaymentResults } from '../src/modules/payment/services/payment-saga';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../src/modules/payment/services/webhook-ingestion';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import {
  confirmEntitlementReservation,
  finiteCommitmentCounts,
  finiteProjection,
  requestEntitlementReservationQuote,
} from '../src/modules/entitlement/services/entitlement-reservation';
import {
  issueRedemptionCredential,
  type IssuedCredentialView,
} from '../src/modules/entitlement/services/redemption-credential';
import {
  previewRedemption,
  redeemCredential,
} from '../src/modules/entitlement/services/attendance-redemption';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCommissionTerm,
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
import { createRacePool, race, type RacePool } from './helpers/race-harness';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/entitlement-reservation-pool';
const NOW = new Date('2026-08-27T12:00:00.000Z');
const SUCCESS_URL = 'https://himma.test/return';
const CANCEL_URL = 'https://himma.test/cancel';

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let racePool: RacePool;
let provider: DeterministicPaymentProvider;
let eventCounter = 8000;

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
  racePool = await createRacePool(testDb.config, 4);
  provider = new DeterministicPaymentProvider({ now: NOW });
});

afterAll(async () => {
  await racePool.destroy();
  await app.close();
  await testDb.drop();
});

/** A reservation-capable finite option: reservation required, no walk-in
 *  unless asked, `sessions` uses via the certified package total. */
async function reservationOption(
  options: { sessions?: number; walkIn?: boolean; branchId?: string | null } = {},
): Promise<{ optionId: string; revisionId: string }> {
  const optionId = await createPriceOption(f, {
    kind: 'package',
    amountFils: 0,
    sessionsCount: options.sessions ?? 3,
  });
  const revisionId = await createFulfillmentRevision(f, optionId, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
    reservationRequired: true,
    walkInAllowed: options.walkIn ?? false,
    branchId: options.branchId ?? null,
  });
  return { optionId, revisionId };
}

async function makeEntitlement(customer: Customer, optionId: string): Promise<string> {
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

/** quote → hold, ready for confirmation. */
async function reservationHold(
  customer: Customer,
  entitlementId: string,
  sessionId: string,
  dbOverride = testDb.db,
): Promise<{ quoteId: string; holdId: string }> {
  const quote = await requestEntitlementReservationQuote({ db: dbOverride }, {
    accountId: customer.accountId,
  }, { entitlementId, sessionId });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold({ db: dbOverride }, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  return { quoteId: quote.quote.quoteId, holdId: hold.outcome.hold.holdId };
}

async function reserve(
  customer: Customer,
  entitlementId: string,
  sessionId: string,
): Promise<{ bookingId: string; quoteId: string }> {
  const { quoteId, holdId } = await reservationHold(customer, entitlementId, sessionId);
  const run = await confirmEntitlementReservation(deps(), { accountId: customer.accountId }, {
    holdId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'reservationConfirmed') throw new Error(run.outcome.kind);
  return { bookingId: run.outcome.reservation.bookingId, quoteId };
}

function scopeFor(membershipId: string, role: OrgScope['role']): OrgScope {
  return {
    organizationId: f.org.orgId,
    membershipId,
    role,
    capabilities: capabilitiesForRole(role),
    branchScope: 'all',
    organizationState: 'live',
  };
}

async function frontDeskScope(): Promise<{ scope: OrgScope; userId: string }> {
  const userId = await createUser(testDb.db);
  const membershipId = await addMembership(testDb.db, userId, f.org.orgId, 'front_desk');
  return { scope: scopeFor(membershipId, 'front_desk'), userId };
}

async function issueCredential(
  customer: Customer,
  target: { kind: 'entitlement'; entitlementId: string } | { kind: 'booking'; bookingId: string },
  dbOverride = testDb.db,
): Promise<IssuedCredentialView> {
  const run = await issueRedemptionCredential({ db: dbOverride }, { accountId: customer.accountId }, {
    target,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'credentialIssued') throw new Error(run.outcome.kind);
  return run.outcome.credential;
}

async function projectionOf(entitlementId: string, usesTotal: number) {
  return testDb.db.transaction().execute(async (trx) => {
    const counts = await finiteCommitmentCounts(trx, entitlementId);
    return finiteProjection(usesTotal, counts);
  });
}

async function paymentArtifactCounts(): Promise<{ intents: number; transactions: number; economics: number }> {
  const rows = await sql<{ intents: string; transactions: string; economics: string }>`
    SELECT (SELECT count(*) FROM payment_intent) AS intents,
           (SELECT count(*) FROM payment_transaction) AS transactions,
           (SELECT count(*) FROM payment_intent_economics) AS economics`.execute(testDb.db);
  return {
    intents: Number(rows.rows[0]!.intents),
    transactions: Number(rows.rows[0]!.transactions),
    economics: Number(rows.rows[0]!.economics),
  };
}

// ---------------------------------------------------------------------------
// Reservation quote — eligibility from the PURCHASED terms
// ---------------------------------------------------------------------------

describe('reservation quote (docs/35 §4/§38)', () => {
  it('issues the entitlement-bound zero-total quote with the advisory finite projection; the row carries the approved shape', async () => {
    const { optionId } = await reservationOption({ sessions: 3 });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession();
    const result = await requestEntitlementReservationQuote(deps(), {
      accountId: customer.accountId,
    }, { entitlementId, sessionId });
    if (result.kind !== 'quoteIssued') throw new Error(result.kind);
    expect(result.quote).toMatchObject({
      entitlementId,
      sessionId,
      totalFils: 0,
      participantId: customer.participantId,
      finite: { usesTotal: 3, used: 0, remaining: 3, reservedUpcoming: 0, availableToReserve: 3 },
    });
    const row = await sql<{
      commercial_shape: string;
      entitlement_id: string;
      total_fils: string;
      session_id: string;
      fulfillment_revision_id: string | null;
    }>`
      SELECT commercial_shape, entitlement_id, total_fils, session_id, fulfillment_revision_id
      FROM price_quote WHERE id = ${result.quote.quoteId}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({
      commercial_shape: 'entitlementReservation',
      entitlement_id: entitlementId,
      total_fils: '0',
      session_id: sessionId,
      // The purchased revision binds TRANSITIVELY through the append-only
      // entitlement (five-column FK); the direct column is the acquisition
      // binding and stays NULL by the 0017 shape CHECK.
      fulfillment_revision_id: null,
    });
  });

  it('cross-account entitlement ids are NOT-FOUND-shaped; the beneficiary is never caller-chosen', async () => {
    const { optionId } = await reservationOption();
    const owner = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(owner, optionId);
    const stranger = await createCustomer(testDb.db);
    const sessionId = await futureSession();
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: stranger.accountId }, {
        entitlementId,
        sessionId,
      }),
    ).toEqual({ kind: 'entitlementNotFound' });
  });

  it('walk-in-only products do not reserve; expired entitlements refuse typed', async () => {
    const walkInOnly = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 3,
    });
    await createFulfillmentRevision(f, walkInOnly, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: false,
      walkInAllowed: true,
    });
    const customer = await createCustomer(testDb.db);
    const walkInEntitlement = await makeEntitlement(customer, walkInOnly);
    const sessionId = await futureSession();
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: customer.accountId }, {
        entitlementId: walkInEntitlement,
        sessionId,
      }),
    ).toEqual({ kind: 'reservationNotPermitted' });

    // Expired: a directly seeded lapsed entitlement (the append-only table
    // forbids UPDATE — the S6-2 fixture precedent).
    const { optionId, revisionId } = await reservationOption();
    const expiredQuote = await requestEntitlementQuote(deps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: optionId,
      participantId: customer.participantId,
    });
    if (expiredQuote.kind !== 'quoteIssued') throw new Error(expiredQuote.kind);
    const purchaseId = newId();
    await sql`
      INSERT INTO entitlement_purchase
        (id, account_id, participant_id, organization_id, program_id, price_option_id,
         quote_id, fulfillment_revision_id, state, reference_code, expires_at, confirmed_at)
      VALUES (${purchaseId}, ${customer.accountId}, ${customer.participantId}, ${f.org.orgId},
              ${f.programId}, ${optionId}, ${expiredQuote.quote.quoteId}, ${revisionId},
              'confirmed', ${`HMP-${purchaseId}`}, now(), now() - interval '60 days')`.execute(
      testDb.db,
    );
    const expired = newId();
    await sql`
      INSERT INTO entitlement
        (id, purchase_id, account_id, participant_id, organization_id, program_id,
         price_option_id, fulfillment_revision_id, usage_kind, uses_total,
         valid_from, valid_until, reservation_required, walk_in_allowed)
      VALUES (${expired}, ${purchaseId}, ${customer.accountId}, ${customer.participantId},
              ${f.org.orgId}, ${f.programId}, ${optionId}, ${revisionId}, 'finite', 3,
              now() - interval '60 days', now() - interval '30 days', true, false)`.execute(
      testDb.db,
    );
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: customer.accountId }, {
        entitlementId: expired,
        sessionId,
      }),
    ).toEqual({ kind: 'entitlementNotActive' });
  });

  it('occurrence rules come from the PURCHASED terms: foreign program, branch limitation, schedule snapshot, past/near-expiry sessions all refuse', async () => {
    const customer = await createCustomer(testDb.db);
    // Branch-limited product (branch B), schedule-bound Mon/Wed 19:00–20:00.
    const branchA = f.org.branchIds[0]!;
    const optionId = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
    const revisionId = await createFulfillmentRevision(f, optionId, {
      usageKind: 'finite',
      usesTotal: 5,
      validityKind: 'daysFromConfirmation',
      validityDays: 10,
      reservationRequired: true,
      walkInAllowed: false,
      branchId: branchA,
    });
    await sql`
      INSERT INTO price_option_fulfillment_schedule_term (id, revision_id, weekday, start_time, end_time)
      VALUES (${newId()}, ${revisionId}, 1, '19:00', '20:00'),
             (${newId()}, ${revisionId}, 3, '19:00', '20:00')`.execute(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);

    // A Monday 19:00 Dubai session (2026-08-31 is a Monday) at branch A.
    const monday = new Date('2026-08-31T15:00:00.000Z'); // 19:00 Asia/Dubai
    const eligible = await createSession(f, {
      start_at: monday,
      end_at: new Date(monday.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: monday,
      branch_id: branchA,
    });
    const quoted = await requestEntitlementReservationQuote(deps(), {
      accountId: customer.accountId,
    }, { entitlementId, sessionId: eligible });
    // The fully ELIGIBLE occurrence passes every purchased-terms gate and
    // reaches the LAST check — the recorded membership-kind gap (0013
    // ck_booking_option_kind; the gate is deliberately ordered after
    // branch/schedule/temporal so this refusal PROVES eligibility passed).
    // The schedule-matched POSITIVE issuance is membership-only product
    // territory and awaits the owner-authorized widening.
    expect(quoted.kind).toBe('membershipReservationUnavailable');

    // Tuesday same time → outside the purchased snapshot.
    const tuesday = new Date('2026-09-01T15:00:00.000Z');
    const offPattern = await createSession(f, {
      start_at: tuesday,
      end_at: new Date(tuesday.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: tuesday,
      branch_id: branchA,
    });
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: customer.accountId }, {
        entitlementId,
        sessionId: offPattern,
      }),
    ).toEqual({ kind: 'occurrenceNotEligible' });

    // Another org's session: not-found-shaped occurrence refusal.
    const foreign = await createBookingFixture(testDb.db);
    await publishProgram(foreign);
    const foreignSession = await createSession(foreign, {
      start_at: monday,
      end_at: new Date(monday.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: monday,
    });
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: customer.accountId }, {
        entitlementId,
        sessionId: foreignSession,
      }),
    ).toEqual({ kind: 'occurrenceNotEligible' });

    // A session beyond the 10-day purchased validity refuses.
    const beyondValidity = await futureSession(15 * 24 * 60);
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: customer.accountId }, {
        entitlementId,
        sessionId: beyondValidity,
      }),
    ).toEqual({ kind: 'occurrenceNotEligible' });

    // A past session refuses.
    const past = await createSession(f, {
      start_at: new Date(Date.now() - 60 * 60 * 1000),
      end_at: new Date(Date.now() - 30 * 60 * 1000),
      registration_cutoff_at: new Date(Date.now() - 60 * 60 * 1000),
      branch_id: branchA,
    });
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId: customer.accountId }, {
        entitlementId,
        sessionId: past,
      }),
    ).toEqual({ kind: 'occurrenceNotEligible' });
  });

  it('the certified age gate applies to the entitlement beneficiary at the occurrence start', async () => {
    const { optionId } = await reservationOption();
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const childId = newId();
    await sql`INSERT INTO participant (id, account_id, kind, first_name, date_of_birth)
              VALUES (${childId}, ${accountId}, 'child', 'Young', '2020-01-01')`.execute(
      testDb.db,
    );
    const customer: Customer = { accountId, participantId: childId };
    // Acquired while the program was all-ages; the provider then tightens
    // the age range — the occurrence gate re-applies the certified rule.
    const entitlementId = await makeEntitlement(customer, optionId);
    await sql`UPDATE program SET min_age = 16, all_ages = false
              WHERE id = ${f.programId}`.execute(testDb.db);
    const sessionId = await futureSession();
    expect(
      await requestEntitlementReservationQuote(deps(), { accountId }, {
        entitlementId,
        sessionId,
      }),
    ).toEqual({ kind: 'participantIneligible' });
    await sql`UPDATE program SET min_age = NULL, all_ages = true
              WHERE id = ${f.programId}`.execute(testDb.db);
  });
});

// ---------------------------------------------------------------------------
// Confirmation — the atomic commitment authority
// ---------------------------------------------------------------------------

describe('confirmEntitlementReservation (docs/35 §7)', () => {
  it('quote → hold → confirm: ONE confirmed Booking + ONE commitment + one committed seat; the §7 projection holds; audit/outbox once; ZERO payment artifacts', async () => {
    const before = await paymentArtifactCounts();
    const { optionId } = await reservationOption({ sessions: 3 });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession();
    const { holdId } = await reservationHold(customer, entitlementId, sessionId);
    const run = await confirmEntitlementReservation(deps(), { accountId: customer.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'reservationConfirmed') throw new Error(run.outcome.kind);
    const view = run.outcome.reservation;
    expect(view).toMatchObject({
      state: 'confirmed',
      entitlementId,
      sessionId,
      finite: { usesTotal: 3, used: 0, remaining: 3, reservedUpcoming: 1, availableToReserve: 2 },
    });

    const truths = await sql<Record<string, string>>`
      SELECT (SELECT state FROM booking WHERE id = ${view.bookingId}) AS booking_state,
             (SELECT count(*) FROM entitlement_reservation
               WHERE booking_id = ${view.bookingId}) AS commitments,
             (SELECT booked_count FROM session WHERE id = ${sessionId})::text AS booked,
             (SELECT count(*) FROM attendance_record
               WHERE entitlement_id = ${entitlementId}) AS attendance,
             (SELECT count(*) FROM outbox_event
               WHERE event_type = 'entitlement.reservation.created'
                 AND aggregate_id = ${view.bookingId}) AS outbox`.execute(testDb.db);
    expect(truths.rows[0]).toEqual({
      booking_state: 'confirmed',
      commitments: '1',
      booked: '1',
      attendance: '0',
      outbox: '1',
    });
    // No payment state of ANY kind was created by quote/hold/confirm.
    expect(await paymentArtifactCounts()).toEqual(before);
    expect(await projectionOf(entitlementId, 3)).toEqual({
      usesTotal: 3,
      used: 0,
      remaining: 3,
      reservedUpcoming: 1,
      availableToReserve: 2,
    });
  });

  it('PROOF 14/15 — cross-shape structural non-crossing: a free capacity quote cannot enter the reservation boundary, and a reservation quote cannot pass confirmFreeBooking', async () => {
    const customer = await createCustomer(testDb.db);
    // Free capacity quote + hold → refused by confirmEntitlementReservation.
    const freeOption = await createPriceOption(f, { kind: 'free' });
    const sessionA = await futureSession();
    const capacityQuote = await requestQuote(deps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: freeOption,
      unit: { kind: 'session', id: sessionA },
      participantId: customer.participantId,
    });
    if (capacityQuote.kind !== 'quoteIssued') throw new Error(capacityQuote.kind);
    const capacityHold = await claimHold(deps(), { accountId: customer.accountId }, {
      unit: { kind: 'session', id: sessionA },
      participantId: customer.participantId,
      quoteId: capacityQuote.quote.quoteId,
      idempotencyKey: newId(),
    });
    if (capacityHold.outcome.kind !== 'holdClaimed') throw new Error(capacityHold.outcome.kind);
    const crossed = await confirmEntitlementReservation(deps(), {
      accountId: customer.accountId,
    }, { holdId: capacityHold.outcome.hold.holdId, idempotencyKey: newId() });
    expect(crossed.outcome).toEqual({ kind: 'notReservationQuote' });

    // Reservation quote + hold → refused by confirmFreeBooking (shape guard).
    const { optionId } = await reservationOption();
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionB = await futureSession();
    const { holdId } = await reservationHold(customer, entitlementId, sessionB);
    const escaped = await confirmFreeBooking(deps(), { accountId: customer.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(escaped.outcome).toEqual({ kind: 'notFreeQuote' });
    // Nothing was consumed either way: the reservation hold is still live.
    const hold = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${holdId}`.execute(testDb.db);
    expect(hold.rows[0]!.state).toBe('active');
  });

  it('IDEMPOTENCY (item 30): same-key replay returns the SAME reservation; a second confirm of a consumed hold cannot duplicate', async () => {
    const { optionId } = await reservationOption({ sessions: 3 });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession();
    const { holdId } = await reservationHold(customer, entitlementId, sessionId);
    const key = newId();
    const first = await confirmEntitlementReservation(deps(), {
      accountId: customer.accountId,
    }, { holdId, idempotencyKey: key });
    if (first.outcome.kind !== 'reservationConfirmed') throw new Error(first.outcome.kind);
    const replay = await confirmEntitlementReservation(deps(), {
      accountId: customer.accountId,
    }, { holdId, idempotencyKey: key });
    expect(replay.replayed).toBe(true);
    if (replay.outcome.kind !== 'reservationConfirmed') throw new Error(replay.outcome.kind);
    expect(replay.outcome.reservation.bookingId).toBe(first.outcome.reservation.bookingId);
    // A DIFFERENT key against the same hold finds the live booking.
    const fresh = await confirmEntitlementReservation(deps(), {
      accountId: customer.accountId,
    }, { holdId, idempotencyKey: newId() });
    expect(fresh.outcome.kind).toBe('alreadyBooked');
    const counts = await sql<{ bookings: string; commitments: string }>`
      SELECT (SELECT count(*) FROM booking WHERE session_id = ${sessionId}) AS bookings,
             (SELECT count(*) FROM entitlement_reservation
               WHERE entitlement_id = ${entitlementId}) AS commitments`.execute(testDb.db);
    expect(counts.rows[0]).toEqual({ bookings: '1', commitments: '1' });
  });

  it('PROOF 11 — final-credit two-transaction race: different Sessions, shared Entitlement; exactly ONE commitment, the loser rolls its provisional Booking/capacity back', async () => {
    const { optionId } = await reservationOption({ sessions: 1 });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionA = await futureSession(60);
    const sessionB = await futureSession(120);
    const holdA = await reservationHold(customer, entitlementId, sessionA);
    const holdB = await reservationHold(customer, entitlementId, sessionB);

    const outcomes = await race([
      () =>
        confirmEntitlementReservation({ db: racePool.db }, { accountId: customer.accountId }, {
          holdId: holdA.holdId,
          idempotencyKey: newId(),
        }),
      () =>
        confirmEntitlementReservation({ db: racePool.db }, { accountId: customer.accountId }, {
          holdId: holdB.holdId,
          idempotencyKey: newId(),
        }),
    ]);
    const kinds = outcomes.map((run) => run.outcome.kind).sort();
    expect(kinds).toEqual(['entitlementFullyCommitted', 'reservationConfirmed']);

    const truths = await sql<Record<string, string>>`
      SELECT (SELECT count(*) FROM booking
               WHERE session_id IN (${sessionA}, ${sessionB})
                 AND state = 'confirmed') AS confirmed_bookings,
             (SELECT count(*) FROM booking
               WHERE session_id IN (${sessionA}, ${sessionB})) AS all_bookings,
             (SELECT count(*) FROM entitlement_reservation
               WHERE entitlement_id = ${entitlementId}) AS commitments,
             (SELECT booked_count FROM session WHERE id = ${sessionA})::text
               || '+' || (SELECT booked_count FROM session WHERE id = ${sessionB})::text
               AS booked,
             (SELECT count(*) FROM attendance_record
               WHERE entitlement_id = ${entitlementId}) AS attendance`.execute(testDb.db);
    const row = truths.rows[0]!;
    // The loser's provisional Booking and counter movement ROLLED BACK
    // atomically — exactly one booking row exists at all.
    expect(row.confirmed_bookings).toBe('1');
    expect(row.all_bookings).toBe('1');
    expect(row.commitments).toBe('1');
    expect(['1+0', '0+1']).toContain(row.booked);
    expect(row.attendance).toBe('0');
    expect(await projectionOf(entitlementId, 1)).toEqual({
      usesTotal: 1,
      used: 0,
      remaining: 1,
      reservedUpcoming: 1,
      availableToReserve: 0,
    });
  });

  it('a reservation AFTER another attendance consumed the final credit refuses at the fresh post-lock recount', async () => {
    const { optionId } = await reservationOption({ sessions: 1, walkIn: true });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession();
    const { holdId } = await reservationHold(customer, entitlementId, sessionId);
    // Walk-in attendance consumes the final use between hold and confirm.
    const credential = await issueCredential(customer, { kind: 'entitlement', entitlementId });
    const desk = await frontDeskScope();
    const redeemed = await redeemCredential(deps(), desk.scope, { userId: desk.userId }, {
      code: credential.displayCode!,
      credentialId: credential.credentialId,
      idempotencyKey: newId(),
    });
    expect(redeemed.outcome.kind).toBe('attendanceRecorded');

    const run = await confirmEntitlementReservation(deps(), { accountId: customer.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(run.outcome).toEqual({ kind: 'entitlementExhausted' });
    expect(await projectionOf(entitlementId, 1)).toEqual({
      usesTotal: 1,
      used: 1,
      remaining: 0,
      reservedUpcoming: 0,
      availableToReserve: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// The reservation ⇄ attendance bridge and lifecycle derivations
// ---------------------------------------------------------------------------

describe('reservation lifecycle (items 10–11; journeys A–D)', () => {
  it('JOURNEY A+B — reserved attendance: credential → preview (reserved context) → redeem → ONE attendance carrying Booking+Entitlement+occurrence; the projection converts commitment → consumption', async () => {
    const { optionId } = await reservationOption({ sessions: 3 });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    // In the check-in window: starts in 30 minutes.
    const sessionId = await futureSession(30);
    const { bookingId } = await reserve(customer, entitlementId, sessionId);
    expect(await projectionOf(entitlementId, 3)).toMatchObject({
      used: 0,
      remaining: 3,
      reservedUpcoming: 1,
      availableToReserve: 2,
    });

    const credential = await issueCredential(customer, { kind: 'booking', bookingId });
    const desk = await frontDeskScope();
    const preview = await previewRedemption(deps(), desk.scope, {
      code: credential.displayCode!,
    });
    if (preview.kind !== 'redemptionPreview') throw new Error(preview.kind);
    expect(preview.preview.targetKind).toBe('reservedEntitlementUse');

    const redeemed = await redeemCredential(deps(), desk.scope, { userId: desk.userId }, {
      code: credential.displayCode!,
      credentialId: credential.credentialId,
      idempotencyKey: newId(),
    });
    if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);
    expect(redeemed.outcome.attendance.targetKind).toBe('reservedEntitlementUse');

    const attendance = await sql<{
      booking_id: string | null;
      entitlement_id: string | null;
      session_id: string | null;
      participant_id: string;
      organization_id: string;
    }>`
      SELECT booking_id, entitlement_id, session_id, participant_id, organization_id
      FROM attendance_record WHERE booking_id = ${bookingId}`.execute(testDb.db);
    expect(attendance.rows[0]).toEqual({
      booking_id: bookingId,
      entitlement_id: entitlementId,
      session_id: sessionId,
      participant_id: customer.participantId,
      organization_id: f.org.orgId,
    });
    // Commitment became consumption DERIVATIONALLY — one attendance insert.
    expect(await projectionOf(entitlementId, 3)).toEqual({
      usesTotal: 3,
      used: 1,
      remaining: 2,
      reservedUpcoming: 0,
      availableToReserve: 2,
    });
  });

  it('JOURNEY C — no-show: a concluded occurrence with no attendance consumes NOTHING and stops reducing availableToReserve', async () => {
    const { optionId } = await reservationOption({ sessions: 3 });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession(30);
    await reserve(customer, entitlementId, sessionId);
    expect(await projectionOf(entitlementId, 3)).toMatchObject({
      reservedUpcoming: 1,
      availableToReserve: 2,
    });
    // The occurrence concludes (time passes) with no attendance.
    await sql`UPDATE session SET start_at = now() - interval '2 hours',
                                 end_at = now() - interval '1 hour'
              WHERE id = ${sessionId}`.execute(testDb.db);
    expect(await projectionOf(entitlementId, 3)).toEqual({
      usesTotal: 3,
      used: 0,
      remaining: 3,
      reservedUpcoming: 0,
      availableToReserve: 3,
    });
  });

  it('ITEM 32 — walk-in redemption versus reservation racing the FINAL unconsumed/uncommitted use: exactly one claims it at the Entitlement lock', async () => {
    const { optionId } = await reservationOption({ sessions: 1, walkIn: true });
    const customer = await createCustomer(testDb.db);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession(60);
    const { holdId } = await reservationHold(customer, entitlementId, sessionId);
    const credential = await issueCredential(customer, { kind: 'entitlement', entitlementId });
    const desk = await frontDeskScope();

    const [reservationRun, redeemRun] = await race<
      | Awaited<ReturnType<typeof confirmEntitlementReservation>>
      | Awaited<ReturnType<typeof redeemCredential>>
    >([
      () =>
        confirmEntitlementReservation({ db: racePool.db }, { accountId: customer.accountId }, {
          holdId,
          idempotencyKey: newId(),
        }),
      () =>
        redeemCredential({ db: racePool.db }, desk.scope, { userId: desk.userId }, {
          code: credential.displayCode!,
          credentialId: credential.credentialId,
          idempotencyKey: newId(),
        }),
    ]);
    const kinds = [reservationRun!.outcome.kind, redeemRun!.outcome.kind].sort();
    expect([
      // Walk-in won: the later reservation recount sees used = total.
      ['attendanceRecorded', 'entitlementExhausted'],
      // Reservation won: the walk-in sees every use committed.
      ['entitlementFullyCommitted', 'reservationConfirmed'],
    ]).toContainEqual(kinds);

    const truths = await sql<{ attendance: string; commitments: string }>`
      SELECT (SELECT count(*) FROM attendance_record
               WHERE entitlement_id = ${entitlementId}) AS attendance,
             (SELECT count(*) FROM entitlement_reservation
               WHERE entitlement_id = ${entitlementId}) AS commitments`.execute(testDb.db);
    const row = truths.rows[0]!;
    // Exactly ONE of the two effects exists — never both.
    expect([`${row.attendance}+${row.commitments}`]).toContainEqual(
      row.attendance === '1' ? '1+0' : '0+1',
    );
    const projection = await projectionOf(entitlementId, 1);
    expect(projection.availableToReserve).toBe(0);
    expect(projection.used + projection.reservedUpcoming).toBe(1);
  });

  it('COMMISSION-ONCE (item 28): one PAID package sale, then multiple reservations and attendances — exactly ONE intent/capture/economics snapshot ever exists', async () => {
    await createCommissionTerm(testDb.db, f.org.orgId, 1200);
    const paidOption = await createPriceOption(f, {
      kind: 'package',
      amountFils: 50_000,
      sessionsCount: 5,
    });
    await createFulfillmentRevision(f, paidOption, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 60,
      reservationRequired: true,
      walkInAllowed: true,
    });
    const customer = await createCustomer(testDb.db);
    const quote = await requestEntitlementQuote(deps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: paidOption,
      participantId: customer.participantId,
    });
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const orchestration = { db: testDb.db, provider: { kind: 'configured' as const, provider } };
    const started = await startPaidEntitlementCheckout(orchestration, {
      accountId: customer.accountId,
    }, {
      quoteId: quote.quote.quoteId,
      idempotencyKey: newId(),
      returnUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    });
    if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
    provider.completeCheckout(started.gatewayRef);
    eventCounter += 1;
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: `evt-s63-${eventCounter}`,
      eventType: 'payment.captured',
      gatewayRef: started.gatewayRef,
    });
    const webhookDeps = { db: testDb.db, provider };
    const accepted = await ingestGatewayDelivery(webhookDeps, delivery.rawBody, delivery.headers);
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    await processPendingGatewayEvents(webhookDeps);
    await processTrustedPaymentResults({ db: testDb.db, provider });
    const entitlement = await sql<{ id: string }>`
      SELECT e.id FROM entitlement e
      JOIN entitlement_purchase p ON p.id = e.purchase_id
      WHERE p.quote_id = ${quote.quote.quoteId}`.execute(testDb.db);
    const entitlementId = entitlement.rows[0]!.id;

    const financialRows = async () =>
      sql<Record<string, string>>`
        SELECT (SELECT count(*) FROM payment_intent pi
                 JOIN entitlement_purchase p ON p.id = pi.purchase_id
                 WHERE p.quote_id = ${quote.quote.quoteId}) AS intents,
               (SELECT count(*) FROM payment_intent_economics x
                 JOIN payment_intent pi ON pi.id = x.intent_id
                 JOIN entitlement_purchase p ON p.id = pi.purchase_id
                 WHERE p.quote_id = ${quote.quote.quoteId}) AS economics,
               (SELECT count(*) FROM payment_transaction t
                 JOIN payment_attempt a ON a.id = t.attempt_id
                 JOIN payment_intent pi ON pi.id = a.intent_id
                 JOIN entitlement_purchase p ON p.id = pi.purchase_id
                 WHERE p.quote_id = ${quote.quote.quoteId}) AS transactions`.execute(testDb.db);
    const before = (await financialRows()).rows[0]!;
    expect(before).toEqual({ intents: '1', economics: '1', transactions: '1' });

    // Two reservations; one attended reserved; one walk-in attendance.
    const desk = await frontDeskScope();
    const sessionOne = await futureSession(30);
    const { bookingId } = await reserve(customer, entitlementId, sessionOne);
    const sessionTwo = await futureSession(48 * 60);
    await reserve(customer, entitlementId, sessionTwo);
    const reservedCredential = await issueCredential(customer, { kind: 'booking', bookingId });
    const reservedRedeem = await redeemCredential(deps(), desk.scope, { userId: desk.userId }, {
      code: reservedCredential.displayCode!,
      credentialId: reservedCredential.credentialId,
      idempotencyKey: newId(),
    });
    expect(reservedRedeem.outcome.kind).toBe('attendanceRecorded');
    const walkInCredential = await issueCredential(customer, {
      kind: 'entitlement',
      entitlementId,
    });
    const walkInRedeem = await redeemCredential(deps(), desk.scope, { userId: desk.userId }, {
      code: walkInCredential.displayCode!,
      credentialId: walkInCredential.credentialId,
      idempotencyKey: newId(),
    });
    expect(walkInRedeem.outcome.kind).toBe('attendanceRecorded');

    // The ORIGINAL marketplace commission only — nothing accrued after.
    expect((await financialRows()).rows[0]).toEqual(before);
    expect(await projectionOf(entitlementId, 5)).toEqual({
      usesTotal: 5,
      used: 2,
      remaining: 3,
      reservedUpcoming: 1,
      availableToReserve: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP journey + security
// ---------------------------------------------------------------------------

describe('HTTP surface and security (items 15, 26, 29)', () => {
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

  it('the full wire journey: reservable read → quote → hold → confirm → the Booking read carries the included-with-pass truth (never "free")', async () => {
    const { optionId } = await reservationOption({ sessions: 3 });
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    const customer: Customer = { accountId, participantId };
    const { bearer } = await bearerForUser(ctx, userId);
    const entitlementId = await makeEntitlement(customer, optionId);
    const sessionId = await futureSession(72 * 60);

    const reservable = await inject(
      'GET',
      `/customer/entitlements/${entitlementId}/reservable-sessions`,
      bearer,
    );
    expect(reservable.statusCode).toBe(200);
    const listed = reservable.json();
    expect(listed.finite.availableToReserve).toBe(3);
    expect(
      listed.sessions.some((row: { sessionId: string }) => row.sessionId === sessionId),
    ).toBe(true);

    const quoted = await inject(
      'POST',
      `/customer/entitlements/${entitlementId}/reservation-quote`,
      bearer,
      { sessionId },
    );
    expect(quoted.statusCode).toBe(201);
    const quoteId = quoted.json().quote.quoteId;
    expect(quoted.json().quote.totalFils).toBe(0);

    const held = await inject('POST', '/customer/holds', bearer, {
      unitKind: 'session',
      unitId: sessionId,
      participantId,
      quoteId,
      idempotencyKey: newId(),
    });
    expect(held.statusCode).toBe(201);
    const holdId = held.json().hold.holdId;

    const confirmed = await inject('POST', '/customer/entitlement-reservations/confirm', bearer, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(confirmed.statusCode).toBe(201);
    const reservation = confirmed.json().reservation;
    expect(reservation.finite).toEqual({
      usesTotal: 3,
      used: 0,
      remaining: 3,
      reservedUpcoming: 1,
      availableToReserve: 2,
    });

    // Item 26/27: My Bookings lists the Booking normally, and the AED 0
    // price is truthfully INCLUDED-WITH-PASS, never a free product.
    const booking = await inject('GET', `/customer/bookings/${reservation.bookingId}`, bearer);
    expect(booking.statusCode).toBe(200);
    expect(booking.json().booking).toMatchObject({
      state: 'confirmed',
      price: { totalFils: 0, currency: 'AED' },
      coveredByEntitlement: true,
      entitlementId,
    });
  });

  it('cross-account and cross-principal authority: B cannot use A\'s entitlement or hold; provider/admin bearers hold NO customer reservation authority; the wire rejects authored counters', async () => {
    const { optionId } = await reservationOption();
    const ownerUserId = await createUser(testDb.db);
    const ownerAccount = await createAccount(testDb.db, ownerUserId);
    const ownerParticipant = await createSelfParticipant(testDb.db, ownerAccount);
    const owner: Customer = { accountId: ownerAccount, participantId: ownerParticipant };
    const { bearer: ownerBearer } = await bearerForUser(ctx, ownerUserId);
    const entitlementId = await makeEntitlement(owner, optionId);
    const sessionId = await futureSession();

    const strangerUserId = await createUser(testDb.db);
    await createAccount(testDb.db, strangerUserId);
    const { bearer: strangerBearer } = await bearerForUser(ctx, strangerUserId);

    // B cannot read/quote/list A's entitlement (not-found-shaped).
    expect(
      (await inject('GET', `/customer/entitlements/${entitlementId}`, strangerBearer)).statusCode,
    ).toBe(404);
    expect(
      (
        await inject(
          'POST',
          `/customer/entitlements/${entitlementId}/reservation-quote`,
          strangerBearer,
          { sessionId },
        )
      ).statusCode,
    ).toBe(404);

    // B cannot confirm with A's hold.
    const { holdId } = await reservationHold(owner, entitlementId, sessionId);
    const stolen = await inject(
      'POST',
      '/customer/entitlement-reservations/confirm',
      strangerBearer,
      { holdId, idempotencyKey: newId() },
    );
    expect(stolen.statusCode).toBe(404);

    // A provider staff bearer conveys NO customer reservation authority.
    const staffUserId = await createUser(testDb.db);
    await addMembership(testDb.db, staffUserId, f.org.orgId, 'owner');
    const { bearer: staffBearerToken } = await bearerForUser(ctx, staffUserId, {
      scopes: ['openid'],
    });
    const staffAttempt = await inject(
      'POST',
      '/customer/entitlement-reservations/confirm',
      staffBearerToken,
      { holdId, idempotencyKey: newId() },
    );
    // A staff user without a customer account has no account principal.
    expect([401, 403, 404]).toContain(staffAttempt.statusCode);

    // The customer cannot AUTHOR any counter/price/beneficiary field —
    // smuggled fields are STRIPPED by the app-wide Ajv (the certified
    // inexpressibility convention); every value stays server-authored.
    const authored = await inject(
      'POST',
      `/customer/entitlements/${entitlementId}/reservation-quote`,
      ownerBearer,
      { sessionId, availableToReserve: 99, totalFils: 500, participantId: newId() },
    );
    expect(authored.statusCode).toBe(201);
    expect(authored.json().quote.totalFils).toBe(0);
    expect(authored.json().quote.participantId).toBe(ownerParticipant);
    expect(authored.json().quote.finite.availableToReserve).toBe(3);

    // Unauthenticated: refused at the policy gate.
    expect(
      (await inject('GET', '/customer/entitlements', null)).statusCode,
    ).toBe(401);
  });

  it('an acquisition quote cannot be held (structural) and therefore never reaches the reservation boundary', async () => {
    const { optionId } = await reservationOption();
    const customer = await createCustomer(testDb.db);
    const quote = await requestEntitlementQuote(deps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: optionId,
      participantId: customer.participantId,
    });
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const sessionId = await futureSession();
    const held = await claimHold(deps(), { accountId: customer.accountId }, {
      unit: { kind: 'session', id: sessionId },
      participantId: customer.participantId,
      quoteId: quote.quote.quoteId,
      idempotencyKey: newId(),
    });
    // The unit-less acquisition quote mismatches every capacity unit.
    expect(held.outcome.kind).toBe('quoteMismatch');
  });
});
