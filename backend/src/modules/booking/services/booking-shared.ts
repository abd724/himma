/**
 * Shared booking/capacity service foundation (S5-2; docs/32 §4–§5; docs/24
 * §5.4–§5.5, §7).
 *
 * GLOBAL LOCK ORDER (binding, docs/24 §7 cross-cutting — documented here and
 * asserted by the concurrency suite): every counting transaction acquires
 * locks in the order
 *
 *   idempotency-key row → capacity-unit row (FOR UPDATE) → hold row(s) → booking row(s)
 *
 * The capacity-unit row lock is taken FIRST among domain rows in every
 * transaction that changes `booked_count`/`held_count`; holds and bookings
 * are only ever locked/updated while the owning unit's lock is held. No
 * S5-2 transaction touches more than one capacity unit (quantity = 1,
 * exactly one unit per hold); if a future transaction must touch several
 * unit rows, it must order them by unit kind (session < camp_week <
 * enrolment_cohort) and then by ascending id. PostgreSQL row locks are the
 * ONLY serializer — no JavaScript mutexes, no advisory capacity locks, no
 * single-process assumptions; isolation stays the repo-standard READ
 * COMMITTED with the S5-1 CHECK constraints as the final invariant
 * authority.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';

/** The three capacity-unit kinds (docs/24 §2.3–§2.4, Amendment A1.1). */
export const UNIT_KINDS = ['session', 'campWeek', 'enrolmentCohort'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface UnitRef {
  kind: UnitKind;
  id: string;
}

interface UnitKindSpec {
  table: string;
  holdColumn: 'session_id' | 'camp_week_id' | 'cohort_id';
  cutoffColumn: string;
}

const UNIT_SPEC: Record<UnitKind, UnitKindSpec> = {
  session: {
    table: 'session',
    holdColumn: 'session_id',
    cutoffColumn: 'registration_cutoff_at',
  },
  campWeek: {
    table: 'camp_week',
    holdColumn: 'camp_week_id',
    cutoffColumn: 'registration_cutoff_at',
  },
  enrolmentCohort: {
    table: 'enrolment_cohort',
    holdColumn: 'cohort_id',
    cutoffColumn: 'enrolment_cutoff_at',
  },
};

export function unitSpec(kind: UnitKind): UnitKindSpec {
  return UNIT_SPEC[kind];
}

export interface BookingServiceDeps {
  db: Db;
  /** D-6: hold TTL, default 600 s (10 minutes). Configuration, not schema. */
  holdTtlSeconds?: number;
  /**
   * TEST-ONLY failure-injection seam (docs/32 §15 proof obligations): invoked
   * at named points inside the §7.1 claim transaction so tests can prove that
   * a failure at any point rolls back ALL partial claimed inventory. Never
   * set in production wiring.
   */
  onClaimPhase?: (phase: ClaimPhase) => void;
}

export type ClaimPhase = 'unitLocked' | 'counterIncremented' | 'holdInserted';

export const DEFAULT_HOLD_TTL_SECONDS = 600;

/** The customer principal executing a hold command (docs/24 §10.1). */
export interface CustomerActor {
  accountId: string;
}

export interface LockedUnitRow {
  id: string;
  organization_id: string;
  program_id: string;
  capacity: number;
  booked_count: number;
  held_count: number;
  state: string;
  cutoff_at: Date;
  db_now: Date;
}

/**
 * Locks the capacity-unit row (`SELECT … FOR UPDATE`) — the FIRST domain
 * lock of every counting transaction — and returns its authoritative counts,
 * state, cutoff, and the database clock (the single time authority for every
 * comparison in the transaction).
 */
export async function lockUnitRow(
  trx: Trx,
  unit: UnitRef,
): Promise<LockedUnitRow | undefined> {
  const spec = unitSpec(unit.kind);
  const result = await sql<LockedUnitRow>`
    SELECT id, organization_id, program_id, capacity, booked_count, held_count, state,
           ${sql.id(spec.cutoffColumn)} AS cutoff_at, now() AS db_now
    FROM ${sql.id(spec.table)}
    WHERE id = ${unit.id}
    FOR UPDATE`.execute(trx);
  return result.rows[0];
}

/**
 * Applies a `held_count` delta on the LOCKED unit row and performs the
 * automatic `open ⇄ full` flip atomically with the count change (docs/32 §3:
 * never a direct API action). Other states are left untouched (a `closed`
 * unit releasing capacity stays `closed`). The S5-1 CHECK rejects any delta
 * that would break `booked_count + held_count <= capacity` or negativity —
 * the caller must have proven headroom under the lock; the CHECK is the
 * final backstop, not the control flow.
 */
export async function applyHeldDelta(
  trx: Trx,
  unit: UnitRef,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const spec = unitSpec(unit.kind);
  await sql`
    UPDATE ${sql.id(spec.table)}
    SET held_count = held_count + ${delta},
        state = CASE
          WHEN state IN ('open', 'full')
            THEN CASE WHEN booked_count + held_count + ${delta} >= capacity
                      THEN 'full' ELSE 'open' END
          ELSE state
        END
    WHERE id = ${unit.id}`.execute(trx);
}

export type HoldEventType = 'hold.created' | 'hold.expired' | 'hold.released';

/**
 * Canonical audit + outbox pair for a hold transition, written inside the
 * owning transaction (docs/24 §9.1). Payload discipline per docs/32 §17:
 * ids + machine facts only — never participant names, customer PII, payment
 * material, or free-form prose. Refused attempts and idempotent replays
 * emit nothing (the caller only reaches this after a winning transition).
 */
export async function emitHoldEvent(
  trx: Trx,
  actor: { type: 'user'; accountId: string } | { type: 'system' },
  holdId: string,
  eventType: HoldEventType,
  payload: {
    unitKind: UnitKind;
    unitId: string;
    organizationId: string;
    state: string;
    expiresAt?: string;
    quantity?: number;
    unwoundBookingId?: string;
  },
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: actor.type === 'user' ? 'user' : 'system',
    ...(actor.type === 'user' ? { actorId: actor.accountId } : {}),
    principalContext: actor.type === 'user' ? 'customer' : 'system',
    action: eventType,
    entityType: 'capacity_hold',
    entityId: holdId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'capacity_hold',
    aggregateId: holdId,
    eventType,
    payload: { holdId, ...payload },
  });
}

