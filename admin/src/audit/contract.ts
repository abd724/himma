/**
 * W3-9 AD-18 audit-explorer contract — the typed frontend mirror of the
 * NEW `GET /admin/audit-events` read (docs/31 §8): a paginated, role-gated
 * read over the EXISTING append-only audit table — never frontend logs,
 * never a mutation surface. The projection is BOUNDED by the backend
 * (who did what to which entity, when); digests, principal context, and
 * request ids are never even selected server-side, so this contract
 * cannot carry them. Viewing emits nothing.
 */

export interface AuditEventRecord {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: string;
}

export interface AuditEventFilter {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorId?: string;
  readonly action?: string;
}

export type AuditEventsOutcome =
  | {
      readonly kind: 'loaded';
      readonly events: readonly AuditEventRecord[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export interface AdminAuditPort {
  listEvents(
    params: AuditEventFilter & { readonly cursor?: string; readonly limit?: number },
  ): Promise<AuditEventsOutcome>;
}
