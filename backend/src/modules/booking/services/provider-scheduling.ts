/**
 * Provider RecurringSchedule administration + session generation — S5-4
 * (docs/32 §11; docs/24 §2.3; rulings D-9, A1.1).
 *
 * Schedules are PURELY TEMPORAL (A1.1): they define when sessions occur,
 * never how many may join — no capacity value exists here, and generation
 * takes the capacity/branch COMMAND input per call. Editing a schedule
 * changes only what FUTURE generation materializes: already-generated
 * sessions are standalone capacity units and are never rewritten,
 * re-timed, or cancelled by a schedule edit (the controlled-disruption
 * workflow is the only path that may touch committed inventory).
 *
 * Generation (docs/32 §3 row 1) is deterministic and idempotent: the
 * occurrence set is a pure function of (schedule pattern, exceptions,
 * effective range, requested window), and every insert rides
 * `ON CONFLICT (schedule_id, occurrence_date) DO NOTHING` against the
 * S5-1 generation-identity unique index — retries and concurrent requests
 * converge on ONE authoritative session per occurrence, and only genuinely
 * created rows emit events (replays emit nothing). D-9: generated sessions
 * open registration by default; the cutoff derives from the schedule's
 * rule (`at_start` → session start, `minutes_before(n)` → start − n).
 *
 * Cross-module note (docs/25 §2): this module consumes the certified
 * catalogue helpers (`programInBranchScope`) and the provider `OrgScope` —
 * organization binding is server-side on every operation; foreign ids are
 * not-found-shaped by construction.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import { withTransaction, type Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { branchInScope, type OrgScope } from '../../provider/services/provider-principal';
import { programInBranchScope } from '../../catalogue/services/catalogue-shared';
import type { BookingServiceDeps } from './booking-shared';

export interface ProviderActor {
  userId: string;
}

export const CUTOFF_KINDS = ['at_start', 'minutes_before'] as const;
export type CutoffKind = (typeof CUTOFF_KINDS)[number];

export interface ScheduleView {
  id: string;
  programId: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  timezone: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  exceptionDates: string[];
  registrationCutoffKind: string;
  registrationCutoffMinutes: number | null;
  instructorStaffId: string | null;
  state: string;
  version: number;
}

const SCHEDULE_COLUMNS = [
  'id',
  'program_id',
  'weekdays',
  'start_time',
  'end_time',
  'timezone',
  'effective_start',
  'effective_end',
  'exception_dates',
  'registration_cutoff_kind',
  'registration_cutoff_minutes',
  'instructor_staff_id',
  'state',
  'version',
] as const;

interface ScheduleRow {
  id: string;
  program_id: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  timezone: string;
  effective_start: Date;
  effective_end: Date | null;
  exception_dates: Date[];
  registration_cutoff_kind: string;
  registration_cutoff_minutes: number | null;
  instructor_staff_id: string | null;
  state: string;
  version: number;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toView(row: ScheduleRow): ScheduleView {
  return {
    id: row.id,
    programId: row.program_id,
    weekdays: row.weekdays,
    startTime: String(row.start_time).slice(0, 5),
    endTime: String(row.end_time).slice(0, 5),
    timezone: row.timezone,
    effectiveStart: isoDate(row.effective_start),
    effectiveEnd: row.effective_end === null ? null : isoDate(row.effective_end),
    exceptionDates: row.exception_dates.map(isoDate),
    registrationCutoffKind: row.registration_cutoff_kind,
    registrationCutoffMinutes: row.registration_cutoff_minutes,
    instructorStaffId: row.instructor_staff_id,
    state: row.state,
    version: row.version,
  };
}

async function findOrgSchedule(
  trx: Trx,
  scope: OrgScope,
  scheduleId: string,
): Promise<ScheduleRow | undefined> {
  return trx
    .selectFrom('recurring_schedule')
    .select(SCHEDULE_COLUMNS)
    .where('id', '=', scheduleId)
    .where('organization_id', '=', scope.organizationId)
    .executeTakeFirst() as Promise<ScheduleRow | undefined>;
}

async function emitScheduleEvent(
  trx: Trx,
  actor: ProviderActor,
  scope: OrgScope,
  scheduleId: string,
  eventType: 'schedule.created' | 'schedule.updated' | 'schedule.ended',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: actor.userId,
    principalContext: 'provider',
    action: eventType,
    entityType: 'recurring_schedule',
    entityId: scheduleId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'recurring_schedule',
    aggregateId: scheduleId,
    eventType,
    payload: { scheduleId, organizationId: scope.organizationId, ...extra },
  });
}

// ---------------------------------------------------------------------------
// Create schedule
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  programId: string;
  weekdays: number[];
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  effectiveStart: string; // YYYY-MM-DD
  effectiveEnd?: string;
  exceptionDates?: string[];
  registrationCutoffKind?: CutoffKind; // D-9 default at_start
  registrationCutoffMinutes?: number;
  instructorStaffId?: string;
  /** Optional network-retry protection (docs/32 §14). */
  idempotencyKey?: string;
}

