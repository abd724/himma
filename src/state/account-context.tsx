import { DEFAULT_ACCOUNT_SCENARIO, isAccountScenarioId } from '@/data/mock/schedule';
import type { AccountScenarioId, ResolvedAccount } from '@/services/contracts/schedule';
import { resolveAccountScenario } from '@/services/mock/mock-schedule-service';
import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

/**
 * QA fixture selection — docs/19 §3: `?qa-scenario` → deterministic mock
 * account fixture → resolved account data. Review/QA only (established
 * `?qa-*` pattern); native and default web builds use the demo household.
 */
export function initialScenarioFromSearch(search: string | undefined): AccountScenarioId {
  if (search === undefined || search === '') return DEFAULT_ACCOUNT_SCENARIO;
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(
    'qa-scenario',
  );
  return value !== null && isAccountScenarioId(value) ? value : DEFAULT_ACCOUNT_SCENARIO;
}

function initialScenario(): AccountScenarioId {
  // Web-only initial-URL read, guarded so native stays safe (docs/12 §3).
  if (typeof window !== 'undefined' && typeof window.location?.search === 'string') {
    return initialScenarioFromSearch(window.location.search);
  }
  return DEFAULT_ACCOUNT_SCENARIO;
}

const AccountContext = createContext<ResolvedAccount | undefined>(undefined);

/**
 * The signed-in account's resolved data — participants, schedule entries,
 * active plans, credit (docs/18 §3, docs/19 §3). Everything downstream
 * consumes this data; scenario ids never drive feed or screen logic.
 */
export function AccountProvider({ children }: PropsWithChildren) {
  const value = useMemo(() => resolveAccountScenario(initialScenario()), []);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): ResolvedAccount {
  const value = useContext(AccountContext);
  if (value === undefined) throw new Error('useAccount requires AccountProvider');
  return value;
}
