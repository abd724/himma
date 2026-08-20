/**
 * Provider-private organization management services (docs/27 §13.2) — S3-3.
 *
 * Every function receives an already-resolved `OrgScope` (the provider
 * policy resolved it fresh from PostgreSQL this request) and re-applies the
 * data rules that belong to the service layer: org-scoped queries (a
 * foreign or unknown id inside this organization's addressing is
 * not-found-shaped), branch-scope enforcement for `branches`-scoped
 * memberships, optimistic-CAS versioning, and the capability-shaped private
 * projection (coach never receives legal/commercial fields — docs/27 §6).
 * Mutations write their audit + outbox events in the same transaction
 * (docs/24 §7); payloads carry safe identifiers only.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { isDbError } from '../../../db/errors';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { branchInScope, type OrgScope } from './provider-principal';
import { getProviderSafeVerificationSummary } from './verification-case';

export interface ProviderServiceDeps {
  db: Db;
}

export interface ProviderActor {
  userId: string;
}

// -- private organization view (§13.2 GET) ------------------------------------

export interface BranchView {
  id: string;
  label: string;
  addressLine: string | null;
  city: string | null;
  areaLabel: string;
  geoPoint: { longitude: number; latitude: number } | null;
  openingHours: unknown;
  facilities: string[];
  active: boolean;
  version: number;
}

export interface ProviderOrganizationView {
  organization: {
    id: string;
    tradeName: string;
    /** Present only with `org.legal.view` (coach minimization, docs/27 §6). */
    legalName?: string;
    orgKind: string;
    verificationState: string;
    /** Present only with `commercial_terms.view` (owner). */
    commercialTermsRef?: string | null;
    version: number;
  };
  profile: {
    displayName: string;
    descriptionEn: string | null;
    descriptionAr: string | null;
    logoMediaRef: string | null;
    coverMediaRef: string | null;
    galleryMediaRefs: string[];
    publicPhone: string | null;
    publicEmail: string | null;
    publicWebsite: string | null;
    publicInstagram: string | null;
    published: boolean;
    version: number;
  };
  branches: BranchView[];
  /** W3-8 (docs/31 §5): the provider-safe verification projection over the
   *  W3-3 structural seam — null when no review round has ever existed;
   *  `latestDecision` null while the current round is undecided. Internal
   *  reviewer notes and reviewer identity are UNSELECTABLE through the
   *  seam, so this view cannot leak them. */
  verification: {
    latestDecision: {
      outcome: string;
      reasonCode: string | null;
      providerMessage: string | null;
      decidedAt: string;
    } | null;
  } | null;
  membership: {
    id: string;
    role: string;
    branchScope: 'all' | string[];
    capabilities: string[];
  };
}

function toBranchView(row: {
  id: string;
  label: string;
  address_line: string | null;
  city: string | null;
  area_label: string;
  geo_point: { x: number; y: number } | null;
  opening_hours: unknown;
  facilities: string[];
  active: boolean;
  version: number;
}): BranchView {
  return {
    id: row.id,
    label: row.label,
    addressLine: row.address_line,
    city: row.city,
    areaLabel: row.area_label,
    geoPoint:
      row.geo_point === null ? null : { longitude: row.geo_point.x, latitude: row.geo_point.y },
    openingHours: row.opening_hours,
    facilities: row.facilities,
    active: row.active,
    version: row.version,
  };
}

const BRANCH_COLUMNS = [
  'id',
  'label',
  'address_line',
  'city',
  'area_label',
  'geo_point',
  'opening_hours',
  'facilities',
  'active',
  'version',
] as const;

