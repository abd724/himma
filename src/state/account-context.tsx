import { entitlementsApi, resolveAccountScenario } from '@/services/composition';
import type { CalendarOccurrence, CustomerEntitlement } from '@/services/contracts/entitlements';
import type { AccountScenarioId, ResolvedAccount } from '@/services/contracts/schedule';
import { isAccountScenarioId } from '@/data/mock/schedule';
import { addDays, civilDate } from '@/features/calendar/calendar-presentation';
import { deriveRealAccount, GUEST_ACCOUNT } from '@/state/account-derivation';
import { useAuth } from '@/state/auth-context';
import { subscribeBookingsChanged } from '@/state/bookings-events';
import { useProfiles } from '@/state/profiles-context';
import { useGlobalSearchParams } from 'expo-router';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

/**
 * QA fixture selection — docs/19 §3: `?qa-scenario` → deterministic mock
 * account fixture. Review/QA only (established `?qa-*` pattern), compiled
 * out of production behavior by the `__DEV__` gate below. RI-1: without
 * the override, the account derives from REAL auth + participant truth
 * (account-derivation.ts) — guests are guests and authenticated accounts
 * carry their real PostgreSQL participants. RI-5: Home's schedule
 * surfaces derive from the SAME bounded unified Calendar read the
 * Calendar destination consumes, and active plans from the REAL
 * Entitlement family — one backend aggregation authority, never a second
 * client-side merge of bookings/passes/recurring rules.
 */
export function scenarioFromParam(value: unknown): AccountScenarioId | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && isAccountScenarioId(single) ? single : undefined;
}

/** Home's bounded schedule window: today through two weeks ahead (well
 *  inside the server's 62-day request maximum). */
export function homeScheduleWindow(now: Date = new Date()): { from: string; to: string } {
  const today = civilDate(now);
  return { from: today, to: addDays(today, 13) };
}

const AccountContext = createContext<ResolvedAccount | undefined>(undefined);

export function AccountProvider({ children }: PropsWithChildren) {
  const params = useGlobalSearchParams<{ 'qa-scenario'?: string }>();
  const fromParam = __DEV__ ? scenarioFromParam(params['qa-scenario']) : undefined;
  // First-valid-wins latch (see the QA note above): once a valid scenario
  // is latched it never changes for the provider's lifetime.
  const [scenario, setScenario] = useState(fromParam);
  if (scenario === undefined && fromParam !== undefined) {
    setScenario(fromParam);
  }

  const auth = useAuth();
  const profiles = useProfiles();

  // RI-5: Home's schedule/plan surfaces derive from the REAL bounded
  // Calendar read + Entitlement list — loaded per auth session and re-read
  // on booking-change signals (a confirmation/reservation bumps the
  // version; nothing optimistic).
  const [calendarEvents, setCalendarEvents] = useState<CalendarOccurrence[]>([]);
  const [entitlements, setEntitlements] = useState<CustomerEntitlement[]>([]);
  const [scheduleVersion, setScheduleVersion] = useState(0);
  useEffect(() => subscribeBookingsChanged(() => setScheduleVersion((v) => v + 1)), []);
  // Render-adjust (RI-1 pattern): leaving the authenticated state clears
  // the schedule immediately — a later sign-in can never flash another
  // session's schedule.
  const [lastAuthStatus, setLastAuthStatus] = useState(auth.status);
  if (lastAuthStatus !== auth.status) {
    setLastAuthStatus(auth.status);
    if (auth.status !== 'authenticated') {
      setCalendarEvents([]);
      setEntitlements([]);
    }
  }
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    let cancelled = false;
    entitlementsApi.listOccurrences(homeScheduleWindow()).then(
      (events) => {
        if (!cancelled) setCalendarEvents(events);
      },
      () => {
        // Unreachable backend: keep the last known truth; Home stays
        // truthful (it renders only what the server actually said).
      },
    );
    entitlementsApi.listEntitlements().then(
      (result) => {
        if (!cancelled) setEntitlements(result.entitlements);
      },
      () => {
        // Same posture as above.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [auth.status, scheduleVersion]);

  const value = useMemo<ResolvedAccount>(() => {
    if (scenario !== undefined) return resolveAccountScenario(scenario);
    if (auth.status !== 'authenticated') return GUEST_ACCOUNT;
    return deriveRealAccount(
      profiles.profiles,
      profiles.status === 'ready',
      calendarEvents,
      entitlements,
    );
  }, [scenario, auth.status, profiles.profiles, profiles.status, calendarEvents, entitlements]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): ResolvedAccount {
  const value = useContext(AccountContext);
  if (value === undefined) throw new Error('useAccount requires AccountProvider');
  return value;
}
