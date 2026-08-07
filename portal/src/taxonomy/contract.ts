/**
 * Area taxonomy read seam — mirrors the REAL public taxonomy read
 * `GET /catalogue/areas` (backend/src/modules/catalogue/http/
 * public-catalogue-routes.ts) field for field: ACTIVE admin-owned area rows
 * in deterministic order, no admin/version metadata, no inactive rows.
 *
 * Areas are DB-managed reference data (docs/24 §12.1) created by Himma
 * administration — the portal only ever READS them. Inactive areas are
 * simply absent from this contract, which is why the branch editor cannot
 * offer them for new selection; a branch whose stored `areaLabel` no longer
 * matches an active area keeps its historical label untouched unless the
 * provider deliberately picks a new area (dirty-field PATCH semantics).
 */

export interface AreaRecord {
  readonly id: string;
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly city: string | null;
}

export type AreaListOutcome =
  | { readonly kind: 'loaded'; readonly areas: readonly AreaRecord[] }
  | { readonly kind: 'unavailable' };

export interface AreaReadPort {
  listAreas(): Promise<AreaListOutcome>;
}
