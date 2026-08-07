/**
 * Internal taxonomy administration services (docs/28 §9 "0007.5", §15,
 * §16.3; docs/24 §2.1/§10.2; D-S4-3).
 *
 * Admin-owned DATA management for the four S4-1 taxonomy entities — the
 * database stays authoritative (never frontend constants), slugs are
 * immutable stable identifiers (no patch can express them; the 0007
 * trigger is the final authority), and retirement is deactivation, never
 * deletion: stable ids and every existing reference (program.
 * activity_type_id, branch.area_id) survive untouched — active-taxonomy
 * enforcement stays where canon put it, at provider create/edit and
 * submission/publication completeness. Authority is the existing admin
 * policy with the `operations` role re-checked fresh per transaction; no
 * second authorization mechanism exists. Mutations write the docs/28 §15
 * `taxonomy.*_changed` audit/outbox vocabulary in the same transaction
 * (aggregate `taxonomy`; ids + a bounded change slug only).
 *
 * English-only launch: label_en/title_en are required; every `_ar` column
 * stays optional and never blocks administration (D-S4-3).
 */
import { appendAuditEvent } from '../../../db/audit';
import { isDbError } from '../../../db/errors';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { hasOperationsRole } from './moderation';

export interface TaxonomyAdminDeps {
  db: Db;
}

export interface TaxonomyAdminActor {
  userId: string;
}

type TaxonomyEntity = 'area' | 'category' | 'activity_type' | 'collection';

const EVENT_ID_KEY: Record<TaxonomyEntity, string> = {
  area: 'areaId',
  category: 'categoryId',
  activity_type: 'activityTypeId',
  collection: 'collectionId',
};

async function emitTaxonomyEvent(
  trx: Trx,
  actor: TaxonomyAdminActor,
  entity: TaxonomyEntity,
  entityId: string,
  change: 'created' | 'updated',
): Promise<void> {
  const eventType = `taxonomy.${entity}_changed`;
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: actor.userId,
    action: eventType,
    entityType: entity,
    entityId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'taxonomy',
    aggregateId: entityId,
    eventType,
    payload: { [EVENT_ID_KEY[entity]]: entityId, change },
  });
}

function isSlugConflict(error: unknown): boolean {
  return isDbError(error, 'uniqueViolation') || (error as { code?: string }).code === '23505';
}

// -- views (explicit camelCase projections) -----------------------------------

export interface AreaView {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  city: string | null;
  sortHint: number;
  active: boolean;
  version: number;
}

export interface CategoryView {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  imageRef: string | null;
  sortHint: number;
  active: boolean;
  version: number;
}

export interface ActivityTypeView {
  id: string;
  slug: string;
  categoryId: string;
  labelEn: string;
  labelAr: string | null;
  synonymsEn: string[];
  synonymsAr: string[];
  active: boolean;
  version: number;
}

export interface CollectionView {
  id: string;
  titleEn: string;
  titleAr: string | null;
  subtitleEn: string | null;
  subtitleAr: string | null;
  imageRef: string | null;
  presetLadiesOnly: boolean;
  presetChildRelevant: boolean;
  presetCamps: boolean;
  presetOffers: boolean;
  presetAvailableToday: boolean;
  presetAfterSchool: boolean;
  presetIndoor: boolean;
  audience: string;
  childFocused: boolean;
  featured: boolean;
  seasonalLabel: string | null;
  state: string;
  version: number;
}

const AREA_COLUMNS = ['id', 'slug', 'label_en', 'label_ar', 'city', 'sort_hint', 'active', 'version'] as const;
const CATEGORY_COLUMNS = ['id', 'slug', 'label_en', 'label_ar', 'image_ref', 'sort_hint', 'active', 'version'] as const;
const TYPE_COLUMNS = ['id', 'slug', 'category_id', 'label_en', 'label_ar', 'synonyms_en', 'synonyms_ar', 'active', 'version'] as const;
const COLLECTION_COLUMNS = [
  'id',
  'title_en',
  'title_ar',
  'subtitle_en',
  'subtitle_ar',
  'image_ref',
  'preset_ladies_only',
  'preset_child_relevant',
  'preset_camps',
  'preset_offers',
  'preset_available_today',
  'preset_after_school',
  'preset_indoor',
  'audience',
  'child_focused',
  'featured',
  'seasonal_label',
  'state',
  'version',
] as const;

