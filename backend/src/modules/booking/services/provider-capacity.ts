/**
 * Provider capacity-unit administration + operational reads — S5-4
 * (docs/32 §11, §3; docs/24 §2.3–§2.4, §5.4; rulings D-5, D-9).
 *
 * Provider inputs are COMMANDS, never authoritative counters: no input
 * anywhere carries `held_count`, `booked_count`, or a derived availability;
 * the database's S5-1 CHECK + the S5-2 unit-row-lock discipline remain the
 * only capacity authority. Capacity edits take the SAME unit FOR UPDATE
 * lock as the customer claim path, so a provider reduction and a customer
 * claim serialize on one row and can never oversell together.
 *
 * The capacity floor is typed here (`capacityBelowCommitments`, with the
 * structured impact counts) and enforced finally by `ck_*_capacity`:
 * reducing below `booked_count + held_count` is refused — the ONLY path
 * below existing commitments is the controlled-disruption workflow (D-5:
 * latest-confirmed-first is candidate SELECTION only, never automatic
 * cancellation), which is NOT part of S5-4; accordingly no operation here
 * can cancel a unit, discard a hold, or touch a confirmed booking.
 *
 * Status mutations expose exactly the §5.4 machine edges a provider may
 * drive: `scheduled → open` (open registration) and `open|full → closed`
 * (close registration; existing holds/bookings untouched). `open ⇄ full`
 * stays automatic-only; `cancelled_by_provider` and `completed` have no
 * provider route.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import { withTransaction, type Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { branchInScope, type OrgScope } from '../../provider/services/provider-principal';
import { programInBranchScope } from '../../catalogue/services/catalogue-shared';
import { unitSpec, type BookingServiceDeps, type UnitKind, type UnitRef } from './booking-shared';
import type { ProviderActor } from './provider-scheduling';

const EVENT_PREFIX: Record<UnitKind, string> = {
  session: 'session',
  campWeek: 'camp_week',
  enrolmentCohort: 'enrolment_cohort',
};

export interface UnitView {
  id: string;
  kind: UnitKind;
  programId: string;
  branchId: string;
  capacity: number;
  bookedCount: number;
  heldCount: number;
  state: string;
  registrationCutoffAt: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  scheduleId: string | null;
  version: number;
}

interface UnitRow {
  id: string;
  program_id: string;
  branch_id: string;
  capacity: number;
  booked_count: number;
  held_count: number;
  state: string;
  cutoff_at: Date;
  start_at: Date | null;
  end_at: Date | null;
  start_date: Date | null;
  end_date: Date | null;
  effective_start: Date | null;
  effective_end: Date | null;
  schedule_id: string | null;
  version: number;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function unitSelect(kind: UnitKind): string {
  if (kind === 'session') {
    return `id, program_id, branch_id, capacity, booked_count, held_count, state,
            registration_cutoff_at AS cutoff_at, start_at, end_at,
            NULL::date AS start_date, NULL::date AS end_date,
            NULL::date AS effective_start, NULL::date AS effective_end,
            schedule_id, version`;
  }
  if (kind === 'campWeek') {
    return `id, program_id, branch_id, capacity, booked_count, held_count, state,
            registration_cutoff_at AS cutoff_at, NULL::timestamptz AS start_at,
            NULL::timestamptz AS end_at, start_date, end_date,
            NULL::date AS effective_start, NULL::date AS effective_end,
            NULL::uuid AS schedule_id, version`;
  }
  return `id, program_id, branch_id, capacity, booked_count, held_count, state,
          enrolment_cutoff_at AS cutoff_at, NULL::timestamptz AS start_at,
          NULL::timestamptz AS end_at, NULL::date AS start_date, NULL::date AS end_date,
          effective_start, effective_end, NULL::uuid AS schedule_id, version`;
}

function toView(kind: UnitKind, row: UnitRow): UnitView {
  return {
    id: row.id,
    kind,
    programId: row.program_id,
    branchId: row.branch_id,
    capacity: row.capacity,
    bookedCount: row.booked_count,
    heldCount: row.held_count,
    state: row.state,
    registrationCutoffAt: row.cutoff_at.toISOString(),
    startAt: row.start_at === null ? null : row.start_at.toISOString(),
    endAt: row.end_at === null ? null : row.end_at.toISOString(),
    startDate: row.start_date === null ? null : isoDate(row.start_date),
    endDate: row.end_date === null ? null : isoDate(row.end_date),
    effectiveStart: row.effective_start === null ? null : isoDate(row.effective_start),
    effectiveEnd: row.effective_end === null ? null : isoDate(row.effective_end),
    scheduleId: row.schedule_id,
    version: row.version,
  };
}

/** Org-scoped locked read — the SAME unit-row FOR UPDATE discipline as the
 *  S5-2 claim path; foreign/cross-org ids are not-found-shaped. */
