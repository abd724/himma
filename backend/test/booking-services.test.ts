/**
 * W4 Slice 5 · S5-3 — booking domain service semantics on real PostgreSQL
 * (docs/32 §6, §10; docs/24 §3.2–§3.4, §5.6, §7.1/§7.3/§7.4; rulings D-2,
 * D-4, D-7, D-8). Proven here: quote issuance (immutable, TTL, offers,
 * never reserves), paid initiation preserving the ACTIVE-hold +
 * pending_payment intermediate state, the atomic §7.3/§7.4b confirmation
 * (reciprocal identity, counter movement, write-once facts, Enrolment),
 * policy fail-close BEFORE mutation, the trusted paid seam, idempotency,
 * and deterministic failure injection. Races live in
 * booking-concurrency.test.ts.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { releaseHold } from '../src/modules/booking/services/hold-lifecycle';
import {
  confirmFreeBooking,
  confirmPaidBooking,
  initiateBooking,
} from '../src/modules/booking/services/booking-lifecycle';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import type {
  BookingServiceDeps,
  UnitRef,
} from '../src/modules/booking/services/booking-shared';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCohort,
  createCustomer,
  createOffer,
  createPriceOption,
  createSession,
  publishProgram,
  reconcileUnit,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let f: BookingFixture;
let deps: BookingServiceDeps;
let dropInOption: string;
let freeOption: string;
let monthlyOption: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  deps = { db: testDb.db };
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  freeOption = await createPriceOption(f, { kind: 'free' });
  monthlyOption = await createPriceOption(f, { kind: 'monthly', amountFils: 20000 });
});

afterAll(async () => {
  await testDb.drop();
});

async function quoteFor(
  customer: Customer,
  unit: UnitRef,
  optionId: string,
  offerId?: string,
): Promise<string> {
  const result = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    unit,
    participantId: customer.participantId,
    ...(offerId !== undefined ? { offerId } : {}),
  });
  if (result.kind !== 'quoteIssued') throw new Error(result.kind);
  return result.quote.quoteId;
}

/** quote → claim → initiate: the paid/free rest state, ready to confirm. */
async function pendingBookingFor(
  customer: Customer,
  unit: UnitRef,
  optionId: string,
  options: { serviceDeps?: BookingServiceDeps; offerId?: string } = {},
): Promise<{ quoteId: string; holdId: string; bookingId: string }> {
  const serviceDeps = options.serviceDeps ?? deps;
  const quoteId = await quoteFor(customer, unit, optionId, options.offerId);
  const claim = await claimHold(serviceDeps, { accountId: customer.accountId }, {
    unit,
    participantId: customer.participantId,
    quoteId,
    idempotencyKey: newId(),
  });
  if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
  const holdId = claim.outcome.hold.holdId;
  const initiate = await initiateBooking(serviceDeps, { accountId: customer.accountId }, {
    holdId,
    quoteId,
    idempotencyKey: newId(),
  });
  if (initiate.outcome.kind !== 'bookingPending') throw new Error(initiate.outcome.kind);
  return { quoteId, holdId, bookingId: initiate.outcome.booking.bookingId };
}

async function holdAndBooking(holdId: string, bookingId: string) {
  const hold = await sql<{ state: string; consumed_by_booking_id: string | null }>`
    SELECT state, consumed_by_booking_id FROM capacity_hold WHERE id = ${holdId}`.execute(
    testDb.db,
  );
  const booking = await sql<{
    state: string;
    hold_id: string;
    reference_code: string | null;
    policy_template_id: string | null;
    confirmed_at: Date | null;
  }>`
    SELECT state, hold_id, reference_code, policy_template_id, confirmed_at
    FROM booking WHERE id = ${bookingId}`.execute(testDb.db);
  return { hold: hold.rows[0]!, booking: booking.rows[0]! };
}

