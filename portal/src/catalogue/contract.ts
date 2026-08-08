/**
 * Provider catalogue READ seam — mirrors the two REAL provider-private
 * catalogue read routes (backend/src/modules/catalogue/http/
 * catalogue-routes.ts) field for field. W2-12 implements this port over the
 * live API; until then the semantic fixture stands behind the same contract.
 *
 * - `listListings` ⇄ `GET /provider/organizations/:orgId/listings`
 *   (capability `catalogue.read` — owner, org_manager, branch_manager,
 *   listings_editor in the shipped registry). Keyset pagination in
 *   `(createdAt, id)` order: `limit` 1–100 (server default 50), `cursor` is
 *   an OPAQUE listing id returned as `nextCursor` — never a page number.
 *   The real service ignores an unknown/foreign cursor (lists from the
 *   start) and, for branch-scoped staff, filters the fetched window to
 *   REACHABLE listings: those with no active branch association (drafts
 *   not yet placed anywhere) or at least one active association to one of
 *   the caller's assigned ACTIVE branches. The summary row carries EXACTLY
 *   the real seven fields — no price, branch, media, offer, or revision
 *   data exists on the list contract.
 * - `loadListing` ⇄ `GET .../listings/:programId` (same capability). The
 *   detail read is organization-scoped ONLY: the shipped service applies NO
 *   branch-scope filter (scope constrains the list window and mutations,
 *   never this read) — proven from program-management.ts. Unknown ids and
 *   other organizations' ids collapse into one not-found shape.
 *
 * Deliberately absent because W2-7 is read-oriented (W2-8/W2-9 own them):
 * no create/PATCH, no submit/publish/pause/archive, no price-option, branch-
 * association, media, offer, or revision mutation of any kind.
 */

/** docs/24 §5.3 — the exact Program lifecycle vocabulary. */
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

/** backend PRICE_OPTION_KINDS (price-option-management.ts) — exact. */
export const PRICE_OPTION_KINDS = [
  'dropIn',
  'monthly',
  'term',
  'camp',
  'package',
  'free',
] as const;
export type PriceOptionKind = (typeof PRICE_OPTION_KINDS)[number];

/** backend OFFER_KINDS (media-offer-management.ts) — exact. */
export const OFFER_KINDS = ['freeTrial', 'paidTrial', 'discount', 'promo'] as const;
export type OfferKind = (typeof OFFER_KINDS)[number];

/** The real list-row projection — seven fields, nothing more. */
export interface ProgramSummaryRecord {
  readonly id: string;
  readonly titleEn: string;
  readonly listingState: string;
  readonly activityTypeId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProgramListPage {
  readonly programs: readonly ProgramSummaryRecord[];
  /** Opaque continuation cursor (a listing id) — null on the last page. */
  readonly nextCursor: string | null;
}

/** ProgramDetailView.priceOptions[] — exact PriceOptionView shape. */
export interface PriceOptionRecord {
  readonly id: string;
  readonly kind: string;
  /** Integer fils; null iff kind `free`. */
  readonly amountFils: number | null;
  readonly currency: string;
  readonly sessionsCount: number | null;
  readonly labelEn: string | null;
  readonly labelAr: string | null;
  readonly sortHint: number;
  readonly state: string;
  readonly version: number;
}

export interface ProgramBranchRecord {
  readonly branchId: string;
  readonly label: string;
  readonly branchActive: boolean;
  readonly associationActive: boolean;
  readonly version: number;
}

export interface ProgramMediaRecord {
  readonly id: string;
  readonly mediaRef: string;
  readonly sortHint: number;
  readonly altTextEn: string | null;
  readonly altTextAr: string | null;
  readonly active: boolean;
  readonly version: number;
}

export interface OfferRecord {
  readonly id: string;
  readonly kind: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly trialAmountFils: number | null;
  readonly effectiveStart: string | null;
  readonly effectiveEnd: string | null;
  readonly state: string;
  readonly version: number;
}

export interface OpenRevisionRecord {
  readonly id: string;
  readonly state: string;
  readonly createdAt: string;
  readonly version: number;
}

/** The real ProgramDetailViewSchema, field for field. Versions and
 *  `sensitiveFieldsVersion` are transported (they exist on the wire and
 *  W2-8 CAS needs them) but are never rendered (task §27). */
export interface ProgramDetailRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly activityType: {
    readonly id: string;
    readonly slug: string;
    readonly labelEn: string;
    readonly active: boolean;
    readonly categoryId: string;
  };
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly setting: string;
  readonly minAge: number | null;
  readonly maxAge: number | null;
  readonly allAges: boolean;
  readonly genderEligibility: string;
  readonly skillLevel: string | null;
  readonly eligibilityNotes: string | null;
  readonly listingState: string;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly sensitiveFieldsVersion: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly priceOptions: readonly PriceOptionRecord[];
  readonly branches: readonly ProgramBranchRecord[];
  readonly media: readonly ProgramMediaRecord[];
  readonly offers: readonly OfferRecord[];
  readonly openRevision: OpenRevisionRecord | null;
}

export type ListListingsOutcome =
  | { readonly kind: 'loaded'; readonly page: ProgramListPage }
  /** Membership lacks `catalogue.read` (403). */
  | { readonly kind: 'forbidden' }
  /** Unknown org OR no membership — canonically not-found-shaped. */
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type ListingDetailOutcome =
  | { readonly kind: 'loaded'; readonly program: ProgramDetailRecord }
  | { readonly kind: 'forbidden' }
  /** Unknown org/listing or a foreign organization's listing — one shape. */
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface ListingsReadPort {
  listListings(
    organizationId: string,
    params?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<ListListingsOutcome>;
  loadListing(organizationId: string, programId: string): Promise<ListingDetailOutcome>;
}