export type CreateScheduleResult =
  | { kind: 'scheduleCreated'; schedule: ScheduleView }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'invalidSchedule' }
  | { kind: 'idempotencyConflict' };

export async function createSchedule(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: CreateScheduleInput,
): Promise<CreateScheduleResult> {
  const run = async (trx: Trx): Promise<CreateScheduleResult> => {
    const program = await trx
      .selectFrom('program')
      .select('id')
      .where('id', '=', input.programId)
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    if (program === undefined) return { kind: 'programNotFound' };
    if (!(await programInBranchScope(trx, scope, input.programId))) {
      return { kind: 'forbidden' };
    }
    if (!scheduleShapeValid(input)) return { kind: 'invalidSchedule' };
    const id = newId();
    await sql`
      INSERT INTO recurring_schedule (id, program_id, organization_id, weekdays, start_time,
                                      end_time, effective_start, effective_end, exception_dates,
                                      registration_cutoff_kind, registration_cutoff_minutes,
                                      instructor_staff_id)
      VALUES (${id}, ${input.programId}, ${scope.organizationId},
              ${input.weekdays}::smallint[], ${input.startTime}, ${input.endTime},
              ${input.effectiveStart}, ${input.effectiveEnd ?? null},
              ${input.exceptionDates ?? []}::date[],
              ${input.registrationCutoffKind ?? 'at_start'},
              ${input.registrationCutoffMinutes ?? null},
              ${input.instructorStaffId ?? null})`.execute(trx);
    await emitScheduleEvent(trx, actor, scope, id, 'schedule.created', {
      programId: input.programId,
    });
    const created = await findOrgSchedule(trx, scope, id);
    return { kind: 'scheduleCreated', schedule: toView(created!) };
  };

  if (input.idempotencyKey === undefined) {
    return withTransaction(deps.db, run);
  }
  const { idempotencyKey, ...logical } = input;
  const outcome = await runIdempotent<CreateScheduleResult>(
    deps.db,
    {
      principalRef: `provider:${scope.membershipId}`,
      endpointScope: 'provider.schedule.create',
      idempotencyKey,
      requestDigest: requestDigest(logical),
    },
    run,
  );
  if (outcome.kind === 'idempotencyConflict') return { kind: 'idempotencyConflict' };
  return outcome.result;
}

