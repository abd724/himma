/**
 * W4 Slice 5 · S5-3 — booking/confirmation races (docs/32 §15 tests 3–5,
 * 8–9; owner instruction §17). Genuinely concurrent PostgreSQL transactions
 * on the S5-2 multi-connection harness; assertions are on INVARIANTS
 * (states, counters, reconciliation), never on which contender wins.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
  confirmFreeBooking,
  confirmPaidBooking,
  initiateBooking,
} from '../src/modules/booking/services/booking-lifecycle';
import type { BookingServiceDeps } from '../src/modules/booking/services/booking-shared';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { expireHold, releaseHold } from '../src/modules/booking/services/hold-lifecycle';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCustomer,
  createPriceOption,
  createSession,
  publishProgram,
  reconcileUnit,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createRacePool, race, type RacePool } from './helpers/race-harness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
let f: BookingFixture;
let racePool: RacePool;
let deps: BookingServiceDeps;
let dropInOption: string;
let freeOption: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  racePool = await createRacePool(testDb.config, 24);
  deps = { db: racePool.db };
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  freeOption = await createPriceOption(f, { kind: 'free' });
});

afterAll(async () => {
  await racePool.destroy();
  await testDb.drop();
});

interface Rest {
  customer: Customer;
  quoteId: string;
  holdId: string;
  bookingId: string;
}

async function restFor(
  unit: { kind: 'session'; id: string },
  optionId: string,
  serviceDeps: BookingServiceDeps = deps,
): Promise<Rest> {
  const customer = await createCustomer(testDb.db);
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    unit,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const claim = await claimHold(serviceDeps, { accountId: customer.accountId }, {
    unit,
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
  const initiate = await initiateBooking(serviceDeps, { accountId: customer.accountId }, {
    holdId: claim.outcome.hold.holdId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (initiate.outcome.kind !== 'bookingPending') throw new Error(initiate.outcome.kind);
  return {
    customer,
    quoteId: quote.quote.quoteId,
    holdId: claim.outcome.hold.holdId,
    bookingId: initiate.outcome.booking.bookingId,
  };
}

interface FreeRest {
  customer: Customer;
  quoteId: string;
  holdId: string;
}

/** quote → claim only: zero-total intents confirm directly through §7.3. */
async function freeHoldFor(
  unit: { kind: 'session'; id: string },
  serviceDeps: BookingServiceDeps = deps,
): Promise<FreeRest> {
  const customer = await createCustomer(testDb.db);
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freeOption,
    unit,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const claim = await claimHold(serviceDeps, { accountId: customer.accountId }, {
    unit,
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
  return { customer, quoteId: quote.quote.quoteId, holdId: claim.outcome.hold.holdId };
}

async function holdJointState(holdId: string) {
  const rows = await sql<{
    hold_state: string;
    consumed_by: string | null;
    booking_state: string | null;
    booking_count: string;
  }>`
    SELECT h.state AS hold_state, h.consumed_by_booking_id AS consumed_by,
           (SELECT b.state FROM booking b WHERE b.hold_id = h.id LIMIT 1) AS booking_state,
           (SELECT count(*) FROM booking b WHERE b.hold_id = h.id) AS booking_count
    FROM capacity_hold h WHERE h.id = ${holdId}`.execute(testDb.db);
  const row = rows.rows[0]!;
  return { ...row, booking_count: Number(row.booking_count) };
}

async function jointState(rest: Rest) {
  const rows = await sql<{ booking_state: string; hold_state: string; consumed_by: string | null }>`
    SELECT b.state AS booking_state, h.state AS hold_state,
           h.consumed_by_booking_id AS consumed_by
    FROM booking b JOIN capacity_hold h ON h.id = b.hold_id
    WHERE b.id = ${rest.bookingId}`.execute(testDb.db);
  return rows.rows[0]!;
}

it('the same free intent confirmed twice CONCURRENTLY → exactly one Booking/confirmation, one counter move, one event set', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
  const rest = await freeHoldFor(unit);
  const runs = await race([
    () =>
      confirmFreeBooking(deps, { accountId: rest.customer.accountId }, {
        holdId: rest.holdId,
        idempotencyKey: newId(),
      }),
    () =>
      confirmFreeBooking(deps, { accountId: rest.customer.accountId }, {
        holdId: rest.holdId,
        idempotencyKey: newId(),
      }),
  ]);
  const kinds = runs.map((run) => run.outcome.kind).sort();
  expect(kinds).toEqual(['alreadyConfirmed', 'bookingConfirmed']);
  const state = await holdJointState(rest.holdId);
  expect(state.hold_state).toBe('consumed');
  expect(state.booking_count).toBe(1);
  expect(state.booking_state).toBe('confirmed');
  const rec = await reconcileUnit(testDb.db, unit);
  expect(rec.bookedCount).toBe(1);
  expect(rec.heldCount).toBe(0);
  const outbox = await sql<{ n: string }>`
    SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${state.consumed_by!}`.execute(
    testDb.db,
  );
  expect(Number(outbox.rows[0]!.n)).toBe(1);
});

it('confirmation racing hold EXPIRY at the TTL boundary → confirmed XOR expired; a booking never confirms on a dead hold', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 1 }) };
  const shortDeps: BookingServiceDeps = { db: racePool.db, holdTtlSeconds: 1 };
  const rest = await freeHoldFor(unit, shortDeps);
  // Land the race window right at expires_at.
  await new Promise((resolve) => setTimeout(resolve, 950));
  const [confirmRun, expiry] = await Promise.all([
    confirmFreeBooking(deps, { accountId: rest.customer.accountId }, {
      holdId: rest.holdId,
      idempotencyKey: newId(),
    }),
    expireHold(deps, { holdId: rest.holdId }),
  ]);

  const state = await holdJointState(rest.holdId);
  const rec = await reconcileUnit(testDb.db, unit);
  if (state.hold_state === 'consumed') {
    // Confirmation won while the hold was still valid.
    expect(confirmRun.outcome.kind).toBe('bookingConfirmed');
    expect(state.booking_count).toBe(1);
    expect(state.booking_state).toBe('confirmed');
    expect(rec.bookedCount).toBe(1);
    expect(rec.heldCount).toBe(0);
    expect(['notLapsed', 'alreadyTerminal']).toContain(expiry.kind);
  } else {
    // Expiry won: NO booking exists and the seat NEVER reached booked_count.
    expect(state.hold_state).toBe('expired');
    expect(state.consumed_by).toBeNull();
    expect(state.booking_count).toBe(0);
    expect(rec.bookedCount).toBe(0);
    expect(rec.heldCount).toBe(0);
    expect(['holdExpired', 'holdNotActive', 'alreadyConfirmed']).toContain(
      confirmRun.outcome.kind,
    );
  }
  expect(rec.heldCount).toBe(rec.activeHolds);
});

