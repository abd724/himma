import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  ActivityTypeView,
  AdminTaxonomyPort,
  AreaView,
  CategoryView,
  CollectionView,
  TaxonomyActionOutcome,
  TaxonomyAdminView,
} from '../../taxonomy/contract';

/**
 * LIVE taxonomy administration port (W3-7) over the CERTIFIED S4 admin
 * taxonomy routes. GET/POST/PATCH pass-through with fail-closed validation
 * of exactly the fields the workspace consumes; every typed backend
 * refusal maps to its own outcome. No taxonomy semantics live here — the
 * backend services stay the single authority (slug immutability, CAS,
 * deactivate-only retirement, parent existence).
 */

function stringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function areaFrom(raw: unknown): AreaView | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.slug !== 'string' ||
    typeof row.labelEn !== 'string' ||
    !stringOrNull(row.labelAr) ||
    !stringOrNull(row.city) ||
    typeof row.sortHint !== 'number' ||
    typeof row.active !== 'boolean' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    city: row.city,
    sortHint: row.sortHint,
    active: row.active,
    version: row.version,
  };
}

function categoryFrom(raw: unknown): CategoryView | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.slug !== 'string' ||
    typeof row.labelEn !== 'string' ||
    !stringOrNull(row.labelAr) ||
    !stringOrNull(row.imageRef) ||
    typeof row.sortHint !== 'number' ||
    typeof row.active !== 'boolean' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    imageRef: row.imageRef,
    sortHint: row.sortHint,
    active: row.active,
    version: row.version,
  };
}

function activityTypeFrom(raw: unknown): ActivityTypeView | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.slug !== 'string' ||
    typeof row.categoryId !== 'string' ||
    typeof row.labelEn !== 'string' ||
    !stringOrNull(row.labelAr) ||
    !stringArray(row.synonymsEn) ||
    !stringArray(row.synonymsAr) ||
    typeof row.active !== 'boolean' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    categoryId: row.categoryId,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    synonymsEn: row.synonymsEn,
    synonymsAr: row.synonymsAr,
    active: row.active,
    version: row.version,
  };
}

function collectionFrom(raw: unknown): CollectionView | null {
  const row = raw as Record<string, unknown>;
  if (
    typeof row?.id !== 'string' ||
    typeof row.titleEn !== 'string' ||
    !stringOrNull(row.titleAr) ||
    !stringOrNull(row.subtitleEn) ||
    !stringOrNull(row.subtitleAr) ||
    !stringOrNull(row.imageRef) ||
    typeof row.presetLadiesOnly !== 'boolean' ||
    typeof row.presetChildRelevant !== 'boolean' ||
    typeof row.presetCamps !== 'boolean' ||
    typeof row.presetOffers !== 'boolean' ||
    typeof row.presetAvailableToday !== 'boolean' ||
    typeof row.presetAfterSchool !== 'boolean' ||
    typeof row.presetIndoor !== 'boolean' ||
    typeof row.audience !== 'string' ||
    typeof row.childFocused !== 'boolean' ||
    typeof row.featured !== 'boolean' ||
    !stringOrNull(row.seasonalLabel) ||
    typeof row.state !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    subtitleEn: row.subtitleEn,
    subtitleAr: row.subtitleAr,
    imageRef: row.imageRef,
    presetLadiesOnly: row.presetLadiesOnly,
    presetChildRelevant: row.presetChildRelevant,
    presetCamps: row.presetCamps,
    presetOffers: row.presetOffers,
    presetAvailableToday: row.presetAvailableToday,
    presetAfterSchool: row.presetAfterSchool,
    presetIndoor: row.presetIndoor,
    audience: row.audience,
    childFocused: row.childFocused,
    featured: row.featured,
    seasonalLabel: row.seasonalLabel,
    state: row.state,
    version: row.version,
  };
}

