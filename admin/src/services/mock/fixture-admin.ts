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
import type { AdminProvidersReadPort } from '../../providers/contract';
import type { AdminVerificationPort } from '../../verification/contract';
import { createFixtureProviderData, createFixtureProvidersPort } from './fixture-providers';
import { createFixtureVerificationPort } from './fixture-verification';

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
 * - stale@himma.demo      operations whose recent-factor window has aged.
 *                         Per the W3-1 final owner decision, a stale factor
 *                         does NOT gate ordinary shell access — this
 *                         identity bootstraps normally, proving MFA
 *                         assurance (not recency) is the baseline.
 *
 * Recent-factor step-up remains a distinct ACTION-LEVEL mechanism
 * (D-W3-5, deferred): the `demandStepUp()` control models a future
 * high-risk operation answering step-up-required, and the adapter's
 * step-up completion re-satisfies it — the seam stays exercisable without
 * wiring it to any ordinary bootstrap path.
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
  // Stale recent factor — bootstraps normally (W3-1 final owner decision).
  { email: 'stale@himma.demo', displayName: 'Stefan Stale', roles: ['operations'] },
];

export interface FixtureAdminControls {
  /** Force the next access resolution to fail transiently. */
  failNextAccessResolve(): void;
  /** Simulate the caller's final admin role being revoked server-side. */
  revokeAllRoles(email: string): void;
  /** Simulate session expiry/revocation (pushes the canonical interrupt). */
  expireSession(): void;
  /** Model a FUTURE action-level step-up demand (D-W3-5 seam): access
   *  resolutions answer stepUpRequired until a step-up completes. Never
   *  wired to ordinary bootstrap. */
  demandStepUp(): void;
  /** Toggle a provider-read outage (directory/detail resolve unavailable
   *  while active) — models a backend incident for error-state tests. */
  setProvidersOutage(active: boolean): void;
  /** Model the W3-4 content-safety gate: false = review/decision/evidence
   *  download refuse with the typed safety condition (the LIVE production
   *  default until real scanning exists). Fixture default: true. */
  setContentSafetyReady(ready: boolean): void;
}

export interface FixtureAdminRuntime {
  adapter: AdminAuthAdapter;
  accessPort: AdminAccessPort;
  providersPort: AdminProvidersReadPort;
  verificationPort: AdminVerificationPort;
  controls: FixtureAdminControls;
  /** Test-harness seeding: start signed in as a fixture identity. */
  seedSession(email: string): void;
}

interface FixtureState {
  current: FixtureIdentity | null;
  pendingChallenge: FixtureIdentity | null;
  /** True only while a (future) action-level step-up demand is open. */
  stepUpDemanded: boolean;
  accessFailurePending: boolean;
  providersOutage: boolean;
  contentSafetyReady: boolean;
  revoked: Set<string>;
}

export function createFixtureAdminRuntime(): FixtureAdminRuntime {
  const state: FixtureState = {
    current: null,
    pendingChallenge: null,
    stepUpDemanded: false,
    accessFailurePending: false,
    providersOutage: false,
    contentSafetyReady: true,
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
      state.stepUpDemanded = false;
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
      state.stepUpDemanded = false;
      return { kind: 'completed', expiresAt: new Date(Date.now() + 600_000).toISOString() };
    },

    async completeStepUpRecoveryCode(code): Promise<StepUpOutcome> {
      return adapter.completeStepUpTotp(code);
    },

    async signOut() {
      state.current = null;
      state.pendingChallenge = null;
      state.stepUpDemanded = false;
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
      if (state.stepUpDemanded) {
        // The D-W3-5 seam only: a modeled action-level demand resolves the
        // dedicated step-up outcome, never access and never a bypass.
        // Ordinary bootstrap NEVER sets this — a stale recent factor is
        // not a gate on shell access (W3-1 final owner decision).
        return { kind: 'stepUpRequired' };
      }
      if (state.revoked.has(identity.email) || identity.roles.length === 0) {
        return { kind: 'noAccess' };
      }
      return { kind: 'resolved', access: accessView(identity) };
    },
  };

  // The fixture provider directory answers with the CURRENT identity's
  // authority — mirroring backend truth (operations-only): revoked or
  // capability-less identities are refused, a missing session is
  // unavailable, never silently served. Directory and verification share
  // ONE mutable data instance, so review decisions surface in the queue.
  const providerData = createFixtureProviderData();
  const currentAuthority = () => {
    const identity = state.current;
    if (identity === null) return null;
    const roles = state.revoked.has(identity.email) ? [] : identity.roles;
    return {
      hasProvidersCapability: fixtureCapabilities(roles).includes('providers.operate'),
    };
  };
  const providersPort = createFixtureProvidersPort(
    {
      currentAuthority,
      takeFailure() {
        return state.providersOutage;
      },
    },
    providerData,
  );
  const verificationPort = createFixtureVerificationPort(
    {
      currentAuthority,
      takeFailure() {
        return state.providersOutage;
      },
      stepUpDemanded() {
        return state.stepUpDemanded;
      },
      contentSafetyReady() {
        return state.contentSafetyReady;
      },
    },
    providerData,
  );

  const controls: FixtureAdminControls = {
    failNextAccessResolve() {
      state.accessFailurePending = true;
    },
    setProvidersOutage(active: boolean) {
      state.providersOutage = active;
    },
    setContentSafetyReady(ready: boolean) {
      state.contentSafetyReady = ready;
    },
    revokeAllRoles(email) {
      state.revoked.add(email);
      notify({ kind: 'accessChanged' });
    },
    expireSession() {
      state.current = null;
      state.stepUpDemanded = false;
      notify({ kind: 'sessionExpired' });
    },
    demandStepUp() {
      state.stepUpDemanded = true;
    },
  };

  const seedSession = (email: string) => {
    const identity = IDENTITIES.find((candidate) => candidate.email === email);
    if (identity === undefined) {
      throw new Error(`unknown fixture admin: ${email}`);
    }
    state.current = identity;
    state.stepUpDemanded = false;
  };

  return { adapter, accessPort, providersPort, verificationPort, controls, seedSession };
}
