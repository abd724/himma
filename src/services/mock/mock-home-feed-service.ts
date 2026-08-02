import {
  areas,
  categories,
  participants,
  programs,
  providers,
  recommendationOrder,
} from '@/data/mock/catalogue';
import type {
  HeroContent,
  HomeFeed,
  HomeFeedInput,
  HomeFeedService,
  ProgramSection,
  QuickFilter,
  QuickFilterId,
} from '@/services/contracts/home-feed';
import type { Area, AreaId, Participant, ParticipantId, Program } from '@/types/domain';

const quickFilters: QuickFilter[] = [
  { id: 'today', label: 'Today', activeDescription: 'Showing activities available today' },
  { id: 'weekend', label: 'This weekend', activeDescription: 'Showing weekend activities' },
  { id: 'near-me', label: 'Near me', activeDescription: 'Showing the closest activities first' },
  { id: 'ladies-only', label: 'Ladies only', activeDescription: 'Showing ladies-only activities' },
  { id: 'camps', label: 'Camps', activeDescription: 'Showing camps' },
  { id: 'offers', label: 'Offers', activeDescription: 'Showing offers and trials' },
];

const hero: HeroContent = {
  eyebrow: 'August in Abu Dhabi',
  title: 'Indoor this August',
  subtitle: 'Cool indoor picks for you and the family — pools, courts and camps.',
  actionLabel: 'Explore summer picks',
  imageKey: 'swimRace',
};

const SECTION_CAPS = { recommended: 5, today: 4, offers: 4, providers: 4 } as const;

function participantById(id: ParticipantId): Participant {
  return participants.find((p) => p.id === id) ?? participants[0];
}

/** Docs/11 §5 — who a program suits under the selected browsing context. */
function suitsParticipant(program: Program, participant: Participant): boolean {
  const { audience, minAge, maxAge } = program.eligibility;
  switch (participant.kind) {
    case 'everyone':
      return true;
    case 'self':
      return audience === 'adults' || audience === 'all';
    case 'child': {
      if (audience === 'adults') return false;
      const age = participant.age ?? 0;
      if (minAge !== undefined && age < minAge) return false;
      if (maxAge !== undefined && age > maxAge) return false;
      return true;
    }
  }
}

/** Docs/11 §6 — filters narrow; "near-me" reorders instead. */
function passesFilter(program: Program, filter?: QuickFilterId): boolean {
  switch (filter) {
    case undefined:
    case 'near-me':
      return true;
    case 'today':
      return program.availableToday;
    case 'weekend':
      return program.runsOnWeekend;
    case 'ladies-only':
      return program.eligibility.ladiesOnly === true;
    case 'camps':
      return program.isCamp;
    case 'offers':
      return program.offer !== undefined;
  }
}

function areaRank(areaId: AreaId, reference: Area): number {
  if (areaId === reference.id) return 0;
  const nearbyIndex = reference.nearby.indexOf(areaId);
  return nearbyIndex === -1 ? reference.nearby.length + 1 : nearbyIndex + 1;
}

/** Stable reorder: closest areas first, original order preserved within ranks. */
function rankNearMe<T>(items: T[], areaOf: (item: T) => AreaId, reference: Area): T[] {
  return items
    .map((item, index) => ({ item, index, rank: areaRank(areaOf(item), reference) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

export class MockHomeFeedService implements HomeFeedService {
  constructor(private readonly delayMs: number = 400) {}

  getParticipants(): Participant[] {
    return participants;
  }

  getAreas(): Area[] {
    return areas;
  }

  getQuickFilters(): QuickFilter[] {
    return quickFilters;
  }

  async getHomeFeed(input: HomeFeedInput): Promise<HomeFeed> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.buildFeed(input);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildFeed(input: HomeFeedInput): HomeFeed {
    const participant = participantById(input.participantId);
    const referenceArea = areas.find((a) => a.id === input.areaId) ?? areas[0];
    const filter = input.quickFilterId;

    const visible = (list: Program[]): Program[] => {
      const matching = list.filter(
        (program) => suitsParticipant(program, participant) && passesFilter(program, filter),
      );
      return filter === 'near-me'
        ? rankNearMe(matching, (program) => program.areaId, referenceArea)
        : matching;
    };

    const byId = new Map(programs.map((program) => [program.id, program]));
    const recommendedFor = (key: string): Program[] =>
      (recommendationOrder[key] ?? [])
        .map((id) => byId.get(id))
        .filter((program): program is Program => program !== undefined);

    const sections: ProgramSection[] = [];
    const pushSection = (id: string, title: string, list: Program[], cap: number) => {
      const items = visible(list).slice(0, cap);
      if (items.length > 0) sections.push({ id, title, programs: items });
    };

    // Docs/11 §5: a selected child's section leads and replaces "for you";
    // "Me" hides the child section; "Everyone" shows both (Adam by default).
    if (participant.kind === 'child') {
      pushSection(
        `recommended-${participant.id}`,
        `Recommended for ${participant.label}`,
        recommendedFor(participant.id),
        SECTION_CAPS.recommended,
      );
    } else {
      pushSection(
        'recommended-me',
        'Recommended for you',
        recommendedFor(participant.kind === 'everyone' ? 'everyone' : 'me'),
        SECTION_CAPS.recommended,
      );
      if (participant.kind === 'everyone') {
        pushSection(
          'recommended-adam',
          'Recommended for Adam',
          recommendedFor('adam'),
          SECTION_CAPS.recommended,
        );
      }
    }

    pushSection(
      'available-today',
      'Available today & tonight',
      programs.filter((program) => program.availableToday),
      SECTION_CAPS.today,
    );
    pushSection(
      'offers-trials',
      'Offers & trials',
      programs.filter((program) => program.offer !== undefined),
      SECTION_CAPS.offers,
    );

    // Provider-first content follows the surviving program content.
    const matchedProviderIds = new Set(
      sections.flatMap((section) => section.programs.map((program) => program.providerId)),
    );
    let visibleProviders = providers.filter((provider) => matchedProviderIds.has(provider.id));
    visibleProviders = rankNearMe(visibleProviders, (provider) => provider.areaId, referenceArea);

    return {
      hero,
      categories,
      programSections: sections,
      providers: visibleProviders.slice(0, SECTION_CAPS.providers),
      credit: { availableCredit: 65 },
      isEmpty: sections.length === 0,
    };
  }
}

export const homeFeedService: HomeFeedService = new MockHomeFeedService();
