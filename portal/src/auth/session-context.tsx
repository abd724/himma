import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { PortalAuthAdapter, StepUpOutcome } from './adapter';
import {
  initialSessionState,
  sessionReducer,
  type PortalSessionState,
} from './session-machine';
import type { ProviderAccessPort } from '../provider-access/contract';

/**
 * Session orchestration: owns the state machine, drives the auth adapter and
 * provider-access port, and exposes semantic actions. All components read
 * session truth from here — no scattered auth booleans anywhere else.
 */

export interface SessionActions {
  signIn(input: { email: string; password: string }): Promise<void>;
  completeMfa(code: string): Promise<void>;
  cancelMfa(): Promise<void>;
  retryAccess(): void;
  signOut(): Promise<void>;
  completeStepUpTotp(code: string): Promise<StepUpOutcome>;
  completeStepUpRecoveryCode(code: string): Promise<StepUpOutcome>;
}

const SessionStateContext = createContext<PortalSessionState | null>(null);
const SessionActionsContext = createContext<SessionActions | null>(null);

export function SessionProvider({
  adapter,
  accessPort,
  initialState,
  children,
}: {
  adapter: PortalAuthAdapter;
  accessPort: ProviderAccessPort;
  /** TEST-ONLY seam: start from a prepared state (never wired to config). */
  initialState?: PortalSessionState;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    sessionReducer,
    undefined,
    () => initialState ?? initialSessionState(),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  // Bootstrap while the machine is in its initial state (skipped when a
  // test provided a state). Guarded by the STATE, not a ref: bootstrap is a
  // read-only resolution, so re-running after React's dev-mode StrictMode
  // unmount/remount cycle is safe — a once-only ref here left the first
  // (cancelled) run as the only attempt and dev builds stuck on the
  // bootstrap screen forever.
  useEffect(() => {
    if (stateRef.current.status !== 'bootstrapping') {
      return;
    }
    let cancelled = false;
    void adapter.bootstrap().then((outcome) => {
      if (!cancelled) {
        dispatch({ type: 'BOOTSTRAP_RESULT', outcome });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  // Entering resolvingAccess always triggers exactly one resolution attempt.
  useEffect(() => {
    if (state.status !== 'resolvingAccess') {
      return;
    }
    let cancelled = false;
    void accessPort.resolveAccess().then((outcome) => {
      if (!cancelled) {
        dispatch({ type: 'ACCESS_RESULT', outcome });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [state, accessPort]);

  // Session interrupts pushed from outside the UI (expiry, access changes).
  useEffect(() => {
    return adapter.subscribe((interrupt) => {
      if (interrupt.kind === 'sessionExpired') {
        dispatch({ type: 'SESSION_INTERRUPTED', interrupt });
        return;
      }
      void accessPort.resolveAccess().then((outcome) => {
        dispatch({ type: 'ACCESS_RESULT', outcome });
      });
    });
  }, [adapter, accessPort]);

  const actions = useMemo<SessionActions>(() => {
    return {
      async signIn(input) {
        if (stateRef.current.status !== 'signedOut') {
          return;
        }
        dispatch({ type: 'SIGN_IN_SUBMITTED' });
        const outcome = await adapter.signIn(input);
        dispatch({ type: 'SIGN_IN_RESULT', outcome });
      },
      async completeMfa(code) {
        const current = stateRef.current;
        if (current.status !== 'mfaChallenge' || current.submitting) {
          return;
        }
        dispatch({ type: 'MFA_SUBMITTED' });
        const outcome = await adapter.completeMfaChallenge(code);
        dispatch({ type: 'MFA_RESULT', outcome });
      },
      async cancelMfa() {
        await adapter.cancelMfaChallenge();
        dispatch({ type: 'MFA_CANCELLED' });
      },
      retryAccess() {
        dispatch({ type: 'ACCESS_RETRY' });
      },
      async signOut() {
        await adapter.signOut();
        dispatch({ type: 'SIGN_OUT_COMPLETED' });
      },
      async completeStepUpTotp(code) {
        const outcome = await adapter.completeStepUpTotp(code);
        if (outcome.kind === 'completed') {
          dispatch({ type: 'STEP_UP_COMPLETED', expiresAt: outcome.expiresAt });
        }
        return outcome;
      },
      async completeStepUpRecoveryCode(code) {
        const outcome = await adapter.completeStepUpRecoveryCode(code);
        if (outcome.kind === 'completed') {
          dispatch({ type: 'STEP_UP_COMPLETED', expiresAt: outcome.expiresAt });
        }
        return outcome;
      },
    };
  }, [adapter]);

  return (
    <SessionStateContext.Provider value={state}>
      <SessionActionsContext.Provider value={actions}>{children}</SessionActionsContext.Provider>
    </SessionStateContext.Provider>
  );
}

export function useSession(): PortalSessionState {
  const state = useContext(SessionStateContext);
  if (state === null) {
    throw new Error('useSession requires SessionProvider');
  }
  return state;
}

export function useSessionActions(): SessionActions {
  const actions = useContext(SessionActionsContext);
  if (actions === null) {
    throw new Error('useSessionActions requires SessionProvider');
  }
  return actions;
}
