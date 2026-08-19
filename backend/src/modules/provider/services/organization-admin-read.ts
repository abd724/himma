/**
 * Himma-admin organization READ model (docs/31 §11 W3-2) — the internal
 * provider directory, review queue, and organization detail.
 *
 * First-class internal reads, deliberately separate from every other
 * surface: provider-private reads stay org-scoped (docs/27 §7), public
 * reads stay live-and-published projections, and THIS surface serves the
 * cross-provider operational view to the `operations` admin role only
 * (resolved fresh from PostgreSQL per request — provider memberships and
 * Cognito claims grant nothing, matching organization-admin.ts). W3-2 is
 * READ-ONLY: no lifecycle transition, no VerificationCase, no evidence.
 *
 * Query discipline (the W2-12C1 lesson): authorization → search/filter
 * predicates over the COMPLETE authorized set → deterministic
 * (created_at, id) order → keyset cursor → bounded projection. The list is
 * ONE query whose per-row aggregates ride correlated scalar subselects —
 * the statement count never scales with page size or branch counts.
 */
import { sql, type SqlBool } from 'kysely';

import type { Db } from '../../../db/kysely';
import { withTransaction } from '../../../db/transaction';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import { LISTING_STATES } from '../../catalogue/services/catalogue-shared';
import type { Trx } from '../../../db/transaction';

/** The exact ck_organization_state vocabulary (0005; docs/27 §5) — the ONE
 *  canonical organization state machine. There is no separate "lifecycle"
 *  column: verification_state IS the lifecycle. */
export const ORGANIZATION_STATES = [
  'draft',
  'submitted',
  'in_review',
  'verified',
  'rejected',
  'live',
  'suspended',
  'offboarded',
] as const;
export type OrganizationState = (typeof ORGANIZATION_STATES)[number];

/**
 * The review-queue predicate (W3-2 §9/§19), derived ENTIRELY from the
 * canonical state — no timers, no SLA, no risk heuristics:
 *
 * - `submitted`  → Himma must START the review        → awaiting_review
 * - `in_review`  → Himma OWNS the open review         → in_review
 * - `verified`   → go-live is a separate ADMIN action → awaiting_go_live
 *
 * Everything else is NOT Himma's action: `draft`/`rejected` wait on the
 * provider (rejected resubmits), `live` needs nothing, and
 * `suspended`/`offboarded` are deliberate admin-imposed states, not open
 * reviews.
 */
export const REVIEW_QUEUE_STATES = ['submitted', 'in_review', 'verified'] as const;

export type AdminReviewState = 'awaiting_review' | 'in_review' | 'awaiting_go_live' | 'none';

export function reviewStateOf(verificationState: string): AdminReviewState {
  switch (verificationState) {
    case 'submitted':
      return 'awaiting_review';
    case 'in_review':
      return 'in_review';
    case 'verified':
      return 'awaiting_go_live';
    default:
      return 'none';
  }
}

export interface AdminOrgReadDeps {
  db: Db;
}

export interface AdminOrgReadActor {
  userId: string;
}

/** Same fresh-per-transaction operations check as organization-admin.ts —
 *  the provider operational surface is operations-only in current canon
 *  (docs/31 §6; future read-only-role expansion is a separate decision). */
