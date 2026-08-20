import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type { AdminAuditPort, AuditEventRecord } from '../../audit/contract';

/**
 * LIVE audit-explorer port (W3-9) over `GET /admin/audit-events` — a pure
 * read pass-through with fail-closed validation of exactly the bounded
 * projection the backend serves. Reading emits nothing.
 */

function eventFrom(raw: unknown): AuditEventRecord | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.actorType !== 'string' ||
    !(typeof row.actorId === 'string' || row.actorId === null) ||
    typeof row.action !== 'string' ||
    typeof row.entityType !== 'string' ||
    typeof row.entityId !== 'string' ||
    typeof row.occurredAt !== 'string'
  ) {
    return null;
  }
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    occurredAt: row.occurredAt,
  };
}

export function createLiveAuditPort(transport: LiveTransport): AdminAuditPort {
  return {
    async listEvents(params) {
      const query = new URLSearchParams();
      if (params.entityType !== undefined) query.set('entityType', params.entityType);
      if (params.entityId !== undefined) query.set('entityId', params.entityId);
      if (params.actorId !== undefined) query.set('actorId', params.actorId);
      if (params.action !== undefined) query.set('action', params.action);
      if (params.cursor !== undefined) query.set('cursor', params.cursor);
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      const encoded = query.toString();
      const response = await transport.authorizedRequest(
        `/admin/audit-events${encoded === '' ? '' : `?${encoded}`}`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as { events?: unknown; nextCursor?: unknown } | null;
        if (
          body === null ||
          !Array.isArray(body.events) ||
          !(typeof body.nextCursor === 'string' || body.nextCursor === null)
        ) {
          return { kind: 'unavailable' };
        }
        const events: AuditEventRecord[] = [];
        for (const entry of body.events) {
          const event = eventFrom(entry);
          if (event === null) return { kind: 'unavailable' };
          events.push(event);
        }
        return { kind: 'loaded', events, nextCursor: body.nextCursor };
      }
      return response.code === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
    },
  };
}
