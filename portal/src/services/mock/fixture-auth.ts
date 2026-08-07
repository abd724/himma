/**
 * Development fixture — semantic access scenarios ONLY (task §16).
 *
 * These fixtures model OUTCOMES (signed in, MFA challenged, no membership,
 * suspended organization, transient access failure), never credentials or
 * token mechanics: no JWT/bearer strings exist anywhere in fixture mode, and
 * nothing an operator types is persisted. The fixture pair implements the
 * same `PortalAuthAdapter` / `ProviderAccessPort` seams the W2-12 live
 * integration replaces — the page tree never knows which is behind them.
 *
 * Demo directory (single shared demo password `himma-demo`, TOTP code
 * `246810`, `000000` demonstrates an expired challenge):
 * - owner@bluewave.demo      → single-org Owner (Blue Wave Swimming)
 * - director@himma.demo      → multi-org (Blue Wave · Noor · suspended Falcon)
 * - coach@noor.demo          → signs in WITHOUT MFA enrolled (single_factor)
 * - former@himma.demo        → authenticated, zero memberships
 * - flaky@bluewave.demo      → first access resolution fails, retry succeeds
 * - suspended@himma.demo     → account suspended at sign-in
 */
import type {
  BootstrapOutcome,
  MfaChallengeOutcome,
  PortalAuthAdapter,
  SessionAssurance,
  SessionIdentity,
  SessionInterrupt,
  SignInOutcome,
  StepUpOutcome,
} from '../../auth/adapter';
import type {
  ProviderAccessOutcome,
  ProviderAccessPort,
  ProviderMembership,
} from '../../provider-access/contract';

export const fixtureOrganizations = {
  blueWave: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01',
    displayName: 'Blue Wave Swimming',
  },
  noor: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e02',
    displayName: 'Noor Learning Centre',
  },
  falcon: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e03',
    displayName: 'Falcon Combat Academy',
  },
} as const;

const NOOR_BRANCH_ID = '0198a2f0-5b7a-7000-8000-2b6c3e8f7a11';

export const FIXTURE_PASSWORD = 'himma-demo';
export const FIXTURE_TOTP_CODE = '246810';
export const FIXTURE_TOTP_EXPIRED_CODE = '000000';
export const FIXTURE_RECOVERY_CODES = ['HW7K-P2QD-XN4R', 'M3JD-8FWP-K2VT'];

interface FixtureIdentity {
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnrolled: boolean;
  readonly accountSuspended?: boolean;
  readonly flakyAccess?: boolean;
  readonly memberships: readonly ProviderMembership[];
}

const IDENTITIES: readonly FixtureIdentity[] = [
  {
    email: 'owner@bluewave.demo',
    displayName: 'Rana Haddad',
    mfaEnrolled: true,
    memberships: [
      { ...fixtureOrganizations.blueWave, role: 'owner', branchScope: 'all', organizationState: 'live' },
    ],
  },
  {
    email: 'director@himma.demo',
    displayName: 'Omar Farouk',
    mfaEnrolled: true,
    memberships: [
      { ...fixtureOrganizations.blueWave, role: 'org_manager', branchScope: 'all', organizationState: 'live' },
      { ...fixtureOrganizations.noor, role: 'owner', branchScope: 'all', organizationState: 'live' },
      { ...fixtureOrganizations.falcon, role: 'owner', branchScope: 'all', organizationState: 'suspended' },
    ],
  },
  {
    email: 'coach@noor.demo',
    displayName: 'Lina Aziz',
    mfaEnrolled: false,
    memberships: [
      { ...fixtureOrganizations.noor, role: 'coach', branchScope: [NOOR_BRANCH_ID], organizationState: 'live' },
    ],
  },
  {
    email: 'former@himma.demo',
    displayName: 'Sami Idris',
    mfaEnrolled: true,
    memberships: [],
  },
  {
    email: 'flaky@bluewave.demo',
    displayName: 'Nadia Rahman',
    mfaEnrolled: true,
    flakyAccess: true,
    memberships: [
      { ...fixtureOrganizations.blueWave, role: 'listings_editor', branchScope: 'all', organizationState: 'live' },
    ],
  },
  {
    email: 'suspended@himma.demo',
    displayName: 'Karim Nassar',
    mfaEnrolled: true,
    accountSuspended: true,
    memberships: [],
  },
];

interface FixtureSessionStore {
  current: FixtureIdentity | null;
  pendingChallenge: FixtureIdentity | null;
  revokedAccess: boolean;
  flakyFailuresRemaining: number;
  usedRecoveryCodes: Set<string>;
  listeners: Set<(interrupt: SessionInterrupt) => void>;
}

export interface FixtureAccessControls {
  /** Simulate the session ending server-side (expiry/revocation). */
  expireSession(): void;
  /** Simulate every membership being revoked while signed in. */
  revokeAccess(): void;
}

