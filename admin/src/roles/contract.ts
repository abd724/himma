/**
 * W3-9 AD-17 roles-administration contract — the typed frontend mirror of
 * the CERTIFIED B2-5 admin role surface (`/admin/role-assignments`
 * list/detail/revoke · `/admin/role-requests` + approve/deny). Nothing
 * here invents authority semantics: exactly five canonical roles (no
 * superadmin exists or can be expressed), grants are DUAL-CONTROL
 * (requester ≠ approver — the database triggers are the final authority,
 * surfaced as the distinct dualControlViolation refusal), D4 exclusivity
 * and finance-approver rules stay server-side, every decision carries CAS
 * `expectedVersion`, and reads are service-gated to access_admin |
 * auditor (roles.view) while mutations additionally demand roles.administer
 * authority AND the adminStepUp recent factor (D-W3-5 owner-pending).
 */

export const ADMIN_ROLE_OPTIONS = [
  'operations',
  'access_admin',
  'auditor',
  'support',
  'finance',
] as const;
export type AdminRoleOption = (typeof ADMIN_ROLE_OPTIONS)[number];

export interface RoleAssignmentRecord {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  /** requested | active | denied | revoked | expired (0002 vocabulary). */
  readonly state: string;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

export type RoleAssignmentsOutcome =
  | { readonly kind: 'loaded'; readonly assignments: readonly RoleAssignmentRecord[] }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

/** Typed action refusals — the certified backend conditions, distinct. */
export type RoleActionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'stepUpRequired' }
  /** Approver = requester (dual control, database-enforced). */
  | { readonly kind: 'dualControlViolation' }
  /** Requester/approver lacks the qualifying authority. */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'alreadyFinalized' }
  | { readonly kind: 'roleConflict' }
  | { readonly kind: 'staleVersion' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface AdminRolesPort {
  listAssignments(params: {
    state?: string;
    userId?: string;
  }): Promise<RoleAssignmentsOutcome>;
  requestRole(input: {
    targetUserId: string;
    role: AdminRoleOption;
    expiresAt?: string;
  }): Promise<RoleActionOutcome>;
  approveRequest(
    assignmentId: string,
    input: { expectedVersion: number },
  ): Promise<RoleActionOutcome>;
  denyRequest(
    assignmentId: string,
    input: { expectedVersion: number },
  ): Promise<RoleActionOutcome>;
  revokeAssignment(
    assignmentId: string,
    input: { expectedVersion: number },
  ): Promise<RoleActionOutcome>;
}
