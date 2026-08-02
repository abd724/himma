import type { FilterSelection, SortId } from '@/services/contracts/filters';
import type {
  AreaId,
  BrowseEntry,
  Category,
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
  totalPrograms: number;
  hasMorePrograms: boolean;
  providers: Provider[];
  totalProviders: number;
  hasMoreProviders: boolean;
  categories: Category[];
  correctedQuery?: string;
}

export interface SearchService {
  getPreSearchContent(): PreSearchContent;
  addRecentSearch(query: string): void;
  clearRecentSearches(): void;
  getSuggestions(input: SearchInput): SearchSuggestion[];
  search(input: SearchInput): SearchResultSet;
  /** Filtered, sorted, paginated results — async like a future API. */
  getResults(query: ResultsQuery): Promise<ResultsPage>;
  /** Live deterministic count for the filter sheet footer. */
  countResults(query: Omit<ResultsQuery, 'page' | 'sort'>): number;
}
