/**
 * W4 Slice 5 · S5-4 — provider scheduling/capacity services on real
 * PostgreSQL (docs/32 §11, §3; docs/24 §2.3, §5.4; rulings D-5, D-9).
 * Service-level semantics + the §16 concurrency matrix: schedule CRUD with
 * future-only effect, deterministic idempotent generation (incl. storms),
 * capacity-floor authority under the S5-2 unit-lock discipline, provider
 * mutations racing customer claims (never overselling), status edges, and
 * org/branch scope enforcement. HTTP authz lives in
 * booking-provider-routes.test.ts.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import type { BookingServiceDeps, UnitRef } from '../src/modules/booking/services/booking-shared';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import {
  closeUnit,
  createUnit,
  listUnits,
  openUnit,
  unitRoster,
  updateUnitConfig,
} from '../src/modules/booking/services/provider-capacity';
import {
  createSchedule,
  endSchedule,
  generateSessions,
  updateSchedule,
} from '../src/modules/booking/services/provider-scheduling';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { ProviderRole } from '../src/modules/provider/provider-roles';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createBookingFixture,
  createContender,
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
let deps: BookingServiceDeps;
let owner: OrgScope;
const actor = { userId: newId() };

function scopeFor(
  org: { orgId: string },
  role: ProviderRole = 'owner',
  branchScope: 'all' | string[] = 'all',
): OrgScope {
  return {
    organizationId: org.orgId,
    membershipId: newId(),
    role,
    capabilities: capabilitiesForRole(role),
    branchScope,
    organizationState: 'live',
  };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  racePool = await createRacePool(testDb.config, 16);
  deps = { db: racePool.db };
  owner = scopeFor(f.org);
});

afterAll(async () => {
  await racePool.destroy();
  await testDb.drop();
});

async function makeSchedule(overrides: Record<string, unknown> = {}) {
  const result = await createSchedule(deps, owner, actor, {
    programId: f.programId,
    weekdays: [1, 3], // Mon, Wed
    startTime: '16:00',
    endTime: '17:00',
    effectiveStart: '2026-09-01',
    ...overrides,
  } as never);
  if (result.kind !== 'scheduleCreated') throw new Error(result.kind);
  return result.schedule;
}

describe('recurring schedules (docs/24 §2.3 — purely temporal, A1.1)', () => {
  it('creates, updates (CAS), and ends a schedule; edits never rewrite already-generated sessions', async () => {
    const schedule = await makeSchedule();
    expect(schedule.state).toBe('active');
    expect(schedule.registrationCutoffKind).toBe('at_start'); // D-9 default

    // Generate a week, then move the schedule's time: the EXISTING sessions
    // keep their materialized times — only future generation changes.
    const gen = await generateSessions(deps, owner, actor, {
      scheduleId: schedule.id,
      branchId: f.org.branchIds[0]!,
      capacity: 5,
      fromDate: '2026-09-07',
      toDate: '2026-09-13',
    });
    if (gen.kind !== 'sessionsGenerated') throw new Error(gen.kind);
    expect(gen.created).toBe(2); // Mon 7th + Wed 9th
    const before = await sql<{ start_at: Date }>`
      SELECT start_at FROM session WHERE id = ${gen.sessionIds[0]!}`.execute(testDb.db);

    const updated = await updateSchedule(deps, owner, actor, {
      scheduleId: schedule.id,
      expectedVersion: schedule.version,
      patch: { startTime: '18:00', endTime: '19:00' },
    });
    if (updated.kind !== 'scheduleUpdated') throw new Error(updated.kind);
    const after = await sql<{ start_at: Date }>`
      SELECT start_at FROM session WHERE id = ${gen.sessionIds[0]!}`.execute(testDb.db);
    expect(after.rows[0]!.start_at).toEqual(before.rows[0]!.start_at); // untouched

    // Future generation uses the NEW pattern.
    const nextWeek = await generateSessions(deps, owner, actor, {
      scheduleId: schedule.id,
      branchId: f.org.branchIds[0]!,
      capacity: 5,
      fromDate: '2026-09-14',
      toDate: '2026-09-20',
    });
    if (nextWeek.kind !== 'sessionsGenerated') throw new Error(nextWeek.kind);
    const times = await sql<{ hour: number }>`
      SELECT EXTRACT(HOUR FROM start_at AT TIME ZONE 'Asia/Dubai')::int AS hour
      FROM session WHERE id = ANY(${nextWeek.sessionIds})`.execute(testDb.db);
    expect(times.rows.every((row) => row.hour === 18)).toBe(true);

    // Stale CAS refuses without mutation; end is a one-way lifecycle edge.
    const stale = await updateSchedule(deps, owner, actor, {
      scheduleId: schedule.id,
      expectedVersion: schedule.version, // now stale
      patch: { startTime: '10:00' },
    });
    expect(stale.kind).toBe('staleVersion');
    const fresh = updated.schedule.version;
    expect((await endSchedule(deps, owner, actor, {
      scheduleId: schedule.id,
      expectedVersion: fresh,
    })).kind).toBe('scheduleEnded');
    // Ended schedules refuse edits and generation.
    expect(
      (
        await updateSchedule(deps, owner, actor, {
          scheduleId: schedule.id,
          expectedVersion: fresh + 1,
          patch: { startTime: '10:00' },
        })
      ).kind,
    ).toBe('lifecycleConflict');
    expect(
      (
        await generateSessions(deps, owner, actor, {
          scheduleId: schedule.id,
          branchId: f.org.branchIds[0]!,
          capacity: 5,
          fromDate: '2026-09-21',
          toDate: '2026-09-27',
        })
      ).kind,
    ).toBe('lifecycleConflict');
  });

  it('fails closed on shape and scope: invalid patterns, foreign program, out-of-scope branch program', async () => {
    expect(
      (
        await createSchedule(deps, owner, actor, {
          programId: f.programId,
          weekdays: [],
          startTime: '16:00',
          endTime: '17:00',
          effectiveStart: '2026-09-01',
        })
      ).kind,
    ).toBe('invalidSchedule');
    expect(
      (
        await createSchedule(deps, owner, actor, {
          programId: f.programId,
          weekdays: [1],
          startTime: '17:00',
          endTime: '16:00',
          effectiveStart: '2026-09-01',
        })
      ).kind,
    ).toBe('invalidSchedule');
    expect(
      (
        await createSchedule(deps, owner, actor, {
          programId: f.programId,
          weekdays: [1],
          startTime: '16:00',
          endTime: '17:00',
          effectiveStart: '2026-09-01',
          registrationCutoffKind: 'minutes_before', // missing minutes
        })
      ).kind,
    ).toBe('invalidSchedule');
    // Foreign program (another org) is not-found-shaped.
    const other = await createBookingFixture(testDb.db);
    expect(
      (
        await createSchedule(deps, owner, actor, {
          programId: other.programId,
          weekdays: [1],
          startTime: '16:00',
          endTime: '17:00',
          effectiveStart: '2026-09-01',
        })
      ).kind,
    ).toBe('programNotFound');
    // A branch-scoped manager whose scope excludes the program's active
    // branch association is refused.
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${f.programId}, ${f.org.branchIds[0]}, ${f.org.orgId})
              ON CONFLICT DO NOTHING`.execute(testDb.db);
    const outOfScope = scopeFor(f.org, 'branch_manager', [newId()]);
    expect(
      (
        await createSchedule(deps, outOfScope, actor, {
          programId: f.programId,
          weekdays: [1],
          startTime: '16:00',
          endTime: '17:00',
          effectiveStart: '2026-09-01',
        })
      ).kind,
    ).toBe('forbidden');
  });

  it('schedule creation with an idempotency key replays; a different payload on the same key conflicts', async () => {
    const key = newId();
    const input = {
      programId: f.programId,
      weekdays: [2],
      startTime: '08:00',
      endTime: '09:00',
      effectiveStart: '2026-09-01',
      idempotencyKey: key,
    };
    const first = await createSchedule(deps, owner, actor, input);
    if (first.kind !== 'scheduleCreated') throw new Error(first.kind);
    const replay = await createSchedule(deps, owner, actor, input);
    if (replay.kind !== 'scheduleCreated') throw new Error(replay.kind);
    expect(replay.schedule.id).toBe(first.schedule.id);
    const conflict = await createSchedule(deps, owner, actor, { ...input, weekdays: [4] });
    expect(conflict.kind).toBe('idempotencyConflict');
  });
});

describe('deterministic idempotent generation (§16: storms + convergence)', () => {
  it('D-9 derivations: default cutoff = session start; minutes_before(n) = start − n; exceptions and effective range excluded; generated sessions open by default', async () => {
    const schedule = await makeSchedule({
      weekdays: [5], // Friday
      registrationCutoffKind: 'minutes_before',
      registrationCutoffMinutes: 60,
      exceptionDates: ['2026-09-18'],
      effectiveEnd: '2026-09-25',
    });
    const gen = await generateSessions(deps, owner, actor, {
      scheduleId: schedule.id,
      branchId: f.org.branchIds[0]!,
      capacity: 8,
      fromDate: '2026-09-01',
      toDate: '2026-09-30',
    });
    if (gen.kind !== 'sessionsGenerated') throw new Error(gen.kind);
    // Fridays in range: 4, 11, 18 (exception), 25 → 3 sessions.
    expect(gen.created).toBe(3);
    const rows = await sql<{ state: string; ok: boolean }>`
      SELECT state, registration_cutoff_at = start_at - interval '60 minutes' AS ok
      FROM session WHERE id = ANY(${gen.sessionIds})`.execute(testDb.db);
    expect(rows.rows.every((row) => row.state === 'open' && row.ok)).toBe(true);
  });

  it('a duplicate generation storm (8 concurrent identical commands) converges on ONE authoritative session per occurrence with one event set', async () => {
    const schedule = await makeSchedule({ weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const command = () =>
      generateSessions(deps, owner, actor, {
        scheduleId: schedule.id,
        branchId: f.org.branchIds[0]!,
        capacity: 5,
        fromDate: '2026-10-01',
        toDate: '2026-10-07',
      });
    const runs = await race(Array.from({ length: 8 }, () => command));
    const totals = runs.map((run) => {
      if (run.kind !== 'sessionsGenerated') throw new Error(run.kind);
      return run.created;
    });
    expect(totals.reduce((a, b) => a + b, 0)).toBe(7); // 7 dates, once each
    const sessions = await sql<{ n: string }>`
      SELECT count(*) AS n FROM session
      WHERE schedule_id = ${schedule.id}
        AND occurrence_date BETWEEN '2026-10-01' AND '2026-10-07'`.execute(testDb.db);
    expect(Number(sessions.rows[0]!.n)).toBe(7);
    // Exactly-once canonical events: one session.created per session.
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'session.created' AND payload->>'scheduleId' = ${schedule.id}`.execute(
      testDb.db,
    );
    expect(Number(events.rows[0]!.n)).toBe(7);
    // A later retry of the same command is a typed no-op.
    const retry = await command();
    if (retry.kind !== 'sessionsGenerated') throw new Error(retry.kind);
    expect(retry.created).toBe(0);
    expect(retry.alreadyExisted).toBe(7);
  });
});

describe('capacity mutation — the certified floor under the S5-2 lock discipline (§16)', () => {
  async function claimedSession(capacity: number, holds: number): Promise<UnitRef> {
    const sessionId = await createSession(f, { capacity });
    const unit: UnitRef = { kind: 'session', id: sessionId };
    for (let i = 0; i < holds; i += 1) {
      const c = await createContender(f, unit);
      const run = await claimHold(deps, { accountId: c.accountId }, {
        unit,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: newId(),
      });
      if (run.outcome.kind !== 'holdClaimed') throw new Error(run.outcome.kind);
    }
    return unit;
  }

  it('increase works (full → open flip, counters preserved); decrease to the exact floor works; below the floor refuses typed with impact counts — active holds count', async () => {
    const unit = await claimedSession(2, 2); // full: 2 active holds
    expect((await reconcileUnit(testDb.db, unit)).state).toBe('full');
    const view = await sql<{ version: number }>`
      SELECT version FROM session WHERE id = ${unit.id}`.execute(testDb.db);
    let version = view.rows[0]!.version;

    const raised = await updateUnitConfig(deps, owner, actor, {
      unit,
      expectedVersion: version,
      patch: { capacity: 5 },
    });
    if (raised.kind !== 'unitUpdated') throw new Error(raised.kind);
    expect(raised.unit.capacity).toBe(5);
    expect(raised.unit.state).toBe('open'); // headroom appeared → flip
    expect(raised.unit.heldCount).toBe(2); // counters preserved
    version = raised.unit.version;

    const toFloor = await updateUnitConfig(deps, owner, actor, {
      unit,
      expectedVersion: version,
      patch: { capacity: 2 },
    });
    if (toFloor.kind !== 'unitUpdated') throw new Error(toFloor.kind);
    expect(toFloor.unit.state).toBe('full');
    version = toFloor.unit.version;

    const below = await updateUnitConfig(deps, owner, actor, {
      unit,
      expectedVersion: version,
      patch: { capacity: 1 },
    });
    expect(below).toEqual({
      kind: 'capacityBelowCommitments',
      capacity: 2,
      bookedCount: 0,
      heldCount: 2,
      floor: 2,
    });
    // The DB CHECK remains the final authority even for direct SQL.
    await expect(
      sql`UPDATE session SET capacity = 1 WHERE id = ${unit.id}`.execute(testDb.db),
    ).rejects.toThrow(/ck_session_capacity/);

    // Stale version refuses with no mutation.
    const stale = await updateUnitConfig(deps, owner, actor, {
      unit,
      expectedVersion: 999,
      patch: { capacity: 10 },
    });
    expect(stale.kind).toBe('staleVersion');
    expect((await reconcileUnit(testDb.db, unit)).capacity).toBe(2);
  });

  it('a capacity reduction RACING the final-seat claim yields one coherent result — never overselling', async () => {
    for (let round = 0; round < 4; round += 1) {
      const sessionId = await createSession(f, { capacity: 2 });
      const unit: UnitRef = { kind: 'session', id: sessionId };
      const first = await createContender(f, unit);
      const firstClaim = await claimHold(deps, { accountId: first.accountId }, {
        unit,
        participantId: first.participantId,
        quoteId: first.quoteId,
        idempotencyKey: newId(),
      });
      expect(firstClaim.outcome.kind).toBe('holdClaimed');
      const challenger = await createContender(f, unit);
      const [claimRun, reduce] = await Promise.all([
        claimHold(deps, { accountId: challenger.accountId }, {
          unit,
          participantId: challenger.participantId,
          quoteId: challenger.quoteId,
          idempotencyKey: newId(),
        }),
        updateUnitConfig(deps, owner, actor, {
          unit,
          expectedVersion: 2, // version after the first claim's flip bump
          patch: { capacity: 1 },
        }),
      ]);
      const rec = await reconcileUnit(testDb.db, unit);
      // Serialized on the unit row lock: either the reduction landed first
      // (claim refused on the shrunk capacity) or the claim landed first
      // (reduction refused below the new floor — or stale-versioned by the
      // claim's own row-version bump). Every outcome is coherent:
      expect(rec.bookedCount + rec.heldCount).toBeLessThanOrEqual(rec.capacity);
      expect(rec.heldCount).toBe(rec.activeHolds);
      if (reduce.kind === 'unitUpdated') {
        expect(rec.capacity).toBe(1);
        expect(claimRun.outcome.kind).toBe('sessionFull');
      } else {
        expect(['capacityBelowCommitments', 'staleVersion']).toContain(reduce.kind);
      }
    }
  });

  it('closing registration RACING a hold claim produces coherent truth (claim refused OR hold retained on the closed unit)', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit: UnitRef = { kind: 'session', id: sessionId };
    const c = await createContender(f, unit);
    const [claimRun, close] = await Promise.all([
      claimHold(deps, { accountId: c.accountId }, {
        unit,
        participantId: c.participantId,
        quoteId: c.quoteId,
        idempotencyKey: newId(),
      }),
      closeUnit(deps, owner, actor, { unit, expectedVersion: 1 }),
    ]);
    const rec = await reconcileUnit(testDb.db, unit);
    if (claimRun.outcome.kind === 'holdClaimed') {
      // Claim won the lock: the hold exists and closing afterwards keeps
      // it UNTOUCHED (nothing is discarded by a status change)…
      expect(rec.heldCount).toBe(1);
      expect(['unitClosed', 'staleVersion'].includes(close.kind)).toBe(true);
    } else {
      // …or closing won and the claim was refused registration.
      expect(claimRun.outcome.kind).toBe('registrationClosed');
      expect(close.kind).toBe('unitClosed');
      expect(rec.heldCount).toBe(0);
    }
    expect(rec.heldCount).toBe(rec.activeHolds);
  });

  it('concurrent capacity edits: one writer wins, the stale writer refuses with no partial state', async () => {
    const sessionId = await createSession(f, { capacity: 5 });
    const unit: UnitRef = { kind: 'session', id: sessionId };
    const [a, b] = await Promise.all([
      updateUnitConfig(deps, owner, actor, { unit, expectedVersion: 1, patch: { capacity: 6 } }),
      updateUnitConfig(deps, owner, actor, { unit, expectedVersion: 1, patch: { capacity: 7 } }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['staleVersion', 'unitUpdated']);
    const rec = await reconcileUnit(testDb.db, unit);
    expect([6, 7]).toContain(rec.capacity);
  });
});

describe('unit lifecycle + reads', () => {
  it('one-off units: scheduled sessions open via the machine edge; closed units refuse claims but keep every hold/booking; no cancel/complete operation exists', async () => {
    const created = await createUnit(deps, owner, actor, {
      kind: 'session',
      programId: f.programId,
      branchId: f.org.branchIds[0]!,
      capacity: 4,
      startAt: '2026-09-10T08:00:00.000Z',
      endAt: '2026-09-10T09:00:00.000Z',
      openRegistration: false,
    });
    if (created.kind !== 'unitCreated') throw new Error(created.kind);
    expect(created.unit.state).toBe('scheduled');
    const unit: UnitRef = { kind: 'session', id: created.unit.id };

    // A scheduled unit refuses customer claims (registrationClosed).
    const early = await createContender(f, unit);
    expect(
      (
        await claimHold(deps, { accountId: early.accountId }, {
          unit,
          participantId: early.participantId,
          quoteId: early.quoteId,
          idempotencyKey: newId(),
        })
      ).outcome.kind,
    ).toBe('registrationClosed');

    const opened = await openUnit(deps, owner, actor, {
      unit,
      expectedVersion: created.unit.version,
    });
    if (opened.kind !== 'unitOpened') throw new Error(opened.kind);
    expect(opened.unit.state).toBe('open');

    const c = await createContender(f, unit);
    const claim = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    expect(claim.outcome.kind).toBe('holdClaimed');

    const closed = await closeUnit(deps, owner, actor, {
      unit,
      expectedVersion: opened.unit.version + 1, // claim bumped the row version
    });
    if (closed.kind !== 'unitClosed') throw new Error(closed.kind);
    // Closing DISCARDED NOTHING: the active hold and its seat survive.
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.activeHolds).toBe(1);
    expect(rec.state).toBe('closed');
    // Reopening a closed unit is not a provider edge (machine: closed is
    // cutoff territory; scheduled→open only).
    expect(
      (await openUnit(deps, owner, actor, { unit, expectedVersion: closed.unit.version })).kind,
    ).toBe('lifecycleConflict');
  });

  it('camp week + cohort creation ride the same machinery; invalid shapes refuse typed', async () => {
    const week = await createUnit(deps, owner, actor, {
      kind: 'campWeek',
      programId: f.programId,
      branchId: f.org.branchIds[0]!,
      capacity: 10,
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      dailyStartTime: '09:00',
      dailyEndTime: '13:00',
      registrationCutoffAt: '2026-10-05T05:00:00.000Z',
    });
    expect(week.kind).toBe('unitCreated');
    const cohort = await createUnit(deps, owner, actor, {
      kind: 'enrolmentCohort',
      programId: f.programId,
      branchId: f.org.branchIds[0]!,
      capacity: 10,
      effectiveStart: '2026-10-01',
      effectiveEnd: '2026-12-31',
      registrationCutoffAt: '2026-10-01T05:00:00.000Z',
    });
    expect(cohort.kind).toBe('unitCreated');
    const invalid = await createUnit(deps, owner, actor, {
      kind: 'campWeek',
      programId: f.programId,
      branchId: f.org.branchIds[0]!,
      capacity: 10,
      startDate: '2026-10-09',
      endDate: '2026-10-05', // reversed
      dailyStartTime: '09:00',
      dailyEndTime: '13:00',
      registrationCutoffAt: '2026-10-05T05:00:00.000Z',
    });
    expect(invalid.kind).toBe('invalidUnit');
  });

  it('roster: bookings with PII-lean projection; ACTIVE HOLDS appear only in heldCount, never as roster entries; branch scope enforced', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const unit: UnitRef = { kind: 'session', id: sessionId };
    // One active hold + one hold with a pending booking (raw, the certified
    // S5-1 shape) so the projection distinction is visible.
    const holder = await createContender(f, unit);
    const holdRun = await claimHold(deps, { accountId: holder.accountId }, {
      unit,
      participantId: holder.participantId,
      quoteId: holder.quoteId,
      idempotencyKey: newId(),
    });
    if (holdRun.outcome.kind !== 'holdClaimed') throw new Error(holdRun.outcome.kind);
    const booker = await createContender(f, unit);
    const bookerHold = await claimHold(deps, { accountId: booker.accountId }, {
      unit,
      participantId: booker.participantId,
      quoteId: booker.quoteId,
      idempotencyKey: newId(),
    });
    if (bookerHold.outcome.kind !== 'holdClaimed') throw new Error(bookerHold.outcome.kind);
    await sql`INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                                   branch_id, option_kind, session_id, quote_id, hold_id)
              VALUES (${newId()}, ${booker.accountId}, ${booker.participantId}, ${f.programId},
                      ${f.org.orgId}, ${f.org.branchIds[0]}, 'dropIn', ${sessionId},
                      ${booker.quoteId}, ${bookerHold.outcome.hold.holdId})`.execute(testDb.db);

    const roster = await unitRoster(deps, owner, { unit });
    if (roster.kind !== 'roster') throw new Error(roster.kind);
    // Occupancy is authoritative-counter truth: two holds counted…
    expect(roster.unit.heldCount).toBe(2);
    expect(roster.unit.bookedCount).toBe(0);
    // …but the roster lists only BOOKINGS (one, pending), never holds, and
    // carries no contact/account/payment data.
    expect(roster.entries).toHaveLength(1);
    expect(roster.entries[0]!.state).toBe('pending_payment');
    expect(roster.entries[0]!.referenceCode).toBeNull();
    expect(Object.keys(roster.entries[0]!).sort()).toEqual(
      ['confirmedAt', 'createdAt', 'participant', 'referenceCode', 'state'].sort(),
    );
    expect(Object.keys(roster.entries[0]!.participant).sort()).toEqual(['firstName', 'kind']);

    // Cross-org: not-found-shaped. Out-of-branch-scope: forbidden.
    const foreignOrg = await createBookingFixture(testDb.db);
    expect((await unitRoster(deps, scopeFor(foreignOrg.org), { unit })).kind).toBe('unitNotFound');
    const outOfScope = scopeFor(f.org, 'branch_manager', [newId()]);
    expect((await unitRoster(deps, outOfScope, { unit })).kind).toBe('forbidden');
  });

  it('unit listing is org-scoped and branch-filtered', async () => {
    const listed = await listUnits(deps, owner, { kind: 'session', programId: f.programId });
    if (listed.kind !== 'units') throw new Error(listed.kind);
    expect(listed.units.length).toBeGreaterThan(0);
    const foreignOrg = await createBookingFixture(testDb.db);
    expect(
      (await listUnits(deps, scopeFor(foreignOrg.org), { kind: 'session', programId: f.programId }))
        .kind,
    ).toBe('programNotFound');
  });

  it('provider commands can NEVER write counters: no service input reaches held_count/booked_count, and the S5-2/S5-3 counters survive every status mutation', async () => {
    const sessionId = await createSession(f, { capacity: 2 });
    const unit: UnitRef = { kind: 'session', id: sessionId };
    const c = await createContender(f, unit);
    const claim = await claimHold(deps, { accountId: c.accountId }, {
      unit,
      participantId: c.participantId,
      quoteId: c.quoteId,
      idempotencyKey: newId(),
    });
    expect(claim.outcome.kind).toBe('holdClaimed');
    // Exercise every provider mutation on the unit; counters never move.
    let version = 2; // claim bumped it
    const edit = await updateUnitConfig(deps, owner, actor, {
      unit,
      expectedVersion: version,
      patch: { capacity: 3, registrationCutoffAt: '2026-09-01T07:00:00.000Z' },
    });
    if (edit.kind !== 'unitUpdated') throw new Error(edit.kind);
    version = edit.unit.version;
    const close = await closeUnit(deps, owner, actor, { unit, expectedVersion: version });
    if (close.kind !== 'unitClosed') throw new Error(close.kind);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    expect(rec.bookedCount).toBe(0);
    expect(rec.activeHolds).toBe(1);
  });
});
