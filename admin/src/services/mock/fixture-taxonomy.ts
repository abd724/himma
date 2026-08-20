import type {
  ActivityTypeView,
  AdminTaxonomyPort,
  AreaView,
  CategoryView,
  CollectionView,
  TaxonomyActionOutcome,
} from '../../taxonomy/contract';

/**
 * Deterministic FIXTURE taxonomy administration data (W3-7) behind the
 * same port the live runtime implements. Semantics mirror the CERTIFIED
 * S4 machine truthfully — fixture behaviour can never advertise a
 * capability production does not possess:
 * - slugs are immutable (no update path can express one) and unique per
 *   entity (duplicate creation → slugConflict);
 * - retirement is deactivation / collection state only — NOTHING deletes,
 *   and deactivated rows stay listed for administration;
 * - activity types require an EXISTING parent category (ghost parent →
 *   invalidTaxonomy) and can never be re-parented;
 * - every update is CAS-checked (stale → staleVersion, no partial change);
 * - ordering is the sortHint data only — no reorder operation exists;
 * - the D-W3-5 OWNER RULING is mirrored: creation and metadata edits are
 *   ordinary baseline administration; ONLY availability changes (`active`
 *   / collection `state`) honour the action-level step-up seam; the
 *   administration READ never demands step-up.
 * Live mode can never reach this module (composition-locked).
 */

interface FixtureTaxonomyState {
  areas: Array<AreaView & { labelAr: string | null }>;
  categories: CategoryView[];
  activityTypes: ActivityTypeView[];
  collections: CollectionView[];
  createdCounter: number;
}

export type FixtureTaxonomyData = FixtureTaxonomyState;

export function createFixtureTaxonomyData(): FixtureTaxonomyData {
  return {
    createdCounter: 0,
    areas: [
      {
        id: 'area-dubai-marina',
        slug: 'dubai-marina',
        labelEn: 'Dubai Marina',
        labelAr: null,
        city: 'Dubai',
        sortHint: 10,
        active: true,
        version: 1,
      },
      {
        id: 'area-jlt',
        slug: 'jlt',
        labelEn: 'Jumeirah Lakes Towers',
        labelAr: null,
        city: 'Dubai',
        sortHint: 20,
        active: true,
        version: 1,
      },
      {
        id: 'area-old-town',
        slug: 'old-town',
        labelEn: 'Old Town',
        labelAr: null,
        city: 'Dubai',
        sortHint: 30,
        active: false,
        version: 3,
      },
    ],
    categories: [
      {
        id: 'cat-water',
        slug: 'water-sports',
        labelEn: 'Water Sports',
        labelAr: null,
        imageRef: null,
        sortHint: 10,
        active: true,
        version: 1,
      },
      {
        id: 'cat-racquet',
        slug: 'racquet-sports',
        labelEn: 'Racquet Sports',
        labelAr: null,
        imageRef: null,
        sortHint: 20,
        active: true,
        version: 2,
      },
      {
        id: 'cat-retired',
        slug: 'retired-category',
        labelEn: 'Retired Category',
        labelAr: null,
        imageRef: null,
        sortHint: 90,
        active: false,
        version: 4,
      },
    ],
    activityTypes: [
      {
        id: 'type-swimming',
        slug: 'swimming',
        categoryId: 'cat-water',
        labelEn: 'Swimming',
        labelAr: null,
        synonymsEn: ['swim lessons', 'aquatics'],
        synonymsAr: [],
        active: true,
        version: 1,
      },
      {
        id: 'type-sailing',
        slug: 'sailing',
        categoryId: 'cat-water',
        labelEn: 'Sailing',
        labelAr: null,
        synonymsEn: ['dinghy'],
        synonymsAr: [],
        active: true,
        version: 1,
      },
      {
        id: 'type-squash',
        slug: 'squash',
        categoryId: 'cat-racquet',
        labelEn: 'Squash',
        labelAr: null,
        synonymsEn: [],
        synonymsAr: [],
        active: false,
        version: 2,
      },
    ],
    collections: [
      {
        id: 'coll-summer-camps',
        titleEn: 'Summer Camps',
        titleAr: null,
        subtitleEn: 'Full-day and half-day camps across the city.',
        subtitleAr: null,
        imageRef: null,
        presetLadiesOnly: false,
        presetChildRelevant: true,
        presetCamps: true,
        presetOffers: false,
        presetAvailableToday: false,
        presetAfterSchool: false,
        presetIndoor: false,
        audience: 'children',
        childFocused: true,
        featured: true,
        seasonalLabel: 'Summer',
        state: 'published',
        version: 2,
      },
      {
        id: 'coll-ladies-only',
        titleEn: 'Ladies Only',
        titleAr: null,
        subtitleEn: null,
        subtitleAr: null,
        imageRef: null,
        presetLadiesOnly: true,
        presetChildRelevant: false,
        presetCamps: false,
        presetOffers: false,
        presetAvailableToday: false,
        presetAfterSchool: false,
        presetIndoor: false,
        audience: 'adults',
        childFocused: false,
        featured: false,
        seasonalLabel: null,
        state: 'draft',
        version: 1,
      },
    ],
  };
}

