import type {
  Area,
  AreaId,
  BrowseEntry,
  CreditSummary,
  Participant,
  ParticipantId,
  Program,
  Provider,
} from '@/types/domain';

export type QuickFilterId =
  | 'today'
  | 'weekend'
  | 'near-me'
  | 'ladies-only'
  | 'camps'
  | 'offers';

export interface QuickFilter {
  id: QuickFilterId;
  label: string;
  /** Shown under the filter row while active, e.g. "Showing ladies-only activities". */
  activeDescription: string;
}

export interface HomeFeedInput {
  areaId: AreaId;
  participantId: ParticipantId;
  quickFilterId?: QuickFilterId;
}

export interface ProgramSection {
  id: string;
  title: string;
  programs: Program[];
}

export interface HeroContent {
  eyebrow: string;
  title: string;
  subtitle: string;
  actionLabel: string;
  imageKey: string;
}

export interface HomeFeed {
  hero: HeroContent;
  /** Home's approved eight browse tiles (labels/images unchanged). */
  categories: BrowseEntry[];
  /** Program-first sections in display order; empty sections are omitted. */
  programSections: ProgramSection[];
  /** Provider-first content; empty when nothing matches. */
  providers: Provider[];
  credit: CreditSummary;
  /** True when an active filter/context combination matched no programs. */
  isEmpty: boolean;
}

/**
 * Home feed boundary — docs/08 §8. The mock implementation is deterministic;
 * a real API client replaces it later without touching screens.
 */
export interface HomeFeedService {
  getHomeFeed(input: HomeFeedInput): Promise<HomeFeed>;
  getParticipants(): Participant[];
  getAreas(): Area[];
  getQuickFilters(): QuickFilter[];
}