export async function getProviderOrganizationView(
  deps: ProviderServiceDeps,
  scope: OrgScope,
): Promise<ProviderOrganizationView> {
  return withTransaction(deps.db, async (trx) => {
    const org = await trx
      .selectFrom('organization')
      .select(['id', 'legal_name', 'trade_name', 'org_kind', 'verification_state', 'commercial_terms_ref', 'version'])
      .where('id', '=', scope.organizationId)
      .executeTakeFirstOrThrow();
    const profile = await trx
      .selectFrom('organization_public_profile')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirstOrThrow();
    const branches = await trx
      .selectFrom('branch')
      .select(BRANCH_COLUMNS)
      .where('organization_id', '=', scope.organizationId)
      .orderBy('created_at')
      .execute();

    // W3-8: the provider-safe verification summary rides the W3-3 seam —
    // structurally unable to select internal notes or reviewer identity.
    // Transaction<DB> extends Kysely<DB>, so the seam reads the SAME
    // transaction snapshot as the rest of the view.
    const verification = await getProviderSafeVerificationSummary(
      { db: trx },
      { organizationId: scope.organizationId },
    );

    return {
      organization: {
        id: org.id,
        tradeName: org.trade_name,
        // Capability-shaped, not filtered-by-convention: the projection adds
        // a private field only when the capability grants it (docs/27 §6).
        ...(scope.capabilities.includes('org.legal.view') ? { legalName: org.legal_name } : {}),
        orgKind: org.org_kind,
        verificationState: org.verification_state,
        ...(scope.capabilities.includes('commercial_terms.view')
          ? { commercialTermsRef: org.commercial_terms_ref }
          : {}),
        version: org.version,
      },
      profile: {
        displayName: profile.display_name,
        descriptionEn: profile.description_en,
        descriptionAr: profile.description_ar,
        logoMediaRef: profile.logo_media_ref,
        coverMediaRef: profile.cover_media_ref,
        galleryMediaRefs: profile.gallery_media_refs,
        publicPhone: profile.public_phone,
        publicEmail: profile.public_email,
        publicWebsite: profile.public_website,
        publicInstagram: profile.public_instagram,
        published: profile.published,
        version: profile.version,
      },
      branches: branches.map(toBranchView),
      verification:
        verification.kind === 'noCase'
          ? null
          : {
              latestDecision:
                verification.summary.decision === null
                  ? null
                  : {
                      outcome: verification.summary.decision.outcome,
                      reasonCode: verification.summary.decision.reasonCode,
                      providerMessage: verification.summary.decision.providerSafeMessage,
                      decidedAt: verification.summary.decision.decidedAt,
                    },
            },
      membership: {
        id: scope.membershipId,
        role: scope.role,
        branchScope: scope.branchScope,
        capabilities: [...scope.capabilities],
      },
    };
  });
}

// -- public-profile edit (§13.2 PATCH .../profile) ----------------------------

export interface ProfilePatch {
  displayName?: string;
  descriptionEn?: string | null;
  descriptionAr?: string | null;
  logoMediaRef?: string | null;
  coverMediaRef?: string | null;
  galleryMediaRefs?: string[];
  publicPhone?: string | null;
  publicEmail?: string | null;
  publicWebsite?: string | null;
  publicInstagram?: string | null;
  published?: boolean;
}

export type UpdateProfileResult =
  | { kind: 'profileUpdated'; version: number }
  | { kind: 'staleVersion' };

export async function updatePublicProfile(
  deps: ProviderServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { expectedVersion: number; patch: ProfilePatch },
): Promise<UpdateProfileResult> {
  return withTransaction(deps.db, async (trx) => {
    const current = await trx
      .selectFrom('organization_public_profile')
      .select(['published', 'version'])
      .where('organization_id', '=', scope.organizationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const patch = input.patch;
    const updated = await trx
      .updateTable('organization_public_profile')
      .set({
        ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}),
        ...(patch.descriptionEn !== undefined ? { description_en: patch.descriptionEn } : {}),
        ...(patch.descriptionAr !== undefined ? { description_ar: patch.descriptionAr } : {}),
        ...(patch.logoMediaRef !== undefined ? { logo_media_ref: patch.logoMediaRef } : {}),
        ...(patch.coverMediaRef !== undefined ? { cover_media_ref: patch.coverMediaRef } : {}),
        ...(patch.galleryMediaRefs !== undefined
          ? { gallery_media_refs: patch.galleryMediaRefs }
          : {}),
        ...(patch.publicPhone !== undefined ? { public_phone: patch.publicPhone } : {}),
        ...(patch.publicEmail !== undefined ? { public_email: patch.publicEmail } : {}),
        ...(patch.publicWebsite !== undefined ? { public_website: patch.publicWebsite } : {}),
        ...(patch.publicInstagram !== undefined
          ? { public_instagram: patch.publicInstagram }
          : {}),
        ...(patch.published !== undefined ? { published: patch.published } : {}),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.profile_updated',
      entityType: 'organization_public_profile',
      entityId: scope.organizationId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: scope.organizationId,
      eventType: 'organization.profile_updated',
      payload: { organizationId: scope.organizationId },
    });
    // The publish switch transition is its own approved audit vocabulary
    // (docs/27 §12.7) on top of the update event.
    if (patch.published !== undefined && patch.published !== current.published) {
      const action = patch.published ? 'org.profile_published' : 'org.profile_unpublished';
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.userId,
        action,
        entityType: 'organization_public_profile',
        entityId: scope.organizationId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'organization',
        aggregateId: scope.organizationId,
        eventType: patch.published
          ? 'organization.profile_published'
          : 'organization.profile_unpublished',
        payload: { organizationId: scope.organizationId },
      });
    }
    return { kind: 'profileUpdated' as const, version: updated.version };
  });
}