describe('PriceQuote issuance (S5-3 quote seam)', () => {
  it('issues the immutable base-line quote: integer fils, AED, notConfigured tax, 15-minute TTL — and never reserves capacity', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
    const c = await createCustomer(testDb.db);
    const result = await requestQuote(deps, { accountId: c.accountId }, {
      programId: f.programId,
      priceOptionId: dropInOption,
      unit,
      participantId: c.participantId,
    });
    if (result.kind !== 'quoteIssued') throw new Error(result.kind);
    expect(result.quote).toMatchObject({
      totalFils: 5000,
      currency: 'AED',
      priceKind: 'oneOff',
      taxTreatment: 'notConfigured',
      optionKind: 'dropIn',
      lines: [{ lineNo: 1, kind: 'base', amountFils: 5000, labelEn: 'dropIn' }],
    });
    const ttl = await sql<{ secs: number }>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS secs
      FROM price_quote WHERE id = ${result.quote.quoteId}`.execute(testDb.db);
    expect(ttl.rows[0]!.secs).toBeCloseTo(900, 0);
    // A quote reserves NOTHING.
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(0);
    expect(rec.bookedCount).toBe(0);
    // Audit-only record; quotes are not outboxed domain state changes.
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${result.quote.quoteId}`.execute(
      testDb.db,
    );
    expect(Number(outbox.rows[0]!.n)).toBe(0);
    const audit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE entity_id = ${result.quote.quoteId} AND action = 'quote.created'`.execute(testDb.db);
    expect(Number(audit.rows[0]!.n)).toBe(1);
  });

  it('D-7 trials derive from Offers on the ordinary path: freeTrial → 0, paidTrial → its amount; discount/promo refuse application', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f) };
    const c = await createCustomer(testDb.db);
    const freeTrial = await createOffer(f, { kind: 'freeTrial' });
    const paidTrial = await createOffer(f, { kind: 'paidTrial', trialAmountFils: 1500 });
    const discount = await createOffer(f, { kind: 'discount' });

    const freeQuote = await requestQuote(deps, { accountId: c.accountId }, {
      programId: f.programId,
      priceOptionId: monthlyOption,
      unit,
      participantId: c.participantId,
      offerId: freeTrial,
    });
    if (freeQuote.kind !== 'quoteIssued') throw new Error(freeQuote.kind);
    expect(freeQuote.quote.totalFils).toBe(0);
    expect(freeQuote.quote.offerId).toBe(freeTrial);
    expect(freeQuote.quote.priceKind).toBe('cadence');

    const paidQuote = await requestQuote(deps, { accountId: c.accountId }, {
      programId: f.programId,
      priceOptionId: monthlyOption,
      unit,
      participantId: c.participantId,
      offerId: paidTrial,
    });
    if (paidQuote.kind !== 'quoteIssued') throw new Error(paidQuote.kind);
    expect(paidQuote.quote.totalFils).toBe(1500);

    const refused = await requestQuote(deps, { accountId: c.accountId }, {
      programId: f.programId,
      priceOptionId: monthlyOption,
      unit,
      participantId: c.participantId,
      offerId: discount,
    });
    expect(refused.kind).toBe('offerNotApplicable');
  });

  it('fails closed on every quote gate', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f) };
    const c = await createCustomer(testDb.db);
    const foreign = await createCustomer(testDb.db);
    const base = {
      programId: f.programId,
      priceOptionId: dropInOption,
      unit,
      participantId: c.participantId,
    };
    const actor = { accountId: c.accountId };

    expect(
      (await requestQuote(deps, actor, { ...base, programId: newId() })).kind,
    ).toBe('programNotFound');
    expect(
      (await requestQuote(deps, actor, { ...base, participantId: foreign.participantId })).kind,
    ).toBe('participantNotFound');
    expect(
      (await requestQuote(deps, actor, { ...base, priceOptionId: newId() })).kind,
    ).toBe('priceOptionNotFound');
    expect(
      (await requestQuote(deps, actor, { ...base, unit: { kind: 'session', id: newId() } })).kind,
    ).toBe('unitNotFound');
    expect(
      (await requestQuote(deps, actor, { ...base, offerId: newId() })).kind,
    ).toBe('offerNotFound');
    const ended = await createOffer(f, { kind: 'freeTrial', state: 'ended' });
    expect(
      (await requestQuote(deps, actor, { ...base, offerId: ended })).kind,
    ).toBe('offerNotApplicable');

    // An unpublished program is not bookable (separate fixture org/program).
    const draftFixture = await createBookingFixture(testDb.db);
    const draftOption = await createPriceOption(draftFixture, { kind: 'dropIn', amountFils: 100 });
    const draftUnit = { kind: 'session' as const, id: await createSession(draftFixture) };
    expect(
      (
        await requestQuote(deps, actor, {
          programId: draftFixture.programId,
          priceOptionId: draftOption,
          unit: draftUnit,
          participantId: c.participantId,
        })
      ).kind,
    ).toBe('programNotBookable');
  });
});

describe('paid initiation — the §7.4a rest state (minus PaymentIntent)', () => {
  it('creates exactly ONE pending_payment Booking on an ACTIVE hold: hold stays active, seat stays HELD, booked_count untouched', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
    const c = await createCustomer(testDb.db);
    const { holdId, bookingId, quoteId } = await pendingBookingFor(c, unit, dropInOption);

    const state = await holdAndBooking(holdId, bookingId);
    expect(state.booking.state).toBe('pending_payment');
    expect(state.booking.hold_id).toBe(holdId);
    expect(state.hold.state).toBe('active');
    expect(state.hold.consumed_by_booking_id).toBeNull();
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.bookedCount).toBe(0);

    // Idempotent replay: the same initiation again returns the SAME booking.
    const key = newId();
    const again = await initiateBooking(deps, { accountId: c.accountId }, {
      holdId,
      quoteId,
      idempotencyKey: key,
    });
    // A NEW key against the already-booked intent is a typed refusal…
    expect(again.outcome.kind).toBe('alreadyBooked');
    // …and only ONE booking row exists.
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM booking WHERE hold_id = ${holdId}`.execute(testDb.db);
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('fails closed: foreign hold, wrong quote, released hold, lapsed hold (settled truthfully as expiry)', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 3 }) };
    const c = await createCustomer(testDb.db);
    const other = await createCustomer(testDb.db);
    const quoteId = await quoteFor(c, unit, dropInOption);
    const claim = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId,
      idempotencyKey: newId(),
    });
    if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
    const holdId = claim.outcome.hold.holdId;

    expect(
      (
        await initiateBooking(deps, { accountId: other.accountId }, {
          holdId,
          quoteId,
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('holdNotFound');
    expect(
      (
        await initiateBooking(deps, { accountId: c.accountId }, {
          holdId,
          quoteId: await quoteFor(c, unit, freeOption),
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('quoteMismatch');

    await releaseHold(deps, { accountId: c.accountId }, { holdId, idempotencyKey: newId() });
    const onReleased = await initiateBooking(deps, { accountId: c.accountId }, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
    });
    expect(onReleased.outcome).toEqual({ kind: 'holdNotActive', state: 'released' });

    // A lapsed hold at initiation settles as §7.2 expiry — no booking on a
    // dead hold, capacity returned once.
    const lapsedDeps: BookingServiceDeps = { db: testDb.db, holdTtlSeconds: 0 };
    const quote2 = await quoteFor(c, unit, dropInOption);
    const lapsedClaim = await claimHold(lapsedDeps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: quote2,
      idempotencyKey: newId(),
    });
    if (lapsedClaim.outcome.kind !== 'holdClaimed') throw new Error(lapsedClaim.outcome.kind);
    const lapsedInitiate = await initiateBooking(deps, { accountId: c.accountId }, {
      holdId: lapsedClaim.outcome.hold.holdId,
      quoteId: quote2,
      idempotencyKey: newId(),
    });
    expect(lapsedInitiate.outcome.kind).toBe('holdExpired');
    const lapsedHold = await sql<{ state: string }>`
      SELECT state FROM capacity_hold
      WHERE id = ${lapsedClaim.outcome.hold.holdId}`.execute(testDb.db);
    expect(lapsedHold.rows[0]!.state).toBe('expired');
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(0);
  });
});

describe('D-8 policy fail-close (must precede EVERY confirmation mutation)', () => {
  it('with NO active template anywhere, confirmation refuses typed and changes NOTHING — then the same key confirms once a template exists', async () => {
    // Runs BEFORE any test activates a template in this database.
    const active = await sql<{ n: string }>`
      SELECT count(*) AS n FROM cancellation_policy_template WHERE state = 'active'`.execute(
      testDb.db,
    );
    expect(Number(active.rows[0]!.n)).toBe(0);

    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 1 }) };
    const c = await createCustomer(testDb.db);
    const { holdId, bookingId } = await pendingBookingFor(c, unit, freeOption);
    const key = newId();
    const refused = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: key,
    });
    expect(refused.outcome.kind).toBe('policyUnavailable');
    const state = await holdAndBooking(holdId, bookingId);
    expect(state.hold.state).toBe('active');
    expect(state.hold.consumed_by_booking_id).toBeNull();
    expect(state.booking.state).toBe('pending_payment');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.bookedCount).toBe(0);

    await createActivePolicyTemplate(testDb.db);
    // The refusal was the stored outcome for THAT key; a fresh key confirms.
    const replay = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: key,
    });
    expect(replay).toEqual({ replayed: true, outcome: { kind: 'policyUnavailable' } });
    const confirmed = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: newId(),
    });
    expect(confirmed.outcome.kind).toBe('bookingConfirmed');
  });
});