async function hasOperationsRole(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

/** Bounded internal directory row — never the organization graph. */
export interface AdminOrganizationSummary {
  organizationId: string;
  displayName: string;
  tradeName: string;
  verificationState: string;
  reviewState: AdminReviewState;
  /** published = provider intent; publiclyVisible = the Amendment A1
   *  effective predicate (live AND published). */
  storefront: { published: boolean; publiclyVisible: boolean };
  activeBranchCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Management search (the W2-12C1 semantics, verbatim): case-insensitive
 * literal substring, LIKE wildcards escaped, whitespace runs collapsed,
 * blank = no predicate. Searches the three legitimate management names —
 * public display name, trade name, and legal name (operations pastes any
 * of them from documents); never emails, subjects, or secrets.
 */
function nameSearchPattern(q: string | undefined): string | null {
  const normalized = (q ?? '').trim().replace(/\s+/g, ' ');
  if (normalized === '') return null;
  return `%${normalized.replace(/[\\%_]/g, (wildcard) => `\\${wildcard}`)}%`;
}

export type ListAdminOrganizationsResult =
  | {
      kind: 'organizations';
      organizations: AdminOrganizationSummary[];
      nextCursor: string | null;
    }
  | { kind: 'forbidden' };

export async function listAdminOrganizations(
  deps: AdminOrgReadDeps,
  actor: AdminOrgReadActor,
  input: {
    limit?: number;
    cursor?: string;
    q?: string;
    state?: OrganizationState;
    needsReview?: boolean;
  },
): Promise<ListAdminOrganizationsResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    // Authorization FIRST — an unauthorized identity learns nothing about
    // which organizations exist (no directory-as-enumeration-oracle).
    if (!(await hasOperationsRole(trx, actor.userId))) {
      return { kind: 'forbidden' as const };
    }

    let query = trx
      .selectFrom('organization')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'organization.id',
      )
      .select((eb) => [
        'organization.id as id',
        'organization.trade_name as trade_name',
        'organization.verification_state as verification_state',
        'organization.created_at as created_at',
        'organization.updated_at as updated_at',
        'organization_public_profile.display_name as display_name',
        'organization_public_profile.published as published',
        // The one per-row aggregate rides a correlated scalar subselect —
        // constant statement count, no row multiplication.
        eb
          .selectFrom('branch')
          .select((sub) => sub.fn.count('branch.id').as('n'))
          .whereRef('branch.organization_id', '=', 'organization.id')
          .where('branch.active', '=', true)
          .as('active_branch_count'),
      ]);

    // Authoritative filters over the COMPLETE set, BEFORE ordering, cursor
    // continuation, and the LIMIT window (the W2-12C1 rule).
    if (input.state !== undefined) {
      query = query.where('organization.verification_state', '=', input.state);
    }
    if (input.needsReview === true) {
      query = query.where('organization.verification_state', 'in', [...REVIEW_QUEUE_STATES]);
    }
    const searchPattern = nameSearchPattern(input.q);
    if (searchPattern !== null) {
      query = query.where(
        sql<SqlBool>`(organization_public_profile.display_name ILIKE ${searchPattern} ESCAPE ${'\\'}
          OR organization.trade_name ILIKE ${searchPattern} ESCAPE ${'\\'}
          OR organization.legal_name ILIKE ${searchPattern} ESCAPE ${'\\'})`,
      );
    }
    if (input.cursor !== undefined) {
      const anchor = await trx
        .selectFrom('organization')
        .select('id')
        .where('id', '=', input.cursor)
        .executeTakeFirst();
      if (anchor !== undefined) {
        // Row-wise keyset continuation evaluated entirely in SQL (exact
        // created_at precision); the cursor is a pure position — a walk
        // holds its filters constant, and a replay under other filters
        // deterministically continues that filter's ordered set.
        query = query.where(
          sql<SqlBool>`(organization.created_at, organization.id) > (SELECT created_at, id FROM organization WHERE id = ${input.cursor})`,
        );
      }
    }

    const rows = await query
      .orderBy('organization.created_at')
      .orderBy('organization.id')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    return {
      kind: 'organizations' as const,
      organizations: page.map((row) => ({
        organizationId: row.id,
        displayName: row.display_name,
        tradeName: row.trade_name,
        verificationState: row.verification_state,
        reviewState: reviewStateOf(row.verification_state),
        storefront: {
          published: row.published,
          publiclyVisible: row.verification_state === 'live' && row.published,
        },
        activeBranchCount: Number(row.active_branch_count),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });
}

// -- organization detail ------------------------------------------------------

export interface AdminOrganizationDetail {
  organization: {
    id: string;
    legalName: string;
    tradeName: string;
    orgKind: string;
    verificationState: string;
    reviewState: AdminReviewState;
    suspendedAt: string | null;
    offboardedAt: string | null;
    createdAt: string;
    updatedAt: string;
    version: number;
  };
  profile: {
    displayName: string;
    descriptionEn: string | null;
    descriptionAr: string | null;
    publicPhone: string | null;
    publicEmail: string | null;
    publicWebsite: string | null;
    publicInstagram: string | null;
    published: boolean;
    publiclyVisible: boolean;
  };
  branches: Array<{
    id: string;
    label: string;
    addressLine: string | null;
    city: string | null;
    areaLabel: string;
    active: boolean;
    createdAt: string;
  }>;
  /** ACTIVE memberships with the safe internal display identity: the
   *  canonical customer_account.display_name (1:1 with the user; every
   *  first-login creates it). Null = no account row exists (possible only
   *  for synthetic data) — never a secret, never an auth identifier. */
  team: Array<{
    membershipId: string;
    displayName: string | null;
    role: string;
    branchScopeKind: string;
    createdAt: string;
  }>;
  /** Real listing-state counts (docs/24 §5.3 vocabulary), ONE aggregate
   *  query — zero states included so the shape is total and honest. */
  catalogue: { total: number; byState: Record<string, number> };
}

export type GetAdminOrganizationDetailResult =
  | { kind: 'organizationDetail'; detail: AdminOrganizationDetail }
  | { kind: 'forbidden' }
  | { kind: 'organizationNotFound' };

export async function getAdminOrganizationDetail(
  deps: AdminOrgReadDeps,
  actor: AdminOrgReadActor,
  organizationId: string,
): Promise<GetAdminOrganizationDetailResult> {
  return withTransaction(deps.db, async (trx) => {
    // Authorization before existence — an unauthorized identity cannot use
    // the detail route as an organization-ID oracle.
    if (!(await hasOperationsRole(trx, actor.userId))) {
      return { kind: 'forbidden' as const };
    }
    const org = await trx
      .selectFrom('organization')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'organization.id',
      )
      .select([
        'organization.id as id',
        'organization.legal_name as legal_name',
        'organization.trade_name as trade_name',
        'organization.org_kind as org_kind',
        'organization.verification_state as verification_state',
        'organization.suspended_at as suspended_at',
        'organization.offboarded_at as offboarded_at',
        'organization.created_at as created_at',
        'organization.updated_at as updated_at',
        'organization.version as version',
        'organization_public_profile.display_name as display_name',
        'organization_public_profile.description_en as description_en',
        'organization_public_profile.description_ar as description_ar',
        'organization_public_profile.public_phone as public_phone',
        'organization_public_profile.public_email as public_email',
        'organization_public_profile.public_website as public_website',
        'organization_public_profile.public_instagram as public_instagram',
        'organization_public_profile.published as published',
      ])
      .where('organization.id', '=', organizationId)
      .executeTakeFirst();
    if (org === undefined) return { kind: 'organizationNotFound' as const };

    // Deliberate bounded section queries (constant count — never per-row):
    // branches, active team + display identity, listing-state aggregate.
    const branches = await trx
      .selectFrom('branch')
      .select(['id', 'label', 'address_line', 'city', 'area_label', 'active', 'created_at'])
      .where('organization_id', '=', organizationId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();

    const team = await trx
      .selectFrom('staff_membership')
      .leftJoin('customer_account', 'customer_account.user_id', 'staff_membership.user_id')
      .select([
        'staff_membership.id as membership_id',
        'staff_membership.role as role',
        'staff_membership.branch_scope_kind as branch_scope_kind',
        'staff_membership.created_at as created_at',
        'customer_account.display_name as display_name',
      ])
      .where('staff_membership.organization_id', '=', organizationId)
      .where('staff_membership.state', '=', 'active')
      .orderBy('staff_membership.created_at')
      .orderBy('staff_membership.id')
      .execute();

    const listingCounts = await trx
      .selectFrom('program')
      .select((eb) => ['listing_state', eb.fn.count('id').as('n')])
      .where('organization_id', '=', organizationId)
      .groupBy('listing_state')
      .execute();
    const byState: Record<string, number> = {};
    for (const state of LISTING_STATES) {
      byState[state] = 0;
    }
    let total = 0;
    for (const row of listingCounts) {
      const count = Number(row.n);
      byState[row.listing_state] = count;
      total += count;
    }

    return {
      kind: 'organizationDetail' as const,
      detail: {
        organization: {
          id: org.id,
          legalName: org.legal_name,
          tradeName: org.trade_name,
          orgKind: org.org_kind,
          verificationState: org.verification_state,
          reviewState: reviewStateOf(org.verification_state),
          suspendedAt: org.suspended_at?.toISOString() ?? null,
          offboardedAt: org.offboarded_at?.toISOString() ?? null,
          createdAt: org.created_at.toISOString(),
          updatedAt: org.updated_at.toISOString(),
          version: org.version,
        },
        profile: {
          displayName: org.display_name,
          descriptionEn: org.description_en,
          descriptionAr: org.description_ar,
          publicPhone: org.public_phone,
          publicEmail: org.public_email,
          publicWebsite: org.public_website,
          publicInstagram: org.public_instagram,
          published: org.published,
          publiclyVisible: org.verification_state === 'live' && org.published,
        },
        branches: branches.map((row) => ({
          id: row.id,
          label: row.label,
          addressLine: row.address_line,
          city: row.city,
          areaLabel: row.area_label,
          active: row.active,
          createdAt: row.created_at.toISOString(),
        })),
        team: team.map((row) => ({
          membershipId: row.membership_id,
          displayName: row.display_name,
          role: row.role,
          branchScopeKind: row.branch_scope_kind,
          createdAt: row.created_at.toISOString(),
        })),
        catalogue: { total, byState },
      },
    };
  });
}