function toAreaView(row: Record<string, unknown>): AreaView {
  return {
    id: row.id as string,
    slug: row.slug as string,
    labelEn: row.label_en as string,
    labelAr: row.label_ar as string | null,
    city: row.city as string | null,
    sortHint: row.sort_hint as number,
    active: row.active as boolean,
    version: row.version as number,
  };
}

function toCategoryView(row: Record<string, unknown>): CategoryView {
  return {
    id: row.id as string,
    slug: row.slug as string,
    labelEn: row.label_en as string,
    labelAr: row.label_ar as string | null,
    imageRef: row.image_ref as string | null,
    sortHint: row.sort_hint as number,
    active: row.active as boolean,
    version: row.version as number,
  };
}

function toTypeView(row: Record<string, unknown>): ActivityTypeView {
  return {
    id: row.id as string,
    slug: row.slug as string,
    categoryId: row.category_id as string,
    labelEn: row.label_en as string,
    labelAr: row.label_ar as string | null,
    synonymsEn: row.synonyms_en as string[],
    synonymsAr: row.synonyms_ar as string[],
    active: row.active as boolean,
    version: row.version as number,
  };
}

function toCollectionView(row: Record<string, unknown>): CollectionView {
  return {
    id: row.id as string,
    titleEn: row.title_en as string,
    titleAr: row.title_ar as string | null,
    subtitleEn: row.subtitle_en as string | null,
    subtitleAr: row.subtitle_ar as string | null,
    imageRef: row.image_ref as string | null,
    presetLadiesOnly: row.preset_ladies_only as boolean,
    presetChildRelevant: row.preset_child_relevant as boolean,
    presetCamps: row.preset_camps as boolean,
    presetOffers: row.preset_offers as boolean,
    presetAvailableToday: row.preset_available_today as boolean,
    presetAfterSchool: row.preset_after_school as boolean,
    presetIndoor: row.preset_indoor as boolean,
    audience: row.audience as string,
    childFocused: row.child_focused as boolean,
    featured: row.featured as boolean,
    seasonalLabel: row.seasonal_label as string | null,
    state: row.state as string,
    version: row.version as number,
  };
}

// -- admin read (all rows, inactive included — administration needs history) --

export interface TaxonomyAdminView {
  areas: AreaView[];
  categories: CategoryView[];
  activityTypes: ActivityTypeView[];
  collections: CollectionView[];
}

export type GetTaxonomyViewResult =
  | { kind: 'view'; view: TaxonomyAdminView }
  | { kind: 'forbidden' };

export async function getTaxonomyAdminView(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
): Promise<GetTaxonomyViewResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const areas = await trx
      .selectFrom('area')
      .select(AREA_COLUMNS)
      .orderBy('sort_hint')
      .orderBy('slug')
      .execute();
    const categories = await trx
      .selectFrom('category')
      .select(CATEGORY_COLUMNS)
      .orderBy('sort_hint')
      .orderBy('slug')
      .execute();
    const activityTypes = await trx
      .selectFrom('activity_type')
      .select(TYPE_COLUMNS)
      .orderBy('category_id')
      .orderBy('slug')
      .execute();
    const collections = await trx
      .selectFrom('collection')
      .select(COLLECTION_COLUMNS)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return {
      kind: 'view' as const,
      view: {
        areas: areas.map((row) => toAreaView(row)),
        categories: categories.map((row) => toCategoryView(row)),
        activityTypes: activityTypes.map((row) => toTypeView(row)),
        collections: collections.map((row) => toCollectionView(row)),
      },
    };
  });
}

// -- area ---------------------------------------------------------------------

export type CreateAreaResult =
  | { kind: 'areaCreated'; area: AreaView }
  | { kind: 'forbidden' }
  | { kind: 'slugConflict' };

export async function createArea(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: { slug: string; labelEn: string; labelAr?: string | null; city?: string | null; sortHint?: number },
): Promise<CreateAreaResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const id = newId();
    try {
      await trx
        .insertInto('area')
        .values({
          id,
          slug: input.slug,
          label_en: input.labelEn,
          label_ar: input.labelAr ?? null,
          city: input.city ?? null,
          sort_hint: input.sortHint ?? 0,
        })
        .execute();
    } catch (error) {
      if (isSlugConflict(error)) return { kind: 'slugConflict' as const };
      throw error;
    }
    await emitTaxonomyEvent(trx, actor, 'area', id, 'created');
    const row = await trx
      .selectFrom('area')
      .select(AREA_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'areaCreated' as const, area: toAreaView(row) };
  });
}

