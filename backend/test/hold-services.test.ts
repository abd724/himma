/**
 * W4 Slice 5 · S5-2 — atomic capacity holds: service semantics on real
 * PostgreSQL (docs/32 §4–§5, §14; docs/24 §7.1–§7.2). Proven here:
 * the §7.1 claim transaction (typed eligibility refusals, TTL, automatic
 * open⇄full flips, opportunistic reclamation), §7.2 release/expiry with
 * exactly-once capacity return and the pending_payment unwind, the
 * idempotency primitive over the certified 0001 store, deterministic
 * failure injection at every claim phase, sweep safety, and the audit/
 * outbox event discipline. Races live in hold-concurrency*.test.ts.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { requestDigest, runIdempotent } from '../src/db/idempotency';
import type { BookingServiceDeps } from '../src/modules/booking/services/booking-shared';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import {
  expireHold,
  releaseHold,
  sweepExpiredHolds,
} from '../src/modules/booking/services/hold-lifecycle';
import {
  createBookingFixture,
  createCampWeek,
  createCohort,
  createContender,
  createCustomer,
  createQuote,
  createSession,
  reconcileUnit,
  type BookingFixture,
} from './helpers/booking-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let f: BookingFixture;
let deps: BookingServiceDeps;
/** Instantly-lapsed holds: TTL 0 makes `expires_at <= now()` immediately. */
let lapsedDeps: BookingServiceDeps;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  deps = { db: testDb.db };
  lapsedDeps = { db: testDb.db, holdTtlSeconds: 0 };
});

afterAll(async () => {
  await testDb.drop();
});

async function eventCounts(entityId: string): Promise<{ audit: number; outbox: number }> {
  const audit = await sql<{ n: string }>`
    SELECT count(*) AS n FROM audit_event WHERE entity_id = ${entityId}`.execute(testDb.db);
  const outbox = await sql<{ n: string }>`
    SELECT count(*) AS n FROM outbox_event WHERE aggregate_id = ${entityId}`.execute(testDb.db);
  return { audit: Number(audit.rows[0]!.n), outbox: Number(outbox.rows[0]!.n) };
}

