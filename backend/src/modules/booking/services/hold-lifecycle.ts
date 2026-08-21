/**
 * Hold release + expiry — the docs/24 §7.2 transaction (S5-2; docs/32 §5).
 *
 * Both paths are the same shape: lock the capacity-unit row FIRST (the
 * global order: idempotency-key → unit → hold → booking), single-statement
 * CAS on the hold, decrement `held_count` exactly once for the winning CAS,
 * unwind any `pending_payment` booking resting on the hold, emit the event —
 * all in ONE transaction. Losers of any race match 0 CAS rows and return a
 * typed outcome without touching a counter, so capacity can never be
 * returned twice. Expiry is correct WITHOUT any background worker: the
 * sweep here and the claim path's opportunistic reclamation are the same
 * CAS; a future scheduled sweep is maintenance, never the correctness
 * authority.
 *
 * DELETE does not exist on this domain (no grant, and history is
 * structural); terminal holds are frozen by the S5-1 trigger.
 */
import { sql } from 'kysely';

import { runIdempotent, requestDigest } from '../../../db/idempotency';
import { withTransaction } from '../../../db/transaction';
import {
  lockHold,
  lockUnitRow,
  readHold,
  settleHold,
  unitRefOf,
  type BookingServiceDeps,
  type CustomerActor,
} from './booking-shared';

// ---------------------------------------------------------------------------
// Release (customer abandonment — idempotency-keyed)
// ---------------------------------------------------------------------------

export interface ReleaseHoldInput {
  holdId: string;
  idempotencyKey: string;
  /** Optional optimistic guard (docs/24 §6.11). */
  expectedVersion?: number;
}

export type ReleaseHoldResult =
  /** The hold was `active` and live — capacity returned exactly once. */
  | { kind: 'holdReleased' }
  /** The hold had already lapsed — expiry semantics applied instead. */
  | { kind: 'holdExpired' }
  | { kind: 'alreadyReleased' }
  | { kind: 'alreadyExpired' }
  | { kind: 'alreadyConsumed' }
  /** Unknown id OR a hold the caller does not own — not-found-shaped so
   *  cross-account/org existence never leaks. */
  | { kind: 'holdNotFound' }
  | { kind: 'staleVersion'; currentVersion: number }
  | { kind: 'idempotencyConflict' };

export interface ReleaseHoldRun {
  replayed: boolean;
  outcome: ReleaseHoldResult;
}

const RELEASE_SCOPE = 'booking.hold.release';

export async function releaseHold(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: ReleaseHoldInput,
): Promise<ReleaseHoldRun> {
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: RELEASE_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      holdId: input.holdId,
      expectedVersion: input.expectedVersion ?? null,
    }),
  };

  const run = await runIdempotent<ReleaseHoldResult>(deps.db, ctx, async (trx) => {
    // Ownership-scoped preread (unlocked) to learn the unit; every state
    // decision below is re-taken from the FOR UPDATE re-read under the lock.
    const preread = await readHold(trx, input.holdId);
    if (preread === undefined || preread.account_id !== actor.accountId) {
      return { kind: 'holdNotFound' };
    }
    const unit = unitRefOf(preread);
    const locked = await lockUnitRow(trx, unit);
    if (locked === undefined) return { kind: 'holdNotFound' };
    const hold = await lockHold(trx, input.holdId);

    if (hold.state === 'released') return { kind: 'alreadyReleased' };
    if (hold.state === 'expired') return { kind: 'alreadyExpired' };
    if (hold.state === 'consumed') return { kind: 'alreadyConsumed' };
    if (input.expectedVersion !== undefined && input.expectedVersion !== hold.version) {
      return { kind: 'staleVersion', currentVersion: hold.version };
    }
    if (hold.expires_at <= locked.db_now) {
      // Lapsed while still `active`: the truthful transition is expiry — the
      // boundary recognizes it and settles atomically (capacity back once).
      await settleHold(trx, unit, hold, 'expired', { type: 'system' });
      return { kind: 'holdExpired' };
    }
    await settleHold(trx, unit, hold, 'released', {
      type: 'user',
      accountId: actor.accountId,
    });
    return { kind: 'holdReleased' };
  });

  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}

// ---------------------------------------------------------------------------
// Expiry (system authority — typed-idempotent, no key needed)
// ---------------------------------------------------------------------------

export type ExpireHoldResult =
  | { kind: 'holdExpired' }
  /** Still `active` with time remaining — expiry refused. */
  | { kind: 'notLapsed' }
  /** Terminal rows can never expire (released/consumed/expired stay put). */
  | { kind: 'alreadyTerminal'; state: 'consumed' | 'expired' | 'released' }
  | { kind: 'holdNotFound' };

/**
 * Expires ONE lapsed hold. Safe to retry and safe to race: the CAS inside
 * (`state='active' AND expires_at <= now()`) is decided under the unit lock,
 * so two concurrent attempts decrement exactly once — the loser re-reads the
 * terminal state and reports `alreadyTerminal`.
 */
export async function expireHold(
  deps: BookingServiceDeps,
  input: { holdId: string },
): Promise<ExpireHoldResult> {
  return withTransaction(deps.db, async (trx) => {
    const preread = await readHold(trx, input.holdId);
    if (preread === undefined) return { kind: 'holdNotFound' };
    const unit = unitRefOf(preread);
    const locked = await lockUnitRow(trx, unit);
    if (locked === undefined) return { kind: 'holdNotFound' };
    const hold = await lockHold(trx, input.holdId);

    if (hold.state !== 'active') {
      return {
        kind: 'alreadyTerminal',
        state: hold.state as 'consumed' | 'expired' | 'released',
      };
    }
    if (hold.expires_at > locked.db_now) return { kind: 'notLapsed' };
    await settleHold(trx, unit, hold, 'expired', { type: 'system' });
    return { kind: 'holdExpired' };
  });
}

/**
 * The maintenance sweep over the S5-1 partial index
 * `(expires_at) WHERE state='active'`. One bounded pass; each hold settles
 * in its own §7.2 transaction (unit-locked CAS), so a candidate that another
 * path settled first is a typed no-op, never a double decrement. Running it
 * is optimization — claim/release boundaries stay correct without it.
 */
export async function sweepExpiredHolds(
  deps: BookingServiceDeps,
  options: { limit?: number } = {},
): Promise<{ scanned: number; expired: number }> {
  const limit = options.limit ?? 100;
  const candidates = await deps.db
    .selectFrom('capacity_hold')
    .select('id')
    .where('state', '=', 'active')
    .where('expires_at', '<=', sql<Date>`now()`)
    .orderBy('expires_at')
    .limit(limit)
    .execute();
  let expired = 0;
  for (const candidate of candidates) {
    const result = await expireHold(deps, { holdId: candidate.id });
    if (result.kind === 'holdExpired') expired += 1;
  }
  return { scanned: candidates.length, expired };
}
