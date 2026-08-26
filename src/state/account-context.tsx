import { commerceApi, resolveAccountScenario } from '@/services/composition';
import type { CustomerBooking } from '@/services/contracts/commerce';
import type { AccountScenarioId, ResolvedAccount } from '@/services/contracts/schedule';
import { isAccountScenarioId } from '@/data/mock/schedule';
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
 * (account-derivation.ts) — guests are guests, authenticated accounts
 * carry their real PostgreSQL participants, and schedule surfaces stay
 * truthfully empty until the RI-3/RI-5 real reads.
 */
export function scenarioFromParam(value: unknown): AccountScenarioId | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && isAccountScenarioId(single) ? single : undefined;
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

  // RI-3: Home's schedule surfaces derive from REAL confirmed bookings —
  // loaded per auth session and re-read on booking-change signals (a
  // confirmation bumps the version; nothing optimistic).
  const [bookings, setBookings] = useState<CustomerBooking[]>([]);
  const [bookingsVersion, setBookingsVersion] = useState(0);
  useEffect(() => subscribeBookingsChanged(() => setBookingsVersion((v) => v + 1)), []);
  // Render-adjust (RI-1 pattern): leaving the authenticated state clears
  // the booking list immediately — a later sign-in can never flash another
  // session's bookings.
  const [lastAuthStatus, setLastAuthStatus] = useState(auth.status);
  if (lastAuthStatus !== auth.status) {
    setLastAuthStatus(auth.status);
    if (auth.status !== 'authenticated') setBookings([]);
  }
  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    let cancelled = false;
    commerceApi.listBookings({ limit: 50 }).then(
      (result) => {
        if (!cancelled) setBookings(result.bookings);
      },
      () => {
        // Unreachable backend: keep the last known list; Home stays
        // truthful (it renders only what the server actually said).
      },
    );
    return () => {
      cancelled = true;
    };
  }, [auth.status, bookingsVersion]);

  const value = useMemo<ResolvedAccount>(() => {
    if (scenario !== undefined) return resolveAccountScenario(scenario);
    if (auth.status !== 'authenticated') return GUEST_ACCOUNT;
    return deriveRealAccount(profiles.profiles, profiles.status === 'ready', bookings);
  }, [scenario, auth.status, profiles.profiles, profiles.status, bookings]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): ResolvedAccount {
  const value = useContext(AccountContext);
  if (value === undefined) throw new Error('useAccount requires AccountProvider');
  return value;
}
