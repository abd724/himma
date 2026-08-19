import {
  initialSessionState,
  sessionReducer,
  type AdminSessionState,
} from '../src/auth/session-machine';
import type { AdminAccess } from '../src/access/contract';

/**
 * The admin session reducer: the step-up-at-bootstrap flow the backend
 * `admin` policy demands, both directions of access re-resolution, and
 * impossible-transition inertness.
 */

const ACCESS: AdminAccess = {
  user: { id: 'u1', displayName: 'Layla Operations' },
  roles: ['operations'],
  capabilities: ['providers.operate', 'catalogue.moderate', 'taxonomy.manage'],
};

const SESSION = { assurance: 'mfa' as const, identity: { email: 'ops@himma.demo', displayName: 'Layla' } };

function resolving(): AdminSessionState {
  return { status: 'resolvingAccess', ...SESSION };
}

describe('admin session machine', () => {
  test('bootstrap → resolvingAccess → active carries the access projection', () => {
    let state = initialSessionState();
    state = sessionReducer(state, {
      type: 'BOOTSTRAP_RESULT',
      outcome: { kind: 'session', ...SESSION },
    });
    expect(state.status).toBe('resolvingAccess');
    state = sessionReducer(state, {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'resolved', access: ACCESS },
    });
    expect(state).toEqual({ status: 'active', ...SESSION, access: ACCESS });
  });

  test('noAccess and unavailable resolve their truthful end-states; retry re-enters resolution', () => {
    expect(sessionReducer(resolving(), { type: 'ACCESS_RESULT', outcome: { kind: 'noAccess' } })).toEqual(
      { status: 'noAdminAccess', ...SESSION },
    );
    let state = sessionReducer(resolving(), {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'unavailable' },
    });
    expect(state.status).toBe('accessUnavailable');
    state = sessionReducer(state, { type: 'ACCESS_RETRY' });
    expect(state.status).toBe('resolvingAccess');
  });

  test('stepUpRequired is its own state; completion re-resolves; failure stays with the error; success then resolves access', () => {
    let state = sessionReducer(resolving(), {
      type: 'ACCESS_RESULT',
      outcome: { kind: 'stepUpRequired' },
    });
    expect(state).toEqual({ status: 'stepUpRequired', ...SESSION, submitting: false, error: null });
    state = sessionReducer(state, { type: 'STEP_UP_SUBMITTED' });
    expect(state).toMatchObject({ status: 'stepUpRequired', submitting: true });
    state = sessionReducer(state, { type: 'STEP_UP_FAILED', error: 'invalidCode' });
    expect(state).toMatchObject({ status: 'stepUpRequired', submitting: false, error: 'invalidCode' });
    state = sessionReducer(state, { type: 'STEP_UP_SUBMITTED' });
    state = sessionReducer(state, { type: 'STEP_UP_COMPLETED' });
    expect(state.status).toBe('resolvingAccess');
    state = sessionReducer(state, { type: 'ACCESS_RESULT', outcome: { kind: 'resolved', access: ACCESS } });
    expect(state.status).toBe('active');
  });

  test('access re-resolves in BOTH directions from active (revocation) and noAdminAccess (grant)', () => {
    const active: AdminSessionState = { status: 'active', ...SESSION, access: ACCESS };
    expect(
      sessionReducer(active, { type: 'ACCESS_RESULT', outcome: { kind: 'noAccess' } }).status,
    ).toBe('noAdminAccess');
    const denied: AdminSessionState = { status: 'noAdminAccess', ...SESSION };
    expect(
      sessionReducer(denied, { type: 'ACCESS_RESULT', outcome: { kind: 'resolved', access: ACCESS } })
        .status,
    ).toBe('active');
  });

  test('sessionExpired exits every authenticated state; sign-in surfaces stay untouched by it', () => {
    for (const state of [
      resolving(),
      { status: 'active', ...SESSION, access: ACCESS } as AdminSessionState,
      { status: 'stepUpRequired', ...SESSION, submitting: false, error: null } as AdminSessionState,
      { status: 'noAdminAccess', ...SESSION } as AdminSessionState,
    ]) {
      expect(
        sessionReducer(state, {
          type: 'SESSION_INTERRUPTED',
          interrupt: { kind: 'sessionExpired' },
        }),
      ).toEqual({ status: 'signedOut', reason: 'sessionExpired', signInError: null });
    }
    const signedOut: AdminSessionState = { status: 'signedOut', reason: 'initial', signInError: null };
    expect(
      sessionReducer(signedOut, { type: 'SESSION_INTERRUPTED', interrupt: { kind: 'sessionExpired' } }),
    ).toBe(signedOut);
  });

  test('impossible transitions are inert', () => {
    const signedOut: AdminSessionState = { status: 'signedOut', reason: 'initial', signInError: null };
    expect(
      sessionReducer(signedOut, { type: 'ACCESS_RESULT', outcome: { kind: 'resolved', access: ACCESS } }),
    ).toBe(signedOut);
    expect(sessionReducer(signedOut, { type: 'STEP_UP_COMPLETED' })).toBe(signedOut);
    const bootstrapping = initialSessionState();
    expect(sessionReducer(bootstrapping, { type: 'SIGN_IN_SUBMITTED' })).toBe(bootstrapping);
  });
});
