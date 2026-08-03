import type { QuickFilter, QuickFilterId } from '@/services/contracts/home-feed';
import type {
  AreaId,
  BrowseEntry,
  Collection,
  ParticipantId,
  Program,
  Provider,
} from '@/types/domain';

export interface DiscoverFeedInput {
  areaId: AreaId;
  participantId: ParticipantId;
  quickFilterId?: QuickFilterId;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
}

/** A collection with its deterministic result count for the active context. */
export interface CollectionSummary {
  collection: Collection;
  /** Programs its preset resolves to for the current participant. */
  programCount: number;
}

export type DiscoverSectionId = 'trending' | 'available-today' | 'offers-trials';

export interface DiscoverProgramSection {
  id: DiscoverSectionId;
  title: string;
  programs: Program[];
  /**
   * Time-led sections show "Today, 7:30 PM" instead of the weekly schedule
   * line (docs/14 §2.8); keys map program id → display label.
   */
  scheduleOverrides?: Record<string, string>;
}

export interface DiscoverFeed {
  /** The eight approved browse tiles (Home visual language reused). */
  browseEntries: BrowseEntry[];
  /** Editorial rail, participant-compatible, empty presets collapsed. */
  collections: CollectionSummary[];
  /** Program-first sections in display order; empty sections are omitted. */
  programSections: DiscoverProgramSection[];
  /** Provider-first carousel derived from surviving program content. */
  providers: Provider[];
  /** True when the context + quick-filter combination matched no programs. */
  isEmpty: boolean;
}

/**
 * Discover feed boundary — docs/15 §5, docs/08 §8. The mock implementation
 * is deterministic; a real API client replaces it without touching screens.
 */
export interface DiscoverFeedService {
  getDiscoverFeed(input: DiscoverFeedInput): Promise<DiscoverFeed>;
  getQuickFilters(): QuickFilter[];
}
