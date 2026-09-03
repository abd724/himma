/**
 * W6-2 — the transactional-outbox relay: durable claim → dispatch →
 * acknowledge, on PostgreSQL (docs/37 §10/§21/§22; docs/36 OP-03).
 *
 * The queue IS the outbox table. One dispatcher pass is ONE claim
 * transaction:
 *
 *   claim   SELECT … WHERE published_at IS NULL AND quarantined_at IS NULL
 *                 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
 *           ORDER BY occurred_at, id LIMIT n  FOR UPDATE SKIP LOCKED
 *   dispatch  every registered handler whose predicate matches runs its OWN
 *             transaction (inbox dedup + effect) on a separate connection —
 *             delivery is at-least-once; EFFECTS are exactly-once by the
 *             consumer's inbox (docs/24 §9.3);
 *   ack     per row, inside the claim transaction:
 *             delivered  → published_at = now(), publish_attempts + 1
 *             unhandled  → published (there is nothing to deliver to) with
 *                          the diagnosable code `unhandledEventType`
 *             failed     → publish_attempts + 1, next_attempt_at = now() +
 *                          server-side exponential backoff (30 s … 1 h)
 *             ceiling    → quarantined_at = now() — durable visibility,
 *                          never deletion; explicit un-quarantine only
 *   commit  releases the row locks.
 *
 * Crash contract: a process death anywhere in the pass rolls back the
 * claim — rows return to the pool untouched; a handler that already
 * committed its effect is absorbed by its inbox on redelivery. Two
 * dispatchers never own the same row (SKIP LOCKED). A failing row never
 * blocks unrelated rows (per-row outcome inside the batch), and never
 * spins hot (backoff is written into the row by the database clock).
 *
 * The dispatcher invokes domain authority; it holds none: handlers are
 * registered explicitly, payloads are never interpreted here, and nothing
 * about a row is logged beyond ids, types, and bounded outcome codes.
 */
import { sql } from 'kysely';

import { isDbError } from '../db/errors';
import type { Db } from '../db/kysely';

export interface OutboxEventRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  sequenceNo: number;
  eventType: string;
  schemaVersion: number;
  publishAttempts: number;
}

export type HandlerOutcome = 'processed' | 'duplicate';

export interface OutboxHandler {
  /** Stable consumer id — the `inbox_event.consumer` dedup namespace. */
  consumer: string;
  matches(event: OutboxEventRow): boolean;
  /**
   * Runs its OWN transaction (inbox dedup + effect). Receives the pool,
   * never the claim transaction — the claim lock and the effect are
   * deliberately separate transactions (docs/37 §21).
   */
  handle(db: Db, event: OutboxEventRow): Promise<HandlerOutcome>;
}

export type DispatchFailpoint = 'afterHandlersBeforeAck';

export interface DispatchOptions {
  batchSize: number;
  maxAttempts: number;
  /** Seconds until the next attempt for attempt number `attempt` (1-based). */
  backoffSeconds?: (attempt: number) => number;
  /** TEST-ONLY crash injection at a named point. Never in production wiring. */
  failpoint?: (point: DispatchFailpoint) => void;
}

export interface DispatchSummary {
  claimed: number;
  delivered: number;
  unhandled: number;
  duplicates: number;
  failed: number;
  quarantined: number;
}

const OUTCOME_CODE_PATTERN = /[^A-Za-z0-9:_.-]/g;

/** Exponential backoff 30 s → 1 h with ±10 % jitter (docs/37 §22). */
export function defaultBackoffSeconds(attempt: number): number {
  const base = Math.min(30 * 2 ** Math.max(0, attempt - 1), 3_600);
  const jitter = 1 + (Math.random() * 0.2 - 0.1);
  return Math.max(1, Math.round(base * jitter));
}

/** Bounded machine code for a handler failure — never a message. */
export function failureCode(error: unknown): string {
  let raw: string;
  if (isDbError(error)) raw = `db.${error.kind}`;
  else if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    raw = typeof withCode.code === 'string' && withCode.code !== '' ? withCode.code : error.name;
  } else raw = 'unknown';
  return raw.replace(OUTCOME_CODE_PATTERN, '_').slice(0, 40) || 'unknown';
}

interface ClaimedRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence_no: string | number;
  event_type: string;
  schema_version: number;
  publish_attempts: number;
}

export async function dispatchOutboxBatch(
  db: Db,
  handlers: readonly OutboxHandler[],
  options: DispatchOptions,
): Promise<DispatchSummary> {
  const backoff = options.backoffSeconds ?? defaultBackoffSeconds;
  const batchSize = Math.min(Math.max(options.batchSize, 1), 1_000);
  return db.transaction().execute(async (trx) => {
    const claimed = await sql<ClaimedRow>`
      SELECT id, aggregate_type, aggregate_id, sequence_no, event_type, schema_version, publish_attempts
      FROM outbox_event
      WHERE published_at IS NULL
        AND quarantined_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY occurred_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `.execute(trx);

    const summary: DispatchSummary = {
      claimed: claimed.rows.length,
      delivered: 0,
      unhandled: 0,
      duplicates: 0,
      failed: 0,
      quarantined: 0,
    };

    for (const raw of claimed.rows) {
      const event: OutboxEventRow = {
        id: raw.id,
        aggregateType: raw.aggregate_type,
        aggregateId: raw.aggregate_id,
        sequenceNo: Number(raw.sequence_no),
        eventType: raw.event_type,
        schemaVersion: raw.schema_version,
        publishAttempts: raw.publish_attempts,
      };
      const matched = handlers.filter((handler) => handler.matches(event));
      if (matched.length === 0) {
        await sql`
          UPDATE outbox_event
          SET published_at = now(), publish_attempts = publish_attempts + 1,
              last_outcome_code = 'unhandledEventType', next_attempt_at = NULL
          WHERE id = ${event.id}
        `.execute(trx);
        summary.unhandled += 1;
        continue;
      }

      let failure: unknown;
      for (const handler of matched) {
        try {
          const outcome = await handler.handle(db, event);
          if (outcome === 'duplicate') summary.duplicates += 1;
        } catch (error) {
          failure = error;
          break;
        }
      }

      options.failpoint?.('afterHandlersBeforeAck');

      if (failure === undefined) {
        await sql`
          UPDATE outbox_event
          SET published_at = now(), publish_attempts = publish_attempts + 1,
              last_outcome_code = 'delivered', next_attempt_at = NULL
          WHERE id = ${event.id}
        `.execute(trx);
        summary.delivered += 1;
        continue;
      }

      const code = failureCode(failure);
      const attempt = event.publishAttempts + 1;
      if (attempt >= options.maxAttempts) {
        await sql`
          UPDATE outbox_event
          SET publish_attempts = publish_attempts + 1, quarantined_at = now(),
              next_attempt_at = NULL, last_outcome_code = ${`quarantined:${code}`}
          WHERE id = ${event.id}
        `.execute(trx);
        summary.quarantined += 1;
      } else {
        const delay = backoff(attempt);
        await sql`
          UPDATE outbox_event
          SET publish_attempts = publish_attempts + 1,
              next_attempt_at = now() + make_interval(secs => ${delay}),
              last_outcome_code = ${`failed:${code}`}
          WHERE id = ${event.id}
        `.execute(trx);
        summary.failed += 1;
      }
    }
    return summary;
  });
}
