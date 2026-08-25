import type { QuickFilter, QuickFilterId } from '@/services/contracts/filters';
import type {
  AreaId,
  BrowseEntry,
  Collection,
  Participant,
  ParticipantId,
  Program,
  Provider,
} from '@/types/domain';

export interface DiscoverFeedInput {
  areaId: AreaId;
  participantId: ParticipantId;
  quickFilterId?: QuickFilterId;
  /**
   * The account's FULL child-profile composition — docs/18 §6 gate input.
   * Never derived from the selected browsing participant (owner caution,
   * 2026-08-03): composition decides whether child-focused collections are
   * eligible for promoted placement; the browsing participant only filters
   * and ranks the content shown. `null` = guest/no account (gate off,
   * docs/18 §18 assumption); `[]` = signed-in with no child profiles.
   */
  childParticipants: Participant[] | null;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
}

/** A collection with its deterministic result count for the active context. */
export interface CollectionSummary {
  collection: Collection;
  /** Programs its preset resolves to; absent when not exactly known. */
  programCount?: number;
}

/** 'new' = published recency (the only real ranking authority); 'trending'
 *  and 'available-today' are mock-only (no popularity/schedule authority
 *  exists) and never emitted by the real feed. */
export type DiscoverSectionId = 'trending' | 'available-today' | 'offers-trials' | 'new';

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
