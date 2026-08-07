import type { PortalSessionState } from '../src/auth/session-machine';
import { initialSessionState, sessionReducer } from '../src/auth/session-machine';
import type { ProviderMembership } from '../src/provider-access/contract';

const identity = { email: 'owner@bluewave.demo', displayName: 'Rana Haddad' };
const membership: ProviderMembership = {
  organizationId: 'org-1',
  displayName: 'Blue Wave Swimming',
  role: 'owner',
  branchScope: 'all',
  organizationState: 'live',
};

function authenticated(): PortalSessionState {
  let state = initialSessionState();
  state = sessionReducer(state, {
    type: 'BOOTSTRAP_RESULT',
    outcome: { kind: 'session', assurance: 'mfa', identity },
  });
  return sessionReducer(state, {
    type: 'ACCESS_RESULT',
    outcome: { kind: 'resolved', memberships: [membership] },
  });
}

describe('session state machine', () => {
  test('starts bootstrapping and resolves a no-session bootstrap to signed out', () => {
    let state = initialSessionState();
    expect(state.status).toBe('bootstrapping');
    state = sessionReducer(state, { type: 'BOOTSTRAP_RESULT', outcome: { kind: 'noSession' } });
    expect(state).toEqual({
      status: 'signedOut',
      reason: 'initial',
      signInError: null,
    });
  });

  test('an unavailable bootstrap fails closed', () => {
    const state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'unavailable' },
    });
    expect(state.status).toBe('unavailable');
  });

  test('an existing session bootstrap moves to access resolution, never straight to active', () => {
    const state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'session', assurance: 'mfa', identity },
    });
    expect(state).toEqual({ status: 'resolvingAccess', assurance: 'mfa', identity });
  });

  test('sign-in submission and rejection round-trip', () => {
    let state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'noSession' },
    });
    state = sessionReducer(state, { type: 'SIGN_IN_SUBMITTED' });
    expect(state.status).toBe('authenticating');
    state = sessionReducer(state, {
      type: 'SIGN_IN_RESULT',
      outcome: { kind: 'invalidCredentials' },
    });
    expect(state).toEqual({
      status: 'signedOut',
      reason: 'initial',
      signInError: 'invalidCredentials',
    });
  });

  test('duplicate submission is structurally impossible (submitting state ignores submits)', () => {
    let state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'noSession' },
    });
    state = sessionReducer(state, { type: 'SIGN_IN_SUBMITTED' });
    const again = sessionReducer(state, { type: 'SIGN_IN_SUBMITTED' });
    expect(again).toBe(state);
  });

  test('MFA challenge path: challenge → submit → invalid → retry → verified → resolving access', () => {
    let state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'noSession' },
    });
    state = sessionReducer(state, { type: 'SIGN_IN_SUBMITTED' });
    state = sessionReducer(state, { type: 'SIGN_IN_RESULT', outcome: { kind: 'mfaChallenge' } });
    expect(state).toEqual({ status: 'mfaChallenge', submitting: false, error: null });

    state = sessionReducer(state, { type: 'MFA_SUBMITTED' });
    expect(state).toEqual({ status: 'mfaChallenge', submitting: true, error: null });

    state = sessionReducer(state, { type: 'MFA_RESULT', outcome: { kind: 'invalidCode' } });
    expect(state).toEqual({ status: 'mfaChallenge', submitting: false, error: 'invalidCode' });

    state = sessionReducer(state, { type: 'MFA_SUBMITTED' });
    state = sessionReducer(state, {
      type: 'MFA_RESULT',
      outcome: { kind: 'signedIn', assurance: 'mfa', identity },
    });
    expect(state).toEqual({ status: 'resolvingAccess', assurance: 'mfa', identity });
  });

  test('an expired login challenge restarts sign-in with its own explanation', () => {
    let state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'noSession' },
    });
    state = sessionReducer(state, { type: 'SIGN_IN_SUBMITTED' });
    state = sessionReducer(state, { type: 'SIGN_IN_RESULT', outcome: { kind: 'mfaChallenge' } });
    state = sessionReducer(state, { type: 'MFA_SUBMITTED' });
    state = sessionReducer(state, { type: 'MFA_RESULT', outcome: { kind: 'challengeExpired' } });
    expect(state).toEqual({
      status: 'signedOut',
      reason: 'initial',
      signInError: 'challengeExpired',
    });
  });

  test('cancelling the MFA challenge returns to signed out without a session', () => {
    let state = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'noSession' },
    });
    state = sessionReducer(state, { type: 'SIGN_IN_SUBMITTED' });
    state = sessionReducer(state, { type: 'SIGN_IN_RESULT', outcome: { kind: 'mfaChallenge' } });
    state = sessionReducer(state, { type: 'MFA_CANCELLED' });
    expect(state).toEqual({ status: 'signedOut', reason: 'initial', signInError: null });
  });

  test('access resolution: memberships → active; empty → noMembership; failure → accessUnavailable with retry', () => {
    const base = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'session', assurance: 'mfa', identity },
    });

    const active = sessionReducer(base, {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'resolved', memberships: [membership] },
    });
    expect(active).toMatchObject({
      status: 'active',
      assurance: 'mfa',
      memberships: [membership],
      stepUpExpiresAt: null,
    });

    const none = sessionReducer(base, {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'resolved', memberships: [] },
    });
    expect(none).toMatchObject({ status: 'noMembership', identity });

    let failed = sessionReducer(base, { type: 'ACCESS_RESULT', outcome: { kind: 'unavailable' } });
    expect(failed.status).toBe('accessUnavailable');
    failed = sessionReducer(failed, { type: 'ACCESS_RETRY' });
    expect(failed).toEqual({ status: 'resolvingAccess', assurance: 'mfa', identity });
  });

  test('a later access refresh can revoke membership out from under an active session', () => {
    const state = sessionReducer(authenticated(), {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'resolved', memberships: [] },
    });
    expect(state.status).toBe('noMembership');
  });

  test('a no-membership session can GAIN access (invitation acceptance re-resolution)', () => {
    const noMembership = sessionReducer(
      sessionReducer(initialSessionState(), {
        type: 'BOOTSTRAP_RESULT',
        outcome: { kind: 'session', assurance: 'mfa', identity },
      }),
      { type: 'ACCESS_RESULT', outcome: { kind: 'resolved', memberships: [] } },
    );
    expect(noMembership.status).toBe('noMembership');
    const regained = sessionReducer(noMembership, {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'resolved', memberships: [membership] },
    });
    expect(regained).toMatchObject({ status: 'active', memberships: [membership] });
  });

  test('session interruption lands on signed out with the canonical expired reason', () => {
    for (const start of [
      authenticated(),
      sessionReducer(initialSessionState(), {
        type: 'BOOTSTRAP_RESULT',
        outcome: { kind: 'session', assurance: 'mfa', identity },
      }),
    ]) {
      const state = sessionReducer(start, {
        type: 'SESSION_INTERRUPTED',
        interrupt: { kind: 'sessionExpired' },
      });
      expect(state).toEqual({
        status: 'signedOut',
        reason: 'sessionExpired',
        signInError: null,
      });
    }
  });

  test('sign-out lands on signed out with the signed-out reason', () => {
    const state = sessionReducer(authenticated(), { type: 'SIGN_OUT_COMPLETED' });
    expect(state).toEqual({ status: 'signedOut', reason: 'signedOut', signInError: null });
  });

  test('step-up completion records the grant expiry on the active session only', () => {
    const active = sessionReducer(authenticated(), {
      type: 'STEP_UP_COMPLETED',
      expiresAt: '2026-08-07T12:00:00.000Z',
    });
    expect(active).toMatchObject({ status: 'active', stepUpExpiresAt: '2026-08-07T12:00:00.000Z' });

    const signedOut = sessionReducer(
      sessionReducer(initialSessionState(), {
        type: 'BOOTSTRAP_RESULT',
        outcome: { kind: 'noSession' },
      }),
      { type: 'STEP_UP_COMPLETED', expiresAt: '2026-08-07T12:00:00.000Z' },
    );
    expect(signedOut.status).toBe('signedOut');
  });

  test('impossible combinations are ignored, not partially applied', () => {
    const active = authenticated();
    expect(sessionReducer(active, { type: 'SIGN_IN_SUBMITTED' })).toBe(active);
    expect(
      sessionReducer(active, { type: 'SIGN_IN_RESULT', outcome: { kind: 'invalidCredentials' } }),
    ).toBe(active);
    expect(
      sessionReducer(active, { type: 'MFA_RESULT', outcome: { kind: 'invalidCode' } }),
    ).toBe(active);

    const signedOut = sessionReducer(initialSessionState(), {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'noSession' },
    });
    expect(
      sessionReducer(signedOut, {
        type: 'ACCESS_RESULT',
        outcome: { kind: 'resolved', memberships: [membership] },
      }),
    ).toBe(signedOut);
    expect(sessionReducer(signedOut, { type: 'MFA_SUBMITTED' })).toBe(signedOut);
    expect(
      sessionReducer(signedOut, {
        type: 'SESSION_INTERRUPTED',
        interrupt: { kind: 'sessionExpired' },
      }),
    ).toBe(signedOut);
  });
});
