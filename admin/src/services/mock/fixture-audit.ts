import type { AdminAuditPort, AuditEventRecord } from '../../audit/contract';

/**
 * Deterministic FIXTURE audit-explorer data (W3-9) behind the same port
 * the live runtime implements — a bounded, read-only trail of fictional
 * administrative actions mirroring the real projection (who did what to
 * which entity, when; NO digests, principal context, or request ids
 * exist in the contract at all). Read-gated by audit.read; reading never
 * mutates anything. Live mode can never reach this module.
 */

const EVENTS: readonly AuditEventRecord[] = [
  {
    id: 'audit-0009',
    actorType: 'user',
    actorId: 'fixture-ops@himma.demo',
    action: 'listing.changes_requested',
    entityType: 'program',
    entityId: 'listing-marina-clinic',
    occurredAt: '2026-08-19T15:20:00.000Z',
  },
  {
    id: 'audit-0008',
    actorType: 'user',
    actorId: 'fixture-ops@himma.demo',
    action: 'taxonomy.category_changed',
    entityType: 'category',
    entityId: 'cat-water',
    occurredAt: '2026-08-19T11:05:00.000Z',
  },
  {
    id: 'audit-0007',
    actorType: 'user',
    actorId: 'fixture-duo@himma.demo',
    action: 'admin_role.activated',
    entityType: 'admin_role_assignment',
    entityId: 'assignment-support',
    occurredAt: '2026-08-18T09:40:00.000Z',
  },
  {
    id: 'audit-0006',
    actorType: 'user',
    actorId: 'fixture-ops@himma.demo',
    action: 'org.verification_rejected',
    entityType: 'organization',
    entityId: 'org-desert-bloom',
    occurredAt: '2026-08-12T10:00:00.000Z',
  },
  {
    id: 'audit-0005',
    actorType: 'user',
    actorId: 'fixture-ops@himma.demo',
    action: 'org.review_started',
    entityType: 'organization',
    entityId: 'org-desert-bloom',
    occurredAt: '2026-08-11T09:00:00.000Z',
  },
  {
    id: 'audit-0004',
    actorType: 'system',
    actorId: null,
    action: 'org.verification_evidence_stored',
    entityType: 'organization',
    entityId: 'org-desert-bloom',
    occurredAt: '2026-08-10T16:30:00.000Z',
  },
  {
    id: 'audit-0003',
    actorType: 'user',
    actorId: 'fixture-ops@himma.demo',
    action: 'org.go_live',
    entityType: 'organization',
    entityId: 'org-blue-wave',
    occurredAt: '2026-08-05T12:00:00.000Z',
  },
  {
    id: 'audit-0002',
    actorType: 'user',
    actorId: 'fixture-ops@himma.demo',
    action: 'listing.approved',
    entityType: 'program',
    entityId: 'listing-marina-term',
    occurredAt: '2026-08-01T09:30:00.000Z',
  },
  {
    id: 'audit-0001',
    actorType: 'user',
    actorId: 'fixture-duo@himma.demo',
    action: 'admin_role.activated',
    entityType: 'admin_role_assignment',
    entityId: 'assignment-ops',
    occurredAt: '2026-08-01T09:00:00.000Z',
  },
];

export interface FixtureAuditAuthority {
  currentAuthority(): { hasAuditRead: boolean } | null;
  takeFailure(): boolean;
}

export function createFixtureAuditPort(authority: FixtureAuditAuthority): AdminAuditPort {
  return {
    async listEvents(params) {
      const auth = authority.currentAuthority();
      if (auth === null || authority.takeFailure()) return { kind: 'unavailable' };
      if (!auth.hasAuditRead) return { kind: 'forbidden' };
      const filtered = EVENTS.filter(
        (event) =>
          (params.entityType === undefined || event.entityType === params.entityType) &&
          (params.entityId === undefined || event.entityId === params.entityId) &&
          (params.actorId === undefined || event.actorId === params.actorId) &&
          (params.action === undefined || event.action === params.action),
      );
      const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
      const start =
        params.cursor === undefined
          ? 0
          : filtered.findIndex((event) => event.id === params.cursor) + 1;
      const page = filtered.slice(start, start + limit);
      const nextIndex = start + limit;
      return {
        kind: 'loaded',
        events: page.map((event) => ({ ...event })),
        nextCursor: nextIndex < filtered.length ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  };
}
