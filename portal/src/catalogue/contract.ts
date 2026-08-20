/**
 * Provider catalogue READ seam — mirrors the two REAL provider-private
 * catalogue read routes (backend/src/modules/catalogue/http/
 * catalogue-routes.ts) field for field. W2-12C1 implements this port over
 * the live API; the semantic fixture stands behind the same contract for
 * fixture mode.
 *
 * - `listListings` ⇄ `GET /provider/organizations/:orgId/listings`
 *   (capability `catalogue.read` — owner, org_manager, branch_manager,
 *   listings_editor in the shipped registry). Keyset pagination in
 *   `(createdAt, id)` order: `limit` 1–100 (server default 50), `cursor` is
 *   an OPAQUE listing id returned as `nextCursor` — never a page number.
 *   The real service ignores an unknown/foreign cursor (lists from the
 *   start) and, for branch-scoped staff, applies the canonical
 *   reachability rule INSIDE the authoritative query before ordering and
 *   the pagination window: reachable = no active branch association
 *   (drafts not yet placed anywhere) or at least one active association to
 *   one of the caller's assigned ACTIVE branches. Inaccessible listings
 *   never consume page slots; the cursor walks the reachable ordered set.
 *   Since W2-12C1 the summary row IS the list-card projection: identity/
 *   lifecycle plus activity display info, the derived D-S4-1 price
 *   summary, the branch summary, and thumbnail metadata ride the ONE
 *   authoritative page query — no offer or revision data exists on the
 *   list contract, and the index never issues per-row detail reads.
 * - `loadListing` ⇄ `GET .../listings/:programId` (same capability). The
 *   detail read shares the SAME branch-scope reachability rule as the
 *   list (one canonical predicate in the backend): an in-organization but
 *   out-of-scope listing, an unknown id, and another organization's id all
 *   collapse into one not-found shape.
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

/**
 * Derived row price display under the binding D-S4-1 semantics: an active
 * free option wins, otherwise `from` the LOWEST active option amount,
 * otherwise the honest `none` readiness state. Never a stored
 * Program.price, never a range, never an average; several options remain
 * ONE listing. (Integer fils; AED formatting stays presentation-side.)
 */
export type ListingPriceSummary =
  | { readonly kind: 'free' }
  | { readonly kind: 'from'; readonly amountFils: number }
  | { readonly kind: 'none' };

/** Concise branch truth: the earliest ACTIVE association's branch label
 *  (the same association order the detail lists) plus how many active
 *  associations exist. Zero = not placed anywhere yet. */
export interface ListingBranchSummary {
  readonly firstLabel: string | null;
  readonly activeCount: number;
}

/**
 * The real list-row LIST-CARD projection (W2-12C1) — the provider list
 * read serves one bounded management row per Program: identity/lifecycle
 * plus activity display info, the derived price summary, the branch
 * summary, and thumbnail presentation. The wire carries thumbnail
 * METADATA only (`mediaRef` + alt text — media binaries/storage remain
 * the carried gap, so no real resolvable URL exists); `thumbnailUrl` is
 * the port-resolved presentation value — fixture mode resolves checked-in
 * demo assets, live mode truthfully resolves null (placeholder) until a
 * media URL source exists.
 */
export interface ProgramSummaryRecord {
  readonly id: string;
  readonly titleEn: string;
  readonly listingState: string;
  /** Canonical activity relationship — provider-friendly label plus the
   *  truthful active flag (a historical inactive type stays representable). */
  readonly activityType: {
    readonly id: string;
    readonly labelEn: string;
    readonly active: boolean;
  };
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly priceSummary: ListingPriceSummary;
  readonly branchSummary: ListingBranchSummary;
  readonly thumbnailUrl: string | null;
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
  /** W3-8 (docs/31 §5): the latest request-changes correction feedback the
   *  real backend stores provider-safely (machine reasonCode + the
   *  reviewer-authored provider message — no internal layer exists in this
   *  domain). Null until a request-changes decision has been recorded. */
  readonly latestDecision: {
    readonly reasonCode: string | null;
    readonly providerMessage: string | null;
    readonly decidedAt: string;
  } | null;
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
  /**
   * `q`/`status` (W2-12C1 final correction) are AUTHORITATIVE server-side
   * predicates applied to the complete authorized set BEFORE pagination —
   * `q` is a bounded case-insensitive title-substring search (blank = no
   * predicate; wildcards are literal text), `status` is one canonical
   * docs/24 §5.3 lifecycle value. The cursor is a pure (createdAt, id)
   * position: a pagination walk MUST hold its filters constant (changing
   * either filter starts a fresh walk from the first page).
   */
  listListings(
    organizationId: string,
    params?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly q?: string;
      readonly status?: ListingState;
    },
  ): Promise<ListListingsOutcome>;
  loadListing(organizationId: string, programId: string): Promise<ListingDetailOutcome>;
}
