/**
 * First bounded consumer of the certified 0001 `idempotency_key` store
 * (docs/24 §6.6, §11.3; docs/32 §14 — S5-2).
 *
 * Semantics (owner-approved):
 * - Same principal + same endpoint scope + same key + same logical request
 *   (digest) → the stored outcome is returned; the domain function is NEVER
 *   re-executed after a committed first run.
 * - Same key with a materially different request digest → typed conflict.
 * - The idempotency row and the domain mutation commit in ONE transaction:
 *   the row is inserted `in_progress` first, the domain function runs on the
 *   same transaction, and the row is completed with the outcome snapshot
 *   before commit. A committed row is therefore ALWAYS `completed`; a failed
 *   transaction rolls the row back too, so a crashed attempt never poisons
 *   the key — the retry re-executes.
 * - Concurrent duplicates serialize on the store's unique index: the loser's
 *   INSERT waits for the winner's commit, aborts with a unique violation
 *   (its domain function untouched — it runs strictly after the insert), and
 *   the loser then returns the winner's committed outcome.
 *
 * Lock-order note (deadlock avoidance, docs/24 §7 cross-cutting): the
 * idempotency insert is the FIRST statement of the wrapped transaction, so
 * every keyed mutation acquires locks in the global order
 * idempotency-key → capacity unit → hold → booking.
 */
import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import { DbError } from './errors';
import { newId } from './ids';
import type { Db } from './kysely';
import { withTransaction, type Trx } from './transaction';

export interface IdempotentContext {
  /** e.g. `customer:<accountId>` — the authenticated principal. */
  principalRef: string;
  /** e.g. `booking.hold.claim` — one scope per logical operation. */
  endpointScope: string;
  /** The client-supplied idempotency key. */
  idempotencyKey: string;
  /** Canonical digest of the logical request payload (see requestDigest). */
  requestDigest: string;
}

export type IdempotentRun<T> =
  /** First execution — the domain function ran in this call's transaction. */
  | { kind: 'executed'; result: T }
  /** A committed identical request exists — its stored outcome, not re-run. */
  | { kind: 'replayed'; result: T }
  /** The key exists with a materially different request payload. */
  | { kind: 'idempotencyConflict' };

/** Stable JSON canonicalization (sorted object keys, recursively). */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 digest of the canonicalized request payload. */
export function requestDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

interface StoredRow {
  status: string;
  request_digest: string | null;
  response_snapshot: unknown;
}

async function readCommitted(db: Db, ctx: IdempotentContext): Promise<StoredRow | undefined> {
  return db
    .selectFrom('idempotency_key')
    .select(['status', 'request_digest', 'response_snapshot'])
    .where('principal_ref', '=', ctx.principalRef)
    .where('endpoint_scope', '=', ctx.endpointScope)
    .where('idempotency_key', '=', ctx.idempotencyKey)
    .executeTakeFirst();
}

function replayFrom<T>(row: StoredRow, ctx: IdempotentContext): IdempotentRun<T> {
  if (row.request_digest !== ctx.requestDigest || row.status !== 'completed') {
    // Digest mismatch is the client reusing a key for a different request.
    // A committed `in_progress` row cannot exist under this primitive's
    // single-transaction design; if one ever appears it is foreign state and
    // the safe answer is the same typed conflict (never silent re-execution).
    return { kind: 'idempotencyConflict' };
  }
  return { kind: 'replayed', result: row.response_snapshot as T };
}

/**
 * Runs `fn` exactly once per (principal, scope, key, digest). The outcome `T`
 * must be JSON-serializable (it is stored as the response snapshot and
 * returned verbatim on replay — use ISO strings, not Date objects).
 *
 * Typed domain refusals are outcomes too: they are RETURNED by `fn` (never
 * thrown), so a refusal commits alongside any reconciliation writes the
 * transaction legitimately performed, and a same-key retry replays the same
 * refusal. Thrown errors abort and roll back everything including the key.
 */
export async function runIdempotent<T>(
  db: Db,
  ctx: IdempotentContext,
  fn: (trx: Trx) => Promise<T>,
): Promise<IdempotentRun<T>> {
  // Bounded retry: a concurrent winner that ROLLED BACK leaves no row, so
  // one further execution attempt is legitimate; two consecutive vanishing
  // winners means something is genuinely wrong — surface the error.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readCommitted(db, ctx);
    if (existing !== undefined) return replayFrom<T>(existing, ctx);

    try {
      const result = await withTransaction(db, async (trx) => {
        const id = newId();
        await trx
          .insertInto('idempotency_key')
          .values({
            id,
            principal_ref: ctx.principalRef,
            endpoint_scope: ctx.endpointScope,
            idempotency_key: ctx.idempotencyKey,
            request_digest: ctx.requestDigest,
          })
          .execute();
        const outcome = await fn(trx);
        await trx
          .updateTable('idempotency_key')
          .set({
            status: 'completed',
            response_snapshot: sql`${JSON.stringify(outcome)}::jsonb`,
          })
          .where('id', '=', id)
          .execute();
        return outcome;
      });
      return { kind: 'executed', result };
    } catch (error) {
      if (
        error instanceof DbError &&
        error.kind === 'uniqueViolation' &&
        error.constraint === 'uq_idempotency_key_scope'
      ) {
        const winner = await readCommitted(db, ctx);
        if (winner !== undefined) return replayFrom<T>(winner, ctx);
        continue; // winner rolled back — re-execute
      }
      throw error;
    }
  }
  throw new Error(
    `idempotency store unstable for scope ${ctx.endpointScope} — repeated vanishing winners`,
  );
}