function viewFrom(body: unknown): TaxonomyAdminView | null {
  const raw = body as Record<string, unknown>;
  if (
    !Array.isArray(raw?.areas) ||
    !Array.isArray(raw.categories) ||
    !Array.isArray(raw.activityTypes) ||
    !Array.isArray(raw.collections)
  ) {
    return null;
  }
  const areas: AreaView[] = [];
  for (const entry of raw.areas) {
    const area = areaFrom(entry);
    if (area === null) return null;
    areas.push(area);
  }
  const categories: CategoryView[] = [];
  for (const entry of raw.categories) {
    const category = categoryFrom(entry);
    if (category === null) return null;
    categories.push(category);
  }
  const activityTypes: ActivityTypeView[] = [];
  for (const entry of raw.activityTypes) {
    const activityType = activityTypeFrom(entry);
    if (activityType === null) return null;
    activityTypes.push(activityType);
  }
  const collections: CollectionView[] = [];
  for (const entry of raw.collections) {
    const collection = collectionFrom(entry);
    if (collection === null) return null;
    collections.push(collection);
  }
  return { areas, categories, activityTypes, collections };
}

function actionOutcomeFrom(response: {
  status: number;
  code: string | null;
}): TaxonomyActionOutcome {
  if (response.status === 200) return { kind: 'completed' };
  switch (response.code) {
    case 'stepUpRequired':
      return { kind: 'stepUpRequired' };
    case 'staleVersion':
      return { kind: 'staleVersion' };
    case 'slugConflict':
      return { kind: 'slugConflict' };
    case 'invalidTaxonomy':
      return { kind: 'invalidTaxonomy' };
    case 'forbidden':
      return { kind: 'forbidden' };
    case 'notFound':
      return { kind: 'notFound' };
    default:
      // Schema-refused input (400/422 without a mapped code) is a distinct
      // reviewer-visible condition, never disguised as an outage.
      return response.status === 400 || response.status === 422
        ? { kind: 'invalidInput' }
        : { kind: 'unavailable' };
  }
}

/** Drops undefined optionals so the wire body carries only declared fields
 *  (the backend strips undeclared fields; we never send `undefined`). */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

export function createLiveTaxonomyPort(transport: LiveTransport): AdminTaxonomyPort {
  const act = async (
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
  ): Promise<TaxonomyActionOutcome> => {
    const response = await transport.authorizedRequest(path, { method, body: compact(body) });
    if (response === null || response.networkFailure) return { kind: 'unavailable' };
    return actionOutcomeFrom(response);
  };

  return {
    async getTaxonomy() {
      const response = await transport.authorizedRequest('/admin/taxonomy');
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const view = viewFrom(response.body);
        return view === null ? { kind: 'unavailable' } : { kind: 'loaded', view };
      }
      return response.code === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
    },

    createArea(input) {
      return act('POST', '/admin/taxonomy/areas', { ...input });
    },

    updateArea(areaId, input) {
      return act('PATCH', `/admin/taxonomy/areas/${encodeURIComponent(areaId)}`, {
        expectedVersion: input.expectedVersion,
        ...input.patch,
      });
    },

    createCategory(input) {
      return act('POST', '/admin/taxonomy/categories', { ...input });
    },

    updateCategory(categoryId, input) {
      return act('PATCH', `/admin/taxonomy/categories/${encodeURIComponent(categoryId)}`, {
        expectedVersion: input.expectedVersion,
        ...input.patch,
      });
    },

    createActivityType(input) {
      return act('POST', '/admin/taxonomy/activity-types', {
        ...input,
        ...(input.synonymsEn !== undefined ? { synonymsEn: [...input.synonymsEn] } : {}),
      });
    },

    updateActivityType(activityTypeId, input) {
      return act(
        'PATCH',
        `/admin/taxonomy/activity-types/${encodeURIComponent(activityTypeId)}`,
        {
          expectedVersion: input.expectedVersion,
          ...input.patch,
          ...(input.patch.synonymsEn !== undefined
            ? { synonymsEn: [...input.patch.synonymsEn] }
            : {}),
        },
      );
    },

    createCollection(input) {
      return act('POST', '/admin/taxonomy/collections', { ...input });
    },

    updateCollection(collectionId, input) {
      return act('PATCH', `/admin/taxonomy/collections/${encodeURIComponent(collectionId)}`, {
        expectedVersion: input.expectedVersion,
        ...input.patch,
      });
    },
  };
}
