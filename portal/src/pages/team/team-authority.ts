import type { BranchRecord, OrganizationView } from '../../profile/contract';
import type { StaffInvitationRecord, StaffMembershipRecord } from '../../team/contract';

export const SUSPENDED_TEAM_COPY =
  'This organization is currently suspended. Changes are unavailable.';

/** Truthful copy for roles without `staff.read` — no staff data is ever
 *  fetched for them (the backend would refuse the read the same way). */
export const TEAM_NO_ACCESS_COPY =
  'Team access and roles are managed by the organization’s Owner. Your role doesn’t include viewing or changing the team.';

export const LAST_OWNER_COPY =
  'Every organization keeps at least one Owner with active access. To remove this Owner, another Owner needs active access first.';

export const STEP_UP_NOTICE_COPY =
  'Thanks for confirming it’s you. Review the details below and confirm again to continue.';

/**
 * UX mirror of the caller's team authority — derived only from the
 * membership capabilities the backend returned, never from the role name.
 * `staff.read` and `staff.manage` are OWNER-ONLY in the canonical registry;
 * the backend stays the boundary, this only decides which surfaces are
 * truthful to render.
 */
export interface TeamAuthority {
  readonly canRead: boolean;
  /** `staff.manage` present AND the organization is not suspended (staff
   *  mutations are refused server-side while suspended). */
  readonly canManage: boolean;
  readonly suspended: boolean;
}

export function teamAuthority(view: OrganizationView): TeamAuthority {
  const suspended = view.organization.verificationState === 'suspended';
  const capabilities = view.membership.capabilities;
  return {
    canRead: capabilities.includes('staff.read'),
    canManage: capabilities.includes('staff.manage') && !suspended,
    suspended,
  };
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatTeamDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return 'Unknown date';
  }
  return dateFormatter.format(time);
}

/**
 * TIME truth for a `sent` invitation: the backend refuses acceptance of an
 * overdue token even before the sweep finalizes the row to `expired`, so
 * the UI presents an overdue `sent` invitation as expired (it can no longer
 * be accepted) while still allowing revocation (the row is still `sent`).
 */
export function invitationIsOverdue(invitation: StaffInvitationRecord): boolean {
  return invitation.state === 'sent' && new Date(invitation.expiresAt).getTime() <= Date.now();
}

/** Human summary of a membership/invitation branch scope, resolved against
 *  the org view's branch records (deactivated branches stay named — scope
 *  history is truth, but a deactivated assignment grants no reach). */
export function scopeSummary(
  branchScopeKind: 'all' | 'branches',
  branchIds: readonly string[],
  branches: readonly BranchRecord[],
): string {
  if (branchScopeKind === 'all') {
    return 'All branches';
  }
  const labels = branchIds.map((branchId) => {
    const branch = branches.find((candidate) => candidate.id === branchId);
    if (!branch) {
      return 'Unavailable branch';
    }
    return branch.active ? branch.label : `${branch.label} (deactivated)`;
  });
  return labels.join(' · ');
}

/** TRUE iff this membership row is the caller's own (the org view returns
 *  the caller's active staff-membership id — the same id the staff read
 *  uses). The ONLY member identity signal the real contract provides. */
export function isOwnMembership(
  membership: StaffMembershipRecord,
  view: OrganizationView,
): boolean {
  return membership.id === view.membership.id;
}

/** TRUE iff revoking this row would remove the organization's only ACTIVE
 *  Owner — mirrored ONLY to avoid offering an operation the backend's
 *  invariant is guaranteed to refuse; the backend refusal
 *  (`lastOwnerProtected`) remains the authority on every attempt. Pending
 *  Owner invitations never count. */
export function isSoleActiveOwner(
  membership: StaffMembershipRecord,
  memberships: readonly StaffMembershipRecord[],
): boolean {
  if (membership.role !== 'owner' || membership.state !== 'active') {
    return false;
  }
  return !memberships.some(
    (candidate) =>
      candidate.id !== membership.id &&
      candidate.role === 'owner' &&
      candidate.state === 'active',
  );
}