export interface AreaPatch {
  labelEn?: string;
  labelAr?: string | null;
  city?: string | null;
  sortHint?: number;
  active?: boolean;
}

export type UpdateAreaResult =
  | { kind: 'areaUpdated'; area: AreaView }
  | { kind: 'areaNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'staleVersion' };

export async function updateArea(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: { areaId: string; expectedVersion: number; patch: AreaPatch },
): Promise<UpdateAreaResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const current = await trx
      .selectFrom('area')
      .select(['id', 'version'])
      .where('id', '=', input.areaId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) return { kind: 'areaNotFound' as const };
    if (current.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('area')
      .set({
        ...(input.patch.labelEn !== undefined ? { label_en: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { label_ar: input.patch.labelAr } : {}),
        ...(input.patch.city !== undefined ? { city: input.patch.city } : {}),
        ...(input.patch.sortHint !== undefined ? { sort_hint: input.patch.sortHint } : {}),
        ...(input.patch.active !== undefined ? { active: input.patch.active } : {}),
      })
      .where('id', '=', input.areaId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitTaxonomyEvent(trx, actor, 'area', input.areaId, 'updated');
    const row = await trx
      .selectFrom('area')
      .select(AREA_COLUMNS)
      .where('id', '=', input.areaId)
      .executeTakeFirstOrThrow();
    return { kind: 'areaUpdated' as const, area: toAreaView(row) };
  });
}

// -- category -----------------------------------------------------------------

export type CreateCategoryResult =
  | { kind: 'categoryCreated'; category: CategoryView }
  | { kind: 'forbidden' }
  | { kind: 'slugConflict' };

export async function createCategory(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: {
    slug: string;
    labelEn: string;
    labelAr?: string | null;
    imageRef?: string | null;
    sortHint?: number;
  },
): Promise<CreateCategoryResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const id = newId();
    try {
      await trx
        .insertInto('category')
        .values({
          id,
          slug: input.slug,
          label_en: input.labelEn,
          label_ar: input.labelAr ?? null,
          image_ref: input.imageRef ?? null,
          sort_hint: input.sortHint ?? 0,
        })
        .execute();
    } catch (error) {
      if (isSlugConflict(error)) return { kind: 'slugConflict' as const };
      throw error;
    }
    await emitTaxonomyEvent(trx, actor, 'category', id, 'created');
    const row = await trx
      .selectFrom('category')
      .select(CATEGORY_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'categoryCreated' as const, category: toCategoryView(row) };
  });
}

export interface CategoryPatch {
  labelEn?: string;
  labelAr?: string | null;
  imageRef?: string | null;
  sortHint?: number;
  active?: boolean;
}

