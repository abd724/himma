import {
  activeFilterCount,
  emptyFilters,
  type FilterSelection,
  type SortId,
} from '@/services/contracts/filters';
import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

export type ResultsTab = 'all' | 'programs' | 'providers' | 'categories';

interface ResultsSessionState {
  query: string;
  tab: ResultsTab;
  filters: FilterSelection;
  sort: SortId;
  page: number;
  /** True once any surface has opened a results session (search or preset). */
  started: boolean;
}

interface ResultsSessionValue extends ResultsSessionState {
  activeCount: number;
  /** A new submitted search resets filters, sort, and pagination (docs/16 §3.8). */
  newSearch: (query: string, tab: ResultsTab) => void;
  setTab: (tab: ResultsTab) => void;
  setFilters: (filters: FilterSelection) => void;
  patchFilters: (patch: Partial<FilterSelection>) => void;
  clearFilters: () => void;
  setSort: (sort: SortId) => void;
  loadMore: () => void;
}

const initialState: ResultsSessionState = {
  query: '',
  tab: 'all',
  filters: emptyFilters,
  sort: 'recommended',
  page: 1,
  started: false,
};

const ResultsSessionContext = createContext<ResultsSessionValue | undefined>(undefined);

/**
 * One active results session shared by the Results list, quick chips, the
 * filter/sort sheets, and the future map mode — docs/16 §3.1, docs/17 §6.
 * Tab switching, filtering, and sorting retain the session; only a new
 * search resets it.
 */
export function ResultsSessionProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<ResultsSessionState>(initialState);

  const value = useMemo<ResultsSessionValue>(
    () => ({
      ...state,
      activeCount: activeFilterCount(state.filters),
      newSearch: (query, tab) =>
        setState({ query, tab, filters: emptyFilters, sort: 'recommended', page: 1, started: true }),
      setTab: (tab) => setState((current) => ({ ...current, tab })),
      setFilters: (filters) => setState((current) => ({ ...current, filters, page: 1 })),
      patchFilters: (patch) =>
        setState((current) => ({ ...current, filters: { ...current.filters, ...patch }, page: 1 })),
      clearFilters: () => setState((current) => ({ ...current, filters: emptyFilters, page: 1 })),
      setSort: (sort) => setState((current) => ({ ...current, sort, page: 1 })),
      loadMore: () => setState((current) => ({ ...current, page: current.page + 1 })),
    }),
    [state],
  );

  return <ResultsSessionContext.Provider value={value}>{children}</ResultsSessionContext.Provider>;
}

export function useResultsSession(): ResultsSessionValue {
  const value = useContext(ResultsSessionContext);
  if (value === undefined) throw new Error('useResultsSession requires ResultsSessionProvider');
  return value;
}