/**
 * Expires every lapsed `active` hold of the LOCKED unit and returns the
 * capacity reclaimed — the docs/32 §5 opportunistic-reclamation leg and the
 * §7.2 sweep leg are BOTH this one CAS (`state='active' AND expires_at <=
 * now()`), so running it twice, concurrently, or from either path is
 * structurally a no-op for already-transitioned rows. Decrements
 * `held_count` once per expired hold and CAS-unwinds any `pending_payment`
 * booking resting on an expired hold (docs/24 §7.2), all under the unit
 * lock, in lock order unit → hold → booking.
 */
export async function expireLapsedHoldsForUnit(
  trx: Trx,
  unit: UnitRef,
  organizationId: string,
): Promise<number> {
  const spec = unitSpec(unit.kind);
  const expired = await sql<{ id: string }>`
    UPDATE capacity_hold SET state = 'expired'
    WHERE ${sql.id(spec.holdColumn)} = ${unit.id}
      AND state = 'active' AND expires_at <= now()
    RETURNING id`.execute(trx);
  if (expired.rows.length === 0) return 0;

  await applyHeldDelta(trx, unit, -expired.rows.length);

  const holdIds = expired.rows.map((row) => row.id);
  const unwound = await sql<{ id: string; hold_id: string }>`
    UPDATE booking SET state = 'expired'
    WHERE hold_id = ANY(${holdIds}) AND state = 'pending_payment'
    RETURNING id, hold_id`.execute(trx);
  const unwoundByHold = new Map(unwound.rows.map((row) => [row.hold_id, row.id]));

  for (const holdId of holdIds) {
    const bookingId = unwoundByHold.get(holdId);
    await emitHoldEvent(trx, { type: 'system' }, holdId, 'hold.expired', {
      unitKind: unit.kind,
      unitId: unit.id,
      organizationId,
      state: 'expired',
      ...(bookingId !== undefined ? { unwoundBookingId: bookingId } : {}),
    });
  }
  return expired.rows.length;
}