export type UpdateCategoryResult =
  | { kind: 'categoryUpdated'; category: CategoryView }
  | { kind: 'categoryNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'staleVersion' };

export async function updateCategory(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: { categoryId: string; expectedVersion: number; patch: CategoryPatch },
): Promise<UpdateCategoryResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const current = await trx
      .selectFrom('category')
      .select(['id', 'version'])
      .where('id', '=', input.categoryId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) return { kind: 'categoryNotFound' as const };
    if (current.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('category')
      .set({
        ...(input.patch.labelEn !== undefined ? { label_en: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { label_ar: input.patch.labelAr } : {}),
        ...(input.patch.imageRef !== undefined ? { image_ref: input.patch.imageRef } : {}),
        ...(input.patch.sortHint !== undefined ? { sort_hint: input.patch.sortHint } : {}),
        ...(input.patch.active !== undefined ? { active: input.patch.active } : {}),
      })
      .where('id', '=', input.categoryId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitTaxonomyEvent(trx, actor, 'category', input.categoryId, 'updated');
    const row = await trx
      .selectFrom('category')
      .select(CATEGORY_COLUMNS)
      .where('id', '=', input.categoryId)
      .executeTakeFirstOrThrow();
    return { kind: 'categoryUpdated' as const, category: toCategoryView(row) };
  });
}

// -- activity type ------------------------------------------------------------

export type CreateActivityTypeResult =
  | { kind: 'activityTypeCreated'; activityType: ActivityTypeView }
  | { kind: 'forbidden' }
  | { kind: 'invalidTaxonomy' }
  | { kind: 'slugConflict' };

export async function createActivityType(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: {
    slug: string;
    categoryId: string;
    labelEn: string;
    labelAr?: string | null;
    synonymsEn?: string[];
    synonymsAr?: string[];
  },
): Promise<CreateActivityTypeResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    // Two levels only (docs/28 §9 "0007.5"): the parent must be a real
    // category; a ghost parent is a typed refusal, never a raw FK error.
    const parent = await trx
      .selectFrom('category')
      .select('id')
      .where('id', '=', input.categoryId)
      .executeTakeFirst();
    if (parent === undefined) return { kind: 'invalidTaxonomy' as const };
    const id = newId();
    try {
      await trx
        .insertInto('activity_type')
        .values({
          id,
          slug: input.slug,
          category_id: input.categoryId,
          label_en: input.labelEn,
          label_ar: input.labelAr ?? null,
          synonyms_en: input.synonymsEn ?? [],
          synonyms_ar: input.synonymsAr ?? [],
        })
        .execute();
    } catch (error) {
      if (isSlugConflict(error)) return { kind: 'slugConflict' as const };
      throw error;
    }
    await emitTaxonomyEvent(trx, actor, 'activity_type', id, 'created');
    const row = await trx
      .selectFrom('activity_type')
      .select(TYPE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'activityTypeCreated' as const, activityType: toTypeView(row) };
  });
}

export interface ActivityTypePatch {
  labelEn?: string;
  labelAr?: string | null;
  synonymsEn?: string[];
  synonymsAr?: string[];
  active?: boolean;
}

export type UpdateActivityTypeResult =
  | { kind: 'activityTypeUpdated'; activityType: ActivityTypeView }
  | { kind: 'activityTypeNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'staleVersion' };

/** Re-parenting (category_id) is deliberately NOT an operation: canon
 *  defines no taxonomy re-parent action, so none exists here. */
export async function updateActivityType(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: { activityTypeId: string; expectedVersion: number; patch: ActivityTypePatch },
): Promise<UpdateActivityTypeResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const current = await trx
      .selectFrom('activity_type')
      .select(['id', 'version'])
      .where('id', '=', input.activityTypeId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) return { kind: 'activityTypeNotFound' as const };
    if (current.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const updated = await trx
      .updateTable('activity_type')
      .set({
        ...(input.patch.labelEn !== undefined ? { label_en: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { label_ar: input.patch.labelAr } : {}),
        ...(input.patch.synonymsEn !== undefined ? { synonyms_en: input.patch.synonymsEn } : {}),
        ...(input.patch.synonymsAr !== undefined ? { synonyms_ar: input.patch.synonymsAr } : {}),
        ...(input.patch.active !== undefined ? { active: input.patch.active } : {}),
      })
      .where('id', '=', input.activityTypeId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitTaxonomyEvent(trx, actor, 'activity_type', input.activityTypeId, 'updated');
    const row = await trx
      .selectFrom('activity_type')
      .select(TYPE_COLUMNS)
      .where('id', '=', input.activityTypeId)
      .executeTakeFirstOrThrow();
    return { kind: 'activityTypeUpdated' as const, activityType: toTypeView(row) };
  });
}

// -- collection ---------------------------------------------------------------

export interface CollectionInput {
  titleEn: string;
  titleAr?: string | null;
  subtitleEn?: string | null;
  subtitleAr?: string | null;
  imageRef?: string | null;
  presetLadiesOnly?: boolean;
  presetChildRelevant?: boolean;
  presetCamps?: boolean;
  presetOffers?: boolean;
  presetAvailableToday?: boolean;
  presetAfterSchool?: boolean;
  presetIndoor?: boolean;
  audience?: 'all' | 'adults' | 'children';
  childFocused?: boolean;
  featured?: boolean;
  seasonalLabel?: string | null;
  state?: 'draft' | 'published' | 'archived';
}

export type CreateCollectionResult =
  | { kind: 'collectionCreated'; collection: CollectionView }
  | { kind: 'forbidden' };

export async function createCollection(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: CollectionInput,
): Promise<CreateCollectionResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const id = newId();
    await trx
      .insertInto('collection')
      .values({
        id,
        title_en: input.titleEn,
        title_ar: input.titleAr ?? null,
        subtitle_en: input.subtitleEn ?? null,
        subtitle_ar: input.subtitleAr ?? null,
        image_ref: input.imageRef ?? null,
        preset_ladies_only: input.presetLadiesOnly ?? false,
        preset_child_relevant: input.presetChildRelevant ?? false,
        preset_camps: input.presetCamps ?? false,
        preset_offers: input.presetOffers ?? false,
        preset_available_today: input.presetAvailableToday ?? false,
        preset_after_school: input.presetAfterSchool ?? false,
        preset_indoor: input.presetIndoor ?? false,
        audience: input.audience ?? 'all',
        child_focused: input.childFocused ?? false,
        featured: input.featured ?? false,
        seasonal_label: input.seasonalLabel ?? null,
        state: input.state ?? 'draft',
      })
      .execute();
    await emitTaxonomyEvent(trx, actor, 'collection', id, 'created');
    const row = await trx
      .selectFrom('collection')
      .select(COLLECTION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { kind: 'collectionCreated' as const, collection: toCollectionView(row) };
  });
}