async function lockOrgUnit(
  trx: Trx,
  scope: OrgScope,
  unit: UnitRef,
): Promise<UnitRow | undefined> {
  const spec = unitSpec(unit.kind);
  const result = await sql<UnitRow>`
    SELECT ${sql.raw(unitSelect(unit.kind))}
    FROM ${sql.id(spec.table)}
    WHERE id = ${unit.id} AND organization_id = ${scope.organizationId}
    FOR UPDATE`.execute(trx);
  return result.rows[0];
}

async function emitUnitEvent(
  trx: Trx,
  actor: ProviderActor,
  scope: OrgScope,
  unit: UnitRef,
  suffix: 'created' | 'updated' | 'opened' | 'closed',
  extra: Record<string, unknown> = {},
): Promise<void> {
  const eventType = `${EVENT_PREFIX[unit.kind]}.${suffix}`;
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: actor.userId,
    principalContext: 'provider',
    action: eventType,
    entityType: EVENT_PREFIX[unit.kind],
    entityId: unit.id,
  });
  await appendOutboxEvent(trx, {
    aggregateType: EVENT_PREFIX[unit.kind],
    aggregateId: unit.id,
    eventType,
    payload: { unitKind: unit.kind, unitId: unit.id, organizationId: scope.organizationId, ...extra },
  });
}

// ---------------------------------------------------------------------------
// One-off unit creation
// ---------------------------------------------------------------------------

export interface CreateUnitInput {
  kind: UnitKind;
  programId: string;
  branchId: string;
  capacity: number;
  /** D-9: omitted → unit start (session) / provided value required for
   *  camp weeks and cohorts where no single start instant exists. */
  registrationCutoffAt?: string;
  /** D-9: sessions open registration by default; `false` keeps a session
   *  deliberately future-gated at `scheduled`. */
  openRegistration?: boolean;
  // session
  startAt?: string;
  endAt?: string;
  instructorStaffId?: string;
  // campWeek
  startDate?: string;
  endDate?: string;
  dailyStartTime?: string;
  dailyEndTime?: string;
  // enrolmentCohort
  effectiveStart?: string;
  effectiveEnd?: string;
  /** Optional network-retry protection (docs/32 §14). */
  idempotencyKey?: string;
}

