import type {
  AdminAuthAdapter,
  MfaChallengeOutcome,
  SessionIdentity,
  SessionInterrupt,
  SignInOutcome,
  StepUpOutcome,
} from '../../auth/adapter';
import type {
  AdminAccess,
  AdminAccessOutcome,
  AdminAccessPort,
  AdminCapability,
  AdminRole,
} from '../../access/contract';

/**
 * Deterministic FIXTURE admin runtime — design/testing/demo identities
 * behind the same adapter + access-port seams the live runtime implements.
 * The capability projection here mirrors the backend's
 * admin-capabilities.ts EXACTLY (test-locked): fixtures model reality,
 * they never define it. Live mode can never reach this module
 * (composition-locked); production defaults to unconfigured fail-closed.
 *
 * Identities (password `admin-demo`, TOTP `246810` — MFA always required,
 * matching the admin baseline):
 * - ops@himma.demo        operations               (Layla Operations)
 * - access@himma.demo     access_admin             (Adnan Access)
 * - audit@himma.demo      auditor                  (Aisha Audit)
 * - duo@himma.demo        operations + access_admin (Dana Duo — D4-legal)
 * - support@himma.demo    support (truthfully EMPTY W3-phase capabilities)
 * - none@himma.demo       authenticated, NO admin role → noAdminAccess
 * - stale@himma.demo      operations, but the first resolution demands a
 *                         recent factor (stepUpRequired) — completes with
 *                         the same TOTP code, then resolves normally.
 */

export const FIXTURE_PASSWORD = 'admin-demo';
export const FIXTURE_TOTP = '246810';

/** Mirror of backend admin-capabilities.ts — kept in ONE place. */
export const FIXTURE_ROLE_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
  operations: ['providers.operate', 'catalogue.moderate', 'taxonomy.manage'],
  access_admin: ['roles.administer', 'roles.view'],
  auditor: ['roles.view', 'audit.read'],
  support: [],
  finance: [],
};

const CAPABILITY_ORDER: readonly AdminCapability[] = [
  'providers.operate',
  'catalogue.moderate',
  'taxonomy.manage',
  'roles.administer',
  'roles.view',
  'audit.read',
];

export function fixtureCapabilities(roles: readonly AdminRole[]): readonly AdminCapability[] {
  const granted = new Set<AdminCapability>();
  for (const role of roles) {
    for (const capability of FIXTURE_ROLE_CAPABILITIES[role]) {
      granted.add(capability);
    }
  }
  return CAPABILITY_ORDER.filter((capability) => granted.has(capability));
}

interface FixtureIdentity {
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly AdminRole[];
  readonly requiresInitialStepUp?: boolean;
}

const IDENTITIES: readonly FixtureIdentity[] = [
  { email: 'ops@himma.demo', displayName: 'Layla Operations', roles: ['operations'] },
  { email: 'access@himma.demo', displayName: 'Adnan Access', roles: ['access_admin'] },
  { email: 'audit@himma.demo', displayName: 'Aisha Audit', roles: ['auditor'] },
  {
    email: 'duo@himma.demo',
    displayName: 'Dana Duo',
    roles: ['operations', 'access_admin'],
  },
  { email: 'support@himma.demo', displayName: 'Samir Support', roles: ['support'] },
  { email: 'none@himma.demo', displayName: 'Noor NoRole', roles: [] },
  {
    email: 'stale@himma.demo',
    displayName: 'Stefan Stale',
    roles: ['operations'],
    requiresInitialStepUp: true,
  },
];

export interface FixtureAdminControls {
  /** Force the next access resolution to fail transiently. */
  failNextAccessResolve(): void;
  /** Simulate the caller's final admin role being revoked server-side. */
  revokeAllRoles(email: string): void;
  /** Simulate session expiry/revocation (pushes the canonical interrupt). */
  expireSession(): void;
}

export interface FixtureAdminRuntime {
  adapter: AdminAuthAdapter;
  accessPort: AdminAccessPort;
  controls: FixtureAdminControls;
  /** Test-harness seeding: start signed in as a fixture identity. */
  seedSession(email: string): void;
}

interface FixtureState {
  current: FixtureIdentity | null;
  pendingChallenge: FixtureIdentity | null;
  stepUpSatisfied: boolean;
  accessFailurePending: boolean;
  revoked: Set<string>;
}

