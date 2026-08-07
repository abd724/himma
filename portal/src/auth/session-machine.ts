import type {
  BootstrapOutcome,
  MfaChallengeOutcome,
  SessionAssurance,
  SessionIdentity,
  SessionInterrupt,
  SignInOutcome,
} from './adapter';
import type { ProviderAccessOutcome, ProviderMembership } from '../provider-access/contract';

/**
 * The one explicit frontend access/session state model (task §5) — a pure
 * reducer over semantic adapter outcomes. Impossible combinations return the
 * state unchanged, so no scattered booleans can drift apart.
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

export type PortalSessionState =
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
      memberships: readonly ProviderMembership[];
      stepUpExpiresAt: string | null;
    }
  | { status: 'noMembership'; assurance: SessionAssurance; identity: SessionIdentity }
  | { status: 'accessUnavailable'; assurance: SessionAssurance; identity: SessionIdentity };

export type SessionEvent =
  | { type: 'BOOTSTRAP_RESULT'; outcome: BootstrapOutcome }
  | { type: 'SIGN_IN_SUBMITTED' }
  | { type: 'SIGN_IN_RESULT'; outcome: SignInOutcome }
  | { type: 'MFA_SUBMITTED' }
  | { type: 'MFA_RESULT'; outcome: MfaChallengeOutcome }
  | { type: 'MFA_CANCELLED' }
  | { type: 'ACCESS_RESULT'; outcome: ProviderAccessOutcome }
  | { type: 'ACCESS_RETRY' }
  | { type: 'SESSION_INTERRUPTED'; interrupt: SessionInterrupt }
  | { type: 'SIGN_OUT_COMPLETED' }
  | { type: 'STEP_UP_COMPLETED'; expiresAt: string };

export function initialSessionState(): PortalSessionState {
  return { status: 'bootstrapping' };
}

function signedOut(reason: SignedOutReason, signInError: SignInError | null = null): PortalSessionState {
  return { status: 'signedOut', reason, signInError };
}

function accessFrom(
  session: { assurance: SessionAssurance; identity: SessionIdentity },
  outcome: ProviderAccessOutcome,
): PortalSessionState {
  if (outcome.kind === 'unavailable') {
    return { status: 'accessUnavailable', assurance: session.assurance, identity: session.identity };
  }
  if (outcome.memberships.length === 0) {
    return { status: 'noMembership', assurance: session.assurance, identity: session.identity };
  }
  return {
    status: 'active',
    assurance: session.assurance,
    identity: session.identity,
    memberships: outcome.memberships,
    stepUpExpiresAt: null,
  };
}

const AUTHENTICATED_STATUSES = new Set([
  'resolvingAccess',
  'active',
  'noMembership',
  'accessUnavailable',
]);

export function sessionReducer(
  state: PortalSessionState,
  event: SessionEvent,
): PortalSessionState {
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
      // Valid in every authenticated state: access can be re-resolved after
      // membership changes in BOTH directions (revocation → noMembership,
      // invitation acceptance → active again).
      if (
        state.status === 'resolvingAccess' ||
        state.status === 'active' ||
        state.status === 'noMembership' ||
        state.status === 'accessUnavailable'
      ) {
        return accessFrom(state, event.outcome);
      }
      return state;
    }

    case 'ACCESS_RETRY':
      return state.status === 'accessUnavailable'
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

    case 'STEP_UP_COMPLETED':
      return state.status === 'active' ? { ...state, stepUpExpiresAt: event.expiresAt } : state;
  }
}