describe('§7.1 claim — the atomic hold transaction', () => {
  it('claims a seat: active hold + held_count in one transaction, TTL applied, hold.created emitted once', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);

    const run = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    expect(run.replayed).toBe(false);
    if (run.outcome.kind !== 'holdClaimed') throw new Error(run.outcome.kind);
    const hold = run.outcome.hold;
    expect(hold.state).toBe('active');
    expect(hold.quantity).toBe(1);
    // D-6 default TTL = 600 s (measured against the DB clock the service used).
    const ttl = await sql<{ secs: number }>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS secs
      FROM capacity_hold WHERE id = ${hold.holdId}`.execute(testDb.db);
    expect(ttl.rows[0]!.secs).toBeCloseTo(600, 0);

    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.activeHolds).toBe(1);
    expect(rec.bookedCount).toBe(0);
    expect(rec.state).toBe('open');

    const events = await eventCounts(hold.holdId);
    expect(events).toEqual({ audit: 1, outbox: 1 });
    const payload = await sql<{ payload: Record<string, unknown>; event_type: string }>`
      SELECT payload, event_type FROM outbox_event WHERE aggregate_id = ${hold.holdId}`.execute(
      testDb.db,
    );
    expect(payload.rows[0]!.event_type).toBe('hold.created');
    // Payload discipline (docs/32 §17): ids + machine facts ONLY.
    expect(Object.keys(payload.rows[0]!.payload).sort()).toEqual(
      ['expiresAt', 'holdId', 'organizationId', 'quantity', 'state', 'unitId', 'unitKind'].sort(),
    );
  });

  it('operates uniformly on all three unit kinds (camp week + enrolment cohort)', async () => {
    for (const unit of [
      { kind: 'campWeek' as const, id: await createCampWeek(f, 2) },
      { kind: 'enrolmentCohort' as const, id: await createCohort(f, 2) },
    ]) {
      const c = await createContender(f, unit);
      const run = await claimHold(deps, { accountId: c.accountId }, {
        unit,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: newId(),
      });
      expect(run.outcome.kind).toBe('holdClaimed');
      const rec = await reconcileUnit(testDb.db, unit);
      expect(rec.heldCount).toBe(1);
      expect(rec.activeHolds).toBe(1);
    }
  });

  it('flips open → full atomically with the claiming count change, and the final seat claim reports full truthfully after', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c1 = await createContender(f, unit);
    const run = await claimHold(deps, { accountId: c1.accountId }, {
      unit,
      participantId: c1.participantId,
      quoteId: c1.quoteId,
      idempotencyKey: newId(),
    });
    expect(run.outcome.kind).toBe('holdClaimed');
    expect((await reconcileUnit(testDb.db, unit)).state).toBe('full');

    const c2 = await createContender(f, unit);
    const refused = await claimHold(deps, { accountId: c2.accountId }, {
      unit,
      participantId: c2.participantId,
      quoteId: c2.quoteId,
      idempotencyKey: newId(),
    });
    expect(refused.outcome.kind).toBe('sessionFull');
  });

  it('fails closed on every eligibility gate with typed refusals', async () => {
    const sessionId = await createSession(f, { capacity: 2 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const foreign = await createCustomer(testDb.db);
    const claim = (
      patch: Partial<{ unitId: string; participantId: string; quoteId: string; accountId: string }>,
    ) =>
      claimHold(deps, { accountId: patch.accountId ?? c.accountId }, {
        unit: { kind: 'session', id: patch.unitId ?? sessionId },
        participantId: patch.participantId ?? c.participantId,
        quoteId: patch.quoteId ?? c.quoteId,
        idempotencyKey: newId(),
      });

    expect((await claim({ unitId: newId() })).outcome.kind).toBe('unitNotFound');
    // A foreign account's participant is not-found-shaped (no existence leak).
    expect((await claim({ participantId: foreign.participantId })).outcome.kind).toBe(
      'participantNotFound',
    );
    expect((await claim({ quoteId: newId() })).outcome.kind).toBe('quoteNotFound');
    // Quote bound to a different unit → mismatch.
    const otherSession = await createSession(f);
    const otherQuote = await createQuote(f, {
      customer: c,
      unit: { kind: 'session', id: otherSession },
    });
    expect((await claim({ quoteId: otherQuote })).outcome.kind).toBe('quoteMismatch');
    // Another customer's quote → mismatch (ownership is part of the binding).
    const foreignQuote = await createQuote(f, { customer: foreign, unit });
    expect((await claim({ quoteId: foreignQuote })).outcome.kind).toBe('quoteMismatch');
    // Expired quote → typed quoteExpired.
    const expiredQuote = await createQuote(f, {
      customer: c,
      unit,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect((await claim({ quoteId: expiredQuote })).outcome.kind).toBe('quoteExpired');

    // Unit-state gates: scheduled (not yet open) and closed (cutoff/machine).
    const scheduled = await createSession(f, { state: 'scheduled' });
    const cScheduled = await createContender(f, { kind: 'session', id: scheduled });
    expect(
      (
        await claimHold(deps, { accountId: cScheduled.accountId }, {
          unit: { kind: 'session', id: scheduled },
          participantId: cScheduled.participantId,
          quoteId: cScheduled.quoteId,
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('registrationClosed');
    const pastCutoff = await createSession(f, {
      registration_cutoff_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    const cCutoff = await createContender(f, { kind: 'session', id: pastCutoff });
    expect(
      (
        await claimHold(deps, { accountId: cCutoff.accountId }, {
          unit: { kind: 'session', id: pastCutoff },
          participantId: cCutoff.participantId,
          quoteId: cCutoff.quoteId,
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('registrationClosed');

    // Duplicate live hold (same participant, same unit, NEW key) → typed.
    const first = await claim({});
    expect(first.outcome.kind).toBe('holdClaimed');
    const dupQuote = await createQuote(f, { customer: c, unit });
    const dup = await claim({ quoteId: dupQuote });
    expect(dup.outcome.kind).toBe('holdAlreadyActive');
    // Nothing double-claimed.
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(1);
  });

  it('refuses a claim when the participant already has a LIVE booking on the unit (alreadyBooked)', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const claimed = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    if (claimed.outcome.kind !== 'holdClaimed') throw new Error(claimed.outcome.kind);
    const holdId = claimed.outcome.hold.holdId;
    // Simulate the S5-3 consumption boundary directly (booking + pairing +
    // counter finalization) so a LIVE confirmed-path booking exists.
    const bookingId = newId();
    await testDb.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO booking (id, account_id, participant_id, program_id,
                                     organization_id, branch_id, option_kind, session_id,
                                     quote_id, hold_id)
                VALUES (${bookingId}, ${c.accountId}, ${c.participantId}, ${f.programId},
                        ${f.org.orgId}, ${f.org.branchIds[0]}, 'dropIn', ${sessionId},
                        ${c.quoteId}, ${holdId})`.execute(trx);
      await sql`UPDATE capacity_hold SET state = 'consumed', consumed_by_booking_id = ${bookingId}
                WHERE id = ${holdId}`.execute(trx);
      await sql`UPDATE session SET held_count = held_count - 1, booked_count = booked_count + 1
                WHERE id = ${sessionId}`.execute(trx);
    });

    const again = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: await createQuote(f, { customer: c, unit }),
      idempotencyKey: newId(),
    });
    expect(again.outcome.kind).toBe('alreadyBooked');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.bookedCount).toBe(1);
    expect(rec.heldCount).toBe(0);
  });

  it('opportunistically reclaims lapsed holds under the unit lock: the final seat is claimable without a sweep, and a resting pending_payment booking unwinds', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c1 = await createContender(f, unit);
    const lapsed = await claimHold(lapsedDeps, { accountId: c1.accountId }, {
      unit,
      participantId: c1.participantId,
      quoteId: c1.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsed.outcome.kind !== 'holdClaimed') throw new Error(lapsed.outcome.kind);
    const lapsedHoldId = lapsed.outcome.hold.holdId;
    // The S5-1-pinned intermediate state: a pending_payment booking rests on it.
    const bookingId = newId();
    await sql`INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                                   branch_id, option_kind, session_id, quote_id, hold_id)
              VALUES (${bookingId}, ${c1.accountId}, ${c1.participantId}, ${f.programId},
                      ${f.org.orgId}, ${f.org.branchIds[0]}, 'dropIn', ${sessionId},
                      ${c1.quoteId}, ${lapsedHoldId})`.execute(testDb.db);
    expect((await reconcileUnit(testDb.db, unit)).state).toBe('full');

    const c2 = await createContender(f, unit);
    const claim2 = await claimHold(deps, { accountId: c2.accountId }, {
      unit,
      participantId: c2.participantId,
      quoteId: c2.quoteId,
      idempotencyKey: newId(),
    });
    expect(claim2.outcome.kind).toBe('holdClaimed');

    const holdState = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${lapsedHoldId}`.execute(testDb.db);
    expect(holdState.rows[0]!.state).toBe('expired');
    const bookingState = await sql<{ state: string }>`
      SELECT state FROM booking WHERE id = ${bookingId}`.execute(testDb.db);
    expect(bookingState.rows[0]!.state).toBe('expired');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1); // the new claim, not the lapsed one
    expect(rec.activeHolds).toBe(1);
    // The reclamation emitted exactly one hold.expired for the lapsed hold.
    const events = await eventCounts(lapsedHoldId);
    expect(events).toEqual({ audit: 2, outbox: 2 }); // created + expired
  });
});

describe('§7.2 release + expiry — exactly-once capacity return', () => {
  it('releases an active hold once: capacity returned, full → open flip, typed outcomes for every terminal state after', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const claimed = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    if (claimed.outcome.kind !== 'holdClaimed') throw new Error(claimed.outcome.kind);
    const holdId = claimed.outcome.hold.holdId;
    expect((await reconcileUnit(testDb.db, unit)).state).toBe('full');

    const released = await releaseHold(deps, { accountId: c.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(released.outcome.kind).toBe('holdReleased');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(0);
    expect(rec.state).toBe('open');

    // Second release with a NEW key: typed alreadyReleased, no double return.
    const again = await releaseHold(deps, { accountId: c.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(again.outcome.kind).toBe('alreadyReleased');
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(0);
    // Expiry can never touch a released hold.
    expect((await expireHold(deps, { holdId })).kind).toEqual('alreadyTerminal');
  });

  it('release is ownership-scoped (foreign account → holdNotFound), version-guarded, and applies expiry semantics to a lapsed hold', async () => {
    const sessionId = await createSession(f, { capacity: 2 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const other = await createCustomer(testDb.db);
    const claimed = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    if (claimed.outcome.kind !== 'holdClaimed') throw new Error(claimed.outcome.kind);
    const holdId = claimed.outcome.hold.holdId;

    const foreign = await releaseHold(deps, { accountId: other.accountId }, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(foreign.outcome.kind).toBe('holdNotFound');

    const stale = await releaseHold(deps, { accountId: c.accountId }, {
      holdId,
      idempotencyKey: newId(),
      expectedVersion: 999,
    });
    expect(stale.outcome.kind).toEqual('staleVersion');
    // Neither refusal touched capacity.
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(1);

    // A lapsed-but-still-active hold: release resolves it as EXPIRY.
    const c2 = await createContender(f, unit);
    const lapsed = await claimHold(lapsedDeps, { accountId: c2.accountId }, {
      unit,
      participantId: c2.participantId,
      quoteId: c2.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsed.outcome.kind !== 'holdClaimed') throw new Error(lapsed.outcome.kind);
    const releaseLapsed = await releaseHold(deps, { accountId: c2.accountId }, {
      holdId: lapsed.outcome.hold.holdId,
      idempotencyKey: newId(),
    });
    expect(releaseLapsed.outcome.kind).toBe('holdExpired');
    const state = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${lapsed.outcome.hold.holdId}`.execute(testDb.db);
    expect(state.rows[0]!.state).toBe('expired');
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(1);
  });

  it('expiry: lapsed → expired with the pending_payment unwind; unexpired → notLapsed; retry → alreadyTerminal; consumed can never expire', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const live = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    if (live.outcome.kind !== 'holdClaimed') throw new Error(live.outcome.kind);
    expect((await expireHold(deps, { holdId: live.outcome.hold.holdId })).kind).toBe('notLapsed');

    const c2 = await createContender(f, unit);
    const lapsed = await claimHold(lapsedDeps, { accountId: c2.accountId }, {
      unit,
      participantId: c2.participantId,
      quoteId: c2.quoteId,
      idempotencyKey: newId(),
    });
    if (lapsed.outcome.kind !== 'holdClaimed') throw new Error(lapsed.outcome.kind);
    const lapsedId = lapsed.outcome.hold.holdId;
    const bookingId = newId();
    await sql`INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                                   branch_id, option_kind, session_id, quote_id, hold_id)
              VALUES (${bookingId}, ${c2.accountId}, ${c2.participantId}, ${f.programId},
                      ${f.org.orgId}, ${f.org.branchIds[0]}, 'dropIn', ${sessionId},
                      ${c2.quoteId}, ${lapsedId})`.execute(testDb.db);

    expect((await expireHold(deps, { holdId: lapsedId })).kind).toBe('holdExpired');
    const booking = await sql<{ state: string }>`
      SELECT state FROM booking WHERE id = ${bookingId}`.execute(testDb.db);
    expect(booking.rows[0]!.state).toBe('expired');
    // Retrying is harmless and typed.
    expect(await expireHold(deps, { holdId: lapsedId })).toEqual({
      kind: 'alreadyTerminal',
      state: 'expired',
    });
    expect((await expireHold(deps, { holdId: newId() })).kind).toBe('holdNotFound');
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1); // only the live hold still counts
    expect(rec.activeHolds).toBe(1);

    // A consumed hold is untouchable by expiry (S5-1 pairing preserved).
    const consumedBooking = newId();
    await testDb.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                                     branch_id, option_kind, session_id, quote_id, hold_id)
                VALUES (${consumedBooking}, ${c.accountId}, ${c.participantId}, ${f.programId},
                        ${f.org.orgId}, ${f.org.branchIds[0]}, 'dropIn', ${sessionId},
                        ${c.quoteId}, ${live.outcome.kind === 'holdClaimed' ? live.outcome.hold.holdId : ''})`.execute(trx);
      await sql`UPDATE capacity_hold SET state = 'consumed', consumed_by_booking_id = ${consumedBooking}
                WHERE id = ${live.outcome.kind === 'holdClaimed' ? live.outcome.hold.holdId : ''}`.execute(trx);
      await sql`UPDATE session SET held_count = held_count - 1, booked_count = booked_count + 1
                WHERE id = ${sessionId}`.execute(trx);
    });
    expect(
      await expireHold(deps, {
        holdId: live.outcome.kind === 'holdClaimed' ? live.outcome.hold.holdId : '',
      }),
    ).toEqual({ kind: 'alreadyTerminal', state: 'consumed' });
  });

  it('the sweep expires every lapsed hold exactly once, leaves live holds alone, and re-running is a no-op', async () => {
    // Three lapsed holds on three separate units (no later claim touches
    // them, so no opportunistic boundary settles them first) + one live hold.
    const lapsed: Array<{ unit: { kind: 'session'; id: string }; holdId: string }> = [];
    for (let i = 0; i < 3; i += 1) {
      const unit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
      const c = await createContender(f, unit);
      const run = await claimHold(lapsedDeps, { accountId: c.accountId }, {
        unit,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: newId(),
      });
      if (run.outcome.kind !== 'holdClaimed') throw new Error(run.outcome.kind);
      lapsed.push({ unit, holdId: run.outcome.hold.holdId });
    }
    const liveUnit = { kind: 'session' as const, id: await createSession(f, { capacity: 2 }) };
    const cLive = await createContender(f, liveUnit);
    const liveRun = await claimHold(deps, { accountId: cLive.accountId }, {
      unit: liveUnit,
      participantId: cLive.participantId,
      quoteId: cLive.quoteId,
      idempotencyKey: newId(),
    });
    expect(liveRun.outcome.kind).toBe('holdClaimed');

    const sweep = await sweepExpiredHolds(deps, { limit: 50 });
    expect(sweep.expired).toBe(3);
    const states = await sql<{ id: string; state: string }>`
      SELECT id, state FROM capacity_hold
      WHERE id = ANY(${lapsed.map((l) => l.holdId)})`.execute(testDb.db);
    expect(states.rows.every((row) => row.state === 'expired')).toBe(true);
    for (const { unit } of lapsed) {
      const rec = await reconcileUnit(testDb.db, unit);
      expect(rec.heldCount).toBe(0);
      expect(rec.activeHolds).toBe(0);
    }
    const liveRec = await reconcileUnit(testDb.db, liveUnit);
    expect(liveRec.heldCount).toBe(1);
    expect(liveRec.activeUnexpiredHolds).toBe(1);

    // Idempotent by construction: a second pass finds nothing to do.
    const again = await sweepExpiredHolds(deps, { limit: 50 });
    expect(again.expired).toBe(0);
    expect((await reconcileUnit(testDb.db, liveUnit)).heldCount).toBe(1);
  });
});

describe('idempotency — the first consumer of the certified 0001 store (docs/32 §14)', () => {
  it('same principal + scope + key + payload replays the stored outcome without re-executing; different payload on the same key is a typed conflict', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const key = newId();
    const input = {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: key,
    };
    const first = await claimHold(deps, { accountId: c.accountId }, input);
    if (first.outcome.kind !== 'holdClaimed') throw new Error(first.outcome.kind);

    const replay = await claimHold(deps, { accountId: c.accountId }, input);
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toEqual(first.outcome);
    // No second hold, no second counter claim, no duplicate events.
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(await eventCounts(first.outcome.hold.holdId)).toEqual({ audit: 1, outbox: 1 });

    // Same key, materially different request → typed conflict, nothing runs.
    const otherQuote = await createQuote(f, { customer: c, unit });
    const conflict = await claimHold(deps, { accountId: c.accountId }, {
      ...input,
      quoteId: otherQuote,
    });
    expect(conflict.outcome.kind).toBe('idempotencyConflict');
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(1);
  });

  it('typed refusals are stored outcomes too: a sessionFull replay stays sessionFull on the same key even after a seat frees', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const unit = { kind: 'session' as const, id: sessionId };
    const winner = await createContender(f, unit);
    const loser = await createContender(f, unit);
    const won = await claimHold(deps, { accountId: winner.accountId }, {
      unit,
      participantId: winner.participantId,
      quoteId: winner.quoteId,
      idempotencyKey: newId(),
    });
    if (won.outcome.kind !== 'holdClaimed') throw new Error(won.outcome.kind);
    const loserKey = newId();
    const refusedInput = {
      unit,
      participantId: loser.participantId,
      quoteId: loser.quoteId,
      idempotencyKey: loserKey,
    };
    const refused = await claimHold(deps, { accountId: loser.accountId }, refusedInput);
    expect(refused.outcome.kind).toBe('sessionFull');

    await releaseHold(deps, { accountId: winner.accountId }, {
      holdId: won.outcome.hold.holdId,
      idempotencyKey: newId(),
    });
    // Same key = same operation = the SAME stored outcome…
    const replayed = await claimHold(deps, { accountId: loser.accountId }, refusedInput);
    expect(replayed).toEqual({ replayed: true, outcome: { kind: 'sessionFull' } });
    // …while a NEW key is a new operation and wins the freed seat.
    const fresh = await claimHold(deps, { accountId: loser.accountId }, {
      ...refusedInput,
      idempotencyKey: newId(),
    });
    expect(fresh.outcome.kind).toBe('holdClaimed');
  });

  it('release replay returns the stored outcome; the key row and mutation committed together', async () => {
    const sessionId = await createSession(f, { capacity: 2 });
    const unit = { kind: 'session' as const, id: sessionId };
    const c = await createContender(f, unit);
    const claimed = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    if (claimed.outcome.kind !== 'holdClaimed') throw new Error(claimed.outcome.kind);
    const key = newId();
    const first = await releaseHold(deps, { accountId: c.accountId }, {
      holdId: claimed.outcome.hold.holdId,
      idempotencyKey: key,
    });
    expect(first).toEqual({ replayed: false, outcome: { kind: 'holdReleased' } });
    const replay = await releaseHold(deps, { accountId: c.accountId }, {
      holdId: claimed.outcome.hold.holdId,
      idempotencyKey: key,
    });
    expect(replay).toEqual({ replayed: true, outcome: { kind: 'holdReleased' } });
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(0);
    // hold.released emitted exactly once (created + released = 2 rows).
    expect(await eventCounts(claimed.outcome.hold.holdId)).toEqual({ audit: 2, outbox: 2 });
  });

  it('the primitive itself: completed rows always carry the snapshot; a thrown transaction leaves NO row (the key is never poisoned)', async () => {
    const ctx = {
      principalRef: 'customer:test-principal',
      endpointScope: 'booking.test.scope',
      idempotencyKey: newId(),
      requestDigest: requestDigest({ probe: 1 }),
    };
    await expect(
      runIdempotent(testDb.db, ctx, async () => {
        throw new Error('injected domain failure');
      }),
    ).rejects.toThrow('injected domain failure');
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM idempotency_key
      WHERE idempotency_key = ${ctx.idempotencyKey}`.execute(testDb.db);
    expect(Number(rows.rows[0]!.n)).toBe(0);

    const ok = await runIdempotent(testDb.db, ctx, async () => ({ value: 42 }));
    expect(ok).toEqual({ kind: 'executed', result: { value: 42 } });
    const stored = await sql<{ status: string; response_snapshot: unknown }>`
      SELECT status, response_snapshot FROM idempotency_key
      WHERE idempotency_key = ${ctx.idempotencyKey}`.execute(testDb.db);
    expect(stored.rows[0]).toEqual({
      status: 'completed',
      response_snapshot: { value: 42 },
    });
  });
});

