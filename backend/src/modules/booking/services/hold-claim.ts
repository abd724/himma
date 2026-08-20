/**
 * Atomic capacity-hold claim — the docs/24 §7.1 transaction (S5-2; docs/32
 * §4–§5).
 *
 * ONE PostgreSQL transaction per claim: idempotency row → unit row lock
 * (FOR UPDATE, first domain lock per the global order) → opportunistic
 * reclamation of the unit's lapsed holds → eligibility (unit state,
 * registration cutoff, participant ownership, quote binding, duplicate live
 * hold/booking) → headroom proof → `held_count` increment (+ automatic
 * open⇄full flip) → `active` hold insert with TTL → audit + outbox
 * `hold.created` → commit. Failure anywhere rolls back EVERYTHING — there
 * is never a hold row without its counter claim nor a counter claim without
 * its hold row; the S5-1 CHECK is the final backstop under application bugs.
 *
 * Refusals are typed RETURN values (never throws), so a refusal commits the
 * idempotency outcome plus any legitimate reclamation the transaction
 * performed. Scope note (docs/32 §19): the `pending_payment` Booking insert
 * of the paid path and every confirmation/consumption behavior are S5-3 —
 * nothing here consumes a hold or touches `booked_count`.
 */
import { sql } from 'kysely';

import { DbError } from '../../../db/errors';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import {
  DEFAULT_HOLD_TTL_SECONDS,
  applyHeldDelta,
  emitHoldEvent,
  expireLapsedHoldsForUnit,
  lockUnitRow,
  unitSpec,
  type BookingServiceDeps,
  type CustomerActor,
  type UnitRef,
} from './booking-shared';

export interface ClaimHoldInput {
  unit: UnitRef;
  participantId: string;
  quoteId: string;
  idempotencyKey: string;
}

/** JSON-serializable (stored as the idempotency response snapshot). */
export interface HoldView {
  holdId: string;
  unitKind: UnitRef['kind'];
  unitId: string;
  organizationId: string;
  participantId: string;
  quantity: number;
  state: 'active';
  expiresAt: string; // ISO
}

export type ClaimHoldResult =
  | { kind: 'holdClaimed'; hold: HoldView }
  | { kind: 'unitNotFound' }
  | { kind: 'registrationClosed' }
  | { kind: 'sessionFull' }
  | { kind: 'participantNotFound' }
  | { kind: 'quoteNotFound' }
  | { kind: 'quoteMismatch' }
  | { kind: 'quoteExpired' }
  | { kind: 'holdAlreadyActive'; holdId?: string; expiresAt?: string }
  | { kind: 'alreadyBooked' }
  | { kind: 'idempotencyConflict' };

export interface ClaimHoldRun {
  /** true when the outcome was replayed from the idempotency store. */
  replayed: boolean;
  outcome: ClaimHoldResult;
}

const CLAIM_SCOPE = 'booking.hold.claim';