export type CreateUnitResult =
  | { kind: 'unitCreated'; unit: UnitView }
  | { kind: 'programNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'invalidBranch' }
  | { kind: 'invalidUnit' }
  | { kind: 'idempotencyConflict' };

export async function createUnit(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: CreateUnitInput,
): Promise<CreateUnitResult> {
  const run = async (trx: Trx): Promise<CreateUnitResult> => {
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
    if (!branchInScope(scope, input.branchId)) return { kind: 'forbidden' };
    const branch = await trx
      .selectFrom('branch')
      .select(['id', 'active'])
      .where('id', '=', input.branchId)
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    if (branch === undefined || !branch.active) return { kind: 'invalidBranch' };
    if (!Number.isInteger(input.capacity) || input.capacity < 0) return { kind: 'invalidUnit' };

    const id = newId();
    if (input.kind === 'session') {
      if (input.startAt === undefined || input.endAt === undefined) return { kind: 'invalidUnit' };
      if (input.endAt <= input.startAt) return { kind: 'invalidUnit' };
      const state = input.openRegistration === false ? 'scheduled' : 'open';
      await sql`
        INSERT INTO session (id, program_id, organization_id, branch_id, start_at, end_at,
                             capacity, state, registration_cutoff_at, instructor_staff_id)
        VALUES (${id}, ${input.programId}, ${scope.organizationId}, ${input.branchId},
                ${input.startAt}, ${input.endAt}, ${input.capacity}, ${state},
                ${input.registrationCutoffAt ?? input.startAt},
                ${input.instructorStaffId ?? null})`.execute(trx);
    } else if (input.kind === 'campWeek') {
      if (
        input.startDate === undefined ||
        input.endDate === undefined ||
        input.dailyStartTime === undefined ||
        input.dailyEndTime === undefined ||
        input.registrationCutoffAt === undefined
      ) {
        return { kind: 'invalidUnit' };
      }
      if (input.endDate < input.startDate || input.dailyEndTime <= input.dailyStartTime) {
        return { kind: 'invalidUnit' };
      }
      await sql`
        INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date, end_date,
                               daily_start_time, daily_end_time, capacity, registration_cutoff_at)
        VALUES (${id}, ${input.programId}, ${scope.organizationId}, ${input.branchId},
                ${input.startDate}, ${input.endDate}, ${input.dailyStartTime},
                ${input.dailyEndTime}, ${input.capacity}, ${input.registrationCutoffAt})`.execute(
        trx,
      );
    } else {
      if (
        input.effectiveStart === undefined ||
        input.effectiveEnd === undefined ||
        input.registrationCutoffAt === undefined
      ) {
        return { kind: 'invalidUnit' };
      }
      if (input.effectiveEnd < input.effectiveStart) return { kind: 'invalidUnit' };
      await sql`
        INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                      effective_start, effective_end, capacity,
                                      enrolment_cutoff_at)
        VALUES (${id}, ${input.programId}, ${scope.organizationId}, ${input.branchId},
                ${input.effectiveStart}, ${input.effectiveEnd}, ${input.capacity},
                ${input.registrationCutoffAt})`.execute(trx);
    }
    const unitRef: UnitRef = { kind: input.kind, id };
    await emitUnitEvent(trx, actor, scope, unitRef, 'created', { programId: input.programId });
    const row = await lockOrgUnit(trx, scope, unitRef);
    return { kind: 'unitCreated', unit: toView(input.kind, row!) };
  };

  if (input.idempotencyKey === undefined) {
    return withTransaction(deps.db, run);
  }
  const { idempotencyKey, ...logical } = input;
  const outcome = await runIdempotent<CreateUnitResult>(
    deps.db,
    {
      principalRef: `provider:${scope.membershipId}`,
      endpointScope: 'provider.unit.create',
      idempotencyKey,
      requestDigest: requestDigest(logical),
    },
    run,
  );
  if (outcome.kind === 'idempotencyConflict') return { kind: 'idempotencyConflict' };
  return outcome.result;
}

// ---------------------------------------------------------------------------
// Configuration edit (capacity/cutoff/times) — CAS + floor under the lock
// ---------------------------------------------------------------------------

export interface UpdateUnitPatch {
  capacity?: number;
  registrationCutoffAt?: string;
  startAt?: string; // session only
  endAt?: string; // session only
  instructorStaffId?: string | null; // session only
}

export type UpdateUnitResult =
  | { kind: 'unitUpdated'; unit: UnitView }
  | { kind: 'unitNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' }
  | { kind: 'invalidUnit' }
  | {
      kind: 'capacityBelowCommitments';
      capacity: number;
      bookedCount: number;
      heldCount: number;
      /** The lowest legal capacity right now (the committed floor). */
      floor: number;
    };

export async function updateUnitConfig(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { unit: UnitRef; expectedVersion: number; patch: UpdateUnitPatch },
): Promise<UpdateUnitResult> {
  const spec = unitSpec(input.unit.kind);
  return withTransaction(deps.db, async (trx) => {
    const row = await lockOrgUnit(trx, scope, input.unit);
    if (row === undefined) return { kind: 'unitNotFound' };
    if (!(await programInBranchScope(trx, scope, row.program_id))) {
      return { kind: 'forbidden' };
    }
    if (!branchInScope(scope, row.branch_id)) return { kind: 'forbidden' };
    if (['completed', 'cancelled_by_provider'].includes(row.state)) {
      return { kind: 'lifecycleConflict' };
    }
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' };

    if (input.unit.kind !== 'session') {
      if (
        input.patch.startAt !== undefined ||
        input.patch.endAt !== undefined ||
        input.patch.instructorStaffId !== undefined
      ) {
        return { kind: 'invalidUnit' };
      }
    }
    const newCapacity = input.patch.capacity ?? row.capacity;
    if (!Number.isInteger(newCapacity) || newCapacity < 0) return { kind: 'invalidUnit' };
    const floor = row.booked_count + row.held_count;
    if (newCapacity < floor) {
      // Typed floor refusal with the structured impact counts (docs/32 §3);
      // reducing committed capacity belongs to the controlled-disruption
      // workflow (D-5) — NOT to a capacity edit, and never silently.
      return {
        kind: 'capacityBelowCommitments',
        capacity: row.capacity,
        bookedCount: row.booked_count,
        heldCount: row.held_count,
        floor,
      };
    }
    const startAt = input.patch.startAt ?? row.start_at?.toISOString();
    const endAt = input.patch.endAt ?? row.end_at?.toISOString();
    if (input.unit.kind === 'session' && startAt !== undefined && endAt !== undefined && endAt <= startAt) {
      return { kind: 'invalidUnit' };
    }

    // One CAS UPDATE under the unit lock. The automatic open⇄full flip is
    // re-evaluated against the NEW capacity (a raise on a full unit reopens
    // it; counters themselves are untouchable by this statement — the
    // ck_*_capacity CHECK is the final floor authority under any bug here).
    const newCutoff = input.patch.registrationCutoffAt ?? row.cutoff_at.toISOString();
    const stateFlip = sql`
      state = CASE
        WHEN state IN ('open', 'full')
          THEN CASE WHEN booked_count + held_count >= ${newCapacity}
                    THEN 'full' ELSE 'open' END
        ELSE state
      END`;
    const updated =
      input.unit.kind === 'session'
        ? await sql`
            UPDATE session
            SET capacity = ${newCapacity}, registration_cutoff_at = ${newCutoff},
                start_at = ${startAt!}, end_at = ${endAt!},
                instructor_staff_id = CASE WHEN ${input.patch.instructorStaffId !== undefined}
                                           THEN ${input.patch.instructorStaffId ?? null}::uuid
                                           ELSE instructor_staff_id END,
                ${stateFlip}
            WHERE id = ${input.unit.id} AND version = ${input.expectedVersion}`.execute(trx)
        : await sql`
            UPDATE ${sql.id(spec.table)}
            SET capacity = ${newCapacity}, ${sql.id(spec.cutoffColumn)} = ${newCutoff},
                ${stateFlip}
            WHERE id = ${input.unit.id} AND version = ${input.expectedVersion}`.execute(trx);
    if (Number(updated.numAffectedRows ?? 0) !== 1) return { kind: 'staleVersion' };
    await emitUnitEvent(trx, actor, scope, input.unit, 'updated', { capacity: newCapacity });
    const fresh = await lockOrgUnit(trx, scope, input.unit);
    return { kind: 'unitUpdated', unit: toView(input.unit.kind, fresh!) };
  });
}

// ---------------------------------------------------------------------------
// Status transitions — exactly the provider-drivable §5.4 edges
// ---------------------------------------------------------------------------

export type UnitStatusResult =
  | { kind: 'unitOpened'; unit: UnitView }
  | { kind: 'unitClosed'; unit: UnitView }
  | { kind: 'unitNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

async function transitionUnit(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { unit: UnitRef; expectedVersion: number },
  edge: { from: string[]; to: 'open' | 'closed'; suffix: 'opened' | 'closed' },
): Promise<UnitStatusResult> {
  const spec = unitSpec(input.unit.kind);
  return withTransaction(deps.db, async (trx) => {
    const row = await lockOrgUnit(trx, scope, input.unit);
    if (row === undefined) return { kind: 'unitNotFound' };
    if (!(await programInBranchScope(trx, scope, row.program_id))) {
      return { kind: 'forbidden' };
    }
    if (!branchInScope(scope, row.branch_id)) return { kind: 'forbidden' };
    if (!edge.from.includes(row.state)) return { kind: 'lifecycleConflict' };
    if (row.version !== input.expectedVersion) return { kind: 'staleVersion' };
    // scheduled → open must land on the truthful side of the open⇄full
    // automation: a unit opened with zero headroom is `full`, not `open`.
    const target =
      edge.to === 'open' && row.booked_count + row.held_count >= row.capacity ? 'full' : edge.to;
    const updated = await sql`
      UPDATE ${sql.id(spec.table)} SET state = ${target}
      WHERE id = ${input.unit.id} AND version = ${input.expectedVersion}
        AND state = ANY(${edge.from})`.execute(trx);
    if (Number(updated.numAffectedRows ?? 0) !== 1) return { kind: 'staleVersion' };
    await emitUnitEvent(trx, actor, scope, input.unit, edge.suffix);
    const fresh = await lockOrgUnit(trx, scope, input.unit);
    return {
      kind: edge.suffix === 'opened' ? 'unitOpened' : 'unitClosed',
      unit: toView(input.unit.kind, fresh!),
    };
  });
}

/** `scheduled → open` (D-9: provider opens a future-gated unit). */
export function openUnit(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { unit: UnitRef; expectedVersion: number },
): Promise<UnitStatusResult> {
  return transitionUnit(deps, scope, actor, input, {
    from: ['scheduled'],
    to: 'open',
    suffix: 'opened',
  });
}

/** `open|full → closed` — registration closes; existing active holds and
 *  bookings are UNTOUCHED (nothing is discarded or cancelled; the customer
 *  claim boundary independently refuses new holds on a closed unit). */
export function closeUnit(
  deps: BookingServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { unit: UnitRef; expectedVersion: number },
): Promise<UnitStatusResult> {
  return transitionUnit(deps, scope, actor, input, {
    from: ['open', 'full'],
    to: 'closed',
    suffix: 'closed',
  });
}

// ---------------------------------------------------------------------------
// Operational reads (org/branch-scoped; PII-lean)
// ---------------------------------------------------------------------------

export async function listUnits(
  deps: BookingServiceDeps,
  scope: OrgScope,
  input: { kind: UnitKind; programId: string },
): Promise<{ kind: 'units'; units: UnitView[] } | { kind: 'programNotFound' }> {
  const spec = unitSpec(input.kind);
  return withTransaction(deps.db, async (trx) => {
    const program = await trx
      .selectFrom('program')
      .select('id')
      .where('id', '=', input.programId)
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirst();
    if (program === undefined) return { kind: 'programNotFound' as const };
    const rows = await sql<UnitRow>`
      SELECT ${sql.raw(unitSelect(input.kind))}
      FROM ${sql.id(spec.table)}
      WHERE program_id = ${input.programId}
      ORDER BY created_at`.execute(trx);
    return {
      kind: 'units' as const,
      units: rows.rows
        .filter((row) => branchInScope(scope, row.branch_id))
        .map((row) => toView(input.kind, row)),
    };
  });
}

export interface RosterEntry {
  referenceCode: string | null;
  state: string;
  participant: { firstName: string; kind: string };
  confirmedAt: string | null;
  createdAt: string;
}

export type UnitRosterResult =
  | {
      kind: 'roster';
      unit: UnitView;
      /** Bookings only (docs/32 §11 PII-lean projection). Active HOLDS are
       *  checkout state, never roster rows — they appear solely inside the
       *  authoritative heldCount on the unit view. */
      entries: RosterEntry[];
    }
  | { kind: 'unitNotFound' }
  | { kind: 'forbidden' };

export async function unitRoster(
  deps: BookingServiceDeps,
  scope: OrgScope,
  input: { unit: UnitRef },
): Promise<UnitRosterResult> {
  const spec = unitSpec(input.unit.kind);
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<UnitRow>`
      SELECT ${sql.raw(unitSelect(input.unit.kind))}
      FROM ${sql.id(spec.table)}
      WHERE id = ${input.unit.id} AND organization_id = ${scope.organizationId}`.execute(trx);
    const row = rows.rows[0];
    if (row === undefined) return { kind: 'unitNotFound' };
    if (!branchInScope(scope, row.branch_id)) return { kind: 'forbidden' };
    const entries = await sql<{
      reference_code: string | null;
      state: string;
      first_name: string;
      participant_kind: string;
      confirmed_at: Date | null;
      created_at: Date;
    }>`
      SELECT b.reference_code, b.state, p.first_name, p.kind AS participant_kind,
             b.confirmed_at, b.created_at
      FROM booking b
      JOIN participant p ON p.id = b.participant_id
      WHERE b.${sql.id(spec.holdColumn)} = ${input.unit.id}
      ORDER BY b.created_at`.execute(trx);
    return {
      kind: 'roster',
      unit: toView(input.unit.kind, row),
      entries: entries.rows.map((entry) => ({
        referenceCode: entry.reference_code,
        state: entry.state,
        participant: { firstName: entry.first_name, kind: entry.participant_kind },
        confirmedAt: entry.confirmed_at === null ? null : entry.confirmed_at.toISOString(),
        createdAt: entry.created_at.toISOString(),
      })),
    };
  });
}
