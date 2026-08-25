/**
 * RI-1 — real authentication state (docs/34 §7 RI-1). Wraps the
 * AuthSession controller: restoration on launch, sign-in/sign-up/logout,
 * and the authenticated profile snapshot. There is NO frontend-only
 * authenticated state — every transition here is server-confirmed, and a
 * failed restore lands on guest (or keeps guest UI with a retry when the
 * backend is unreachable, without destroying stored session material).
 */
import { authSession } from '@/services/composition';
import type { CustomerProfile } from '@/services/contracts/identity';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';

export type AuthStatus = 'restoring' | 'guest' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  /** Present exactly when status === 'authenticated'. */
  profile: CustomerProfile | null;
  userId: string | null;
  accountId: string | null;
  /** True when launch restoration failed because the backend was unreachable. */
  restoreUnavailable: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: { email: string; password: string; displayName?: string }): Promise<void>;
  logout(): Promise<void>;
  retryRestore(): void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [restoreUnavailable, setRestoreUnavailable] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  // `status` starts at 'restoring'; retries reset it in the retry handler,
  // so the effect itself performs no synchronous state writes.
  useEffect(() => {
    let cancelled = false;
    authSession.restore().then(
      (snapshot) => {
        if (cancelled) return;
        if (snapshot === null) {
          setStatus('guest');
          setProfile(null);
          setUserId(null);
          setAccountId(null);
        } else {
          setProfile(snapshot.profile);
          setUserId(snapshot.userId);
          setAccountId(snapshot.accountId ?? null);
          setStatus('authenticated');
        }
      },
      () => {
        // Backend unreachable at launch: guest UI with retry; the stored
        // session material is retained for the next attempt.
        if (cancelled) return;
        setStatus('guest');
        setRestoreUnavailable(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [restoreAttempt]);

  const applySnapshot = useCallback(
    (snapshot: { userId: string; accountId?: string; profile: CustomerProfile }) => {
      setProfile(snapshot.profile);
      setUserId(snapshot.userId);
      setAccountId(snapshot.accountId ?? null);
      setStatus('authenticated');
      setRestoreUnavailable(false);
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      profile,
      userId,
      accountId,
      restoreUnavailable,
      async signIn(email, password) {
        applySnapshot(await authSession.signIn(email, password));
      },
      async signUp(input) {
        applySnapshot(await authSession.signUp(input));
      },
      async logout() {
        await authSession.logout();
        setProfile(null);
        setUserId(null);
        setAccountId(null);
        setStatus('guest');
      },
      retryRestore() {
        setStatus('restoring');
        setRestoreUnavailable(false);
        setRestoreAttempt((attempt) => attempt + 1);
      },
    }),
    [status, profile, userId, accountId, restoreUnavailable, applySnapshot],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === undefined) throw new Error('useAuth requires AuthProvider');
  return value;
}
