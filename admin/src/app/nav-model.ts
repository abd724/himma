import type { AdminAccess, AdminCapability } from '../access/contract';

/**
 * Capability-aware navigation model (task §16/§17): visibility derives
 * ONLY from the backend's `/admin/me` capability projection — never from
 * hardcoded role names. This is UX gating; every backend route stays
 * independently authorized. Each future area names the W3 slice that
 * connects it (truthful placeholders, no fake operational data).
 */
export interface NavItem {
  readonly path: string;
  readonly label: string;
  /** null = visible to every authorized administrator. */
  readonly capability: AdminCapability | null;
  /** The W3 slice that connects the real surface (null = live now). */
  readonly pendingSlice: string | null;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', capability: null, pendingSlice: null },
  { path: '/providers', label: 'Providers', capability: 'providers.operate', pendingSlice: 'W3-2' },
  {
    path: '/verification',
    label: 'Verification',
    capability: 'providers.operate',
    pendingSlice: 'W3-3–W3-5',
  },
  {
    path: '/moderation',
    label: 'Catalogue moderation',
    capability: 'catalogue.moderate',
    pendingSlice: 'W3-6',
  },
  {
    path: '/revisions',
    label: 'Revision moderation',
    capability: 'catalogue.moderate',
    pendingSlice: 'W3-6',
  },
  { path: '/taxonomy', label: 'Taxonomy', capability: 'taxonomy.manage', pendingSlice: 'W3-7' },
  { path: '/access', label: 'Access administration', capability: 'roles.view', pendingSlice: 'W3-9' },
  { path: '/audit', label: 'Audit', capability: 'audit.read', pendingSlice: 'W3-9' },
];

export function visibleNavItems(access: AdminAccess): readonly NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.capability === null || access.capabilities.includes(item.capability),
  );
}

export function canAccessPath(access: AdminAccess, path: string): boolean {
  const item = NAV_ITEMS.find(
    (candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`),
  );
  if (item === undefined) {
    return true; // not a gated area (e.g. not-found) — page renders its own truth
  }
  return item.capability === null || access.capabilities.includes(item.capability);
}
