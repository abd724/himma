/**
 * W3-2 internal provider-organization read contract — the typed frontend
 * mirror of the backend's `GET /admin/organizations[/:organizationId]`
 * read model (organization-admin-read.ts). READ-ONLY by design: no
 * lifecycle transitions, no VerificationCase, no evidence.
 */

/** The exact ck_organization_state vocabulary — verification_state IS the
 *  one canonical organization lifecycle; no frontend-only states exist. */
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

/** Derived review-queue projection (state-driven, never persisted):
 *  submitted → awaiting_review · in_review → in_review ·
 *  verified → awaiting_go_live · everything else → none. */
export const REVIEW_STATES = ['awaiting_review', 'in_review', 'awaiting_go_live', 'none'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** docs/24 §5.3 listing lifecycle vocabulary (catalogue summary keys). */
export const LISTING_STATES = [
  'draft',
  'submitted',
  'in_review',
  'approved',
  'changes_requested',
  'published',
  'paused',
  'archived',
] as const;
export type ListingState = (typeof LISTING_STATES)[number];

export interface OrganizationStorefront {
  readonly published: boolean;
  readonly publiclyVisible: boolean;
}

export interface OrganizationSummary {
  readonly organizationId: string;
  readonly displayName: string;
  readonly tradeName: string;
  readonly verificationState: OrganizationState;
  readonly reviewState: ReviewState;
  readonly storefront: OrganizationStorefront;
  readonly activeBranchCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrganizationsPage {
  readonly organizations: readonly OrganizationSummary[];
  readonly nextCursor: string | null;
}

export interface OrganizationDetail {
  readonly organization: {
    readonly id: string;
    readonly legalName: string;
    readonly tradeName: string;
    readonly orgKind: string;
    readonly verificationState: OrganizationState;
    readonly reviewState: ReviewState;
    readonly suspendedAt: string | null;
    readonly offboardedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly version: number;
  };
  readonly profile: {
    readonly displayName: string;
    readonly descriptionEn: string | null;
    readonly descriptionAr: string | null;
    readonly publicPhone: string | null;
    readonly publicEmail: string | null;
    readonly publicWebsite: string | null;
    readonly publicInstagram: string | null;
    readonly published: boolean;
    readonly publiclyVisible: boolean;
  };
  readonly branches: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly addressLine: string | null;
    readonly city: string | null;
    readonly areaLabel: string;
    readonly active: boolean;
    readonly createdAt: string;
  }>;
  readonly team: ReadonlyArray<{
    readonly membershipId: string;
    readonly displayName: string | null;
    readonly role: string;
    readonly branchScopeKind: string;
    readonly createdAt: string;
  }>;
  readonly catalogue: {
    readonly total: number;
    readonly byState: Readonly<Record<ListingState, number>>;
  };
}

export interface ListOrganizationsParams {
  readonly limit: number;
  readonly cursor?: string;
  readonly q?: string;
  readonly state?: OrganizationState;
  readonly needsReview?: boolean;
}

export type OrganizationsListOutcome =
  | { readonly kind: 'loaded'; readonly page: OrganizationsPage }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export type OrganizationDetailOutcome =
  | { readonly kind: 'loaded'; readonly detail: OrganizationDetail }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface AdminProvidersReadPort {
  listOrganizations(params: ListOrganizationsParams): Promise<OrganizationsListOutcome>;
  getOrganization(organizationId: string): Promise<OrganizationDetailOutcome>;
}
