import type {
  BootstrapOutcome,
  MfaChallengeOutcome,
  SessionAssurance,
  SessionIdentity,
  SessionInterrupt,
  SignInOutcome,
} from './adapter';
import type { AdminAccess, AdminAccessOutcome } from '../access/contract';

/**
 * The one explicit admin access/session state model — a pure reducer over
 * semantic adapter outcomes (the W2-2/W2-12A pattern, admin-shaped).
 * Impossible combinations return the state unchanged.
 *
 * Admin-specific truths:
 * - access comes ONLY from `GET /admin/me`; `noAdminAccess` is a valid
 *   authenticated end-state (customer/provider identities land there and
 *   learn nothing else);
 * - ordinary bootstrap NEVER demands step-up (W3-1 final owner decision:
 *   the `admin` baseline requires MFA assurance, not factor recency).
 *   `stepUpRequired` is retained as the generic SEAM — the future D-W3-5
 *   action-level mechanism, plus the degenerate session holding no
 *   MFA-verified factor at all — and completing it re-resolves access
 *   authoritatively (never a bypass).
 */

export type SignInError =
  | 'invalidCredentials'
  | 'accountSuspended'
  | 'rateLimited'
  | 'providerUnavailable'
  | 'challengeExpired'
  | 'failure';

export type MfaError = 'invalidCode' | 'rateLimited' | 'failure';

export type SignedOutReason = 'initial' | 'signedOut' | 'sessionExpired';

export type AdminSessionState =
  | { status: 'bootstrapping' }
  /** Auth not configured/available in this environment — fail closed. */
  | { status: 'unavailable' }
  | { status: 'signedOut'; reason: SignedOutReason; signInError: SignInError | null }
  | { status: 'authenticating' }
  | { status: 'mfaChallenge'; submitting: boolean; error: MfaError | null }
  | { status: 'resolvingAccess'; assurance: SessionAssurance; identity: SessionIdentity }
  | {
      status: 'active';
      assurance: SessionAssurance;
      identity: SessionIdentity;
      access: AdminAccess;
    }
  /** Authenticated but holding NO active admin role — denied, truthfully. */
  | { status: 'noAdminAccess'; assurance: SessionAssurance; identity: SessionIdentity }
  /** The retained step-up SEAM: a future action-level demand (D-W3-5) or
   *  a session with no MFA-verified factor — never ordinary bootstrap. */
  | {
      status: 'stepUpRequired';
      assurance: SessionAssurance;
      identity: SessionIdentity;
      submitting: boolean;
      error: MfaError | null;
    }
  | { status: 'accessUnavailable'; assurance: SessionAssurance; identity: SessionIdentity };

export type SessionEvent =
  | { type: 'BOOTSTRAP_RESULT'; outcome: BootstrapOutcome }
  | { type: 'SIGN_IN_SUBMITTED' }
  | { type: 'SIGN_IN_RESULT'; outcome: SignInOutcome }
  | { type: 'MFA_SUBMITTED' }
  | { type: 'MFA_RESULT'; outcome: MfaChallengeOutcome }
  | { type: 'MFA_CANCELLED' }
  | { type: 'ACCESS_RESULT'; outcome: AdminAccessOutcome }
  | { type: 'ACCESS_RETRY' }
  | { type: 'STEP_UP_SUBMITTED' }
  | { type: 'STEP_UP_FAILED'; error: MfaError }
  | { type: 'STEP_UP_COMPLETED' }
  | { type: 'SESSION_INTERRUPTED'; interrupt: SessionInterrupt }
  | { type: 'SIGN_OUT_COMPLETED' };

export function initialSessionState(): AdminSessionState {
  return { status: 'bootstrapping' };
}

function signedOut(
  reason: SignedOutReason,
  signInError: SignInError | null = null,
): AdminSessionState {
  return { status: 'signedOut', reason, signInError };
}