describe('§7.3 free confirmation — the atomic consumption transaction', () => {
  it('confirms a zero-price booking through FULL hold consumption: reciprocal identity, one-seat counter move, write-once facts, events', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 1 }) };
    const c = await createCustomer(testDb.db);
    const { holdId, bookingId } = await pendingBookingFor(c, unit, freeOption);
    expect((await reconcileUnit(testDb.db, unit)).state).toBe('full');

    const run = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'bookingConfirmed') throw new Error(run.outcome.kind);
    expect(run.outcome.booking.referenceCode).toMatch(/^HM-[A-Z2-9]{8}$/);
    expect(run.outcome.booking.enrolmentCreated).toBe(false);

    // Reciprocal identity, both directions, same unit.
    const state = await holdAndBooking(holdId, bookingId);
    expect(state.booking.state).toBe('confirmed');
    expect(state.booking.hold_id).toBe(holdId);
    expect(state.hold.state).toBe('consumed');
    expect(state.hold.consumed_by_booking_id).toBe(bookingId);
    expect(state.booking.reference_code).toBe(run.outcome.booking.referenceCode);
    expect(state.booking.policy_template_id).not.toBeNull();
    expect(state.booking.confirmed_at).not.toBeNull();

    // The seat MOVED (held→booked); occupied inventory constant; still full.
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(0);
    expect(rec.bookedCount).toBe(1);
    expect(rec.state).toBe('full');

    // Events: exactly one booking.confirmed outbox row; consumption audited.
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${bookingId} AND event_type = 'booking.confirmed'`.execute(testDb.db);
    expect(Number(outbox.rows[0]!.n)).toBe(1);
    const consumedAudit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE entity_id = ${holdId} AND action = 'hold.consumed'`.execute(testDb.db);
    expect(Number(consumedAudit.rows[0]!.n)).toBe(1);

    // Duplicate confirmation: a NEW key is typed; the seat never moves twice.
    const again = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: newId(),
    });
    expect(again.outcome.kind).toBe('alreadyConfirmed');
    expect((await reconcileUnit(testDb.db, unit)).bookedCount).toBe(1);
  });

  it('a PAID booking can never confirm through the free path', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f) };
    const c = await createCustomer(testDb.db);
    const { bookingId } = await pendingBookingFor(c, unit, dropInOption);
    const run = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: newId(),
    });
    expect(run.outcome.kind).toBe('notFreeQuote');
  });

  it('confirmation NEVER succeeds on a dead hold: lapsed → truthful expiry (no booked seat), released → typed refusal', async () => {
    // Lapsed: a short-TTL hold that dies between initiation and confirmation.
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
    const c = await createCustomer(testDb.db);
    const shortDeps: BookingServiceDeps = { db: testDb.db, holdTtlSeconds: 1 };
    const { holdId, bookingId } = await pendingBookingFor(c, unit, freeOption, {
      serviceDeps: shortDeps,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const run = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: newId(),
    });
    expect(run.outcome.kind).toBe('holdExpired');
    const state = await holdAndBooking(holdId, bookingId);
    expect(state.hold.state).toBe('expired');
    expect(state.booking.state).toBe('expired'); // unwound, never confirmed
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.bookedCount).toBe(0);
    expect(rec.heldCount).toBe(0);

    // Released: release unwinds the pending booking; confirmation then sees
    // a dead booking, and nothing can resurrect the hold.
    const c2 = await createCustomer(testDb.db);
    const rest2 = await pendingBookingFor(c2, unit, freeOption);
    await releaseHold(deps, { accountId: c2.accountId }, {
      holdId: rest2.holdId,
      idempotencyKey: newId(),
    });
    const run2 = await confirmFreeBooking(deps, { accountId: c2.accountId }, {
      bookingId: rest2.bookingId,
      idempotencyKey: newId(),
    });
    expect(run2.outcome).toEqual({ kind: 'invalidBookingState', state: 'expired' });
    const hold2 = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${rest2.holdId}`.execute(testDb.db);
    expect(hold2.rows[0]!.state).toBe('released');
  });

  it('idempotent replay returns the identical confirmed view without re-execution', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f) };
    const c = await createCustomer(testDb.db);
    const { bookingId } = await pendingBookingFor(c, unit, freeOption);
    const key = newId();
    const first = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: key,
    });
    if (first.outcome.kind !== 'bookingConfirmed') throw new Error(first.outcome.kind);
    const replay = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toEqual(first.outcome);
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${bookingId}`.execute(testDb.db);
    expect(Number(outbox.rows[0]!.n)).toBe(1);
  });
});