export function createFixtureAdminRuntime(): FixtureAdminRuntime {
  const state: FixtureState = {
    current: null,
    pendingChallenge: null,
    stepUpSatisfied: false,
    accessFailurePending: false,
    revoked: new Set(),
  };
  const listeners = new Set<(interrupt: SessionInterrupt) => void>();
  const notify = (interrupt: SessionInterrupt) => {
    for (const listener of listeners) {
      listener(interrupt);
    }
  };

  const identityView = (identity: FixtureIdentity): SessionIdentity => ({
    email: identity.email,
    displayName: identity.displayName,
  });

  const accessView = (identity: FixtureIdentity): AdminAccess => ({
    user: { id: `fixture-${identity.email}`, displayName: identity.displayName },
    roles: identity.roles,
    capabilities: fixtureCapabilities(identity.roles),
  });

  const adapter: AdminAuthAdapter = {
    async bootstrap() {
      // Fixture reloads start signed out — deterministic walkthroughs
      // always begin at the sign-in surface.
      return state.current === null
        ? { kind: 'noSession' }
        : {
            kind: 'session',
            assurance: 'mfa',
            identity: identityView(state.current),
          };
    },

    async signIn(input): Promise<SignInOutcome> {
      state.pendingChallenge = null;
      const identity = IDENTITIES.find((candidate) => candidate.email === input.email);
      if (identity === undefined || input.password !== FIXTURE_PASSWORD) {
        // Account-enumeration-safe: unknown email and wrong password are
        // the same single credential-failure class.
        return { kind: 'invalidCredentials' };
      }
      state.pendingChallenge = identity;
      return { kind: 'mfaChallenge' };
    },

    async completeMfaChallenge(code): Promise<MfaChallengeOutcome> {
      const challenge = state.pendingChallenge;
      if (challenge === null) {
        return { kind: 'challengeExpired' };
      }
      if (code !== FIXTURE_TOTP) {
        return { kind: 'invalidCode' };
      }
      state.pendingChallenge = null;
      state.current = challenge;
      state.stepUpSatisfied = challenge.requiresInitialStepUp !== true;
      return { kind: 'signedIn', assurance: 'mfa', identity: identityView(challenge) };
    },

    async cancelMfaChallenge() {
      state.pendingChallenge = null;
    },

    async completeStepUpTotp(code): Promise<StepUpOutcome> {
      if (state.current === null) {
        return { kind: 'failure' };
      }
      if (code !== FIXTURE_TOTP) {
        return { kind: 'invalidCode' };
      }
      state.stepUpSatisfied = true;
      return { kind: 'completed', expiresAt: new Date(Date.now() + 600_000).toISOString() };
    },

    async completeStepUpRecoveryCode(code): Promise<StepUpOutcome> {
      return adapter.completeStepUpTotp(code);
    },

    async signOut() {
      state.current = null;
      state.pendingChallenge = null;
      state.stepUpSatisfied = false;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const accessPort: AdminAccessPort = {
    async resolveAccess(): Promise<AdminAccessOutcome> {
      const identity = state.current;
      if (identity === null) {
        return { kind: 'unavailable' };
      }
      if (state.accessFailurePending) {
        state.accessFailurePending = false;
        return { kind: 'unavailable' };
      }
      if (!state.stepUpSatisfied) {
        // Mirrors the backend admin policy: a stale factor resolves the
        // dedicated step-up outcome, never access and never a bypass.
        return { kind: 'stepUpRequired' };
      }
      if (state.revoked.has(identity.email) || identity.roles.length === 0) {
        return { kind: 'noAccess' };
      }
      return { kind: 'resolved', access: accessView(identity) };
    },
  };

  const controls: FixtureAdminControls = {
    failNextAccessResolve() {
      state.accessFailurePending = true;
    },
    revokeAllRoles(email) {
      state.revoked.add(email);
      notify({ kind: 'accessChanged' });
    },
    expireSession() {
      state.current = null;
      state.stepUpSatisfied = false;
      notify({ kind: 'sessionExpired' });
    },
  };

  const seedSession = (email: string) => {
    const identity = IDENTITIES.find((candidate) => candidate.email === email);
    if (identity === undefined) {
      throw new Error(`unknown fixture admin: ${email}`);
    }
    state.current = identity;
    state.stepUpSatisfied = identity.requiresInitialStepUp !== true;
  };

  return { adapter, accessPort, controls, seedSession };
}
