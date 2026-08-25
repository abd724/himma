/**
 * RI-2 — cached public taxonomy (categories, activity types, areas,
 * collections).
 *
 * Catalogue METADATA is the one discovery family safe to cache (owner
 * §19): it changes rarely and never carries availability. One in-flight
 * fetch is shared; entries revalidate after a short TTL; a failed load is
 * never cached. Availability/search results are NOT cached here — they
 * stay request-fresh so stale inventory is never presented.
 */
import type { DiscoveryApi } from '@/services/api/discovery-api';
import {
  toActivityType,
  toArea,
  toCategory,
  toCollection,
} from '@/services/api/discovery-mapping';
import type { ActivityType, Area, Category, Collection } from '@/types/domain';

const TTL_MS = 5 * 60 * 1000;

export interface Taxonomy {
  categories: Category[];
  activityTypes: ActivityType[];
  areas: Area[];
  collections: Collection[];
  categoryById: Map<string, Category>;
  activityTypeById: Map<string, ActivityType>;
  areaById: Map<string, Area>;
}

export interface TaxonomyCache {
  get(): Promise<Taxonomy>;
  /** Drops the cached value (tests / pull-to-refresh). */
  invalidate(): void;
}

export function createTaxonomyCache(
  api: DiscoveryApi,
  now: () => number = Date.now,
): TaxonomyCache {
  let cached: { value: Taxonomy; at: number } | undefined;
  let inFlight: Promise<Taxonomy> | undefined;

  async function load(): Promise<Taxonomy> {
    const [categories, activityTypes, areas, collections] = await Promise.all([
      api.getCategories(),
      api.getActivityTypes(),
      api.getAreas(),
      api.getCollections(),
    ]);
    const mapped: Taxonomy = {
      categories: categories.map(toCategory),
      activityTypes: activityTypes.map(toActivityType),
      areas: areas.map(toArea),
      collections: collections.map(toCollection),
      categoryById: new Map(),
      activityTypeById: new Map(),
      areaById: new Map(),
    };
    for (const category of mapped.categories) mapped.categoryById.set(category.id, category);
    for (const type of mapped.activityTypes) mapped.activityTypeById.set(type.id, type);
    for (const area of mapped.areas) mapped.areaById.set(area.id, area);
    return mapped;
  }

  return {
    async get() {
      if (cached !== undefined && now() - cached.at < TTL_MS) return cached.value;
      if (inFlight === undefined) {
        inFlight = load()
          .then((value) => {
            cached = { value, at: now() };
            return value;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      return inFlight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
