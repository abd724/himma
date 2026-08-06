/**
 * Transactional outbox + consumer inbox primitives (docs/24 §9.1–9.3).
 *
 * Slice-1 scope: the shared database foundation only — event rows written in
 * the same transaction as the causing state change, per-aggregate ordering,
 * and consumer-side deduplication. The publishing relay worker belongs to the
 * async-processing infrastructure (docs/23 §10.4) in a later slice.
 */
import { sql } from 'kysely';

import { newId } from '../db/ids';
import type { Db } from '../db/kysely';
import type { Trx } from '../db/transaction';

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
}

export interface AppendedOutboxEvent {
  id: string;
  sequenceNo: number;
}

/**
 * Appends a domain event inside the caller's transaction.
 *
 * The parameter is deliberately typed `Trx` (a Kysely Transaction), not `Db`:
 * an outbox row without the causing state change in the SAME transaction is
 * structurally forbidden (docs/24 §9.1), and the per-aggregate advisory lock
 * below is transaction-scoped (`pg_advisory_xact_lock`) — it serializes
 * concurrent appends for one aggregate and releases at commit/rollback.
 */
export async function appendOutboxEvent(
  trx: Trx,
  event: NewOutboxEvent,
): Promise<AppendedOutboxEvent> {
  const aggregateKey = `${event.aggregateType}:${event.aggregateId}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${aggregateKey}, 42))`.execute(trx);

  const next = await trx
    .selectFrom('outbox_event')
    .select(sql<string>`COALESCE(MAX(sequence_no), 0) + 1`.as('next'))
    .where('aggregate_type', '=', event.aggregateType)
    .where('aggregate_id', '=', event.aggregateId)
    .executeTakeFirstOrThrow();
  const sequenceNo = Number(next.next);

  const id = newId();
  await trx
    .insertInto('outbox_event')
    .values({
      id,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      sequence_no: sequenceNo,
      event_type: event.eventType,
      schema_version: event.schemaVersion ?? 1,
      payload: JSON.stringify(event.payload),
    })
    .execute();

  return { id, sequenceNo };
}

/**
 * Consumer-inbox deduplication (docs/24 §9.3). Returns true when this call
 * recorded the event as processed for the consumer (first delivery) and false
 * on a duplicate — callers skip side effects on false. Run inside the
 * consumer's processing transaction so at-least-once delivery yields
 * exactly-once effects.
 */
export async function markInboxProcessed(
  db: Db | Trx,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const result = await db
    .insertInto('inbox_event')
    .values({ consumer, event_id: eventId })
    .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
    .executeTakeFirst();
  return result.numInsertedOrUpdatedRows === 1n;
}