export interface FixtureAuthRuntime {
  adapter: PortalAuthAdapter;
  accessPort: ProviderAccessPort;
  controls: FixtureAccessControls;
  /**
   * Test-harness seeding: aligns the fixture store with a prepared session
   * state (the render helper's authenticated seam) so adapter operations
   * that require a current session (step-up, access resolution) behave.
   * Never wired to configuration or UI.
   */
  seedSession(email: string): void;
}

export function createFixtureAuthRuntime(): FixtureAuthRuntime {
  const store: FixtureSessionStore = {
    current: null,
    pendingChallenge: null,
    revokedAccess: false,
    flakyFailuresRemaining: 0,
    usedRecoveryCodes: new Set(),
    listeners: new Set(),
  };

  const identityView = (identity: FixtureIdentity): SessionIdentity => ({
    email: identity.email,
    displayName: identity.displayName,
  });

  const assuranceOf = (identity: FixtureIdentity): SessionAssurance =>
    identity.mfaEnrolled ? 'mfa' : 'single_factor';

  const emit = (interrupt: SessionInterrupt) => {
    for (const listener of store.listeners) {
      listener(interrupt);
    }
  };

  const stepUp = (valid: boolean): StepUpOutcome => {
    if (!store.current) {
      return { kind: 'failure' };
    }
    if (!valid) {
      return { kind: 'invalidCode' };
    }
    // Mirrors HIMMA_MFA_STEP_UP_TTL_SECONDS default (900 s).
    return { kind: 'completed', expiresAt: new Date(Date.now() + 900_000).toISOString() };
  };

  const adapter: PortalAuthAdapter = {
    async bootstrap(): Promise<BootstrapOutcome> {
      // Fixture sessions live in memory only — a fresh load starts signed out.
      return store.current
        ? { kind: 'session', assurance: assuranceOf(store.current), identity: identityView(store.current) }
        : { kind: 'noSession' };
    },

    async signIn({ email, password }): Promise<SignInOutcome> {
      const identity = IDENTITIES.find(
        (candidate) => candidate.email === email.trim().toLowerCase(),
      );
      // Enumeration-safe: unknown identity and wrong password are identical.
      if (!identity || password !== FIXTURE_PASSWORD) {
        return { kind: 'invalidCredentials' };
      }
      if (identity.accountSuspended) {
        return { kind: 'accountSuspended' };
      }
      store.revokedAccess = false;
      store.flakyFailuresRemaining = identity.flakyAccess ? 1 : 0;
      if (identity.mfaEnrolled) {
        store.pendingChallenge = identity;
        return { kind: 'mfaChallenge' };
      }
      store.current = identity;
      return { kind: 'signedIn', assurance: 'single_factor', identity: identityView(identity) };
    },

    async completeMfaChallenge(code): Promise<MfaChallengeOutcome> {
      const identity = store.pendingChallenge;
      if (!identity) {
        return { kind: 'challengeExpired' };
      }
      if (code.trim() === FIXTURE_TOTP_EXPIRED_CODE) {
        store.pendingChallenge = null;
        return { kind: 'challengeExpired' };
      }
      if (code.trim() !== FIXTURE_TOTP_CODE) {
        return { kind: 'invalidCode' };
      }
      store.pendingChallenge = null;
      store.current = identity;
      return { kind: 'signedIn', assurance: 'mfa', identity: identityView(identity) };
    },

    async cancelMfaChallenge() {
      store.pendingChallenge = null;
    },

    async completeStepUpTotp(code) {
      return stepUp(code.trim() === FIXTURE_TOTP_CODE);
    },

    async completeStepUpRecoveryCode(code) {
      const normalized = code.trim().toUpperCase();
      if (store.usedRecoveryCodes.has(normalized)) {
        return { kind: 'invalidCode' };
      }
      const valid = FIXTURE_RECOVERY_CODES.includes(normalized);
      if (valid) {
        store.usedRecoveryCodes.add(normalized);
      }
      return stepUp(valid);
    },

    async signOut() {
      store.current = null;
      store.pendingChallenge = null;
      store.revokedAccess = false;
    },

    subscribe(listener) {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
  };

  const accessPort: ProviderAccessPort = {
    async resolveAccess(): Promise<ProviderAccessOutcome> {
      if (!store.current) {
        return { kind: 'unavailable' };
      }
      if (store.flakyFailuresRemaining > 0) {
        store.flakyFailuresRemaining -= 1;
        return { kind: 'unavailable' };
      }
      return {
        kind: 'resolved',
        memberships: store.revokedAccess ? [] : store.current.memberships,
      };
    },
  };

  const controls: FixtureAccessControls = {
    expireSession() {
      store.current = null;
      store.pendingChallenge = null;
      emit({ kind: 'sessionExpired' });
    },
    revokeAccess() {
      store.revokedAccess = true;
      emit({ kind: 'accessChanged' });
    },
  };

  const seedSession = (email: string) => {
    store.current = IDENTITIES.find((identity) => identity.email === email) ?? null;
  };

  return { adapter, accessPort, controls, seedSession };
}