// -- submission (§13.2 POST .../submit; docs/27 §10 step 3) -------------------

export type SubmitOrganizationResult =
  | { kind: 'organizationSubmitted'; version: number }
  | { kind: 'organizationIncomplete' }
  | { kind: 'lifecycleConflict' }
  | { kind: 'staleVersion' };

export async function submitOrganization(
  deps: ProviderServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { expectedVersion: number },
): Promise<SubmitOrganizationResult> {
  return withTransaction(deps.db, async (trx) => {
    const org = await trx
      .selectFrom('organization')
      .select(['verification_state', 'version'])
      .where('id', '=', scope.organizationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (org.verification_state !== 'draft' && org.verification_state !== 'rejected') {
      return { kind: 'lifecycleConflict' as const };
    }
    if (org.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    // Submission completeness (docs/27 §5.1/§10): profile essentials plus
    // at least one ACTIVE branch.
    const profile = await trx
      .selectFrom('organization_public_profile')
      .select(['display_name'])
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirstOrThrow();
    const activeBranches = await trx
      .selectFrom('branch')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('active', '=', true)
      .limit(1)
      .execute();
    if (profile.display_name.trim().length === 0 || activeBranches.length === 0) {
      return { kind: 'organizationIncomplete' as const };
    }

    const updated = await trx
      .updateTable('organization')
      .set({ verification_state: 'submitted' })
      .where('id', '=', scope.organizationId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.submitted',
      entityType: 'organization',
      entityId: scope.organizationId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: scope.organizationId,
      eventType: 'organization.submitted',
      payload: { organizationId: scope.organizationId, previousState: org.verification_state },
    });
    return { kind: 'organizationSubmitted' as const, version: updated.version };
  });
}

// -- branch management (§13.2 POST/PATCH/deactivate) --------------------------

export interface BranchInput {
  label: string;
  addressLine?: string | null;
  city?: string | null;
  areaLabel: string;
  geoPoint?: { longitude: number; latitude: number } | null;
  openingHours?: unknown;
  facilities?: string[];
}

export type CreateBranchResult = { kind: 'branchCreated'; branch: BranchView };

export async function createBranch(
  deps: ProviderServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: BranchInput,
): Promise<CreateBranchResult> {
  return withTransaction(deps.db, async (trx) => {
    const id = newId();
    await trx
      .insertInto('branch')
      .values({
        id,
        organization_id: scope.organizationId,
        label: input.label,
        address_line: input.addressLine ?? null,
        city: input.city ?? null,
        area_label: input.areaLabel,
        geo_point:
          input.geoPoint === undefined || input.geoPoint === null
            ? null
            : sql`point(${input.geoPoint.longitude}, ${input.geoPoint.latitude})`,
        opening_hours:
          input.openingHours === undefined ? null : JSON.stringify(input.openingHours),
        facilities: input.facilities ?? [],
      })
      .execute();
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.branch_created',
      entityType: 'branch',
      entityId: id,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: scope.organizationId,
      eventType: 'organization.branch_created',
      payload: { branchId: id },
    });
    const created = await trx
      .selectFrom('branch')
      .select(BRANCH_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'branchCreated' as const, branch: toBranchView(created) };
  });
}

export interface BranchPatch {
  label?: string;
  addressLine?: string | null;
  city?: string | null;
  areaLabel?: string;
  geoPoint?: { longitude: number; latitude: number } | null;
  openingHours?: unknown;
  facilities?: string[];
}