describe('the trusted paid-confirmation seam (§7.4b shape — internal only)', () => {
  it('confirms a pending PAID booking on trusted identifiers; refuses free bookings and stale versions', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f) };
    const c = await createCustomer(testDb.db);
    const { holdId, bookingId } = await pendingBookingFor(c, unit, dropInOption);

    const stale = await confirmPaidBooking(deps, {
      bookingId,
      holdId,
      idempotencyKey: newId(),
      expectedVersion: 999,
    });
    expect(stale.outcome.kind).toBe('staleVersion');

    const run = await confirmPaidBooking(deps, {
      bookingId,
      holdId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'bookingConfirmed') throw new Error(run.outcome.kind);
    const state = await holdAndBooking(holdId, bookingId);
    expect(state.hold.state).toBe('consumed');
    expect(state.hold.consumed_by_booking_id).toBe(bookingId);
    expect(state.booking.state).toBe('confirmed');
    // The confirmation was audited as SYSTEM (payments saga), not a customer.
    const audit = await sql<{ actor_type: string }>`
      SELECT actor_type FROM audit_event
      WHERE entity_id = ${bookingId} AND action = 'booking.confirmed'`.execute(testDb.db);
    expect(audit.rows[0]!.actor_type).toBe('system');

    // Free bookings have no payment to confirm — §7.3 owns them.
    const cFree = await createCustomer(testDb.db);
    const rest = await pendingBookingFor(cFree, unit, freeOption);
    const refused = await confirmPaidBooking(deps, {
      bookingId: rest.bookingId,
      holdId: rest.holdId,
      idempotencyKey: newId(),
    });
    expect(refused.outcome.kind).toBe('notPaidQuote');
  });

  it('ADVERSARIAL reciprocal identity: Booking B can never consume Hold A — and consumption always pairs both directions on one unit', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
    const a = await createCustomer(testDb.db);
    const b = await createCustomer(testDb.db);
    const restA = await pendingBookingFor(a, unit, dropInOption);
    const restB = await pendingBookingFor(b, unit, dropInOption);

    // Booking B + Hold A: both rows exist and are live — refused anyway.
    const crossed = await confirmPaidBooking(deps, {
      bookingId: restB.bookingId,
      holdId: restA.holdId,
      idempotencyKey: newId(),
    });
    expect(crossed.outcome.kind).toBe('reciprocalMismatch');
    // Nothing moved for either party.
    const stateA = await holdAndBooking(restA.holdId, restA.bookingId);
    const stateB = await holdAndBooking(restB.holdId, restB.bookingId);
    expect(stateA.hold.state).toBe('active');
    expect(stateB.hold.state).toBe('active');
    expect(stateA.booking.state).toBe('pending_payment');
    expect(stateB.booking.state).toBe('pending_payment');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(2);
    expect(rec.bookedCount).toBe(0);

    // Legitimate confirmations pair reciprocally, per party, same unit.
    for (const rest of [restA, restB]) {
      const run = await confirmPaidBooking(deps, {
        bookingId: rest.bookingId,
        holdId: rest.holdId,
        idempotencyKey: newId(),
      });
      expect(run.outcome.kind).toBe('bookingConfirmed');
    }
    const pairing = await sql<{ ok: boolean }>`
      SELECT bool_and(b.hold_id = h.id AND h.consumed_by_booking_id = b.id
                      AND b.session_id = h.session_id) AS ok
      FROM booking b JOIN capacity_hold h ON h.id = b.hold_id
      WHERE b.id = ANY(${[restA.bookingId, restB.bookingId]})`.execute(testDb.db);
    expect(pairing.rows[0]!.ok).toBe(true);
    const after = await reconcileUnit(testDb.db, unit);
    expect(after.heldCount).toBe(0);
    expect(after.bookedCount).toBe(2);
  });
});

