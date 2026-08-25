import type { FilterSelection, SortId } from '@/services/contracts/filters';
import type {
  AreaId,
  BrowseEntry,
  Category,
  Participant,
  ParticipantId,
  Program,
  Provider,
} from '@/types/domain';

export type SuggestionKind = 'activity' | 'provider' | 'category' | 'area';

export interface SearchSuggestion {
  /** Unique row id (kinds may share entity ids across tables). */
  id: string;
  kind: SuggestionKind;
  label: string;
  /** Secondary context, e.g. the category of an activity type. */
  sublabel?: string;
  /** Query submitted when the row is tapped. */
  query: string;
  /** Entity id for direct routing once destination screens exist. */
  targetId: string;
}

export interface PreSearchContent {
  recentSearches: string[];
  popularSearches: string[];
  categoryShortcuts: BrowseEntry[];
}

export interface SearchInput {
  query: string;
  participantId: ParticipantId;
  /**
   * The selected browsing participant object. A child context becomes a
   * truthful server-side age filter (public programme metadata — owner
   * guest-filtering rule); adults are never filtered. Absent/`everyone`
   * applies no personal narrowing.
   */
  participant?: Participant;
  areaId: AreaId;
}

export interface SearchResultSet {
  programs: Program[];
  providers: Provider[];
  categories: Category[];
  /** Set when curated typo correction changed the effective query. */
  correctedQuery?: string;
}

/**
 * Search boundary — docs/14 §3, docs/17 §8. Deterministic mock over the
 * shared catalogue; a real search backend replaces it without touching
 * screens. Ranking follows docs/14 §3.3: personalization ranks, it never
 * silently hides household-relevant content; only a child context hard-
 * excludes out-of-age-range programs. No gender-based filtering happens
 * here — Ladies only is an explicit filter (Commit 4).
 */
export interface ResultsQuery extends SearchInput {
  filters: FilterSelection;
  sort: SortId;
  /** 1-based page for the Programs/Providers lists. */
  page: number;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
}

export interface ResultsPage {
  programs: Program[];
  /** Absent when the backend has more pages — totals are shown only when
   *  exact, never estimated (real composition). */
  totalPrograms?: number;
  hasMorePrograms: boolean;
  providers: Provider[];
  totalProviders?: number;
  hasMoreProviders: boolean;
  categories: Category[];
  correctedQuery?: string;
}

export interface SearchService {
  getPreSearchContent(): Promise<PreSearchContent>;
  addRecentSearch(query: string): void;
  clearRecentSearches(): void;
  getSuggestions(input: SearchInput): Promise<SearchSuggestion[]>;
  /** Filtered, sorted, paginated results. */
  getResults(query: ResultsQuery): Promise<ResultsPage>;
}
