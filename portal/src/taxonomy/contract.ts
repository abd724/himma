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

/**
 * Activity-type taxonomy read — mirrors the REAL public taxonomy read
 * `GET /catalogue/activity-types` field for field: ACTIVE admin-owned rows
 * in deterministic order, no synonyms, no admin/version metadata. W2-7 uses
 * it only to LABEL the `activityTypeId` carried by the provider listing
 * summary rows (the listing detail projection embeds its own activity-type
 * object and needs no lookup). An inactive activity type is simply absent
 * from this read — a listing referencing one renders without a label here
 * and carries the truthful `active: false` flag in its own detail.
 */
export interface ActivityTypeRecord {
  readonly id: string;
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly categoryId: string;
}

export type ActivityTypeListOutcome =
  | { readonly kind: 'loaded'; readonly activityTypes: readonly ActivityTypeRecord[] }
  | { readonly kind: 'unavailable' };

export interface ActivityTypeReadPort {
  listActivityTypes(): Promise<ActivityTypeListOutcome>;
}

/**
 * Category taxonomy read — mirrors the REAL public taxonomy read
 * `GET /catalogue/categories` field for field: ACTIVE admin-owned category
 * rows in deterministic order, no admin/version metadata. The portal reads
 * categories only to give activity types their catalogue context (e.g.
 * "Swimming — Aquatics" in the activity-type selector); providers never
 * create or edit categories.
 */
export interface CategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly imageRef: string | null;
}

export type CategoryListOutcome =
  | { readonly kind: 'loaded'; readonly categories: readonly CategoryRecord[] }
  | { readonly kind: 'unavailable' };

export interface CategoryReadPort {
  listCategories(): Promise<CategoryListOutcome>;
}

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
