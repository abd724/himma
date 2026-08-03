import {
  activityTypes,
  areas,
  categories,
  collections,
  participants,
  programs,
  providers,
} from '@/data/mock/catalogue';
import type {
  ActivityTypePage,
  AllCategoriesListing,
  CatalogueService,
  CataloguePageInput,
  CategoryPage,
} from '@/services/contracts/catalogue';
import { collectionFilterSelection } from '@/services/contracts/filters';
import { passesFilters } from '@/services/mock/results-engine';
import type {
  Area,
  AreaId,
  CategoryId,
  Participant,
  ParticipantId,
  Program,
} from '@/types/domain';
import { participantAge, suitsAdult, suitsChild } from '@/utils/eligibility';

const CAPS = { popularPrograms: 6, providers: 4, offers: 4 } as const;

/** The two browse lenses surfaced on All Categories — docs/15 §3 group 12. */
const LENS_COLLECTION_IDS = ['kids-teens', 'camps'] as const;

function participantById(id: ParticipantId): Participant {
  return participants.find((participant) => participant.id === id) ?? participants[0];
}

/** Child contexts hard-exclude by provider-defined age range (docs/16 §4). */
function inParticipantContext(program: Program, participant: Participant): boolean {
  if (participant.kind !== 'child') return true;
  return suitsChild(program.eligibility, participantAge(participant) ?? 0);
}

function areaRank(areaId: AreaId, reference: Area): number {
  if (areaId === reference.id) return 0;
  const nearbyIndex = reference.nearby.indexOf(areaId);
  return nearbyIndex === -1 ? reference.nearby.length + 1 : nearbyIndex + 1;
}

export class MockCatalogueService implements CatalogueService {
  constructor(private readonly delayMs: number = 300) {}

  async getAllCategories(): Promise<AllCategoriesListing> {
    await this.delay();
    return this.buildAllCategories();
  }

  async getCategoryPage(
    input: CataloguePageInput & { categoryId: CategoryId },
  ): Promise<CategoryPage | undefined> {
    await this.delay();
    return this.buildCategoryPage(input);
  }

  async getActivityTypePage(
    input: CataloguePageInput & { activityTypeId: string },
  ): Promise<ActivityTypePage | undefined> {
    await this.delay();
    return this.buildActivityTypePage(input);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildAllCategories(): AllCategoriesListing {
    const taxonomyIndex = new Map(categories.map((category, index) => [category.id, index]));
    const listed = categories
      .map((category) => ({
        category,
        programCount: programs.filter((program) => program.categoryId === category.id).length,
      }))
      .sort(
        (a, b) =>
          b.programCount - a.programCount ||
          (taxonomyIndex.get(a.category.id) ?? 0) - (taxonomyIndex.get(b.category.id) ?? 0),
      );

    const lenses = LENS_COLLECTION_IDS.flatMap((collectionId) => {
      const collection = collections.find((entry) => entry.id === collectionId);
      if (collection === undefined) return [];
      const selection = collectionFilterSelection(collection);
      return [
        {
          collectionId: collection.id,
          label: collection.title,
          imageKey: collection.imageKey,
          programCount: programs.filter((program) => passesFilters(program, selection)).length,
        },
      ];
    });

    return { categories: listed, lenses };
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildCategoryPage(
    input: CataloguePageInput & { categoryId: CategoryId },
  ): CategoryPage | undefined {
    const category = categories.find((entry) => entry.id === input.categoryId);
    if (category === undefined) return undefined;

    const participant = participantById(input.participantId);
    const visible = this.rank(
      programs.filter(
        (program) =>
          program.categoryId === category.id && inParticipantContext(program, participant),
      ),
      input.areaId,
      participant,
    );

    const typeCounts = activityTypes
      .filter((activityType) => activityType.categoryId === category.id)
      .map((activityType) => ({
        activityType,
        programCount: visible.filter((program) => program.activityTypeId === activityType.id)
          .length,
      }))
      .filter((entry) => entry.programCount > 0)
      .sort((a, b) => b.programCount - a.programCount);

    const providerIds = new Set(visible.map((program) => program.providerId));
    const rankedProviders = providers
      .filter((provider) => providerIds.has(provider.id))
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => b.provider.rating - a.provider.rating || a.index - b.index)
      .map((entry) => entry.provider)
      .slice(0, CAPS.providers);

    return {
      category,
      activityTypes: typeCounts,
      popularPrograms: visible.slice(0, CAPS.popularPrograms),
      providers: rankedProviders,
      offerPrograms: visible
        .filter((program) => program.offer !== undefined)
        .slice(0, CAPS.offers),
      visibleProgramCount: visible.length,
    };
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildActivityTypePage(
    input: CataloguePageInput & { activityTypeId: string },
  ): ActivityTypePage | undefined {
    const activityType = activityTypes.find((entry) => entry.id === input.activityTypeId);
    if (activityType === undefined) return undefined;
    const category = categories.find((entry) => entry.id === activityType.categoryId);
    if (category === undefined) return undefined;

    const participant = participantById(input.participantId);
    const visible = this.rank(
      programs.filter(
        (program) =>
          program.activityTypeId === activityType.id &&
          inParticipantContext(program, participant),
      ),
      input.areaId,
      participant,
    );

    const providerIds = new Set(visible.map((program) => program.providerId));
    const rankedProviders = providers
      .filter((provider) => providerIds.has(provider.id))
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => b.provider.rating - a.provider.rating || a.index - b.index)
      .map((entry) => entry.provider);

    return { activityType, category, programs: visible, providers: rankedProviders };
  }

  /**
   * Simple rule-based ranking (docs/09 §18): "Me" ranks adult-suitable first
   * without hiding child programs (docs/16 §4), then rating, area proximity,
   * and stable catalogue order. No behavioral signals.
   */
  private rank(list: Program[], areaId: AreaId, participant: Participant): Program[] {
    const reference = areas.find((area) => area.id === areaId) ?? areas[0];
    const indexById = new Map(programs.map((program, index) => [program.id, index]));
    const adultEmphasis = (program: Program) =>
      participant.kind === 'self' && !suitsAdult(program.eligibility) ? 1 : 0;
    return [...list].sort(
      (a, b) =>
        adultEmphasis(a) - adultEmphasis(b) ||
        b.rating - a.rating ||
        areaRank(a.areaId, reference) - areaRank(b.areaId, reference) ||
        (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0),
    );
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

export const catalogueService: CatalogueService = new MockCatalogueService();
