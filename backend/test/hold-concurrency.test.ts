/**
 * W4 Slice 5 · S5-2 — the concurrency certification gate (docs/32 §15/§16;
 * owner ruling D-1: Tier 1 = 50 simultaneous contenders, 3 deterministic CI
 * repetitions). Genuinely concurrent PostgreSQL transactions on independent
 * pool connections — never a loop of awaited promises on one connection.
 * Assertions are on INVARIANTS (counts, states, reconciliation), never on
 * which contender wins a race. Post-run counter reconciliation runs after
 * EVERY scenario (docs/32 §1.2.5).
 */
import { sql } from 'kysely';

import { DbError } from '../src/db/errors';
import { newId } from '../src/db/ids';
import type { BookingServiceDeps } from '../src/modules/booking/services/booking-shared';
import { claimHold, type ClaimHoldRun } from '../src/modules/booking/services/hold-claim';
import { expireHold, releaseHold } from '../src/modules/booking/services/hold-lifecycle';
import {
  createBookingFixture,
  createContender,
  createCustomer,
  createQuote,
  createSession,
  reconcileUnit,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createRacePool, race, type RacePool } from './helpers/race-harness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
let f: BookingFixture;
let racePool: RacePool;
let deps: BookingServiceDeps; // service deps bound to the RACE pool
let lapsedDeps: BookingServiceDeps;

const TIER1_CONTENDERS = 50; // owner ruling D-1
const TIER1_CAPACITY = 7;
const TIER1_REPETITIONS = 3;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  racePool = await createRacePool(testDb.config, TIER1_CONTENDERS + 4);
  deps = { db: racePool.db };
  lapsedDeps = { db: racePool.db, holdTtlSeconds: 0 };
});

afterAll(async () => {
  await racePool.destroy();
  await testDb.drop();
});

interface Contender {
  accountId: string;
  participantId: string;
  quoteId: string;
}

function claimThunk(
  serviceDeps: BookingServiceDeps,
  unit: { kind: 'session'; id: string },
  contender: Contender,
): () => Promise<ClaimHoldRun> {
  return () =>
    claimHold(serviceDeps, { accountId: contender.accountId }, {
      unit,
      participantId: contender.participantId,
      quoteId: contender.quoteId,
      idempotencyKey: newId(),
    });
}

function kinds(runs: ClaimHoldRun[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.outcome.kind] = (counts[run.outcome.kind] ?? 0) + 1;
  return counts;
}

async function assertNoOrphans(): Promise<void> {
  // Every idempotency row committed by a hold command is completed — an
  // in_progress row surviving a run would be an orphan by construction.
  const inProgress = await sql<{ n: string }>`
    SELECT count(*) AS n FROM idempotency_key WHERE status = 'in_progress'`.execute(testDb.db);
  expect(Number(inProgress.rows[0]!.n)).toBe(0);
}

describe('final-seat races (§15 tests 1–2)', () => {
  it('capacity 1, two simultaneous claims → exactly one active hold + one typed sessionFull', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const [a, b] = [await createContender(f, unit), await createContender(f, unit)];
    const runs = await race([claimThunk(deps, unit, a), claimThunk(deps, unit, b)]);
    expect(kinds(runs)).toEqual({ holdClaimed: 1, sessionFull: 1 });
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.activeHolds).toBe(1);
    expect(rec.state).toBe('full');
    await assertNoOrphans();
  });

  it('capacity N=5, N+K=12 simultaneous claims → exactly 5 succeed, 7 typed refusals, counter = row aggregate', async () => {
    const sessionId = await createSession(f, { capacity: 5 });
    const unit = { kind: 'session' as const, id: sessionId };
    const contenders = await Promise.all(
      Array.from({ length: 12 }, () => createContender(f, unit)),
    );
    const runs = await race(contenders.map((c) => claimThunk(deps, unit, c)));
    expect(kinds(runs)).toEqual({ holdClaimed: 5, sessionFull: 7 });
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(5);
    expect(rec.activeHolds).toBe(5);
    expect(rec.bookedCount + rec.heldCount).toBeLessThanOrEqual(rec.capacity);
    await assertNoOrphans();
  });
});