describe('D-4 Enrolment — cohort participation, atomic with confirmation', () => {
  it('a cohort monthly booking (free trial via D-7) confirms with its Enrolment row; one participant per cohort at launch; no billing semantics', async () => {
    const cohortId = await createCohort(f, 3);
    const unit = { kind: 'enrolmentCohort' as const, id: cohortId };
    const c = await createCustomer(testDb.db);
    const freeTrial = await createOffer(f, { kind: 'freeTrial' });
    const { holdId, bookingId } = await pendingBookingFor(c, unit, monthlyOption, {
      offerId: freeTrial,
    });
    const run = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: newId(),
    });
    if (run.outcome.kind !== 'bookingConfirmed') throw new Error(run.outcome.kind);
    expect(run.outcome.booking.enrolmentCreated).toBe(true);

    const enrolment = await sql<{ cadence: string; cohort_id: string; renewal_policy: string | null }>`
      SELECT cadence, cohort_id, renewal_policy FROM enrolment
      WHERE booking_id = ${bookingId}`.execute(testDb.db);
    expect(enrolment.rows[0]).toEqual({
      cadence: 'monthly',
      cohort_id: cohortId,
      renewal_policy: null, // D-4: participation only — no billing semantics
    });
    const state = await holdAndBooking(holdId, bookingId);
    expect(state.hold.state).toBe('consumed');

    // One participant per cohort enrolment at launch: a fresh trial intent
    // for the SAME participant is refused before any new capacity claim.
    const secondQuote = await quoteFor(c, unit, monthlyOption, freeTrial);
    const secondClaim = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: secondQuote,
      idempotencyKey: newId(),
    });
    expect(secondClaim.outcome.kind).toBe('alreadyBooked');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.bookedCount).toBe(1);
    expect(rec.heldCount).toBe(0);
  });
});