function accessFrom(
  session: { assurance: SessionAssurance; identity: SessionIdentity },
  outcome: AdminAccessOutcome,
): AdminSessionState {
  switch (outcome.kind) {
    case 'resolved':
      return {
        status: 'active',
        assurance: session.assurance,
        identity: session.identity,
        access: outcome.access,
      };
    case 'noAccess':
      return { status: 'noAdminAccess', assurance: session.assurance, identity: session.identity };
    case 'stepUpRequired':
      return {
        status: 'stepUpRequired',
        assurance: session.assurance,
        identity: session.identity,
        submitting: false,
        error: null,
      };
    case 'unavailable':
      return {
        status: 'accessUnavailable',
        assurance: session.assurance,
        identity: session.identity,
      };
  }
}

const AUTHENTICATED_STATUSES = new Set([
  'resolvingAccess',
  'active',
  'noAdminAccess',
  'stepUpRequired',
  'accessUnavailable',
]);

export function sessionReducer(state: AdminSessionState, event: SessionEvent): AdminSessionState {
  switch (event.type) {
    case 'BOOTSTRAP_RESULT': {
      if (state.status !== 'bootstrapping') {
        return state;
      }
      switch (event.outcome.kind) {
        case 'noSession':
          return signedOut('initial');
        case 'unavailable':
          return { status: 'unavailable' };
        case 'session':
          return {
            status: 'resolvingAccess',
            assurance: event.outcome.assurance,
            identity: event.outcome.identity,
          };
      }
      return state;
    }

    case 'SIGN_IN_SUBMITTED':
      return state.status === 'signedOut' ? { status: 'authenticating' } : state;

    case 'SIGN_IN_RESULT': {
      if (state.status !== 'authenticating') {
        return state;
      }
      switch (event.outcome.kind) {
        case 'signedIn':
          return {
            status: 'resolvingAccess',
            assurance: event.outcome.assurance,
            identity: event.outcome.identity,
          };
        case 'mfaChallenge':
          return { status: 'mfaChallenge', submitting: false, error: null };
        default:
          return signedOut('initial', event.outcome.kind);
      }
    }

    case 'MFA_SUBMITTED':
      return state.status === 'mfaChallenge' && !state.submitting
        ? { ...state, submitting: true, error: null }
        : state;

    case 'MFA_RESULT': {
      if (state.status !== 'mfaChallenge') {
        return state;
      }
      switch (event.outcome.kind) {
        case 'signedIn':
          return {
            status: 'resolvingAccess',
            assurance: event.outcome.assurance,
            identity: event.outcome.identity,
          };
        case 'challengeExpired':
          return signedOut('initial', 'challengeExpired');
        default:
          return { status: 'mfaChallenge', submitting: false, error: event.outcome.kind };
      }
    }

    case 'MFA_CANCELLED':
      return state.status === 'mfaChallenge' ? signedOut('initial') : state;

    case 'ACCESS_RESULT': {
      // Valid in every authenticated state: access re-resolves in BOTH
      // directions (a revoked final role → noAdminAccess; a fresh factor
      // after stepUpRequired → active).
      if (AUTHENTICATED_STATUSES.has(state.status) && state.status !== 'bootstrapping') {
        const session = state as { assurance: SessionAssurance; identity: SessionIdentity };
        return accessFrom(session, event.outcome);
      }
      return state;
    }

    case 'ACCESS_RETRY':
      return state.status === 'accessUnavailable'
        ? { status: 'resolvingAccess', assurance: state.assurance, identity: state.identity }
        : state;

    case 'STEP_UP_SUBMITTED':
      return state.status === 'stepUpRequired' && !state.submitting
        ? { ...state, submitting: true, error: null }
        : state;

    case 'STEP_UP_FAILED':
      return state.status === 'stepUpRequired'
        ? { ...state, submitting: false, error: event.error }
        : state;

    case 'STEP_UP_COMPLETED':
      // A fresh recent factor exists — resolve access again authoritatively.
      return state.status === 'stepUpRequired'
        ? { status: 'resolvingAccess', assurance: state.assurance, identity: state.identity }
        : state;

    case 'SESSION_INTERRUPTED': {
      if (event.interrupt.kind === 'sessionExpired') {
        return AUTHENTICATED_STATUSES.has(state.status) ? signedOut('sessionExpired') : state;
      }
      return state;
    }

    case 'SIGN_OUT_COMPLETED':
      return AUTHENTICATED_STATUSES.has(state.status) || state.status === 'mfaChallenge'
        ? signedOut('signedOut')
        : state;
  }
}
