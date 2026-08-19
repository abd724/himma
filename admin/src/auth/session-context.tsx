import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminAuthAdapter, StepUpOutcome } from './adapter';
import {
  initialSessionState,
  sessionReducer,
  type AdminSessionState,
} from './session-machine';
import type { AdminAccessPort } from '../access/contract';

/**
 * Admin session orchestration: owns the state machine, drives the auth
 * adapter and the `/admin/me` access port, and exposes semantic actions.
 * All components read session truth from here — no scattered auth booleans.
 *
 * Admin-specific: the backend `admin` BASELINE never demands a recent
 * factor for ordinary bootstrap (W3-1 final owner decision) — a stale
 * factor still enters the shell. `stepUpRequired` remains the generic
 * seam for the future D-W3-5 action-level mechanism (and the degenerate
 * no-MFA-factor session); completing it (TOTP or recovery code)
 * re-resolves access authoritatively — the frontend never bypasses.
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

const SessionStateContext = createContext<AdminSessionState | null>(null);
const SessionActionsContext = createContext<SessionActions | null>(null);

export function SessionProvider({
  adapter,
  accessPort,
  initialState,
  children,
}: {
  adapter: AdminAuthAdapter;
  accessPort: AdminAccessPort;
  /** TEST-ONLY seam: start from a prepared state (never wired to config). */
  initialState?: AdminSessionState;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    sessionReducer,
    undefined,
    () => initialState ?? initialSessionState(),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  // Session end (sign-out OR expiry/revocation) clears every cached admin
  // read — no stale operational data survives the session that loaded it.
  const queryClient = useQueryClient();

  // Bootstrap while the machine is in its initial state (skipped when a
  // test provided a state). Guarded by the STATE, not a ref — safe under
  // StrictMode remount (the W2-12A lesson, preserved).
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
        queryClient.clear();
        dispatch({ type: 'SESSION_INTERRUPTED', interrupt });
        return;
      }
      void accessPort.resolveAccess().then((outcome) => {
        dispatch({ type: 'ACCESS_RESULT', outcome });
      });
    });
  }, [adapter, accessPort, queryClient]);

  const actions = useMemo<SessionActions>(() => {
    const finishStepUp = (outcome: StepUpOutcome) => {
      if (outcome.kind === 'completed') {
        dispatch({ type: 'STEP_UP_COMPLETED' });
      } else {
        dispatch({
          type: 'STEP_UP_FAILED',
          error:
            outcome.kind === 'invalidCode' || outcome.kind === 'challengeExpired'
              ? 'invalidCode'
              : outcome.kind === 'rateLimited'
                ? 'rateLimited'
                : 'failure',
        });
      }
      return outcome;
    };
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
        queryClient.clear();
        dispatch({ type: 'SIGN_OUT_COMPLETED' });
      },
      async completeStepUpTotp(code) {
        const current = stateRef.current;
        if (current.status === 'stepUpRequired') {
          if (current.submitting) {
            return { kind: 'failure' };
          }
          dispatch({ type: 'STEP_UP_SUBMITTED' });
        }
        return finishStepUp(await adapter.completeStepUpTotp(code));
      },
      async completeStepUpRecoveryCode(code) {
        const current = stateRef.current;
        if (current.status === 'stepUpRequired') {
          if (current.submitting) {
            return { kind: 'failure' };
          }
          dispatch({ type: 'STEP_UP_SUBMITTED' });
        }
        return finishStepUp(await adapter.completeStepUpRecoveryCode(code));
      },
    };
  }, [adapter, queryClient]);

  return (
    <SessionStateContext.Provider value={state}>
      <SessionActionsContext.Provider value={actions}>{children}</SessionActionsContext.Provider>
    </SessionStateContext.Provider>
  );
}

export function useSession(): AdminSessionState {
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