it('confirmation racing customer RELEASE → exactly one truthful winner, coherent joint state either way', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 1 }) };
  const rest = await freeHoldFor(unit);
  const [confirmRun, releaseRun] = await Promise.all([
    confirmFreeBooking(deps, { accountId: rest.customer.accountId }, {
      holdId: rest.holdId,
      idempotencyKey: newId(),
    }),
    releaseHold(deps, { accountId: rest.customer.accountId }, {
      holdId: rest.holdId,
      idempotencyKey: newId(),
    }),
  ]);
  const state = await holdJointState(rest.holdId);
  const rec = await reconcileUnit(testDb.db, unit);
  if (state.hold_state === 'consumed') {
    expect(confirmRun.outcome.kind).toBe('bookingConfirmed');
    expect(state.booking_count).toBe(1);
    expect(state.booking_state).toBe('confirmed');
    expect(releaseRun.outcome.kind).toBe('alreadyConsumed');
    expect(rec.bookedCount).toBe(1);
    expect(rec.heldCount).toBe(0);
  } else {
    expect(state.hold_state).toBe('released');
    expect(state.booking_count).toBe(0); // no booking was ever created
    expect(releaseRun.outcome.kind).toBe('holdReleased');
    expect(confirmRun.outcome).toEqual({ kind: 'holdNotActive', state: 'released' });
    expect(rec.bookedCount).toBe(0);
    expect(rec.heldCount).toBe(0);
  }
});

it('free confirmation racing a rival CLAIM for the final seat → occupied inventory constant, zero oversell', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 1 }) };
  const rest = await freeHoldFor(unit);
  const rival = await createCustomer(testDb.db);
  const rivalQuote = await requestQuote(deps, { accountId: rival.accountId }, {
    programId: f.programId,
    priceOptionId: freeOption,
    unit,
    participantId: rival.participantId,
  });
  if (rivalQuote.kind !== 'quoteIssued') throw new Error(rivalQuote.kind);

  const [confirmRun, rivalClaim] = await Promise.all([
    confirmFreeBooking(deps, { accountId: rest.customer.accountId }, {
      holdId: rest.holdId,
      idempotencyKey: newId(),
    }),
    claimHold(deps, { accountId: rival.accountId }, {
      unit,
      participantId: rival.participantId,
      quoteId: rivalQuote.quote.quoteId,
      idempotencyKey: newId(),
    }),
  ]);
  // The seat was occupied (held OR booked) the whole time: the rival can
  // never win it, and confirmation moves it without freeing anything.
  expect(confirmRun.outcome.kind).toBe('bookingConfirmed');
  expect(rivalClaim.outcome.kind).toBe('sessionFull');
  const rec = await reconcileUnit(testDb.db, unit);
  expect(rec.bookedCount).toBe(1);
  expect(rec.heldCount).toBe(0);
  expect(rec.bookedCount + rec.heldCount).toBeLessThanOrEqual(rec.capacity);
});

