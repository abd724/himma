/**
 * Append-only audit trail writes (docs/24 §4.1, §6.8).
 *
 * Every §5 state transition and every sensitive access emits one of these in
 * the same transaction as the change it records (docs/24 §7 boundaries).
 *
 * W6-1 correlation seam (docs/37 §23): when no explicit `requestId` is
 * supplied, the CANONICAL ambient correlation id (server-generated; HTTP
 * request today, worker/scheduler run id in W6-2/W6-3) is recorded — this
 * single helper is the only place correlation meets the audit trail, so no
 * domain-service signature changes. An explicitly supplied id always wins.
 */
import { currentRequestId } from '../observability/request-context';
import { newId } from './ids';
import type { Db } from './kysely';
import type { Trx } from './transaction';

export interface NewAuditEvent {
  actorType: 'user' | 'system';
  actorId?: string;
  principalContext?: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeDigest?: string;
  afterDigest?: string;
  requestId?: string;
}

export async function appendAuditEvent(
  db: Db | Trx,
  event: NewAuditEvent,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('audit_event')
    .values({
      id,
      actor_type: event.actorType,
      actor_id: event.actorId ?? null,
      principal_context: event.principalContext ?? null,
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId,
      before_digest: event.beforeDigest ?? null,
      after_digest: event.afterDigest ?? null,
      request_id: event.requestId ?? currentRequestId() ?? null,
    })
    .execute();
  return id;
}