describe('Tier-1 launch gate (owner ruling D-1): 50 contenders × 3 deterministic repetitions', () => {
  it(`${TIER1_CONTENDERS} simultaneous contenders, capacity ${TIER1_CAPACITY}, ${TIER1_REPETITIONS} repetitions — zero oversell, exact counts, typed refusals, no orphans`, async () => {
    // The contender population is created once; each repetition races it
    // against a FRESH unit (with a new quote per unit — quotes are unit-bound).
    const population = await Promise.all(
      Array.from({ length: TIER1_CONTENDERS }, () => createCustomer(testDb.db)),
    );

    for (let rep = 1; rep <= TIER1_REPETITIONS; rep += 1) {
      const sessionId = await createSession(f, { capacity: TIER1_CAPACITY });
      const unit = { kind: 'session' as const, id: sessionId };
      const contenders: Contender[] = await Promise.all(
        population.map(async (customer) => ({
          ...customer,
          quoteId: await createQuote(f, { customer, unit }),
        })),
      );

      const runs = await race(contenders.map((c) => claimThunk(deps, unit, c)));

      const counts = kinds(runs);
      expect(counts).toEqual({
        holdClaimed: TIER1_CAPACITY,
        sessionFull: TIER1_CONTENDERS - TIER1_CAPACITY,
      });
      const rec = await reconcileUnit(testDb.db, unit);
      expect(rec.heldCount).toBe(TIER1_CAPACITY);
      expect(rec.activeHolds).toBe(TIER1_CAPACITY);
      expect(rec.bookedCount).toBe(0);
      expect(rec.bookedCount + rec.heldCount).toBeLessThanOrEqual(rec.capacity);
      expect(rec.state).toBe('full');
      // The DB CHECK remains provably intact: a direct oversell attempt dies.
      await expect(
        sql`UPDATE session SET held_count = held_count + 1 WHERE id = ${sessionId}`.execute(
          testDb.db,
        ),
      ).rejects.toThrow(/ck_session_capacity/);
      // Domain-row audit: exactly one hold row per winner, none for losers.
      const holdRows = await sql<{ n: string }>`
        SELECT count(*) AS n FROM capacity_hold WHERE session_id = ${sessionId}`.execute(testDb.db);
      expect(Number(holdRows.rows[0]!.n)).toBe(TIER1_CAPACITY);
      await assertNoOrphans();
    }
  });
});

