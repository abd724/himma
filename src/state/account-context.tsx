import { DEFAULT_ACCOUNT_SCENARIO, isAccountScenarioId } from '@/data/mock/schedule';
import type { AccountScenarioId, ResolvedAccount } from '@/services/contracts/schedule';
import { resolveAccountScenario } from '@/services/mock/mock-schedule-service';
import { useGlobalSearchParams } from 'expo-router';
import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

/**
 * QA fixture selection — docs/19 §3: `?qa-scenario` → deterministic mock
 * account fixture → resolved account data. Review/QA only (established
 * `?qa-*` pattern); the read is an Expo Router param, so it works identically
 * on web URLs and native deep links, and is compiled out of production
 * behavior by the `__DEV__` gate at the capture site.
 */
export function scenarioFromParam(value: unknown): AccountScenarioId | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && isAccountScenarioId(single) ? single : undefined;
}

const AccountContext = createContext<ResolvedAccount | undefined>(undefined);

/**
 * The signed-in account's resolved data — participants, schedule entries,
 * active plans, credit (docs/18 §3, docs/19 §3). Everything downstream
 * consumes this data; scenario ids never drive feed or screen logic.
 *
 * The scenario is captured once at provider mount (dev builds only) and kept
 * for the provider's lifetime — later navigation never switches the account,
 * exactly like the previous initial-URL capture.
 */
export function AccountProvider({ children }: PropsWithChildren) {
  const params = useGlobalSearchParams<{ 'qa-scenario'?: string }>();
  const fromParam = __DEV__ ? scenarioFromParam(params['qa-scenario']) : undefined;
  // First-valid-wins latch: navigation state hydrates a render after mount
  // on native, so a mount-time capture would miss cold deep links. Once a
  // valid scenario is latched it never changes for the provider's lifetime —
  // later navigation cannot switch the account, like the previous
  // initial-URL capture.
  const [scenario, setScenario] = useState(fromParam);
  if (scenario === undefined && fromParam !== undefined) {
    setScenario(fromParam);
  }
  const value = useMemo(
    () => resolveAccountScenario(scenario ?? DEFAULT_ACCOUNT_SCENARIO),
    [scenario],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): ResolvedAccount {
  const value = useContext(AccountContext);
  if (value === undefined) throw new Error('useAccount requires AccountProvider');
  return value;
}