export type UpdateBranchResult =
  | { kind: 'branchUpdated'; branch: BranchView }
  | { kind: 'branchNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'staleVersion' };

/** Org-scoped branch lookup: a foreign organization's branch id resolves to
 *  nothing here, so cross-org ids are not-found-shaped by construction. */
async function findOrgBranch(
  trx: Trx,
  scope: OrgScope,
  branchId: string,
): Promise<{ id: string; active: boolean; version: number } | undefined> {
  return trx
    .selectFrom('branch')
    .select(['id', 'active', 'version'])
    .where('id', '=', branchId)
    .where('organization_id', '=', scope.organizationId)
    .forUpdate()
    .executeTakeFirst();
}

export async function updateBranch(
  deps: ProviderServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { branchId: string; expectedVersion: number; patch: BranchPatch },
): Promise<UpdateBranchResult> {
  return withTransaction(deps.db, async (trx) => {
    const branch = await findOrgBranch(trx, scope, input.branchId);
    if (branch === undefined) return { kind: 'branchNotFound' as const };
    // Branch-scoped memberships act only on explicitly assigned ACTIVE
    // branches (scope resolution already dropped deactivated ones); there
    // is no fallback from an empty scope list to org-wide reach.
    if (!branchInScope(scope, input.branchId)) return { kind: 'forbidden' as const };
    if (branch.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const patch = input.patch;
    const updated = await trx
      .updateTable('branch')
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.addressLine !== undefined ? { address_line: patch.addressLine } : {}),
        ...(patch.city !== undefined ? { city: patch.city } : {}),
        ...(patch.areaLabel !== undefined ? { area_label: patch.areaLabel } : {}),
        ...(patch.geoPoint !== undefined
          ? {
              geo_point:
                patch.geoPoint === null
                  ? null
                  : sql`point(${patch.geoPoint.longitude}, ${patch.geoPoint.latitude})`,
            }
          : {}),
        ...(patch.openingHours !== undefined
          ? {
              opening_hours:
                patch.openingHours === null ? null : JSON.stringify(patch.openingHours),
            }
          : {}),
        ...(patch.facilities !== undefined ? { facilities: patch.facilities } : {}),
      })
      .where('id', '=', input.branchId)
      .where('version', '=', input.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    if (updated === undefined) return { kind: 'staleVersion' as const };

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.branch_updated',
      entityType: 'branch',
      entityId: input.branchId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: scope.organizationId,
      eventType: 'organization.branch_updated',
      payload: { branchId: input.branchId },
    });
    const row = await trx
      .selectFrom('branch')
      .select(BRANCH_COLUMNS)
      .where('id', '=', input.branchId)
      .executeTakeFirstOrThrow();
    return { kind: 'branchUpdated' as const, branch: toBranchView(row) };
  });
}

export type DeactivateBranchResult =
  | { kind: 'branchDeactivated' }
  | { kind: 'branchNotFound' }
  | { kind: 'staleVersion' };

export async function deactivateBranch(
  deps: ProviderServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { branchId: string; expectedVersion: number },
): Promise<DeactivateBranchResult> {
  return withTransaction(deps.db, async (trx) => {
    const branch = await findOrgBranch(trx, scope, input.branchId);
    if (branch === undefined) return { kind: 'branchNotFound' as const };
    // Idempotent: deactivating an inactive branch changes nothing and
    // re-emits nothing.
    if (!branch.active) return { kind: 'branchDeactivated' as const };
    if (branch.version !== input.expectedVersion) return { kind: 'staleVersion' as const };

    const updated = await trx
      .updateTable('branch')
      .set({ active: false })
      .where('id', '=', input.branchId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      action: 'org.branch_deactivated',
      entityType: 'branch',
      entityId: input.branchId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'organization',
      aggregateId: scope.organizationId,
      eventType: 'organization.branch_deactivated',
      payload: { branchId: input.branchId },
    });
    return { kind: 'branchDeactivated' as const };
  });
}

// -- staff list + membership revocation (§13.2 staff surface) -----------------

export interface StaffMembershipView {
  id: string;
  userId: string;
  role: string;
  branchScopeKind: string;
  branchIds: string[];
  state: string;
  createdAt: string;
  version: number;
}