describe('claim/expiry/release races (§15 tests 3, 6–8 + idempotent storm)', () => {
  it('a claim racing the EXPIRY of the last-seat hold: never both active, counts consistent, exactly one expiry', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const lapsedRun = await claimHold(lapsedDeps, { accountId: holder.accountId }, {
      unit,
      participantId: holder.participantId,
      quoteId: holder.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsedRun.outcome.kind !== 'holdClaimed') throw new Error(lapsedRun.outcome.kind);
    const lapsedHoldId = lapsedRun.outcome.hold.holdId;

    const challenger = await createContender(f, unit);
    const [claimRun, expiry] = await Promise.all([
      claimThunk(deps, unit, challenger)(),
      expireHold(deps, { holdId: lapsedHoldId }),
    ]);

    // Whoever won the unit lock first, the invariants are the same:
    expect(['holdClaimed', 'sessionFull']).toContain(claimRun.outcome.kind);
    expect(['holdExpired', 'alreadyTerminal']).toContain(expiry.kind);
    const lapsedState = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${lapsedHoldId}`.execute(testDb.db);
    expect(lapsedState.rows[0]!.state).toBe('expired'); // expired exactly once, by someone
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(claimRun.outcome.kind === 'holdClaimed' ? 1 : 0);
    expect(rec.heldCount).toBe(rec.activeHolds);
    await assertNoOrphans();
  });

  it('a claim racing the RELEASE of the last-seat hold: released exactly once, claim wins or refuses — never oversells', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const heldRun = await claimHold(deps, { accountId: holder.accountId }, {
      unit,
      participantId: holder.participantId,
      quoteId: holder.quoteId,
      idempotencyKey: newId(),
    });
    if (heldRun.outcome.kind !== 'holdClaimed') throw new Error(heldRun.outcome.kind);

    const challenger = await createContender(f, unit);
    const [claimRun, releaseRun] = await Promise.all([
      claimThunk(deps, unit, challenger)(),
      releaseHold(deps, { accountId: holder.accountId }, {
        holdId: heldRun.outcome.hold.holdId,
        idempotencyKey: newId(),
      }),
    ]);
    expect(releaseRun.outcome.kind).toBe('holdReleased');
    expect(['holdClaimed', 'sessionFull']).toContain(claimRun.outcome.kind);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(claimRun.outcome.kind === 'holdClaimed' ? 1 : 0);
    expect(rec.heldCount).toBe(rec.activeHolds);
    expect(rec.bookedCount + rec.heldCount).toBeLessThanOrEqual(rec.capacity);
    await assertNoOrphans();
  });

  it('two concurrent releases of one hold → capacity returned exactly once', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const heldRun = await claimHold(deps, { accountId: holder.accountId }, {
      unit,
      participantId: holder.participantId,
      quoteId: holder.quoteId,
      idempotencyKey: newId(),
    });
    if (heldRun.outcome.kind !== 'holdClaimed') throw new Error(heldRun.outcome.kind);
    const holdId = heldRun.outcome.hold.holdId;

    const runs = await Promise.all([
      releaseHold(deps, { accountId: holder.accountId }, { holdId, idempotencyKey: newId() }),
      releaseHold(deps, { accountId: holder.accountId }, { holdId, idempotencyKey: newId() }),
    ]);
    const outcomes = runs.map((run) => run.outcome.kind).sort();
    expect(outcomes).toEqual(['alreadyReleased', 'holdReleased']);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(0);
    expect(rec.activeHolds).toBe(0);
    await assertNoOrphans();
  });

  it('two concurrent expiry attempts → capacity returned exactly once', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const lapsedRun = await claimHold(lapsedDeps, { accountId: holder.accountId }, {
      unit,
      participantId: holder.participantId,
      quoteId: holder.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsedRun.outcome.kind !== 'holdClaimed') throw new Error(lapsedRun.outcome.kind);
    const holdId = lapsedRun.outcome.hold.holdId;

    const [first, second] = await Promise.all([
      expireHold(deps, { holdId }),
      expireHold(deps, { holdId }),
    ]);
    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(['alreadyTerminal', 'holdExpired']);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(0);
    await assertNoOrphans();
  });

  it('release racing expiry on a lapsed hold → exactly ONE terminal transition wins, one decrement', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const lapsedRun = await claimHold(lapsedDeps, { accountId: holder.accountId }, {
      unit,
      participantId: holder.participantId,
      quoteId: holder.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsedRun.outcome.kind !== 'holdClaimed') throw new Error(lapsedRun.outcome.kind);
    const holdId = lapsedRun.outcome.hold.holdId;

    const [releaseRun, expiry] = await Promise.all([
      releaseHold(deps, { accountId: holder.accountId }, { holdId, idempotencyKey: newId() }),
      expireHold(deps, { holdId }),
    ]);
    // On a lapsed hold the truthful terminal state is `expired` whichever
    // boundary reaches it first; the loser reports it typed.
    expect(['holdExpired', 'alreadyExpired']).toContain(releaseRun.outcome.kind);
    expect(['holdExpired', 'alreadyTerminal']).toContain(expiry.kind);
    const winners = [releaseRun.outcome.kind, expiry.kind].filter((k) => k === 'holdExpired');
    expect(winners).toHaveLength(1);
    const state = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${holdId}`.execute(testDb.db);
    expect(state.rows[0]!.state).toBe('expired');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(0);
    await assertNoOrphans();
  });

  it('a duplicate idempotent claim storm (one key × 20 concurrent) → ONE hold, ONE counter claim, one event set', async () => {
    const sessionId = await createSession(f, { capacity: 5 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const key = newId();
    const storm = Array.from({ length: 20 }, () => () =>
      claimHold(deps, { accountId: holder.accountId }, {
        unit,
        participantId: holder.participantId,
        quoteId: holder.quoteId,
        idempotencyKey: key,
      }),
    );
    const runs = await race(storm);
    expect(runs.every((run) => run.outcome.kind === 'holdClaimed')).toBe(true);
    expect(runs.filter((run) => !run.replayed)).toHaveLength(1);
    expect(runs.filter((run) => run.replayed)).toHaveLength(19);
    const holdIds = new Set(
      runs.map((run) => (run.outcome.kind === 'holdClaimed' ? run.outcome.hold.holdId : '?')),
    );
    expect(holdIds.size).toBe(1);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    const keyRows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM idempotency_key WHERE idempotency_key = ${key}`.execute(testDb.db);
    expect(Number(keyRows.rows[0]!.n)).toBe(1);
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${[...holdIds][0]!}`.execute(testDb.db);
    expect(Number(events.rows[0]!.n)).toBe(1);
    await assertNoOrphans();
  });

  it('two contenders minting DIFFERENT keys for the same live intent → the partial unique holds the line (one hold ever)', async () => {
    const sessionId = await createSession(f, { capacity: 5 });
    const unit = { kind: 'session' as const, id: sessionId };
    const holder = await createContender(f, unit);
    const runs = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimHold(deps, { accountId: holder.accountId }, {
          unit,
          participantId: holder.participantId,
          quoteId: holder.quoteId,
          idempotencyKey: newId(),
        }),
      ),
    );
    const counts = kinds(runs);
    expect(counts['holdClaimed']).toBe(1);
    expect(counts['holdAlreadyActive']).toBe(7);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.activeHolds).toBe(1);
  });
});