describe('deterministic failure injection (docs/32 §15 proof obligations)', () => {
  it.each(['unitLocked', 'counterIncremented', 'holdInserted'] as const)(
    'a failure at phase %s rolls back EVERYTHING — no hold, no counter claim, no key row, no events',
    async (phase) => {
      const sessionId = await createSession(f, { capacity: 2 });
      const unit = { kind: 'session' as const, id: sessionId };
      const c = await createContender(f, unit);
      const key = newId();
      const sabotaged: BookingServiceDeps = {
        db: testDb.db,
        onClaimPhase: (p) => {
          if (p === phase) throw new Error(`sabotage:${phase}`);
        },
      };
      await expect(
        claimHold(sabotaged, { accountId: c.accountId }, {
          unit,
          participantId: c.participantId,
          quoteId: c.quoteId,
          idempotencyKey: key,
        }),
      ).rejects.toThrow(`sabotage:${phase}`);

      const rec = await reconcileUnit(testDb.db, unit);
      expect(rec.heldCount).toBe(0);
      expect(rec.activeHolds).toBe(0);
      const holds = await sql<{ n: string }>`
        SELECT count(*) AS n FROM capacity_hold WHERE session_id = ${sessionId}`.execute(testDb.db);
      expect(Number(holds.rows[0]!.n)).toBe(0);
      const keys = await sql<{ n: string }>`
        SELECT count(*) AS n FROM idempotency_key WHERE idempotency_key = ${key}`.execute(testDb.db);
      expect(Number(keys.rows[0]!.n)).toBe(0);
      const outbox = await sql<{ n: string }>`
        SELECT count(*) AS n FROM outbox_event
        WHERE aggregate_type = 'capacity_hold'
          AND payload->>'unitId' = ${sessionId}`.execute(testDb.db);
      expect(Number(outbox.rows[0]!.n)).toBe(0);

      // The key was not poisoned: the SAME key now executes cleanly.
      const retry = await claimHold(deps, { accountId: c.accountId }, {
        unit,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: key,
      });
      expect(retry).toMatchObject({ replayed: false, outcome: { kind: 'holdClaimed' } });
    },
  );
});
