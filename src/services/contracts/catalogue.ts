import type {
  ActivityType,
  AreaId,
  Category,
  CategoryId,
  Participant,
  ParticipantId,
  Program,
  Provider,
} from '@/types/domain';

/** A category with its deterministic total supply (drives HMA-011 ordering). */
export interface CategoryListing {
  category: Category;
  /** Absent when no exact supply count is known (real composition serves
   *  no catalogue-wide counts — nothing is estimated). */
  programCount?: number;
}

/**
 * A browse lens shown alongside categories on All Categories — docs/15 §3
 * group 12. Lenses resolve to preset Results, never to a category page.
 */
export interface LensListing {
  collectionId: string;
  label: string;
  imageKey: string;
  programCount?: number;
}

export interface AllCategoriesListing {
  /** Supply-aware order: program count descending, taxonomy order on ties. */
  categories: CategoryListing[];
  lenses: LensListing[];
}

export interface CataloguePageInput {
  areaId: AreaId;
  participantId: ParticipantId;
  /** Selected browsing participant — child context narrows by age (server-side). */
  participant?: Participant;
}

/** An activity type with its participant-visible supply. */
export interface ActivityTypeCount {
  activityType: ActivityType;
  programCount?: number;
}

export interface CategoryPage {
  category: Category;
  /** Featured chips, supply-ordered; zero-supply types are omitted. */
  activityTypes: ActivityTypeCount[];
  popularPrograms: Program[];
  providers: Provider[];
  /** Offer-bearing subset; the section collapses when empty. */
  offerPrograms: Program[];
  /** Participant-visible supply — drives the honest weak-supply state.
   *  Absent when the count is not exactly known. */
  visibleProgramCount?: number;
}

export interface ActivityTypePage {
  activityType: ActivityType;
  category: Category;
  programs: Program[];
  providers: Provider[];
}

/**
 * Catalogue browsing boundary — docs/15 §5, docs/08 §8. Deterministic
 * lookups and supply counts over the shared catalogue; ranking is simple and
 * rule-based only (docs/09 §18): eligibility first, then rating, proximity,
 * and stable catalogue order. No behavioral signals.
 */
export interface CatalogueService {
  getAllCategories(): Promise<AllCategoriesListing>;
  /** Undefined when the id is unknown (bad deep link) — screens recover. */
  getCategoryPage(
    input: CataloguePageInput & { categoryId: CategoryId },
  ): Promise<CategoryPage | undefined>;
  getActivityTypePage(
    input: CataloguePageInput & { activityTypeId: string },
  ): Promise<ActivityTypePage | undefined>;
}