describe('capacity floor under live holds (§15 test 6 / S5-1 CHECK re-proof)', () => {
  it('capacity reduction below booked + held stays impossible while service-claimed holds exist', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit = { kind: 'session' as const, id: sessionId };
    for (let i = 0; i < 2; i += 1) {
      const c = await createContender(f, unit);
      const run = await claimHold(deps, { accountId: c.accountId }, {
        unit,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: newId(),
      });
      expect(run.outcome.kind).toBe('holdClaimed');
    }
    await expect(
      sql`UPDATE session SET capacity = 1 WHERE id = ${sessionId}`.execute(testDb.db),
    ).rejects.toThrow(/ck_session_capacity/);
    // Reduction TO the committed floor remains legal (docs/24 §3.7).
    await sql`UPDATE session SET capacity = 2 WHERE id = ${sessionId}`.execute(testDb.db);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.capacity).toBe(2);
    expect(rec.heldCount).toBe(2);
  });
});

describe('typed DbError surface', () => {
  it('lock waits resolve as typed refusals — no serialization failures or deadlocks leak at READ COMMITTED', async () => {
    // A meta-assertion for the suite: rerun a mixed contention burst and
    // prove nothing surfaced as deadlockDetected/serializationFailure.
    const sessionId = await createSession(f, { capacity: 2 });
    const unit = { kind: 'session' as const, id: sessionId };
    const contenders = await Promise.all(
      Array.from({ length: 8 }, () => createContender(f, unit)),
    );
    try {
      const runs = await race(contenders.map((c) => claimThunk(deps, unit, c)));
      expect(kinds(runs)).toEqual({ holdClaimed: 2, sessionFull: 6 });
    } catch (error) {
      if (error instanceof DbError) {
        throw new Error(`typed DbError leaked from race: ${error.kind} (${error.message})`);
      }
      throw error;
    }
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(rec.activeHolds);
    await assertNoOrphans();
  });
});