export interface StaffInvitationView {
  id: string;
  email: string;
  role: string;
  branchScopeKind: string;
  branchIds: string[];
  state: string;
  expiresAt: string;
  version: number;
}

export interface StaffListView {
  memberships: StaffMembershipView[];
  invitations: StaffInvitationView[];
}

export async function listStaff(
  deps: ProviderServiceDeps,
  scope: OrgScope,
): Promise<StaffListView> {
  return withTransaction(deps.db, async (trx) => {
    const memberships = await trx
      .selectFrom('staff_membership')
      .select(['id', 'user_id', 'role', 'branch_scope_kind', 'state', 'created_at', 'version'])
      .where('organization_id', '=', scope.organizationId)
      .orderBy('created_at')
      .execute();
    const scopeRows = await trx
      .selectFrom('staff_membership_branch')
      .select(['membership_id', 'branch_id'])
      .where('organization_id', '=', scope.organizationId)
      .execute();
    const branchesByMembership = new Map<string, string[]>();
    for (const row of scopeRows) {
      const list = branchesByMembership.get(row.membership_id) ?? [];
      list.push(row.branch_id);
      branchesByMembership.set(row.membership_id, list);
    }
    const invitations = await trx
      .selectFrom('staff_invitation')
      .select(['id', 'email', 'role', 'branch_scope_kind', 'branch_scope_ids', 'state', 'expires_at', 'version'])
      .where('organization_id', '=', scope.organizationId)
      .orderBy('created_at')
      .execute();
    return {
      memberships: memberships.map((row) => ({
        id: row.id,
        userId: row.user_id,
        role: row.role,
        branchScopeKind: row.branch_scope_kind,
        branchIds: branchesByMembership.get(row.id) ?? [],
        state: row.state,
        createdAt: row.created_at.toISOString(),
        version: row.version,
      })),
      invitations: invitations.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        branchScopeKind: row.branch_scope_kind,
        branchIds: row.branch_scope_ids,
        state: row.state,
        expiresAt: row.expires_at.toISOString(),
        version: row.version,
      })),
    };
  });
}

export type RevokeMembershipResult =
  | { kind: 'membershipRevoked' }
  | { kind: 'membershipNotFound' }
  | { kind: 'lastOwnerProtected' }
  | { kind: 'staleVersion' };

/**
 * Revokes one membership row (docs/27 §5: role/scope change = revoke +
 * NEW invitation/membership — history is never rewritten). The S3-2
 * last-active-owner trigger stays the final authority; its refusal is
 * translated, never bypassed. Revoking an already-revoked membership is
 * idempotent and emits nothing.
 */
export async function revokeStaffMembership(
  deps: ProviderServiceDeps,
  scope: OrgScope,
  actor: ProviderActor,
  input: { membershipId: string; expectedVersion: number },
): Promise<RevokeMembershipResult> {
  try {
    return await withTransaction(deps.db, async (trx) => {
      const membership = await trx
        .selectFrom('staff_membership')
        .select(['id', 'state', 'version'])
        .where('id', '=', input.membershipId)
        .where('organization_id', '=', scope.organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (membership === undefined) return { kind: 'membershipNotFound' as const };
      if (membership.state === 'revoked') return { kind: 'membershipRevoked' as const };
      if (membership.version !== input.expectedVersion) {
        return { kind: 'staleVersion' as const };
      }

      const updated = await trx
        .updateTable('staff_membership')
        .set({ state: 'revoked', revoked_at: new Date(), revoked_by: actor.userId })
        .where('id', '=', input.membershipId)
        .where('version', '=', input.expectedVersion)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };

      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.userId,
        action: 'org.staff_revoked',
        entityType: 'staff_membership',
        entityId: input.membershipId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'organization',
        aggregateId: scope.organizationId,
        eventType: 'staff.revoked',
        payload: { membershipId: input.membershipId },
      });
      return { kind: 'membershipRevoked' as const };
    });
  } catch (error) {
    // The S3-2 guard's refusal, typed — the trigger remains the authority.
    if (isDbError(error, 'raisedException') && error.message.includes('last-owner protection')) {
      return { kind: 'lastOwnerProtected' };
    }
    throw error;
  }
}
