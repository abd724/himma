/**
 * W3-7 taxonomy administration contract — the typed frontend mirror of the
 * CERTIFIED S4 admin taxonomy surface (`GET /admin/taxonomy` + the named
 * create/patch routes per entity). Nothing here invents taxonomy
 * semantics: four DISTINCT resource types (area, category, activity type,
 * collection — never a flattened universal record), slugs are immutable
 * stable identifiers (no update input can express one), retirement is the
 * `active` flag / collection `state` (no delete exists anywhere), ordering
 * is the certified `sortHint` data only (no arbitrary reorder operation),
 * activity types keep their parent category for life (re-parenting is not
 * an operation), and every mutation carries CAS `expectedVersion`.
 */

export interface AreaView {
  readonly id: string;
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly city: string | null;
  readonly sortHint: number;
  readonly active: boolean;
  readonly version: number;
}

export interface CategoryView {
  readonly id: string;
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly imageRef: string | null;
  readonly sortHint: number;
  readonly active: boolean;
  readonly version: number;
}

export interface ActivityTypeView {
  readonly id: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly synonymsEn: readonly string[];
  readonly synonymsAr: readonly string[];
  readonly active: boolean;
  readonly version: number;
}

export type CollectionState = 'draft' | 'published' | 'archived';

export interface CollectionView {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly subtitleEn: string | null;
  readonly subtitleAr: string | null;
  readonly imageRef: string | null;
  readonly presetLadiesOnly: boolean;
  readonly presetChildRelevant: boolean;
  readonly presetCamps: boolean;
  readonly presetOffers: boolean;
  readonly presetAvailableToday: boolean;
  readonly presetAfterSchool: boolean;
  readonly presetIndoor: boolean;
  readonly audience: string;
  readonly childFocused: boolean;
  readonly featured: boolean;
  readonly seasonalLabel: string | null;
  readonly state: string;
  readonly version: number;
}

/** The full administration view — inactive rows included; administration
 *  operates on the actual database truth, never a public projection. */
export interface TaxonomyAdminView {
  readonly areas: readonly AreaView[];
  readonly categories: readonly CategoryView[];
  readonly activityTypes: readonly ActivityTypeView[];
  readonly collections: readonly CollectionView[];
}

export type TaxonomyViewOutcome =
  | { readonly kind: 'loaded'; readonly view: TaxonomyAdminView }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

/** Typed mutation refusals — the certified backend conditions, distinct. */
export type TaxonomyActionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'stepUpRequired' }
  | { readonly kind: 'staleVersion' }
  /** The stable identifier is already taken by an existing row. */
  | { readonly kind: 'slugConflict' }
  /** The referenced parent category does not exist (two levels only). */
  | { readonly kind: 'invalidTaxonomy' }
  | { readonly kind: 'invalidInput' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/** Create inputs mirror the route bodies exactly — a slug is chosen ONCE
 *  at creation and never editable afterwards. */
export interface CreateAreaInput {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr?: string | null;
  readonly city?: string | null;
  readonly sortHint?: number;
}

export interface CreateCategoryInput {
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr?: string | null;
  readonly sortHint?: number;
}

export interface CreateActivityTypeInput {
  readonly slug: string;
  readonly categoryId: string;
  readonly labelEn: string;
  readonly labelAr?: string | null;
  readonly synonymsEn?: readonly string[];
}

export interface CreateCollectionInput {
  readonly titleEn: string;
  readonly subtitleEn?: string | null;
  readonly audience?: 'all' | 'adults' | 'children';
  readonly featured?: boolean;
  readonly seasonalLabel?: string | null;
  readonly state?: CollectionState;
}

/** Update patches carry ONLY the certified mutable fields — no slug, no
 *  categoryId (re-parenting is not an operation), no delete. */
export interface AreaPatch {
  readonly labelEn?: string;
  readonly labelAr?: string | null;
  readonly city?: string | null;
  readonly sortHint?: number;
  readonly active?: boolean;
}

export interface CategoryPatch {
  readonly labelEn?: string;
  readonly labelAr?: string | null;
  readonly sortHint?: number;
  readonly active?: boolean;
}

export interface ActivityTypePatch {
  readonly labelEn?: string;
  readonly labelAr?: string | null;
  readonly synonymsEn?: readonly string[];
  readonly active?: boolean;
}

export interface CollectionPatch {
  readonly titleEn?: string;
  readonly subtitleEn?: string | null;
  readonly audience?: 'all' | 'adults' | 'children';
  readonly featured?: boolean;
  readonly seasonalLabel?: string | null;
  readonly state?: CollectionState;
}

export interface AdminTaxonomyPort {
  getTaxonomy(): Promise<TaxonomyViewOutcome>;
  createArea(input: CreateAreaInput): Promise<TaxonomyActionOutcome>;
  updateArea(
    areaId: string,
    input: { expectedVersion: number; patch: AreaPatch },
  ): Promise<TaxonomyActionOutcome>;
  createCategory(input: CreateCategoryInput): Promise<TaxonomyActionOutcome>;
  updateCategory(
    categoryId: string,
    input: { expectedVersion: number; patch: CategoryPatch },
  ): Promise<TaxonomyActionOutcome>;
  createActivityType(input: CreateActivityTypeInput): Promise<TaxonomyActionOutcome>;
  updateActivityType(
    activityTypeId: string,
    input: { expectedVersion: number; patch: ActivityTypePatch },
  ): Promise<TaxonomyActionOutcome>;
  createCollection(input: CreateCollectionInput): Promise<TaxonomyActionOutcome>;
  updateCollection(
    collectionId: string,
    input: { expectedVersion: number; patch: CollectionPatch },
  ): Promise<TaxonomyActionOutcome>;
}
