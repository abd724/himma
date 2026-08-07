import type { BranchRecord, OrganizationView } from '../../profile/contract';

export const SUSPENDED_BRANCH_COPY =
  'This organization is currently suspended. Changes are unavailable.';

/**
 * UX mirror of the caller's branch MUTATION reach — derived only from the
 * membership the backend returned (capabilities + branchScope), never
 * re-derived from the role name. The backend stays the boundary; this only
 * decides which controls are truthful to render.
 *
 * - `all`: `branch.edit` with org-wide scope (owner, org_manager).
 * - `scoped`: `branch.edit` with an assigned-branch list (branch_manager) —
 *   reach covers assigned ACTIVE branches only, exactly like the real
 *   principal resolution (deactivation removes reach; an empty list never
 *   falls back to org-wide).
 * - `none`: no `branch.edit` capability, or the organization is suspended
 *   (mutations refused server-side regardless of role).
 */
export type BranchEditReach =
  | { readonly kind: 'all' }
  | { readonly kind: 'scoped'; readonly branchIds: readonly string[] }
  | { readonly kind: 'none' };

export function branchEditReach(
  membership: OrganizationView['membership'],
  suspended: boolean,
): BranchEditReach {
  if (suspended || !membership.capabilities.includes('branch.edit')) {
    return { kind: 'none' };
  }
  if (membership.branchScope === 'all') {
    return { kind: 'all' };
  }
  return { kind: 'scoped', branchIds: membership.branchScope };
}

export function canEditBranch(reach: BranchEditReach, branch: BranchRecord): boolean {
  if (reach.kind === 'all') {
    return true;
  }
  if (reach.kind === 'scoped') {
    return branch.active && reach.branchIds.includes(branch.id);
  }
  return false;
}
