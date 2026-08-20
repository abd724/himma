/**
 * Read-only repository over the append-only 0001 `audit_event` table for
 * the AD-18 explorer (W3-9). Selection is deliberately BOUNDED: digests,
 * principal context, and request ids are internal forensic material and
 * are never selected here, so no caller can serialize them.
 */
import type { Trx } from '../../../db/transaction';

export interface AuditEventRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  occurred_at: Date;
}

export interface AuditEventFilter {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
}

/** Keyset page DESC by (occurred_at, id); fetches limit+1 rows so the
 *  caller can derive the next cursor. An unknown anchor id anchors
 *  nothing (first page again) — no existence oracle. */
export async function listAuditEventRows(
  trx: Trx,
  input: { filter: AuditEventFilter; limit: number; cursor?: string },
): Promise<AuditEventRow[]> {
  let query = trx
    .selectFrom('audit_event')
    .select(['id', 'actor_type', 'actor_id', 'action', 'entity_type', 'entity_id', 'occurred_at'])
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(input.limit + 1);
  const { filter } = input;
  if (filter.entityType !== undefined) query = query.where('entity_type', '=', filter.entityType);
  if (filter.entityId !== undefined) query = query.where('entity_id', '=', filter.entityId);
  if (filter.actorId !== undefined) query = query.where('actor_id', '=', filter.actorId);
  if (filter.action !== undefined) query = query.where('action', '=', filter.action);
  if (input.cursor !== undefined) {
    const anchor = await trx
      .selectFrom('audit_event')
      .select(['occurred_at', 'id'])
      .where('id', '=', input.cursor)
      .executeTakeFirst();
    if (anchor !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb('occurred_at', '<', anchor.occurred_at),
          eb.and([eb('occurred_at', '=', anchor.occurred_at), eb('id', '<', anchor.id)]),
        ]),
      );
    }
  }
  return query.execute();
}
