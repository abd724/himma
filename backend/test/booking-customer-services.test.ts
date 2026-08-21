/**
 * W4 Slice 5 · S5-5 — customer booking services on real PostgreSQL
 * (docs/32 §12; docs/24 §2.5, §3.2–3.3; rulings D-6…D-10). Proven here:
 * the deferred participant age-eligibility engine, the FULL D-10 freeTrial
 * redemption matrix (advisory prechecks + the transactional authority,
 * incl. the two-Sessions-one-Program race), the derived availability
 * projection (no counters on the wire), hold status truthfulness, the
 * fail-closed paid boundary, and cross-account fail-closure. HTTP
 * contracts live in booking-customer-routes.test.ts.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import type {
  BookingServiceDeps,
  UnitRef,
} from '../src/modules/booking/services/booking-shared';
import { confirmFreeBooking } from '../src/modules/booking/services/booking-lifecycle';
import {
  getBooking,
  holdStatus,
  listAvailability,
  paidCheckoutBoundary,
} from '../src/modules/booking/services/customer-booking-read';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { releaseHold } from '../src/modules/booking/services/hold-lifecycle';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCustomer,
  createOffer,
  createPriceOption,
  createSession,
  publishProgram,
  reconcileUnit,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createRacePool, type RacePool } from './helpers/race-harness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
let f: BookingFixture;
let racePool: RacePool;
let deps: BookingServiceDeps;
let monthlyOption: string;
let freeOption: string;
let dropInOption: string;
let freeTrialOffer: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  racePool = await createRacePool(testDb.config, 12);
  deps = { db: racePool.db };
  monthlyOption = await createPriceOption(f, { kind: 'monthly', amountFils: 20000 });
  freeOption = await createPriceOption(f, { kind: 'free' });
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  freeTrialOffer = await createOffer(f, { kind: 'freeTrial' });
});

afterAll(async () => {
  await racePool.destroy();
  await testDb.drop();
});

async function createChild(accountId: string, dateOfBirth: string | null): Promise<string> {
  const id = newId();
  await sql`INSERT INTO participant (id, account_id, kind, first_name, date_of_birth)
            VALUES (${id}, ${accountId}, 'child', 'Child', ${dateOfBirth})`.execute(testDb.db);
  return id;
}

async function quoteFor(
  customer: { accountId: string },
  participantId: string,
  unit: UnitRef,
  optionId: string,
  offerId?: string,
) {
  return requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    unit,
    participantId,
    ...(offerId !== undefined ? { offerId } : {}),
  });
}

async function claimFor(
  customer: { accountId: string },
  participantId: string,
  unit: UnitRef,
  quoteId: string,
): Promise<string> {
  const run = await claimHold(deps, { accountId: customer.accountId }, {
    unit,
    participantId,
    quoteId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'holdClaimed') throw new Error(run.outcome.kind);
  return run.outcome.hold.holdId;
}

async function redemptionCount(participantId: string): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM trial_redemption
    WHERE participant_id = ${participantId}`.execute(testDb.db);
  return Number(rows.rows[0]!.n);
}

describe('participant eligibility (docs/24 §2.5 — the S5-3-deferred engine)', () => {
  beforeAll(async () => {
    await sql`UPDATE program SET min_age = 6, max_age = 10, all_ages = false
              WHERE id = ${f.programId}`.execute(testDb.db);
  });
  afterAll(async () => {
    await sql`UPDATE program SET min_age = NULL, max_age = NULL, all_ages = true
              WHERE id = ${f.programId}`.execute(testDb.db);
  });

  it('child suitability is PURELY age-based against the unit start date; adults are never filtered; overrides inherit per session (null = inherit)', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f) }; // starts 2026-09-01
    const c = await createCustomer(testDb.db);
    const eligible = await createChild(c.accountId, '2018-06-01'); // 8y at start
    const tooYoung = await createChild(c.accountId, '2023-06-01'); // 3y
    const tooOld = await createChild(c.accountId, '2014-06-01'); // 12y
    const noDob = await createChild(c.accountId, null);

    expect((await quoteFor(c, eligible, unit, freeOption)).kind).toBe('quoteIssued');
    expect((await quoteFor(c, tooYoung, unit, freeOption)).kind).toBe('participantIneligible');
    expect((await quoteFor(c, tooOld, unit, freeOption)).kind).toBe('participantIneligible');
    // No DOB on a child in an age-bounded program fails CLOSED.
    expect((await quoteFor(c, noDob, unit, freeOption)).kind).toBe('participantIneligible');
    // The adult self participant is never age/gender-filtered (docs/24 §2.5.2).
    expect((await quoteFor(c, c.participantId, unit, freeOption)).kind).toBe('quoteIssued');

    // A session override widens eligibility for THAT session only.
    const allAgesSession = {
      kind: 'session' as const,
      id: await createSession(f, { override_all_ages: true }),
    };
    expect((await quoteFor(c, tooYoung, allAgesSession, freeOption)).kind).toBe('quoteIssued');
    // Age boundary: exactly the minimum age is eligible.
    const exactlySix = await createChild(c.accountId, '2020-09-01'); // 6y on the dot
    expect((await quoteFor(c, exactlySix, unit, freeOption)).kind).toBe('quoteIssued');
  });
});

describe('D-10 — one confirmed freeTrial per participant per Program, lifetime', () => {
  it('the full entitlement matrix: first confirms; second Session refused by the AUTHORITY; siblings and other Programs independent; Offer replacement never resets; dead attempts never consume; replay consumes once', async () => {
    const sessionA = { kind: 'session' as const, id: await createSession(f, { capacity: 5 }) };
    const sessionB = { kind: 'session' as const, id: await createSession(f, { capacity: 5 }) };
    const c = await createCustomer(testDb.db);

    // Pre-create BOTH quotes+holds while unredeemed (so the confirm-time
    // AUTHORITY — not the quote precheck — decides session B).
    const quoteA = await quoteFor(c, c.participantId, sessionA, monthlyOption, freeTrialOffer);
    const quoteB = await quoteFor(c, c.participantId, sessionB, monthlyOption, freeTrialOffer);
    if (quoteA.kind !== 'quoteIssued' || quoteB.kind !== 'quoteIssued') throw new Error('quote');
    expect(quoteA.quote.totalFils).toBe(0);
    const holdA = await claimFor(c, c.participantId, sessionA, quoteA.quote.quoteId);
    const holdB = await claimFor(c, c.participantId, sessionB, quoteB.quote.quoteId);

    // (1) First eligible trial confirms and consumes the entitlement.
    const first = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId: holdA,
      idempotencyKey: newId(),
    });
    if (first.outcome.kind !== 'bookingConfirmed') throw new Error(first.outcome.kind);
    expect(await redemptionCount(c.participantId)).toBe(1);
    const redemption = await sql<{ booking_id: string; offer_id: string; program_id: string }>`
      SELECT booking_id, offer_id, program_id FROM trial_redemption
      WHERE participant_id = ${c.participantId}`.execute(testDb.db);
    expect(redemption.rows[0]).toEqual({
      booking_id: first.outcome.booking.bookingId,
      offer_id: freeTrialOffer,
      program_id: f.programId,
    });

    // (2) Same participant, ANOTHER Session of the same Program → refused
    // by the confirmation authority; the hold survives untouched.
    const second = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId: holdB,
      idempotencyKey: newId(),
    });
    expect(second.outcome.kind).toBe('trialAlreadyRedeemed');
    const holdBState = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${holdB}`.execute(testDb.db);
    expect(holdBState.rows[0]!.state).toBe('active');
    expect(await redemptionCount(c.participantId)).toBe(1);
    // Quote-time precheck now also refuses new trial intents.
    expect(
      (await quoteFor(c, c.participantId, sessionB, monthlyOption, freeTrialOffer)).kind,
    ).toBe('trialAlreadyRedeemed');

    // (3) A sibling participant on the SAME account holds its own entitlement.
    const sibling = await createChild(c.accountId, '2016-01-01');
    const siblingQuote = await quoteFor(c, sibling, sessionA, monthlyOption, freeTrialOffer);
    if (siblingQuote.kind !== 'quoteIssued') throw new Error(siblingQuote.kind);
    const siblingHold = await claimFor(c, sibling, sessionA, siblingQuote.quote.quoteId);
    const siblingRun = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId: siblingHold,
      idempotencyKey: newId(),
    });
    expect(siblingRun.outcome.kind).toBe('bookingConfirmed');
    expect(await redemptionCount(sibling)).toBe(1);

    // (4) The SAME participant may trial a DIFFERENT Program.
    const otherFixture = await createBookingFixture(testDb.db);
    await publishProgram(otherFixture);
    const otherOption = await createPriceOption(otherFixture, { kind: 'monthly', amountFils: 9000 });
    const otherTrial = await createOffer(otherFixture, { kind: 'freeTrial' });
    const otherSession = { kind: 'session' as const, id: await createSession(otherFixture) };
    const otherQuote = await requestQuote(deps, { accountId: c.accountId }, {
      programId: otherFixture.programId,
      priceOptionId: otherOption,
      unit: otherSession,
      participantId: c.participantId,
      offerId: otherTrial,
    });
    if (otherQuote.kind !== 'quoteIssued') throw new Error(otherQuote.kind);
    const otherHold = await claimFor(c, c.participantId, otherSession, otherQuote.quote.quoteId);
    const otherRun = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId: otherHold,
      idempotencyKey: newId(),
    });
    expect(otherRun.outcome.kind).toBe('bookingConfirmed');
    expect(await redemptionCount(c.participantId)).toBe(2); // one per Program

    // (5) Replacing the Offer never resets the entitlement.
    await sql`UPDATE offer SET state = 'ended' WHERE id = ${freeTrialOffer}`.execute(testDb.db);
    const replacementOffer = await createOffer(f, { kind: 'freeTrial' });
    expect(
      (await quoteFor(c, c.participantId, sessionB, monthlyOption, replacementOffer)).kind,
    ).toBe('trialAlreadyRedeemed');
  });

  it('dead attempts never consume: failed confirmation rolls the redemption back; an expired hold consumes nothing; a replayed key consumes once', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 5 }) };
    const trialOffer = await createOffer(f, { kind: 'freeTrial' });
    const c = await createCustomer(testDb.db);
    const quote = await quoteFor(c, c.participantId, unit, monthlyOption, trialOffer);
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);

    // Expired hold: nothing consumed (quote/hold/pending never consume).
    const lapsedDeps: BookingServiceDeps = { db: racePool.db, holdTtlSeconds: 0 };
    const lapsedClaim = await claimHold(lapsedDeps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: quote.quote.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsedClaim.outcome.kind !== 'holdClaimed') throw new Error(lapsedClaim.outcome.kind);
    const lapsedRun = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId: lapsedClaim.outcome.hold.holdId,
      idempotencyKey: newId(),
    });
    expect(lapsedRun.outcome.kind).toBe('holdExpired');
    expect(await redemptionCount(c.participantId)).toBe(0);

    // Failed (sabotaged) confirmation: full rollback including the
    // redemption row; the key is not poisoned.
    const holdId = await claimFor(c, c.participantId, unit, quote.quote.quoteId);
    const key = newId();
    const sabotaged: BookingServiceDeps = {
      db: racePool.db,
      onConfirmPhase: (phase) => {
        if (phase === 'beforeCommit') throw new Error('sabotage:trial');
      },
    };
    await expect(
      confirmFreeBooking(sabotaged, { accountId: c.accountId }, {
        holdId,
        idempotencyKey: key,
      }),
    ).rejects.toThrow('sabotage:trial');
    expect(await redemptionCount(c.participantId)).toBe(0);

    // The SAME key then confirms once; a replay returns the stored view
    // and consumes nothing further.
    const confirmed = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId,
      idempotencyKey: key,
    });
    if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
    const replay = await confirmFreeBooking(deps, { accountId: c.accountId }, {
      holdId,
      idempotencyKey: key,
    });
    expect(replay).toEqual({ replayed: true, outcome: confirmed.outcome });
    expect(await redemptionCount(c.participantId)).toBe(1);
  });

  it('RACE: two simultaneous free-trial confirmations on two different Sessions of one Program → exactly ONE redemption, loser fully rolled back', async () => {
    const sessionA = { kind: 'session' as const, id: await createSession(f, { capacity: 3 }) };
    const sessionB = { kind: 'session' as const, id: await createSession(f, { capacity: 3 }) };
    const trialOffer = await createOffer(f, { kind: 'freeTrial' });
    const c = await createCustomer(testDb.db);
    const quoteA = await quoteFor(c, c.participantId, sessionA, monthlyOption, trialOffer);
    const quoteB = await quoteFor(c, c.participantId, sessionB, monthlyOption, trialOffer);
    if (quoteA.kind !== 'quoteIssued' || quoteB.kind !== 'quoteIssued') throw new Error('quote');
    const holdA = await claimFor(c, c.participantId, sessionA, quoteA.quote.quoteId);
    const holdB = await claimFor(c, c.participantId, sessionB, quoteB.quote.quoteId);

    const [runA, runB] = await Promise.all([
      confirmFreeBooking(deps, { accountId: c.accountId }, {
        holdId: holdA,
        idempotencyKey: newId(),
      }),
      confirmFreeBooking(deps, { accountId: c.accountId }, {
        holdId: holdB,
        idempotencyKey: newId(),
      }),
    ]);
    const kinds = [runA.outcome.kind, runB.outcome.kind].sort();
    expect(kinds).toEqual(['bookingConfirmed', 'trialAlreadyRedeemed']);
    expect(await redemptionCount(c.participantId)).toBe(1);

    // The loser's ENTIRE transaction rolled back: hold active, unit clean.
    const loserHold = runA.outcome.kind === 'bookingConfirmed' ? holdB : holdA;
    const loserUnit = runA.outcome.kind === 'bookingConfirmed' ? sessionB : sessionA;
    const winnerUnit = runA.outcome.kind === 'bookingConfirmed' ? sessionA : sessionB;
    const loserHoldRow = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${loserHold}`.execute(testDb.db);
    expect(loserHoldRow.rows[0]!.state).toBe('active');
    const loserRec = await reconcileUnit(testDb.db, loserUnit);
    expect(loserRec.bookedCount).toBe(0);
    expect(loserRec.heldCount).toBe(1);
    const winnerRec = await reconcileUnit(testDb.db, winnerUnit);
    expect(winnerRec.bookedCount).toBe(1);
    expect(winnerRec.heldCount).toBe(0);
  });
});

describe('availability projection + hold status (derived truth, no counters)', () => {
  it('derives available/fewLeft/full/closed without exposing counters; provider close does not destroy a valid active hold', async () => {
    const open = await createSession(f, { capacity: 10 });
    const few = await createSession(f, { capacity: 2 });
    const fullUnit = { kind: 'session' as const, id: await createSession(f, { capacity: 1 }) };
    const closed = await createSession(f, { capacity: 5 });
    const scheduled = await createSession(f, { state: 'scheduled' });
    const pastCutoff = await createSession(f, {
      registration_cutoff_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    // Occupy the full unit through the real claim path.
    const c = await createCustomer(testDb.db);
    const q = await quoteFor(c, c.participantId, fullUnit, dropInOption);
    if (q.kind !== 'quoteIssued') throw new Error(q.kind);
    const heldHold = await claimFor(c, c.participantId, fullUnit, q.quote.quoteId);
    await sql`UPDATE session SET state = 'closed' WHERE id = ${closed}`.execute(testDb.db);

    const result = await listAvailability(deps, { programId: f.programId, unitKind: 'session' });
    if (result.kind !== 'availability') throw new Error(result.kind);
    const byId = new Map(result.units.map((unit) => [unit.unitId, unit]));
    expect(byId.get(open)!.availability).toBe('available');
    expect(byId.get(open)!.spotsLeft).toBeUndefined();
    expect(byId.get(few)!.availability).toBe('fewLeft');
    expect(byId.get(few)!.spotsLeft).toBe(2);
    expect(byId.get(fullUnit.id)!.availability).toBe('full');
    expect(byId.get(closed)!.availability).toBe('closed');
    expect(byId.get(scheduled)!.availability).toBe('closed');
    expect(byId.get(pastCutoff)!.availability).toBe('closed');
    // The wire projection NEVER carries counters or version mechanics.
    for (const unit of result.units) {
      expect(Object.keys(unit)).not.toEqual(
        expect.arrayContaining(['heldCount', 'bookedCount', 'held_count', 'booked_count', 'version']),
      );
    }

    // Provider registration close does not silently destroy a valid hold:
    // the certified semantics survive at the customer read.
    await sql`UPDATE session SET state = 'closed' WHERE id = ${fullUnit.id}`.execute(testDb.db);
    const status = await holdStatus(deps, { accountId: c.accountId }, { holdId: heldHold });
    if (status.kind !== 'holdStatus') throw new Error(status.kind);
    expect(status.hold.state).toBe('active');
    const rec = await reconcileUnit(testDb.db, fullUnit);
    expect(rec.heldCount).toBe(1);

    // A lapsed-but-unsettled hold reports the TRUTHFUL effective state.
    const lapsedDeps: BookingServiceDeps = { db: racePool.db, holdTtlSeconds: 0 };
    const q2 = await quoteFor(c, c.participantId, { kind: 'session', id: open }, dropInOption);
    if (q2.kind !== 'quoteIssued') throw new Error(q2.kind);
    const lapsedClaim = await claimHold(lapsedDeps, { accountId: c.accountId }, {
      unit: { kind: 'session', id: open },
      participantId: c.participantId,
      quoteId: q2.quote.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsedClaim.outcome.kind !== 'holdClaimed') throw new Error(lapsedClaim.outcome.kind);
    const lapsedStatus = await holdStatus(deps, { accountId: c.accountId }, {
      holdId: lapsedClaim.outcome.hold.holdId,
    });
    if (lapsedStatus.kind !== 'holdStatus') throw new Error(lapsedStatus.kind);
    expect(lapsedStatus.hold.state).toBe('expired');
  });
});

describe('paid fail-closed boundary + cross-account fail-closure', () => {
  it('a nonzero intent refuses paymentUnavailable BEFORE any Booking exists; a zero intent is redirected typed; nothing rests in pending_payment', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 3 }) };
    const c = await createCustomer(testDb.db);
    const paidQuote = await quoteFor(c, c.participantId, unit, dropInOption);
    if (paidQuote.kind !== 'quoteIssued') throw new Error(paidQuote.kind);
    const paidHold = await claimFor(c, c.participantId, unit, paidQuote.quote.quoteId);

    const refused = await paidCheckoutBoundary(deps, { accountId: c.accountId }, {
      holdId: paidHold,
      quoteId: paidQuote.quote.quoteId,
    });
    expect(refused.kind).toBe('paymentUnavailable');
    const bookings = await sql<{ n: string }>`
      SELECT count(*) AS n FROM booking WHERE hold_id = ${paidHold}`.execute(testDb.db);
    expect(Number(bookings.rows[0]!.n)).toBe(0); // no dead-end pending rest
    // The hold survives (its TTL is the honest backstop).
    const hold = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${paidHold}`.execute(testDb.db);
    expect(hold.rows[0]!.state).toBe('active');

    const other = await createCustomer(testDb.db);
    const freeQuote = await quoteFor(other, other.participantId, unit, freeOption);
    if (freeQuote.kind !== 'quoteIssued') throw new Error(freeQuote.kind);
    const freeHold = await claimFor(other, other.participantId, unit, freeQuote.quote.quoteId);
    expect(
      (
        await paidCheckoutBoundary(deps, { accountId: other.accountId }, {
          holdId: freeHold,
          quoteId: freeQuote.quote.quoteId,
        })
      ).kind,
    ).toBe('paymentNotRequired');
  });

  it('cross-account holds/bookings/participants stay fail-closed and not-found-shaped', async () => {
    const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 3 }) };
    const owner = await createCustomer(testDb.db);
    const stranger = await createCustomer(testDb.db);
    const quote = await quoteFor(owner, owner.participantId, unit, freeOption);
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const holdId = await claimFor(owner, owner.participantId, unit, quote.quote.quoteId);

    // Foreign participant on a quote request → not-found-shaped.
    expect((await quoteFor(stranger, owner.participantId, unit, freeOption)).kind).toBe(
      'participantNotFound',
    );
    // Foreign hold: status, release, and free confirmation all fail closed.
    expect(
      (await holdStatus(deps, { accountId: stranger.accountId }, { holdId })).kind,
    ).toBe('holdNotFound');
    expect(
      (
        await releaseHold(deps, { accountId: stranger.accountId }, {
          holdId,
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('holdNotFound');
    expect(
      (
        await confirmFreeBooking(deps, { accountId: stranger.accountId }, {
          holdId,
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('holdNotFound');

    // Foreign booking read is not-found-shaped.
    const confirmed = await confirmFreeBooking(deps, { accountId: owner.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
    expect(
      (
        await getBooking(deps, { accountId: stranger.accountId }, {
          bookingId: confirmed.outcome.booking.bookingId,
        })
      ).kind,
    ).toBe('bookingNotFound');
  });
});
