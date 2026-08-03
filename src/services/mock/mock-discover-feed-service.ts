import { areas, collections, homeBrowseEntries, participants, programs, providers } from '@/data/mock/catalogue';
import { collectionFilterSelection } from '@/services/contracts/filters';
import type {
  CollectionSummary,
  DiscoverFeed,
  DiscoverFeedInput,
  DiscoverFeedService,
  DiscoverProgramSection,
} from '@/services/contracts/discover-feed';
import type { QuickFilter, QuickFilterId } from '@/services/contracts/filters';
import { passesFilters } from '@/services/mock/results-engine';
import type { Area, AreaId, Collection, Participant, ParticipantId, Program } from '@/types/domain';
import { isLadiesOnly, participantAge, suitsAdult, suitsChild } from '@/utils/eligibility';

/** Discover's six quick chips — docs/14 §2.4 (moved from the Home service; Home has no quick filters, docs/18 §4). */
export const quickFilters: QuickFilter[] = [
  { id: 'today', label: 'Today', activeDescription: 'Showing activities available today' },
  { id: 'weekend', label: 'This weekend', activeDescription: 'Showing weekend activities' },
  { id: 'near-me', label: 'Near me', activeDescription: 'Showing the closest activities first' },
  { id: 'ladies-only', label: 'Ladies only', activeDescription: 'Showing ladies-only activities' },
  { id: 'camps', label: 'Camps', activeDescription: 'Showing camps' },
  { id: 'offers', label: 'Offers', activeDescription: 'Showing offers and trials' },
];

const CAPS = { trending: 5, today: 4, offers: 4, providers: 4, collections: 5 } as const;

function participantById(id: ParticipantId): Participant {
  return participants.find((p) => p.id === id) ?? participants[0];
}

/** Child contexts hard-exclude by provider-defined age range (docs/16 §4). */
function inParticipantContext(program: Program, participant: Participant): boolean {
  if (participant.kind !== 'child') return true;
  return suitsChild(program.eligibility, participantAge(participant) ?? 0);
}

