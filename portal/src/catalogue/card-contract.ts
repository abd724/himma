/**
 * Listing-card PRESENTATION projection (W2-11 owner visual correction).
 *
 * The REAL provider list read (`GET /provider/organizations/:orgId/listings`)
 * returns EXACTLY seven summary fields per row — no media, no price options,
 * no branch information. The owner-approved Listings index needs a richer
 * management row (thumbnail · price summary · branch summary), so this seam
 * composes those extras from the SHARED frontend fixture catalogue truth for
 * the frontend-first portal.
 *
 * ⚠ RECORDED W2-12 LIVE-INTEGRATION CONTRACT REQUIREMENT (Class B): no
 * backend contract can serve this projection today, and W2-12 must NOT
 * emulate it with an N+1 detail request per row. The production provider
 * listing-index contract needs an appropriate LIST-CARD projection
 * (thumbnail reference/URL · derived price summary under D-S4-1 semantics ·
 * branch summary) — an owner/backend decision at integration planning. No
 * fake endpoint is invented here; the fixture composes what the future
 * projection would serve. Thumbnail BINARIES remain the carried Class-C
 * media gap: fixture previews resolve to checked-in demo assets only, and
 * the unconfigured production port resolves nothing (placeholders, fail
 * closed).
 *
 * Price semantics (binding, D-S4-1 preserved): a listing's row price is a
 * DERIVED display over its ACTIVE ProgramPriceOptions — `free` when an
 * active free option exists, otherwise `from` the LOWEST active option
 * amount, otherwise `none` (the honest no-active-option readiness state).
 * Never an authoritative Program.price, never a range, never an average;
 * several options remain ONE listing.
 */

export type ListingPriceSummary =
  | { readonly kind: 'free' }
  | { readonly kind: 'from'; readonly amountFils: number }
  | { readonly kind: 'none' };

export interface ListingCardExtras {
  /** Displayable preview URL for the listing's first active media, or null
   *  (placeholder). Binaries/CDN remain the carried Class-C gap. */
  readonly thumbnailUrl: string | null;
  readonly priceSummary: ListingPriceSummary;
  /** Concise branch truth: the first ACTIVE association's branch label (in
   *  the same deterministic order the detail lists) plus how many active
   *  associations exist in total. Zero = not placed anywhere yet. */
  readonly branchSummary: {
    readonly firstLabel: string | null;
    readonly activeCount: number;
  };
}

export type ListingCardExtrasOutcome =
  /** Extras keyed by listing id; ids the caller cannot read are absent. */
  | { readonly kind: 'loaded'; readonly extras: Readonly<Record<string, ListingCardExtras>> }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface ListingCardPort {
  loadCardExtras(
    organizationId: string,
    programIds: readonly string[],
  ): Promise<ListingCardExtrasOutcome>;
}
