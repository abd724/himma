/**
 * Provider principal resolution (docs/27 §7, §8) — S3-3.
 *
 * Provider authority comes ONLY from an active `staff_membership` row in
 * Himma PostgreSQL, resolved fresh per request for the ONE addressed
 * organization — never from Cognito groups/custom claims, never cached,
 * never carried in tokens (docs/26 D1/A1.1). The org id in the URL is an
 * addressing input that must MATCH a membership, never a grant: no
 * membership, no organization, and terminal (offboarded) organizations all
 * collapse into the same not-found-shaped refusal so Provider A probing
 * Provider B's resources learns nothing (docs/26 §11.2).
 *
 * Membership revocation, organization suspension/offboarding, and role or
 * scope replacement therefore bite on the very next request — there is no
 * state anywhere else to go stale.
 */
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import {
  capabilitiesForRole,
  type ProviderCapability,
} from '../provider-capabilities';
import type { ProviderRole } from '../provider-roles';

export type OrganizationState =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'verified'
  | 'rejected'
  | 'live'
  | 'suspended'
  | 'offboarded';

/** The resolved per-request provider context (docs/27 §8 shape). */
export interface OrgScope {
  organizationId: string;
  membershipId: string;
  role: ProviderRole;
  capabilities: readonly ProviderCapability[];
  /** 'all' = organization-wide; otherwise the assigned ACTIVE branch ids —
   *  an empty array grants nothing (never a fallback to org-wide), and a
   *  deactivated branch simply disappears from the list. */
  branchScope: 'all' | string[];
  organizationState: OrganizationState;
}

export type ResolveOrgScopeResult =
  | { kind: 'resolved'; orgScope: OrgScope }
  | { kind: 'organizationNotFound' };

export async function resolveOrgScope(
  deps: { db: Db },
  input: { userId: string; organizationId: string },
): Promise<ResolveOrgScopeResult> {
  return withTransaction(deps.db, (trx) => resolveOrgScopeInTrx(trx, input));
}

export async function resolveOrgScopeInTrx(
  trx: Trx,
  input: { userId: string; organizationId: string },
): Promise<ResolveOrgScopeResult> {
  const notFound = { kind: 'organizationNotFound' as const };
  const org = await trx
    .selectFrom('organization')
    .select(['id', 'verification_state'])
    .where('id', '=', input.organizationId)
    .executeTakeFirst();
  if (org === undefined || org.verification_state === 'offboarded') return notFound;

  const membership = await trx
    .selectFrom('staff_membership')
    .select(['id', 'role', 'branch_scope_kind'])
    .where('user_id', '=', input.userId)
    .where('organization_id', '=', input.organizationId)
    .where('state', '=', 'active')
    .executeTakeFirst();
  if (membership === undefined) return notFound;

  const role = membership.role as ProviderRole;
  let branchScope: 'all' | string[] = 'all';
  if (membership.branch_scope_kind === 'branches') {
    // Assigned ACTIVE branches only: deactivation removes reach without
    // ever transferring it anywhere else (docs/27 §4/§5).
    const rows = await trx
      .selectFrom('staff_membership_branch')
      .innerJoin('branch', (join) =>
        join
          .onRef('branch.id', '=', 'staff_membership_branch.branch_id')
          .onRef('branch.organization_id', '=', 'staff_membership_branch.organization_id'),
      )
      .select('staff_membership_branch.branch_id')
      .where('staff_membership_branch.membership_id', '=', membership.id)
      .where('branch.active', '=', true)
      .execute();
    branchScope = rows.map((row) => row.branch_id);
  }

  return {
    kind: 'resolved',
    orgScope: {
      organizationId: org.id,
      membershipId: membership.id,
      role,
      capabilities: capabilitiesForRole(role),
      branchScope,
      organizationState: org.verification_state as OrganizationState,
    },
  };
}

/** TRUE iff the scope reaches the given branch (org-wide, or assigned+active). */
export function branchInScope(scope: OrgScope, branchId: string): boolean {
  return scope.branchScope === 'all' || scope.branchScope.includes(branchId);
}

export interface ProviderMembershipSummary {
  organizationId: string;
  displayName: string;
  role: ProviderRole;
  branchScope: 'all' | string[];
  organizationState: OrganizationState;
}

/**
 * The caller's own active memberships (GET /provider/me) — the portal's org
 * switcher source; per-request org binding still happens per docs/27 §8.
 * Offboarded organizations are terminal and omitted.
 */
export async function listProviderMemberships(
  deps: { db: Db },
  input: { userId: string },
): Promise<ProviderMembershipSummary[]> {
  return withTransaction(deps.db, async (trx) => {
    const memberships = await trx
      .selectFrom('staff_membership')
      .innerJoin('organization', 'organization.id', 'staff_membership.organization_id')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'organization.id',
      )
      .select([
        'staff_membership.id as membership_id',
        'staff_membership.organization_id',
        'staff_membership.role',
        'staff_membership.branch_scope_kind',
        'organization.verification_state',
        'organization_public_profile.display_name',
      ])
      .where('staff_membership.user_id', '=', input.userId)
      .where('staff_membership.state', '=', 'active')
      .where('organization.verification_state', '!=', 'offboarded')
      .orderBy('organization_public_profile.display_name')
      .execute();

    const summaries: ProviderMembershipSummary[] = [];
    for (const row of memberships) {
      let branchScope: 'all' | string[] = 'all';
      if (row.branch_scope_kind === 'branches') {
        const scopes = await trx
          .selectFrom('staff_membership_branch')
          .innerJoin('branch', (join) =>
            join
              .onRef('branch.id', '=', 'staff_membership_branch.branch_id')
              .onRef('branch.organization_id', '=', 'staff_membership_branch.organization_id'),
          )
          .select('staff_membership_branch.branch_id')
          .where('staff_membership_branch.membership_id', '=', row.membership_id)
          .where('branch.active', '=', true)
          .execute();
        branchScope = scopes.map((scope) => scope.branch_id);
      }
      summaries.push({
        organizationId: row.organization_id,
        displayName: row.display_name,
        role: row.role as ProviderRole,
        branchScope,
        organizationState: row.verification_state as OrganizationState,
      });
    }
    return summaries;
  });
}