export type CollectionPatch = Partial<CollectionInput>;

export type UpdateCollectionResult =
  | { kind: 'collectionUpdated'; collection: CollectionView }
  | { kind: 'collectionNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'staleVersion' };

export async function updateCollection(
  deps: TaxonomyAdminDeps,
  actor: TaxonomyAdminActor,
  input: { collectionId: string; expectedVersion: number; patch: CollectionPatch },
): Promise<UpdateCollectionResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const current = await trx
      .selectFrom('collection')
      .select(['id', 'version'])
      .where('id', '=', input.collectionId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) return { kind: 'collectionNotFound' as const };
    if (current.version !== input.expectedVersion) return { kind: 'staleVersion' as const };
    const patch = input.patch;
    const updated = await trx
      .updateTable('collection')
      .set({
        ...(patch.titleEn !== undefined ? { title_en: patch.titleEn } : {}),
        ...(patch.titleAr !== undefined ? { title_ar: patch.titleAr } : {}),
        ...(patch.subtitleEn !== undefined ? { subtitle_en: patch.subtitleEn } : {}),
        ...(patch.subtitleAr !== undefined ? { subtitle_ar: patch.subtitleAr } : {}),
        ...(patch.imageRef !== undefined ? { image_ref: patch.imageRef } : {}),
        ...(patch.presetLadiesOnly !== undefined
          ? { preset_ladies_only: patch.presetLadiesOnly }
          : {}),
        ...(patch.presetChildRelevant !== undefined
          ? { preset_child_relevant: patch.presetChildRelevant }
          : {}),
        ...(patch.presetCamps !== undefined ? { preset_camps: patch.presetCamps } : {}),
        ...(patch.presetOffers !== undefined ? { preset_offers: patch.presetOffers } : {}),
        ...(patch.presetAvailableToday !== undefined
          ? { preset_available_today: patch.presetAvailableToday }
          : {}),
        ...(patch.presetAfterSchool !== undefined
          ? { preset_after_school: patch.presetAfterSchool }
          : {}),
        ...(patch.presetIndoor !== undefined ? { preset_indoor: patch.presetIndoor } : {}),
        ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
        ...(patch.childFocused !== undefined ? { child_focused: patch.childFocused } : {}),
        ...(patch.featured !== undefined ? { featured: patch.featured } : {}),
        ...(patch.seasonalLabel !== undefined ? { seasonal_label: patch.seasonalLabel } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
      })
      .where('id', '=', input.collectionId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'staleVersion' as const };
    await emitTaxonomyEvent(trx, actor, 'collection', input.collectionId, 'updated');
    const row = await trx
      .selectFrom('collection')
      .select(COLLECTION_COLUMNS)
      .where('id', '=', input.collectionId)
      .executeTakeFirstOrThrow();
    return { kind: 'collectionUpdated' as const, collection: toCollectionView(row) };
  });
}
