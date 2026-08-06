/**
 * Provider staff persistence (docs/27 §5, §9; repository layer of the
 * docs/25 §10 boundary). Every function takes the caller's transaction —
 * services own the documented transaction boundaries and this module owns
 * ALL access to staff_membership, staff_membership_branch, and
 * staff_invitation. No module above it touches these tables directly.
 */
import { sql } from 'kysely';

import { newId } from '../../../db/ids';
import type { Trx } from '../../../db/transaction';
import type { ProviderRole } from '../provider-roles';

export interface OrganizationRow {
  id: string;
  verification_state: string;
}

export interface StaffMembershipRow {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
  branch_scope_kind: string;
  state: string;
  version: number;
}

export interface StaffInvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  branch_scope_kind: string;
  branch_scope_ids: string[];
  state: string;
  invited_by: string;
  pepper_version: number;
  expires_at: Date;
  version: number;
}

// -- organization (read-only here; owned by the future org services) ----------

export async function findOrganizationState(
  trx: Trx,
  organizationId: string,
): Promise<OrganizationRow | undefined> {
  return trx
    .selectFrom('organization')
    .select(['id', 'verification_state'])
    .where('id', '=', organizationId)
    .executeTakeFirst();
}

/** Branches of the organization among the given ids (issue-time validation). */
export async function listOrganizationBranches(
  trx: Trx,
  organizationId: string,
  branchIds: string[],
): Promise<{ id: string; active: boolean }[]> {
  if (branchIds.length === 0) return [];
  return trx
    .selectFrom('branch')
    .select(['id', 'active'])
    .where('organization_id', '=', organizationId)
    .where('id', 'in', branchIds)
    .execute();
}

// -- staff_membership ---------------------------------------------------------

export async function findActiveMembership(
  trx: Trx,
  userId: string,
  organizationId: string,
): Promise<StaffMembershipRow | undefined> {
  return trx
    .selectFrom('staff_membership')
    .select(['id', 'user_id', 'organization_id', 'role', 'branch_scope_kind', 'state', 'version'])
    .where('user_id', '=', userId)
    .where('organization_id', '=', organizationId)
    .where('state', '=', 'active')
    .executeTakeFirst();
}

export interface NewStaffMembership {
  userId: string;
  organizationId: string;
  role: ProviderRole;
  branchScopeKind: 'all' | 'branches';
  invitedBy?: string;
  invitationId?: string;
}

export async function insertMembership(
  trx: Trx,
  membership: NewStaffMembership,
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('staff_membership')
    .values({
      id,
      user_id: membership.userId,
      organization_id: membership.organizationId,
      role: membership.role,
      branch_scope_kind: membership.branchScopeKind,
      invited_by: membership.invitedBy ?? null,
      invitation_id: membership.invitationId ?? null,
    })
    .execute();
  return id;
}

export async function insertMembershipBranchScopes(
  trx: Trx,
  input: { membershipId: string; organizationId: string; branchIds: string[] },
): Promise<void> {
  if (input.branchIds.length === 0) return;
  await trx
    .insertInto('staff_membership_branch')
    .values(
      input.branchIds.map((branchId) => ({
        membership_id: input.membershipId,
        branch_id: branchId,
        organization_id: input.organizationId,
      })),
    )
    .execute();
}

// -- staff_invitation ---------------------------------------------------------

export interface NewStaffInvitation {
  organizationId: string;
  /** Normalized (lowercased) target address. */
  email: string;
  role: ProviderRole;
  branchScopeKind: 'all' | 'branches';
  branchScopeIds: string[];
  invitedBy: string;
  tokenDigest: string;
  pepperVersion: number;
  expiresAt: Date;
}

export async function insertInvitation(
  trx: Trx,
  invitation: NewStaffInvitation,
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('staff_invitation')
    .values({
      id,
      organization_id: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      branch_scope_kind: invitation.branchScopeKind,
      branch_scope_ids: invitation.branchScopeIds,
      invited_by: invitation.invitedBy,
      token_digest: invitation.tokenDigest,
      pepper_version: invitation.pepperVersion,
      expires_at: invitation.expiresAt,
    })
    .execute();
  return id;
}