export interface FixtureTaxonomyAuthority {
  currentAuthority(): { hasTaxonomyCapability: boolean } | null;
  takeFailure(): boolean;
  stepUpDemanded(): boolean;
}

export function createFixtureTaxonomyPort(
  authority: FixtureTaxonomyAuthority,
  data: FixtureTaxonomyData,
): AdminTaxonomyPort {
  const admit = (): TaxonomyActionOutcome | null => {
    const auth = authority.currentAuthority();
    if (auth === null) return { kind: 'unavailable' };
    if (authority.takeFailure()) return { kind: 'unavailable' };
    if (!auth.hasTaxonomyCapability) return { kind: 'forbidden' };
    return null;
  };
  /** D-W3-5 ruling: ordinary administration (creation + metadata edits)
   *  is baseline; ONLY availability changes (`active` / collection
   *  `state`) demand the recent factor — mirrored per call site. */
  const admitMutation = (touchesAvailability = false): TaxonomyActionOutcome | null => {
    const refused = admit();
    if (refused !== null) return refused;
    if (touchesAvailability && authority.stepUpDemanded()) {
      return { kind: 'stepUpRequired' };
    }
    return null;
  };
  const nextId = (prefix: string): string => {
    data.createdCounter += 1;
    return `${prefix}-created-${data.createdCounter}`;
  };

  return {
    async getTaxonomy() {
      const refused = admit();
      if (refused !== null) {
        return refused.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
      }
      // Snapshots, never live references — a real transport can only ever
      // hand the consumer serialized copies.
      return {
        kind: 'loaded',
        view: {
          areas: data.areas.map((area) => ({ ...area })),
          categories: data.categories.map((category) => ({ ...category })),
          activityTypes: data.activityTypes.map((type) => ({
            ...type,
            synonymsEn: [...type.synonymsEn],
            synonymsAr: [...type.synonymsAr],
          })),
          collections: data.collections.map((collection) => ({ ...collection })),
        },
      };
    },

    async createArea(input) {
      const refused = admitMutation();
      if (refused !== null) return refused;
      if (data.areas.some((area) => area.slug === input.slug)) return { kind: 'slugConflict' };
      data.areas.push({
        id: nextId('area'),
        slug: input.slug,
        labelEn: input.labelEn,
        labelAr: input.labelAr ?? null,
        city: input.city ?? null,
        sortHint: input.sortHint ?? 0,
        active: true,
        version: 1,
      });
      return { kind: 'completed' };
    },

    async updateArea(areaId, input) {
      const refused = admitMutation(input.patch.active !== undefined);
      if (refused !== null) return refused;
      const area = data.areas.find((entry) => entry.id === areaId);
      if (area === undefined) return { kind: 'notFound' };
      if (area.version !== input.expectedVersion) return { kind: 'staleVersion' };
      // Slug/id are structurally absent from the patch type — immutable.
      Object.assign(area, {
        ...(input.patch.labelEn !== undefined ? { labelEn: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { labelAr: input.patch.labelAr } : {}),
        ...(input.patch.city !== undefined ? { city: input.patch.city } : {}),
        ...(input.patch.sortHint !== undefined ? { sortHint: input.patch.sortHint } : {}),
        ...(input.patch.active !== undefined ? { active: input.patch.active } : {}),
        version: area.version + 1,
      });
      return { kind: 'completed' };
    },

    async createCategory(input) {
      const refused = admitMutation();
      if (refused !== null) return refused;
      if (data.categories.some((category) => category.slug === input.slug)) {
        return { kind: 'slugConflict' };
      }
      data.categories.push({
        id: nextId('cat'),
        slug: input.slug,
        labelEn: input.labelEn,
        labelAr: input.labelAr ?? null,
        imageRef: null,
        sortHint: input.sortHint ?? 0,
        active: true,
        version: 1,
      });
      return { kind: 'completed' };
    },

    async updateCategory(categoryId, input) {
      const refused = admitMutation(input.patch.active !== undefined);
      if (refused !== null) return refused;
      const index = data.categories.findIndex((entry) => entry.id === categoryId);
      if (index === -1) return { kind: 'notFound' };
      const category = data.categories[index]!;
      if (category.version !== input.expectedVersion) return { kind: 'staleVersion' };
      data.categories[index] = {
        ...category,
        ...(input.patch.labelEn !== undefined ? { labelEn: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { labelAr: input.patch.labelAr } : {}),
        ...(input.patch.sortHint !== undefined ? { sortHint: input.patch.sortHint } : {}),
        ...(input.patch.active !== undefined ? { active: input.patch.active } : {}),
        version: category.version + 1,
      };
      return { kind: 'completed' };
    },

    async createActivityType(input) {
      const refused = admitMutation();
      if (refused !== null) return refused;
      // Two levels only: the parent must be a REAL category (any state).
      if (!data.categories.some((category) => category.id === input.categoryId)) {
        return { kind: 'invalidTaxonomy' };
      }
      if (data.activityTypes.some((type) => type.slug === input.slug)) {
        return { kind: 'slugConflict' };
      }
      data.activityTypes.push({
        id: nextId('type'),
        slug: input.slug,
        categoryId: input.categoryId,
        labelEn: input.labelEn,
        labelAr: input.labelAr ?? null,
        synonymsEn: [...(input.synonymsEn ?? [])],
        synonymsAr: [],
        active: true,
        version: 1,
      });
      return { kind: 'completed' };
    },

    async updateActivityType(activityTypeId, input) {
      const refused = admitMutation(input.patch.active !== undefined);
      if (refused !== null) return refused;
      const index = data.activityTypes.findIndex((entry) => entry.id === activityTypeId);
      if (index === -1) return { kind: 'notFound' };
      const activityType = data.activityTypes[index]!;
      if (activityType.version !== input.expectedVersion) return { kind: 'staleVersion' };
      // categoryId is structurally absent — re-parenting is not an operation.
      data.activityTypes[index] = {
        ...activityType,
        ...(input.patch.labelEn !== undefined ? { labelEn: input.patch.labelEn } : {}),
        ...(input.patch.labelAr !== undefined ? { labelAr: input.patch.labelAr } : {}),
        ...(input.patch.synonymsEn !== undefined
          ? { synonymsEn: [...input.patch.synonymsEn] }
          : {}),
        ...(input.patch.active !== undefined ? { active: input.patch.active } : {}),
        version: activityType.version + 1,
      };
      return { kind: 'completed' };
    },

    async createCollection(input) {
      const refused = admitMutation();
      if (refused !== null) return refused;
      data.collections.push({
        id: nextId('coll'),
        titleEn: input.titleEn,
        titleAr: null,
        subtitleEn: input.subtitleEn ?? null,
        subtitleAr: null,
        imageRef: null,
        presetLadiesOnly: false,
        presetChildRelevant: false,
        presetCamps: false,
        presetOffers: false,
        presetAvailableToday: false,
        presetAfterSchool: false,
        presetIndoor: false,
        audience: input.audience ?? 'all',
        childFocused: false,
        featured: input.featured ?? false,
        seasonalLabel: input.seasonalLabel ?? null,
        state: input.state ?? 'draft',
        version: 1,
      });
      return { kind: 'completed' };
    },

    async updateCollection(collectionId, input) {
      const refused = admitMutation(input.patch.state !== undefined);
      if (refused !== null) return refused;
      const index = data.collections.findIndex((entry) => entry.id === collectionId);
      if (index === -1) return { kind: 'notFound' };
      const collection = data.collections[index]!;
      if (collection.version !== input.expectedVersion) return { kind: 'staleVersion' };
      data.collections[index] = {
        ...collection,
        ...(input.patch.titleEn !== undefined ? { titleEn: input.patch.titleEn } : {}),
        ...(input.patch.subtitleEn !== undefined ? { subtitleEn: input.patch.subtitleEn } : {}),
        ...(input.patch.audience !== undefined ? { audience: input.patch.audience } : {}),
        ...(input.patch.featured !== undefined ? { featured: input.patch.featured } : {}),
        ...(input.patch.seasonalLabel !== undefined
          ? { seasonalLabel: input.patch.seasonalLabel }
          : {}),
        ...(input.patch.state !== undefined ? { state: input.patch.state } : {}),
        version: collection.version + 1,
      };
      return { kind: 'completed' };
    },
  };
}
