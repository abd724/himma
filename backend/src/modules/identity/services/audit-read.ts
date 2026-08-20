/**
 * AD-18 audit explorer read (W3-9; docs/31 §8): a PAGINATED, ROLE-GATED
 * read over the EXISTING 0001 `audit_event` table — never frontend logs,
 * never a new audit mechanism. Authorization per docs/31 §8: the
 * designated reading roles are `auditor` and `operations`, resolved fresh
 * from PostgreSQL inside the transaction (baseline `admin` assurance has
 * already run; assurance is never authorization).
 *
 * The projection is deliberately BOUNDED: id, actor, action, entity, and
 * time only. `before_digest`/`after_digest`, `principal_context`, and
 * `request_id` are internal forensic material — the repository never even
 * selects them. The table itself stays append-only (0001 trigger +
 * grants); reading it emits no events (viewing is not an action).
 */
import type { Db } from '../../../db/kysely';
import { withTransaction } from '../../../db/transaction';
import { listActiveRoles } from '../persistence/admin-role-repository';
import { listAuditEventRows } from '../persistence/audit-event-repository';

export interface AuditEventView {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: string;
}

export type ListAuditEventsResult =
  | { kind: 'events'; events: AuditEventView[]; nextCursor: string | null }
  | { kind: 'forbidden' };

export async function listAuditEvents(
  deps: { db: Db },
  actor: { userId: string },
  input: {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    action?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<ListAuditEventsResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    const roles = await listActiveRoles(trx, actor.userId);
    if (!roles.includes('auditor') && !roles.includes('operations')) {
      return { kind: 'forbidden' as const };
    }
    const rows = await listAuditEventRows(trx, {
      filter: {
        ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
        ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
      },
      limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      kind: 'events' as const,
      events: page.map((row) => ({
        id: row.id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        occurredAt: row.occurred_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}