const INVITATION_COLUMNS = [
  'id',
  'organization_id',
  'email',
  'role',
  'branch_scope_kind',
  'branch_scope_ids',
  'state',
  'invited_by',
  'pepper_version',
  'expires_at',
  'version',
] as const;

/** Acceptance lookup — FOR UPDATE so racing acceptances serialize on the row. */
export async function findInvitationByDigestForUpdate(
  trx: Trx,
  tokenDigest: string,
): Promise<StaffInvitationRow | undefined> {
  return trx
    .selectFrom('staff_invitation')
    .select(INVITATION_COLUMNS)
    .where('token_digest', '=', tokenDigest)
    .forUpdate()
    .executeTakeFirst();
}

export async function findInvitationById(
  trx: Trx,
  organizationId: string,
  invitationId: string,
): Promise<StaffInvitationRow | undefined> {
  return trx
    .selectFrom('staff_invitation')
    .select(INVITATION_COLUMNS)
    .where('id', '=', invitationId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
}

/** CAS sent → accepted; the trigger additionally refuses overdue rows. */
export async function acceptInvitationCas(
  trx: Trx,
  invitationId: string,
  acceptedBy: string,
): Promise<boolean> {
  const result = await trx
    .updateTable('staff_invitation')
    .set({ state: 'accepted', accepted_at: new Date(), accepted_by: acceptedBy })
    .where('id', '=', invitationId)
    .where('state', '=', 'sent')
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** CAS sent → revoked; false when the row already left `sent`. */
export async function revokeInvitationCas(
  trx: Trx,
  invitationId: string,
  revokedBy: string,
): Promise<boolean> {
  const result = await trx
    .updateTable('staff_invitation')
    .set({ state: 'revoked', revoked_at: new Date(), revoked_by: revokedBy })
    .where('id', '=', invitationId)
    .where('state', '=', 'sent')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Revokes every still-`sent` invitation for the organization + normalized
 * address (the approved resend policy: revoke + NEW row, docs/27 §9).
 * Returns the revoked ids for auditing.
 */
export async function revokeSentInvitationsForEmail(
  trx: Trx,
  input: { organizationId: string; email: string; revokedBy: string },
): Promise<string[]> {
  const rows = await trx
    .updateTable('staff_invitation')
    .set({ state: 'revoked', revoked_at: new Date(), revoked_by: input.revokedBy })
    .where('organization_id', '=', input.organizationId)
    .where('email', '=', input.email)
    .where('state', '=', 'sent')
    .returning('id')
    .execute();
  return rows.map((row) => row.id);
}

/**
 * Expiry sweep (B2-5 pattern): finalizes overdue `sent` rows. Rows are
 * locked in deterministic id order first, so concurrent sweeps serialize
 * instead of deadlocking; the re-evaluated state predicate makes the sweep
 * idempotent — a row transitions (and is returned for eventing) exactly
 * once.
 */
export async function expireDueInvitations(
  trx: Trx,
): Promise<{ id: string; organization_id: string }[]> {
  const due = await trx
    .selectFrom('staff_invitation')
    .select(['id', 'organization_id'])
    .where('state', '=', 'sent')
    .where('expires_at', '<=', new Date())
    .orderBy('id')
    .forUpdate()
    .execute();
  if (due.length === 0) return [];
  await trx
    .updateTable('staff_invitation')
    .set({ state: 'expired', expired_at: new Date() })
    .where('id', 'in', due.map((row) => row.id))
    .execute();
  return due;
}

// -- D-S3-1 verified-email authorization condition ----------------------------

/**
 * TRUE iff the user holds an ACTIVE identity whose VERIFIED email matches
 * the normalized target (docs/27 §9, D-S3-1). Display names never
 * participate; issuer+subject alone never satisfies this; an Apple
 * private-relay address simply fails to match until the user links and
 * verifies the invited address through the Slice-2 flow.
 */
export async function userHasActiveVerifiedEmail(
  trx: Trx,
  userId: string,
  normalizedEmail: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('auth_identity')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .where('email_verified', '=', true)
    .where(sql`lower(email)`, '=', normalizedEmail)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