/** Same narrowing semantics as Home's quick filters; "near-me" reorders only. */
function passesQuickFilter(program: Program, filter?: QuickFilterId): boolean {
  switch (filter) {
    case undefined:
    case 'near-me':
      return true;
    case 'today':
      return program.availableToday;
    case 'weekend':
      return program.runsOnWeekend;
    case 'ladies-only':
      return isLadiesOnly(program.eligibility);
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

/** Minutes since midnight for "7:30 PM"; non-clock labels sort last. */
function todayTimeMinutes(program: Program): number {
  const match = program.todayTime?.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = (Number(match[1]) % 12) + (match[3] === 'PM' ? 12 : 0);
  return hours * 60 + Number(match[2]);
}

/** Collections make sense for the browsing context, not just its age gate. */
function collectionSuitsParticipant(collection: Collection, participant: Participant): boolean {
  if (participant.kind === 'child') return collection.audience !== 'adults';
  if (participant.kind === 'self') return collection.audience !== 'children';
  return true;
}

export class MockDiscoverFeedService implements DiscoverFeedService {
  constructor(private readonly delayMs: number = 400) {}

  getQuickFilters(): QuickFilter[] {
    return quickFilters;
  }

  async getDiscoverFeed(input: DiscoverFeedInput): Promise<DiscoverFeed> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.buildFeed(input);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildFeed(input: DiscoverFeedInput): DiscoverFeed {
    if (input.simulateFailure === true) {
      throw new Error('Simulated network failure (QA only)');
    }
    const participant = participantById(input.participantId);
    const referenceArea = areas.find((area) => area.id === input.areaId) ?? areas[0];
    const nearMeActive = input.quickFilterId === 'near-me';

    const indexById = new Map(programs.map((program, index) => [program.id, index]));
    const stable = (program: Program) => indexById.get(program.id) ?? 0;
    // "Me" emphasizes adult-suitable content without hiding child programs
    // (docs/16 §4); other contexts rank everything equally.
    const adultEmphasis = (program: Program) =>
      participant.kind === 'self' && !suitsAdult(program.eligibility) ? 1 : 0;
    const proximity = (program: Program) => areaRank(program.areaId, referenceArea);

    const visible = programs.filter(
      (program) =>
        inParticipantContext(program, participant) &&
        passesQuickFilter(program, input.quickFilterId),
    );

    const rank = (list: Program[], compare: (a: Program, b: Program) => number): Program[] =>
      [...list].sort(
        (a, b) =>
          adultEmphasis(a) - adultEmphasis(b) ||
          (nearMeActive ? proximity(a) - proximity(b) : 0) ||
          compare(a, b) ||
          stable(a) - stable(b),
      );

    const sections: DiscoverProgramSection[] = [];
    const pushSection = (section: DiscoverProgramSection) => {
      if (section.programs.length > 0) sections.push(section);
    };

    // Trending near you — area proximity first, then rating (docs/14 §2.7).
    pushSection({
      id: 'trending',
      title: 'Trending near you',
      programs: rank(visible, (a, b) => proximity(a) - proximity(b) || b.rating - a.rating).slice(
        0,
        CAPS.trending,
      ),
    });

    // Available today — time-led: soonest mock "today" time first (docs/14 §2.8).
    const todayList = rank(
      visible.filter((program) => program.availableToday),
      (a, b) => todayTimeMinutes(a) - todayTimeMinutes(b),
    ).slice(0, CAPS.today);
    const scheduleOverrides: Record<string, string> = {};
    for (const program of todayList) {
      if (program.todayTime !== undefined) {
        const timeLed = `Today, ${program.todayTime}`;
        if (program.scheduleLabel !== timeLed) scheduleOverrides[program.id] = timeLed;
      }
    }
    pushSection({
      id: 'available-today',
      title: 'Available today',
      programs: todayList,
      scheduleOverrides,
    });

    // Offers & trials — badge-led (docs/14 §2.10).
    pushSection({
      id: 'offers-trials',
      title: 'Offers & trials',
      programs: rank(
        visible.filter((program) => program.offer !== undefined),
        (a, b) => b.rating - a.rating,
      ).slice(0, CAPS.offers),
    });

    // Popular providers — derived from surviving program content, rating-led.
    const matchedProviderIds = new Set(
      sections.flatMap((section) => section.programs.map((program) => program.providerId)),
    );
    const rankedProviders = providers
      .filter((provider) => matchedProviderIds.has(provider.id))
      .map((provider, index) => ({ provider, index }))
      .sort(
        (a, b) =>
          b.provider.rating - a.provider.rating ||
          areaRank(a.provider.areaId, referenceArea) - areaRank(b.provider.areaId, referenceArea) ||
          a.index - b.index,
      )
      .map((entry) => entry.provider)
      .slice(0, CAPS.providers);

    // Child-dependent visibility — docs/18 §6: a child-focused collection is
    // eligible for promoted placement only when the ACCOUNT has a child
    // profile with age-eligible supply in that collection. This reads account
    // composition, never the browsing participant (owner caution,
    // 2026-08-03); `null` children = guest, gate off (docs/18 §18).
    const passesChildGate = (collection: Collection): boolean => {
      if (!collection.childFocused) return true;
      const accountChildren = input.childParticipants;
      if (accountChildren === null) return true;
      if (accountChildren.length === 0) return false;
      const selection = collectionFilterSelection(collection);
      return programs.some(
        (program) =>
          passesFilters(program, selection) &&
          accountChildren.some((child) =>
            suitsChild(program.eligibility, participantAge(child) ?? 0),
          ),
      );
    };

    // Editorial rail — account-gated, participant-compatible, counts
    // deterministic, empty presets collapsed. The quick filter narrows
    // programs, not the rail.
    const countFor = (collection: Collection): number => {
      const selection = collectionFilterSelection(collection);
      return programs.filter(
        (program) =>
          inParticipantContext(program, participant) && passesFilters(program, selection),
      ).length;
    };
    const rail: CollectionSummary[] = collections
      .filter(
        (collection) =>
          collection.featuredOnDiscover &&
          passesChildGate(collection) &&
          collectionSuitsParticipant(collection, participant),
      )
      .map((collection) => ({ collection, programCount: countFor(collection) }))
      .filter((summary) => summary.programCount > 0)
      .slice(0, CAPS.collections);

    const isEmpty = sections.length === 0;

    return {
      browseEntries: homeBrowseEntries,
      collections: isEmpty ? [] : rail,
      programSections: sections,
      providers: rankedProviders,
      isEmpty,
    };
  }
}

export const discoverFeedService: DiscoverFeedService = new MockDiscoverFeedService();