function scheduleShapeValid(input: {
  weekdays: number[];
  startTime: string;
  endTime: string;
  effectiveStart: string;
  effectiveEnd?: string | undefined;
  registrationCutoffKind?: CutoffKind | undefined;
  registrationCutoffMinutes?: number | undefined;
}): boolean {
  if (input.weekdays.length === 0) return false;
  if (new Set(input.weekdays).size !== input.weekdays.length) return false;
  if (!input.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return false;
  if (input.endTime <= input.startTime) return false;
  if (input.effectiveEnd !== undefined && input.effectiveEnd < input.effectiveStart) return false;
  const kind = input.registrationCutoffKind ?? 'at_start';
  if ((kind === 'minutes_before') !== (input.registrationCutoffMinutes !== undefined)) return false;
  if (input.registrationCutoffMinutes !== undefined && input.registrationCutoffMinutes <= 0) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Update / end schedule (CAS; future-generation-only effect)
// ---------------------------------------------------------------------------

export interface UpdateSchedulePatch {
  weekdays?: number[];
  startTime?: string;
  endTime?: string;
  effectiveEnd?: string | null;
  exceptionDates?: string[];
  registrationCutoffKind?: CutoffKind;
  registrationCutoffMinutes?: number | null;
  instructorStaffId?: string | null;
}

export type UpdateScheduleResult =
  | { kind: 'scheduleUpdated'; schedule: ScheduleView }
  | { kind: 'scheduleNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' }
  | { kind: 'invalidSchedule' };

export async function updateSchedule(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { scheduleId: string; expectedVersion: number; patch: UpdateSchedulePatch },
): Promise<UpdateScheduleResult> {
  return withTransaction(deps.db, async (trx) => {
    const row = await findOrgSchedule(trx, scope, input.scheduleId);
    if (row === undefined) return { kind: 'scheduleNotFound' };
    if (!(await programInBranchScope(trx, scope, row.program_id))) {
      return { kind: 'forbidden' };
    }
    if (row.state !== 'active') return { kind: 'lifecycleConflict' };
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' };

    const merged = {
      weekdays: input.patch.weekdays ?? row.weekdays,
      startTime: input.patch.startTime ?? String(row.start_time).slice(0, 5),
      endTime: input.patch.endTime ?? String(row.end_time).slice(0, 5),
      effectiveStart: isoDate(row.effective_start),
      effectiveEnd:
        input.patch.effectiveEnd === undefined
          ? (row.effective_end === null ? undefined : isoDate(row.effective_end))
          : (input.patch.effectiveEnd ?? undefined),
      registrationCutoffKind: (input.patch.registrationCutoffKind ??
        row.registration_cutoff_kind) as CutoffKind,
      registrationCutoffMinutes:
        input.patch.registrationCutoffMinutes === undefined
          ? (row.registration_cutoff_minutes ?? undefined)
          : (input.patch.registrationCutoffMinutes ?? undefined),
    };
    if (!scheduleShapeValid(merged)) return { kind: 'invalidSchedule' };

    // CAS on version; identity columns are trigger-immutable. The edit
    // affects ONLY future generation — existing sessions stay untouched.
    const updated = await sql`
      UPDATE recurring_schedule
      SET weekdays = ${merged.weekdays}::smallint[],
          start_time = ${merged.startTime}, end_time = ${merged.endTime},
          effective_end = ${merged.effectiveEnd ?? null},
          exception_dates = ${input.patch.exceptionDates ?? row.exception_dates.map(isoDate)}::date[],
          registration_cutoff_kind = ${merged.registrationCutoffKind},
          registration_cutoff_minutes = ${merged.registrationCutoffMinutes ?? null},
          instructor_staff_id = ${
            input.patch.instructorStaffId === undefined
              ? row.instructor_staff_id
              : input.patch.instructorStaffId
          }
      WHERE id = ${input.scheduleId} AND version = ${input.expectedVersion}
        AND state = 'active'`.execute(trx);
    if (Number(updated.numAffectedRows ?? 0) !== 1) return { kind: 'staleVersion' };
    await emitScheduleEvent(trx, actor, scope, input.scheduleId, 'schedule.updated');
    const fresh = await findOrgSchedule(trx, scope, input.scheduleId);
    return { kind: 'scheduleUpdated', schedule: toView(fresh!) };
  });
}

export type EndScheduleResult =
  | { kind: 'scheduleEnded' }
  | { kind: 'scheduleNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function endSchedule(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { scheduleId: string; expectedVersion: number },
): Promise<EndScheduleResult> {
  return withTransaction(deps.db, async (trx) => {
    const row = await findOrgSchedule(trx, scope, input.scheduleId);
    if (row === undefined) return { kind: 'scheduleNotFound' };
    if (!(await programInBranchScope(trx, scope, row.program_id))) {
      return { kind: 'forbidden' };
    }
    if (row.state !== 'active') return { kind: 'lifecycleConflict' };
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' };
    const updated = await sql`
      UPDATE recurring_schedule SET state = 'ended'
      WHERE id = ${input.scheduleId} AND version = ${input.expectedVersion}
        AND state = 'active'`.execute(trx);
    if (Number(updated.numAffectedRows ?? 0) !== 1) return { kind: 'staleVersion' };
    await emitScheduleEvent(trx, actor, scope, input.scheduleId, 'schedule.ended');
    return { kind: 'scheduleEnded' };
  });
}

export async function listSchedules(
  deps: BookingServiceDeps,
  scope: OrgScope,
  input: { programId: string },
): Promise<{ kind: 'schedules'; schedules: ScheduleView[] } | { kind: 'programNotFound' }> {
  return withTransaction(deps.db, async (trx) => {
    const program = await trx
      .selectFrom('program')
      .select('id')
      .where('id', '=', input.programId)
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    if (program === undefined) return { kind: 'programNotFound' as const };
    const rows = (await trx
      .selectFrom('recurring_schedule')
      .select(SCHEDULE_COLUMNS)
      .where('program_id', '=', input.programId)
      .orderBy('created_at')
      .execute()) as ScheduleRow[];
    return { kind: 'schedules' as const, schedules: rows.map(toView) };
  });
}

// ---------------------------------------------------------------------------
// Session generation (deterministic, idempotent, concurrency-safe)
// ---------------------------------------------------------------------------

/** Generation window bound: keeps one command's transaction (and its event
 *  emission) small; longer horizons are repeated bounded commands. */
export const MAX_GENERATION_DAYS = 62;

export interface GenerateSessionsInput {
  scheduleId: string;
  branchId: string;
  capacity: number;
  fromDate: string; // YYYY-MM-DD inclusive
  toDate: string; // YYYY-MM-DD inclusive
}

export type GenerateSessionsResult =
  | {
      kind: 'sessionsGenerated';
      /** Sessions genuinely created by THIS command. */
      created: number;
      /** Occurrences that already existed (idempotent replay/retry). */
      alreadyExisted: number;
      sessionIds: string[];
    }
  | { kind: 'scheduleNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'invalidGeneration' }
  | { kind: 'invalidBranch' };

export async function generateSessions(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: GenerateSessionsInput,
): Promise<GenerateSessionsResult> {
  return withTransaction(deps.db, async (trx) => {
    const schedule = await findOrgSchedule(trx, scope, input.scheduleId);
    if (schedule === undefined) return { kind: 'scheduleNotFound' };
    if (!(await programInBranchScope(trx, scope, schedule.program_id))) {
      return { kind: 'forbidden' };
    }
    if (schedule.state !== 'active') return { kind: 'lifecycleConflict' };
    if (!branchInScope(scope, input.branchId)) return { kind: 'forbidden' };
    const branch = await trx
      .selectFrom('branch')
      .select(['id', 'active'])
      .where('id', '=', input.branchId)
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    if (branch === undefined || !branch.active) return { kind: 'invalidBranch' };

    const from = new Date(`${input.fromDate}T00:00:00.000Z`);
    const to = new Date(`${input.toDate}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      return { kind: 'invalidGeneration' };
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_GENERATION_DAYS) return { kind: 'invalidGeneration' };
    if (!Number.isInteger(input.capacity) || input.capacity < 0) {
      return { kind: 'invalidGeneration' };
    }

    // Deterministic occurrence set: pattern ∩ window ∩ effective range,
    // minus exceptions. Weekday is evaluated on the civil date (0=Sunday).
    const exceptions = new Set(schedule.exception_dates.map(isoDate));
    const effectiveStart = isoDate(schedule.effective_start);
    const effectiveEnd = schedule.effective_end === null ? null : isoDate(schedule.effective_end);
    const occurrences: string[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = new Date(from.getTime() + i * 86_400_000);
      const dateIso = isoDate(date);
      if (!schedule.weekdays.includes(date.getUTCDay())) continue;
      if (dateIso < effectiveStart) continue;
      if (effectiveEnd !== null && dateIso > effectiveEnd) continue;
      if (exceptions.has(dateIso)) continue;
      occurrences.push(dateIso);
    }

    const sessionIds: string[] = [];
    let created = 0;
    for (const occurrenceDate of occurrences) {
      const id = newId();
      // D-9: start/end from the schedule's Asia/Dubai wall-clock times;
      // cutoff at_start → start, minutes_before(n) → start − n minutes.
      // Idempotency + concurrency safety are the S5-1 generation-identity
      // unique index: conflicting inserts are no-ops with NO event.
      const inserted = await sql<{ id: string }>`
        INSERT INTO session (id, program_id, organization_id, branch_id, schedule_id,
                             occurrence_date, start_at, end_at, capacity,
                             registration_cutoff_at, instructor_staff_id)
        SELECT ${id}, ${schedule.program_id}, ${scope.organizationId}, ${input.branchId},
               ${input.scheduleId}, ${occurrenceDate},
               start_at, end_at, ${input.capacity},
               CASE WHEN ${schedule.registration_cutoff_kind} = 'minutes_before'
                    THEN start_at - make_interval(mins => ${schedule.registration_cutoff_minutes ?? 0})
                    ELSE start_at END,
               ${schedule.instructor_staff_id}
        FROM (SELECT
                ((${occurrenceDate} || ' ' || ${String(schedule.start_time)})::timestamp
                  AT TIME ZONE ${schedule.timezone}) AS start_at,
                ((${occurrenceDate} || ' ' || ${String(schedule.end_time)})::timestamp
                  AT TIME ZONE ${schedule.timezone}) AS end_at) AS derived
        ON CONFLICT (schedule_id, occurrence_date) WHERE schedule_id IS NOT NULL DO NOTHING
        RETURNING id`.execute(trx);
      if (inserted.rows.length === 1) {
        created += 1;
        sessionIds.push(id);
        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.userId,
          principalContext: 'provider',
          action: 'session.created',
          entityType: 'session',
          entityId: id,
        });
        await appendOutboxEvent(trx, {
          aggregateType: 'session',
          aggregateId: id,
          eventType: 'session.created',
          payload: {
            sessionId: id,
            scheduleId: input.scheduleId,
            programId: schedule.program_id,
            organizationId: scope.organizationId,
            occurrenceDate,
          },
        });
      }
    }
    return {
      kind: 'sessionsGenerated',
      created,
      alreadyExisted: occurrences.length - created,
      sessionIds,
    };
  });
}