export async function claimHold(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: ClaimHoldInput,
): Promise<ClaimHoldRun> {
  const ttlSeconds = deps.holdTtlSeconds ?? DEFAULT_HOLD_TTL_SECONDS;
  const spec = unitSpec(input.unit.kind);
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: CLAIM_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      unitKind: input.unit.kind,
      unitId: input.unit.id,
      participantId: input.participantId,
      quoteId: input.quoteId,
    }),
  };

  let run;
  try {
    run = await runIdempotent<ClaimHoldResult>(deps.db, ctx, async (trx) => {
      const unit = await lockUnitRow(trx, input.unit);
      if (unit === undefined) return { kind: 'unitNotFound' };
      deps.onClaimPhase?.('unitLocked');

      const participant = await trx
        .selectFrom('participant')
        .select('id')
        .where('id', '=', input.participantId)
        .where('account_id', '=', actor.accountId)
        .executeTakeFirst();
      if (participant === undefined) return { kind: 'participantNotFound' };

      const quote = await trx
        .selectFrom('price_quote')
        .select([
          'account_id',
          'participant_id',
          'organization_id',
          'program_id',
          'session_id',
          'camp_week_id',
          'cohort_id',
          'expires_at',
        ])
        .where('id', '=', input.quoteId)
        .executeTakeFirst();
      if (quote === undefined) return { kind: 'quoteNotFound' };
      const quoteUnitId =
        input.unit.kind === 'session'
          ? quote.session_id
          : input.unit.kind === 'campWeek'
            ? quote.camp_week_id
            : quote.cohort_id;
      if (
        quote.account_id !== actor.accountId ||
        quote.participant_id !== input.participantId ||
        quoteUnitId !== input.unit.id ||
        quote.organization_id !== unit.organization_id ||
        quote.program_id !== unit.program_id
      ) {
        return { kind: 'quoteMismatch' };
      }
      if (quote.expires_at <= unit.db_now) return { kind: 'quoteExpired' };

      // Registration eligibility: claims exist only while the unit is open
      // (or transiently `full`, where reclamation below may free a seat).
      if (unit.state !== 'open' && unit.state !== 'full') {
        return { kind: 'registrationClosed' };
      }
      if (unit.cutoff_at <= unit.db_now) return { kind: 'registrationClosed' };

      // Opportunistic reclamation (docs/32 §5): under the unit lock, lapsed
      // holds are expired NOW, so the final seat is claimable without
      // waiting for any sweep, and the duplicate checks below see only
      // genuinely live rows.
      const reclaimed = await expireLapsedHoldsForUnit(
        trx,
        input.unit,
        unit.organization_id,
      );
      const heldCount = unit.held_count - reclaimed;

      const liveHold = await trx
        .selectFrom('capacity_hold')
        .select(['id', 'expires_at'])
        .where('account_id', '=', actor.accountId)
        .where('participant_id', '=', input.participantId)
        .where(spec.holdColumn, '=', input.unit.id)
        .where('state', '=', 'active')
        .executeTakeFirst();
      if (liveHold !== undefined) {
        return {
          kind: 'holdAlreadyActive',
          holdId: liveHold.id,
          expiresAt: liveHold.expires_at.toISOString(),
        };
      }

      const liveBooking = await trx
        .selectFrom('booking')
        .select('id')
        .where(spec.holdColumn, '=', input.unit.id)
        .where('participant_id', '=', input.participantId)
        .where('state', 'in', ['pending_payment', 'confirmed'])
        .executeTakeFirst();
      if (liveBooking !== undefined) return { kind: 'alreadyBooked' };

      if (unit.booked_count + heldCount >= unit.capacity) {
        return { kind: 'sessionFull' };
      }

      await applyHeldDelta(trx, input.unit, 1);
      deps.onClaimPhase?.('counterIncremented');

      const holdId = newId();
      const inserted = await sql<{ expires_at: Date }>`
        INSERT INTO capacity_hold (id, organization_id, ${sql.id(spec.holdColumn)},
                                   account_id, participant_id, quote_id, expires_at)
        VALUES (${holdId}, ${unit.organization_id}, ${input.unit.id},
                ${actor.accountId}, ${input.participantId}, ${input.quoteId},
                now() + make_interval(secs => ${ttlSeconds}))
        RETURNING expires_at`.execute(trx);
      deps.onClaimPhase?.('holdInserted');
      const expiresAt = inserted.rows[0]!.expires_at.toISOString();

      await emitHoldEvent(
        trx,
        { type: 'user', accountId: actor.accountId },
        holdId,
        'hold.created',
        {
          unitKind: input.unit.kind,
          unitId: input.unit.id,
          organizationId: unit.organization_id,
          state: 'active',
          expiresAt,
          quantity: 1,
        },
      );

      return {
        kind: 'holdClaimed',
        hold: {
          holdId,
          unitKind: input.unit.kind,
          unitId: input.unit.id,
          organizationId: unit.organization_id,
          participantId: input.participantId,
          quantity: 1,
          state: 'active',
          expiresAt,
        },
      };
    });
  } catch (error) {
    // Defense in depth behind the precheck: a racing claim that slipped past
    // the duplicate read (distinct idempotency keys, same live intent) dies
    // on the one-live-hold partial unique — surfaced as the same typed
    // refusal. The aborted transaction rolled its idempotency row back, so a
    // retry re-executes and takes the precheck path.
    if (
      error instanceof DbError &&
      error.kind === 'uniqueViolation' &&
      error.constraint !== undefined &&
      error.constraint.startsWith('uq_capacity_hold_live_')
    ) {
      return { replayed: false, outcome: { kind: 'holdAlreadyActive' } };
    }
    throw error;
  }

  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}