it('duplicate INITIATION storm (one key × 10) → exactly one Booking row, nine replays', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
  const customer = await createCustomer(testDb.db);
  const quote = await requestQuote(deps, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: dropInOption,
    unit,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const claim = await claimHold(deps, { accountId: customer.accountId }, {
    unit,
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
  const key = newId();
  const runs = await race(
    Array.from({ length: 10 }, () => () =>
      initiateBooking(deps, { accountId: customer.accountId }, {
        holdId: claim.outcome.kind === 'holdClaimed' ? claim.outcome.hold.holdId : '',
        quoteId: quote.kind === 'quoteIssued' ? quote.quote.quoteId : '',
        idempotencyKey: key,
      }),
    ),
  );
  expect(runs.every((run) => run.outcome.kind === 'bookingPending')).toBe(true);
  expect(runs.filter((run) => !run.replayed)).toHaveLength(1);
  const bookingIds = new Set(
    runs.map((run) => (run.outcome.kind === 'bookingPending' ? run.outcome.booking.bookingId : '?')),
  );
  expect(bookingIds.size).toBe(1);
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM booking WHERE session_id = ${unit.id}`.execute(testDb.db);
  expect(Number(rows.rows[0]!.n)).toBe(1);
  // The rest state is intact: hold ACTIVE, seat held, nothing booked.
  const rec = await reconcileUnit(testDb.db, unit);
  expect(rec.heldCount).toBe(1);
  expect(rec.bookedCount).toBe(0);
});

it('duplicate FREE-confirmation storm (one key × 10) → ONE Booking, ONE consumption, ONE event set, nine replays', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
  const rest = await freeHoldFor(unit);
  const key = newId();
  const runs = await race(
    Array.from({ length: 10 }, () => () =>
      confirmFreeBooking(deps, { accountId: rest.customer.accountId }, {
        holdId: rest.holdId,
        idempotencyKey: key,
      }),
    ),
  );
  expect(runs.every((run) => run.outcome.kind === 'bookingConfirmed')).toBe(true);
  expect(runs.filter((run) => !run.replayed)).toHaveLength(1);
  const state = await holdJointState(rest.holdId);
  expect(state.hold_state).toBe('consumed');
  expect(state.booking_count).toBe(1);
  expect(state.booking_state).toBe('confirmed');
  const rec = await reconcileUnit(testDb.db, unit);
  expect(rec.bookedCount).toBe(1);
  expect(rec.heldCount).toBe(0);
  const outbox = await sql<{ n: string }>`
    SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${state.consumed_by!}`.execute(
    testDb.db,
  );
  expect(Number(outbox.rows[0]!.n)).toBe(1);
  const keyRows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM idempotency_key WHERE idempotency_key = ${key}`.execute(testDb.db);
  expect(Number(keyRows.rows[0]!.n)).toBe(1);
});

it('duplicate trusted PAID-confirmation storm (one key × 10) → one consumption, one counter move, nine replays', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
  const rest = await restFor(unit, dropInOption);
  const key = newId();
  const runs = await race(
    Array.from({ length: 10 }, () => () =>
      confirmPaidBooking(deps, {
        bookingId: rest.bookingId,
        holdId: rest.holdId,
        idempotencyKey: key,
      }),
    ),
  );
  expect(runs.every((run) => run.outcome.kind === 'bookingConfirmed')).toBe(true);
  expect(runs.filter((run) => !run.replayed)).toHaveLength(1);
  const state = await jointState(rest);
  expect(state.hold_state).toBe('consumed');
  expect(state.consumed_by).toBe(rest.bookingId);
  const rec = await reconcileUnit(testDb.db, unit);
  expect(rec.bookedCount).toBe(1);
  expect(rec.heldCount).toBe(0);
  const outbox = await sql<{ n: string }>`
    SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${rest.bookingId}`.execute(
    testDb.db,
  );
  expect(Number(outbox.rows[0]!.n)).toBe(1);
  const keyRows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM idempotency_key WHERE idempotency_key = ${key}`.execute(testDb.db);
  expect(Number(keyRows.rows[0]!.n)).toBe(1);
});

it('same key with a materially different request → typed idempotencyConflict, nothing executes', async () => {
  const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
  const rest = await restFor(unit, dropInOption);
  const key = newId();
  const first = await confirmPaidBooking(deps, {
    bookingId: rest.bookingId,
    holdId: rest.holdId,
    idempotencyKey: key,
  });
  expect(first.outcome.kind).toBe('bookingConfirmed');
  const conflicting = await confirmPaidBooking(deps, {
    bookingId: rest.bookingId,
    holdId: newId(), // different material payload under the same key
    idempotencyKey: key,
  });
  expect(conflicting.outcome.kind).toBe('idempotencyConflict');
});