describe('deterministic failure injection (§18): every sabotage leaves the pre-operation state intact', () => {
  it.each([
    'holdLocked',
    'holdConsumed',
    'counterMoved',
    'bookingConfirmed',
    'enrolmentInserted',
    'beforeCommit',
  ] as const)('confirmation sabotaged at %s → hold active, counters unmoved, booking pending, no enrolment, no events, key reusable', async (phase) => {
    const cohortId = await createCohort(f, 2);
    const unit = { kind: 'enrolmentCohort' as const, id: cohortId };
    const c = await createCustomer(testDb.db);
    const freeTrial = await createOffer(f, { kind: 'freeTrial' });
    const { holdId, bookingId } = await pendingBookingFor(c, unit, monthlyOption, {
      offerId: freeTrial,
    });
    const key = newId();
    const sabotaged: BookingServiceDeps = {
      db: testDb.db,
      onConfirmPhase: (p) => {
        if (p === phase) throw new Error(`sabotage:${phase}`);
      },
    };
    await expect(
      confirmFreeBooking(sabotaged, { accountId: c.accountId }, {
        bookingId,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(`sabotage:${phase}`);

    const state = await holdAndBooking(holdId, bookingId);
    expect(state.hold.state).toBe('active');
    expect(state.hold.consumed_by_booking_id).toBeNull();
    expect(state.booking.state).toBe('pending_payment');
    expect(state.booking.reference_code).toBeNull();
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.bookedCount).toBe(0);
    const enrolment = await sql<{ n: string }>`
      SELECT count(*) AS n FROM enrolment WHERE booking_id = ${bookingId}`.execute(testDb.db);
    expect(Number(enrolment.rows[0]!.n)).toBe(0);
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${bookingId}`.execute(testDb.db);
    expect(Number(outbox.rows[0]!.n)).toBe(0);
    const keys = await sql<{ n: string }>`
      SELECT count(*) AS n FROM idempotency_key WHERE idempotency_key = ${key}`.execute(testDb.db);
    expect(Number(keys.rows[0]!.n)).toBe(0);

    // The key was not poisoned; the same key completes the confirmation.
    const retry = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      bookingId,
      idempotencyKey: key,
    });
    expect(retry).toMatchObject({ replayed: false, outcome: { kind: 'bookingConfirmed' } });
  });
});
