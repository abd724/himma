/**
 * Development fixture — semantic access/onboarding scenarios ONLY.
 *
 * These fixtures model OUTCOMES (signed in, MFA challenged, no membership,
 * invitation accepted/refused, onboarding stages), never credentials or
 * token mechanics: no JWT/bearer strings exist anywhere in fixture mode, and
 * nothing an operator types is persisted. The fixture set implements the
 * same seams the W2-12 live integration replaces — the page tree never
 * knows which is behind them.
 *
 * Demo directory (single shared demo password `himma-demo`, TOTP code
 * `246810`, `000000` demonstrates an expired challenge):
 * - owner@bluewave.demo      → single-org Owner (Blue Wave Swimming, live)
 * - director@himma.demo      → multi-org (Blue Wave · Noor · suspended Falcon)
 * - stages@himma.demo        → owner of orgs in submitted/in_review/rejected/verified
 * - newowner@coral.demo      → no access yet; founding-Owner invitation target
 * - newcoach@bluewave.demo   → no access yet; ordinary staff invitation target
 * - assistant@coral.demo     → coach at draft Coral (role-aware read-only)
 * - manager@bluewave.demo    → branch-scoped Branch Manager (Dubai Marina pool only)
 * - frontdesk@bluewave.demo  → Front Desk at Blue Wave (branches read-only)
 * - finance@bluewave.demo    → Finance at Blue Wave (branches read-only)
 * - coach@noor.demo          → signs in WITHOUT MFA enrolled (single_factor)
 * - former@himma.demo        → authenticated, zero memberships
 * - flaky@bluewave.demo      → first access resolution fails, retry succeeds
 * - suspended@himma.demo     → account suspended at sign-in
 *
 * Demo invitation codes (opaque one-time codes, ≥16 chars like the real
 * 256-bit tokens; every refusal is the ONE canonical `invitationInvalid`):
 * - HIMMA-INVITE-OWNER-CORAL     → founding Owner of draft Coral Kids Climbing
 * - HIMMA-INVITE-STAFF-BLUEWAVE  → coach at live Blue Wave Swimming
 * - HIMMA-INVITE-EXPIRED-DEMO / HIMMA-INVITE-REVOKED-DEMO → canonical refusal
 * - HIMMA-INVITE-UNAVAILABLE     → transient service failure
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
  BranchInput,
  BranchPatch,
  BranchPort,
  CreateBranchOutcome,
  DeactivateBranchOutcome,
  UpdateBranchOutcome,
} from '../../branches/contract';
import { BRANCH_FIELD_LIMITS } from '../../branches/contract';
import type { InvitationAcceptOutcome, InvitationPort } from '../../invitations/contract';
import type {
  OnboardingPort,
  OnboardingSnapshot,
  OnboardingSnapshotOutcome,
  SubmitForVerificationOutcome,
} from '../../onboarding/contract';
import type {
  OrganizationProfilePort,
  OrganizationView,
  OrganizationViewOutcome,
  ProfilePatch,
  UpdateProfileOutcome,
} from '../../profile/contract';
import type {
  BranchScope,
  ProviderAccessOutcome,
  ProviderAccessPort,
  ProviderMembership,
  ProviderRole,
} from '../../provider-access/contract';
import type { AreaReadPort, AreaRecord } from '../../taxonomy/contract';

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
  coral: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e04',
    displayName: 'Coral Kids Climbing',
  },
  sunrise: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e05',
    displayName: 'Sunrise Pottery Studio',
  },
  marina: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e06',
    displayName: 'Marina Chess Club',
  },
  desertBloom: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e07',
    displayName: 'Desert Bloom Yoga',
  },
  pearl: {
    organizationId: '0198a2f0-5b7a-7000-8000-1f4a2d9c6e08',
    displayName: 'Pearl Divers Freediving',
  },
} as const;

const NOOR_BRANCH_ID = '0198a2f0-5b7a-7000-8000-2b6c3e8f7a11';

/** Stable branch ids (exported for tests and branch-scope fixtures). */
export const fixtureBranches = {
  blueWaveMarina: '0198a2f0-5b7a-7000-8000-2b6c3e8f7a01',
  blueWaveBay: '0198a2f0-5b7a-7000-8000-2b6c3e8f7a02',
  blueWaveSufouh: '0198a2f0-5b7a-7000-8000-2b6c3e8f7a03',
  noorBarsha: NOOR_BRANCH_ID,
} as const;

/**
 * Fixture area directory — shaped exactly on the public taxonomy read
 * `GET /catalogue/areas` (ACTIVE admin-owned rows only, deterministic
 * order). 'Al Sufouh' is deliberately ABSENT: it models a historical/
 * deactivated area still referenced by an old branch's `areaLabel`.
 */
function areaDirectory(): AreaRecord[] {
  const area = (suffix: string, slug: string, labelEn: string): AreaRecord => ({
    id: `0198a2f0-5b7a-7000-8000-3c7d4f9a8b${suffix}`,
    slug,
    labelEn,
    labelAr: null,
    city: 'Dubai',
  });
  return [
    area('01', 'al-barsha', 'Al Barsha'),
    area('02', 'business-bay', 'Business Bay'),
    area('03', 'deira', 'Deira'),
    area('04', 'downtown-dubai', 'Downtown Dubai'),
    area('05', 'dubai-marina', 'Dubai Marina'),
    area('06', 'jumeirah', 'Jumeirah'),
  ];
}

export const FIXTURE_PASSWORD = 'himma-demo';
export const FIXTURE_TOTP_CODE = '246810';
export const FIXTURE_TOTP_EXPIRED_CODE = '000000';
export const FIXTURE_RECOVERY_CODES = ['HW7K-P2QD-XN4R', 'M3JD-8FWP-K2VT'];

export const FIXTURE_INVITATIONS = {
  foundingOwner: 'HIMMA-INVITE-OWNER-CORAL',
  staff: 'HIMMA-INVITE-STAFF-BLUEWAVE',
  expired: 'HIMMA-INVITE-EXPIRED-DEMO',
  revoked: 'HIMMA-INVITE-REVOKED-DEMO',
  unavailable: 'HIMMA-INVITE-UNAVAILABLE',
} as const;

/**
 * Mirror of the backend's PROVIDER_ROLE_CAPABILITIES registry — fixture data
 * shaped on the real vocabulary (live values arrive in the real
 * organization-view response at W2-12; nothing here invents a capability).
 */
const ROLE_CAPABILITIES: Record<ProviderRole, readonly string[]> = {
  owner: [
    'org.read',
    'org.legal.view',
    'commercial_terms.view',
    'profile.edit',
    'branch.create',
    'branch.edit',
    'branch.deactivate',
    'staff.read',
    'staff.manage',
    'org.submit',
    'catalogue.read',
    'listings.manage',
    'listings.publish',
    'media.manage',
  ],
  org_manager: [
    'org.read',
    'org.legal.view',
    'profile.edit',
    'branch.create',
    'branch.edit',
    'branch.deactivate',
    'catalogue.read',
    'listings.manage',
    'listings.publish',
    'media.manage',
  ],
  branch_manager: ['org.read', 'org.legal.view', 'branch.edit', 'catalogue.read', 'listings.manage', 'media.manage'],
  listings_editor: ['org.read', 'org.legal.view', 'catalogue.read', 'listings.manage', 'media.manage'],
  coach: ['org.read'],
  front_desk: ['org.read', 'org.legal.view'],
  finance: ['org.read', 'org.legal.view'],
};

interface FixtureBranchState {
  readonly id: string;
  label: string;
  addressLine: string | null;
  city: string | null;
  areaLabel: string;
  geoPoint: { longitude: number; latitude: number } | null;
  openingHours: unknown;
  facilities: string[];
  active: boolean;
  version: number;
}

/** Mirrors organization_public_profile — the storefront record (own version). */
interface FixtureProfileState {
  displayName: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  logoMediaRef: string | null;
  coverMediaRef: string | null;
  galleryMediaRefs: string[];
  publicPhone: string | null;
  publicEmail: string | null;
  publicWebsite: string | null;
  publicInstagram: string | null;
  published: boolean;
  version: number;
}

interface FixtureOrganizationState {
  readonly organizationId: string;
  readonly tradeName: string;
  readonly legalName: string;
  verificationState: string;
  version: number;
  profile: FixtureProfileState;
  branches: FixtureBranchState[];
  listingCount: number;
}

function organizationDirectory(): Map<string, FixtureOrganizationState> {
  const branch = (
    organizationId: string,
    suffix: string,
    label: string,
    areaLabel: string,
    options: Partial<Pick<FixtureBranchState, 'addressLine' | 'facilities' | 'active'>> = {},
  ): FixtureBranchState => ({
    id: suffix.length > 12 ? suffix : `${organizationId.slice(0, 8)}-${suffix}`,
    label,
    addressLine: options.addressLine ?? null,
    city: null,
    areaLabel,
    geoPoint: null,
    openingHours: null,
    facilities: options.facilities ?? [],
    active: options.active ?? true,
    version: 1,
  });

  const org = (
    ref: { organizationId: string; displayName: string },
    verificationState: string,
    options: {
      legalName?: string;
      profile?: Partial<FixtureProfileState>;
      branches?: FixtureBranchState[];
      listingCount?: number;
    } = {},
  ): FixtureOrganizationState => ({
    organizationId: ref.organizationId,
    tradeName: ref.displayName,
    legalName: options.legalName ?? `${ref.displayName} LLC`,
    verificationState,
    version: 3,
    profile: {
      displayName: ref.displayName,
      descriptionEn: null,
      descriptionAr: null,
      logoMediaRef: null,
      coverMediaRef: null,
      galleryMediaRefs: [],
      publicPhone: null,
      publicEmail: null,
      publicWebsite: null,
      publicInstagram: null,
      published: false,
      version: 2,
      ...options.profile,
    },
    branches:
      options.branches ??
      [branch(ref.organizationId, 'branch-1', 'Main branch', 'Downtown Dubai')],
    listingCount: options.listingCount ?? 0,
  });

  return new Map(
    [
      org(fixtureOrganizations.blueWave, 'live', {
        listingCount: 3,
        profile: {
          descriptionEn:
            'Learn-to-swim classes, squad training, and holiday camps for children and adults, taught by certified coaches.',
          publicPhone: '+971 4 555 0100',
          publicEmail: 'hello@bluewave.example',
          publicWebsite: 'https://bluewave.example',
          publicInstagram: '@bluewaveswim',
          published: true,
        },
        branches: [
          branch(fixtureOrganizations.blueWave.organizationId, fixtureBranches.blueWaveMarina, 'Dubai Marina pool', 'Dubai Marina', {
            addressLine: 'Marina Promenade, Block C',
            facilities: ['Indoor pool', 'Changing rooms', 'Parking'],
          }),
          branch(fixtureOrganizations.blueWave.organizationId, fixtureBranches.blueWaveBay, 'Business Bay pool', 'Business Bay', {
            addressLine: 'Bay Avenue, Tower 2',
            facilities: ['Outdoor pool', 'Café'],
          }),
          // Deactivated location referencing a HISTORICAL area label that is
          // no longer in the active area taxonomy (preserved, never offered
          // for new selection, never silently rewritten).
          branch(fixtureOrganizations.blueWave.organizationId, fixtureBranches.blueWaveSufouh, 'Al Sufouh training pool', 'Al Sufouh', {
            addressLine: 'Knowledge Park, Gate 4',
            active: false,
          }),
        ],
      }),
      org(fixtureOrganizations.noor, 'live', {
        listingCount: 2,
        profile: {
          descriptionEn: 'After-school learning support and enrichment programs.',
          publicEmail: 'contact@noorlearning.example',
          published: true,
        },
        branches: [
          branch(fixtureOrganizations.noor.organizationId, fixtureBranches.noorBarsha, 'Al Barsha centre', 'Al Barsha'),
        ],
      }),
      org(fixtureOrganizations.falcon, 'suspended', {
        listingCount: 1,
        profile: {
          descriptionEn: 'Combat sports classes for teens and adults.',
          published: true,
        },
      }),
      // Fresh admin-created draft: profile shell empty, no branch yet.
      org(fixtureOrganizations.coral, 'draft', {
        profile: { displayName: '' },
        branches: [],
      }),
      org(fixtureOrganizations.sunrise, 'submitted'),
      org(fixtureOrganizations.marina, 'in_review'),
      org(fixtureOrganizations.desertBloom, 'rejected', {
        profile: { descriptionEn: 'Yoga and mindfulness studio for all levels.' },
      }),
      // Verified + published storefront, NOT yet live: publication alone
      // never makes a provider publicly visible (live AND published).
      org(fixtureOrganizations.pearl, 'verified', {
        profile: {
          descriptionEn: 'Freediving courses and guided open-water sessions.',
          published: true,
        },
      }),
    ].map((entry) => [entry.organizationId, entry]),
  );
}

interface FixtureMembershipSeat {
  readonly organizationId: string;
  readonly role: ProviderRole;
  readonly branchScope: BranchScope;
}

interface FixtureIdentity {
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnrolled: boolean;
  readonly accountSuspended?: boolean;
  readonly flakyAccess?: boolean;
  memberships: FixtureMembershipSeat[];
}

function identityDirectory(): FixtureIdentity[] {
  const seat = (
    ref: { organizationId: string },
    role: ProviderRole,
    branchScope: BranchScope = 'all',
  ): FixtureMembershipSeat => ({ organizationId: ref.organizationId, role, branchScope });

  return [
    {
      email: 'owner@bluewave.demo',
      displayName: 'Rana Haddad',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'owner')],
    },
    {
      email: 'director@himma.demo',
      displayName: 'Omar Farouk',
      mfaEnrolled: true,
      memberships: [
        seat(fixtureOrganizations.blueWave, 'org_manager'),
        seat(fixtureOrganizations.noor, 'owner'),
        seat(fixtureOrganizations.falcon, 'owner'),
      ],
    },
    {
      email: 'stages@himma.demo',
      displayName: 'Huda Saleh',
      mfaEnrolled: true,
      memberships: [
        seat(fixtureOrganizations.sunrise, 'owner'),
        seat(fixtureOrganizations.marina, 'owner'),
        seat(fixtureOrganizations.desertBloom, 'owner'),
        seat(fixtureOrganizations.pearl, 'owner'),
      ],
    },
    {
      email: 'newowner@coral.demo',
      displayName: 'Amal Kassem',
      mfaEnrolled: true,
      memberships: [],
    },
    {
      email: 'newcoach@bluewave.demo',
      displayName: 'Yara Habib',
      mfaEnrolled: true,
      memberships: [],
    },
    {
      email: 'assistant@coral.demo',
      displayName: 'Rami Odeh',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.coral, 'coach')],
    },
    {
      // Branch-scoped Branch Manager: edit reach = Dubai Marina pool ONLY
      // (the real org view still lists every branch — scope limits
      // MUTATION, never the org.read projection).
      email: 'manager@bluewave.demo',
      displayName: 'Salem Qassim',
      mfaEnrolled: true,
      memberships: [
        seat(fixtureOrganizations.blueWave, 'branch_manager', [fixtureBranches.blueWaveMarina]),
      ],
    },
    {
      email: 'frontdesk@bluewave.demo',
      displayName: 'Dana Mansour',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'front_desk')],
    },
    {
      email: 'finance@bluewave.demo',
      displayName: 'Tariq Aswad',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'finance')],
    },
    {
      email: 'coach@noor.demo',
      displayName: 'Lina Aziz',
      mfaEnrolled: false,
      memberships: [seat(fixtureOrganizations.noor, 'coach', [NOOR_BRANCH_ID])],
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
      memberships: [seat(fixtureOrganizations.blueWave, 'listings_editor')],
    },
    {
      email: 'suspended@himma.demo',
      displayName: 'Karim Nassar',
      mfaEnrolled: true,
      accountSuspended: true,
      memberships: [],
    },
  ];
}

interface FixtureInvitation {
  readonly token: string;
  readonly email: string;
  readonly organizationId: string;
  readonly role: ProviderRole;
  readonly branchScope: BranchScope;
  state: 'sent' | 'accepted' | 'revoked' | 'expired';
}

function invitationDirectory(): FixtureInvitation[] {
  return [
    {
      token: FIXTURE_INVITATIONS.foundingOwner,
      email: 'newowner@coral.demo',
      organizationId: fixtureOrganizations.coral.organizationId,
      role: 'owner',
      branchScope: 'all',
      state: 'sent',
    },
    {
      token: FIXTURE_INVITATIONS.staff,
      email: 'newcoach@bluewave.demo',
      organizationId: fixtureOrganizations.blueWave.organizationId,
      role: 'coach',
      branchScope: 'all',
      state: 'sent',
    },
    {
      token: FIXTURE_INVITATIONS.expired,
      email: 'newowner@coral.demo',
      organizationId: fixtureOrganizations.coral.organizationId,
      role: 'owner',
      branchScope: 'all',
      state: 'expired',
    },
    {
      token: FIXTURE_INVITATIONS.revoked,
      email: 'newcoach@bluewave.demo',
      organizationId: fixtureOrganizations.blueWave.organizationId,
      role: 'coach',
      branchScope: 'all',
      state: 'revoked',
    },
  ];
}

interface FixtureSessionStore {
  current: FixtureIdentity | null;
  pendingChallenge: FixtureIdentity | null;
  revokedAccess: boolean;
  flakyFailuresRemaining: number;
  usedRecoveryCodes: Set<string>;
  profileLoadFailures: Set<string>;
  profileSaveFailures: Set<string>;
  branchMutationFailures: Set<string>;
  areaLoadFailurePending: boolean;
  createdBranchCount: number;
  listeners: Set<(interrupt: SessionInterrupt) => void>;
}

export interface FixtureAccessControls {
  /** Simulate the session ending server-side (expiry/revocation). */
  expireSession(): void;
  /** Simulate every membership being revoked while signed in. */
  revokeAccess(): void;
  /**
   * Simulate ANOTHER staff member saving the storefront profile while this
   * one is open (bumps the profile row's version): the next save carrying
   * the old `expectedVersion` receives the canonical `staleVersion`.
   */
  simulateConcurrentProfileEdit(organizationId: string): void;
  /** Make the next organization-view load fail transiently. */
  failNextProfileLoad(organizationId: string): void;
  /** Make the next profile save fail transiently. */
  failNextProfileSave(organizationId: string): void;
  /**
   * Simulate ANOTHER staff member saving the branch while this one is open
   * (bumps the branch row's version): the next mutation carrying the old
   * `expectedVersion` receives the canonical `staleVersion`.
   */
  simulateConcurrentBranchEdit(organizationId: string, branchId: string): void;
  /** Make the next branch create/update/deactivate fail transiently. */
  failNextBranchMutation(organizationId: string): void;
  /** Make the next area taxonomy read fail transiently. */
  failNextAreaLoad(): void;
}

export interface FixtureAuthRuntime {
  adapter: PortalAuthAdapter;
  accessPort: ProviderAccessPort;
  invitationPort: InvitationPort;
  onboardingPort: OnboardingPort;
  profilePort: OrganizationProfilePort;
  branchPort: BranchPort;
  areaPort: AreaReadPort;
  controls: FixtureAccessControls;
  /**
   * Test-harness seeding: aligns the fixture store with a prepared session
   * state (the render helper's authenticated seam) so adapter operations
   * that require a current session behave. Never wired to configuration/UI.
   */
  seedSession(email: string): void;
  /**
   * Test-harness read: the session state matching a fixture identity's
   * current memberships (for the render helper's initial-state seam).
   */
  sessionStateFor(email: string): {
    identity: SessionIdentity;
    assurance: SessionAssurance;
    memberships: ProviderMembership[];
  } | null;
}

export function createFixtureAuthRuntime(): FixtureAuthRuntime {
  const organizations = organizationDirectory();
  const identities = identityDirectory();
  const invitations = invitationDirectory();

  const store: FixtureSessionStore = {
    current: null,
    pendingChallenge: null,
    revokedAccess: false,
    flakyFailuresRemaining: 0,
    usedRecoveryCodes: new Set(),
    profileLoadFailures: new Set(),
    profileSaveFailures: new Set(),
    branchMutationFailures: new Set(),
    areaLoadFailurePending: false,
    createdBranchCount: 0,
    listeners: new Set(),
  };
  const areas = areaDirectory();

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

  const membershipsOf = (identity: FixtureIdentity): ProviderMembership[] =>
    identity.memberships
      .map((seatEntry) => {
        const organization = organizations.get(seatEntry.organizationId);
        if (!organization || organization.verificationState === 'offboarded') {
          return null;
        }
        return {
          organizationId: organization.organizationId,
          displayName: organization.profile.displayName || organization.tradeName,
          role: seatEntry.role,
          branchScope: seatEntry.branchScope,
          organizationState: organization.verificationState,
        };
      })
      .filter((entry): entry is ProviderMembership => entry !== null);

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
      const identity = identities.find(
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
        memberships: store.revokedAccess ? [] : membershipsOf(store.current),
      };
    },
  };

  const invitationPort: InvitationPort = {
    /**
     * Mirrors POST /provider/invitations/accept exactly, including the
     * canonical collapse: every refusal below is the same
     * `invitationInvalid` with no distinguishing detail.
     */
    async accept(token): Promise<InvitationAcceptOutcome> {
      if (token === FIXTURE_INVITATIONS.unavailable) {
        return { kind: 'providerUnavailable' };
      }
      const caller = store.current;
      if (!caller) {
        return { kind: 'failure' };
      }
      const invitation = invitations.find((candidate) => candidate.token === token);
      if (!invitation || invitation.state !== 'sent') {
        return { kind: 'invitationInvalid' };
      }
      const organization = organizations.get(invitation.organizationId);
      if (
        !organization ||
        organization.verificationState === 'suspended' ||
        organization.verificationState === 'offboarded'
      ) {
        return { kind: 'invitationInvalid' };
      }
      // D-S3-1: verified-email match (fixture emails model verified emails).
      if (invitation.email !== caller.email) {
        return { kind: 'invitationInvalid' };
      }
      if (caller.memberships.some((seatEntry) => seatEntry.organizationId === invitation.organizationId)) {
        return { kind: 'invitationInvalid' };
      }
      invitation.state = 'accepted';
      caller.memberships = [
        ...caller.memberships,
        {
          organizationId: invitation.organizationId,
          role: invitation.role,
          branchScope: invitation.branchScope,
        },
      ];
      emit({ kind: 'accessChanged' });
      return {
        kind: 'invitationAccepted',
        organizationId: invitation.organizationId,
        membershipId: `${invitation.organizationId.slice(0, 8)}-membership-demo`,
      };
    },
  };

  const snapshotFor = (organizationId: string): OnboardingSnapshotOutcome => {
    const caller = store.current;
    const organization = organizations.get(organizationId);
    const seatEntry = caller?.memberships.find(
      (candidate) => candidate.organizationId === organizationId,
    );
    if (!caller || !organization || !seatEntry || organization.verificationState === 'offboarded') {
      return { kind: 'notFound' };
    }
    const capabilities = ROLE_CAPABILITIES[seatEntry.role];
    const snapshot: OnboardingSnapshot = {
      organization: {
        id: organization.organizationId,
        tradeName: organization.tradeName,
        verificationState: organization.verificationState,
        version: organization.version,
      },
      profile: {
        displayName: organization.profile.displayName,
        published: organization.profile.published,
      },
      branches: organization.branches.map((branch) => ({
        id: branch.id,
        label: branch.label,
        active: branch.active,
      })),
      membership: { role: seatEntry.role, capabilities },
      listingCount: capabilities.includes('catalogue.read') ? organization.listingCount : null,
    };
    return { kind: 'loaded', snapshot };
  };

  const onboardingPort: OnboardingPort = {
    async loadSnapshot(organizationId) {
      if (!store.current) {
        return { kind: 'unavailable' };
      }
      return snapshotFor(organizationId);
    },

    /** Mirrors POST /provider/organizations/:organizationId/submit exactly. */
    async submitForVerification(
      organizationId,
      expectedVersion,
    ): Promise<SubmitForVerificationOutcome> {
      const caller = store.current;
      const organization = organizations.get(organizationId);
      const seatEntry = caller?.memberships.find(
        (candidate) => candidate.organizationId === organizationId,
      );
      if (!caller || !organization || !seatEntry) {
        return { kind: 'unavailable' };
      }
      if (organization.verificationState === 'suspended') {
        return { kind: 'organizationSuspended' };
      }
      if (!ROLE_CAPABILITIES[seatEntry.role].includes('org.submit')) {
        return { kind: 'forbidden' };
      }
      if (
        organization.verificationState !== 'draft' &&
        organization.verificationState !== 'rejected'
      ) {
        return { kind: 'lifecycleConflict' };
      }
      if (organization.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const complete =
        organization.profile.displayName.trim().length > 0 &&
        organization.branches.some((branch) => branch.active);
      if (!complete) {
        return { kind: 'organizationIncomplete' };
      }
      organization.verificationState = 'submitted';
      organization.version += 1;
      emit({ kind: 'accessChanged' });
      return { kind: 'organizationSubmitted', version: organization.version };
    },
  };

  /**
   * Mirrors the PATCH .../profile TypeBox constraints so the server-side
   * `validationError` (422) seam is real in fixture mode too. The client
   * form validates first; this is the backend-authoritative backstop.
   */
  const patchViolatesConstraints = (patch: ProfilePatch): boolean => {
    const tooLong = (value: string | null | undefined, max: number) =>
      typeof value === 'string' && value.length > max;
    if (patch.displayName !== undefined && (patch.displayName.length < 1 || patch.displayName.length > 120)) {
      return true;
    }
    if (tooLong(patch.descriptionEn, 2000) || tooLong(patch.descriptionAr, 2000)) {
      return true;
    }
    if (typeof patch.publicEmail === 'string' && (patch.publicEmail.length > 320 || !patch.publicEmail.includes('@'))) {
      return true;
    }
    return (
      tooLong(patch.publicPhone, 32) ||
      tooLong(patch.publicWebsite, 300) ||
      tooLong(patch.publicInstagram, 64)
    );
  };

  const profilePort: OrganizationProfilePort = {
    /** Mirrors GET /provider/organizations/:organizationId (capability-shaped). */
    async loadOrganizationView(organizationId): Promise<OrganizationViewOutcome> {
      const caller = store.current;
      if (!caller) {
        return { kind: 'unavailable' };
      }
      if (store.profileLoadFailures.delete(organizationId)) {
        return { kind: 'unavailable' };
      }
      const organization = organizations.get(organizationId);
      const seatEntry = caller.memberships.find(
        (candidate) => candidate.organizationId === organizationId,
      );
      if (!organization || !seatEntry || organization.verificationState === 'offboarded') {
        return { kind: 'notFound' };
      }
      const capabilities = ROLE_CAPABILITIES[seatEntry.role];
      const view: OrganizationView = {
        organization: {
          id: organization.organizationId,
          tradeName: organization.tradeName,
          ...(capabilities.includes('org.legal.view') ? { legalName: organization.legalName } : {}),
          orgKind: 'provider',
          verificationState: organization.verificationState,
          ...(capabilities.includes('commercial_terms.view') ? { commercialTermsRef: null } : {}),
          version: organization.version,
        },
        profile: { ...organization.profile, galleryMediaRefs: [...organization.profile.galleryMediaRefs] },
        branches: organization.branches.map((branch) => ({ ...branch, facilities: [...branch.facilities] })),
        membership: {
          id: `${organization.organizationId.slice(0, 8)}-membership-demo`,
          role: seatEntry.role,
          branchScope: seatEntry.branchScope,
          capabilities,
        },
      };
      return { kind: 'loaded', view };
    },

    /**
     * Mirrors PATCH /provider/organizations/:organizationId/profile,
     * including the policy-pipeline refusal order (not-found shaping →
     * capability `forbidden` → suspended-org mutation refusal) and the
     * version CAS. `published` is a field of this same PATCH (canon).
     */
    async updateProfile(organizationId, expectedVersion, patch): Promise<UpdateProfileOutcome> {
      const caller = store.current;
      if (!caller) {
        return { kind: 'unavailable' };
      }
      const organization = organizations.get(organizationId);
      const seatEntry = caller.memberships.find(
        (candidate) => candidate.organizationId === organizationId,
      );
      if (!organization || !seatEntry || organization.verificationState === 'offboarded') {
        return { kind: 'notFound' };
      }
      if (!ROLE_CAPABILITIES[seatEntry.role].includes('profile.edit')) {
        return { kind: 'forbidden' };
      }
      if (organization.verificationState === 'suspended') {
        return { kind: 'organizationSuspended' };
      }
      if (store.profileSaveFailures.delete(organizationId)) {
        return { kind: 'unavailable' };
      }
      if (patchViolatesConstraints(patch)) {
        return { kind: 'validationError' };
      }
      if (organization.profile.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const previousDisplayName = organization.profile.displayName;
      const apply = <K extends keyof FixtureProfileState>(key: K, value: FixtureProfileState[K] | undefined) => {
        if (value !== undefined) {
          organization.profile[key] = value;
        }
      };
      apply('displayName', patch.displayName);
      apply('descriptionEn', patch.descriptionEn);
      apply('descriptionAr', patch.descriptionAr);
      apply('publicPhone', patch.publicPhone);
      apply('publicEmail', patch.publicEmail);
      apply('publicWebsite', patch.publicWebsite);
      apply('publicInstagram', patch.publicInstagram);
      apply('published', patch.published);
      organization.profile.version += 1;
      if (organization.profile.displayName !== previousDisplayName) {
        // Membership display identity derives from the profile — the shell
        // (org switcher, nav context) re-resolves it like a real /provider/me.
        emit({ kind: 'accessChanged' });
      }
      return { kind: 'profileUpdated', version: organization.profile.version };
    },
  };

  /**
   * Mirrors the branch route TypeBox constraints so the server-side 422
   * `validationError` seam is real in fixture mode too (the client form
   * validates first; this is the backend-authoritative backstop).
   */
  const branchFieldsViolateConstraints = (input: BranchInput | BranchPatch): boolean => {
    const badString = (value: string | null | undefined, max: number, min = 0) =>
      typeof value === 'string' && (value.length > max || value.length < min);
    if (badString(input.label, BRANCH_FIELD_LIMITS.label, 1)) {
      return true;
    }
    if (badString(input.areaLabel, BRANCH_FIELD_LIMITS.areaLabel, 1)) {
      return true;
    }
    if (
      badString(input.addressLine, BRANCH_FIELD_LIMITS.addressLine) ||
      badString(input.city, BRANCH_FIELD_LIMITS.city)
    ) {
      return true;
    }
    if (input.geoPoint !== undefined && input.geoPoint !== null) {
      const { longitude, latitude } = input.geoPoint;
      if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
        return true;
      }
    }
    if (input.facilities !== undefined) {
      if (input.facilities.length > BRANCH_FIELD_LIMITS.facilitiesCount) {
        return true;
      }
      return input.facilities.some(
        (facility) =>
          facility.length < 1 || facility.length > BRANCH_FIELD_LIMITS.facilityLength,
      );
    }
    return false;
  };

  /**
   * Shared mutation-context resolution mirroring the provider policy
   * pipeline: unknown org, no membership, and offboarded org collapse into
   * ONE not-found shape; then the declared capability; then the
   * suspended-organization mutation refusal.
   */
  const resolveBranchMutation = (
    organizationId: string,
    capability: string,
  ):
    | { refusal: 'notFound' | 'forbidden' | 'organizationSuspended' | 'unavailable' }
    | {
        refusal: null;
        organization: FixtureOrganizationState;
        seatEntry: FixtureMembershipSeat;
      } => {
    const caller = store.current;
    if (!caller) {
      return { refusal: 'unavailable' };
    }
    const organization = organizations.get(organizationId);
    const seatEntry = caller.memberships.find(
      (candidate) => candidate.organizationId === organizationId,
    );
    if (!organization || !seatEntry || organization.verificationState === 'offboarded') {
      return { refusal: 'notFound' };
    }
    if (!ROLE_CAPABILITIES[seatEntry.role].includes(capability)) {
      return { refusal: 'forbidden' };
    }
    if (organization.verificationState === 'suspended') {
      return { refusal: 'organizationSuspended' };
    }
    if (store.branchMutationFailures.delete(organizationId)) {
      return { refusal: 'unavailable' };
    }
    return { refusal: null, organization, seatEntry };
  };

  /** TRUE iff the seat's scope reaches the branch (org-wide, or assigned +
   *  still ACTIVE — deactivation removes reach, exactly like the real
   *  principal resolution that lists assigned ACTIVE branches only). */
  const branchInFixtureScope = (
    seatEntry: FixtureMembershipSeat,
    branchRow: FixtureBranchState,
  ): boolean =>
    seatEntry.branchScope === 'all' ||
    (branchRow.active && seatEntry.branchScope.includes(branchRow.id));

  const copyBranch = (branchRow: FixtureBranchState) => ({
    ...branchRow,
    facilities: [...branchRow.facilities],
  });

  const branchPort: BranchPort = {
    /** Mirrors POST /provider/organizations/:organizationId/branches. */
    async createBranch(organizationId, input): Promise<CreateBranchOutcome> {
      const context = resolveBranchMutation(organizationId, 'branch.create');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      if (branchFieldsViolateConstraints(input)) {
        return { kind: 'validationError' };
      }
      store.createdBranchCount += 1;
      const branchRow: FixtureBranchState = {
        id: `${organizationId.slice(0, 8)}-created-${store.createdBranchCount}`,
        label: input.label,
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        areaLabel: input.areaLabel,
        geoPoint: input.geoPoint ?? null,
        openingHours: input.openingHours ?? null,
        facilities: input.facilities ? [...input.facilities] : [],
        active: true,
        version: 1,
      };
      context.organization.branches.push(branchRow);
      return { kind: 'branchCreated', branch: copyBranch(branchRow) };
    },

    /**
     * Mirrors PATCH .../branches/:branchId, including the service order:
     * org-scoped lookup (foreign/unknown ids are not-found-shaped by
     * construction) → branch-scope check (`forbidden`) → version CAS.
     */
    async updateBranch(
      organizationId,
      branchId,
      expectedVersion,
      patch,
    ): Promise<UpdateBranchOutcome> {
      const context = resolveBranchMutation(organizationId, 'branch.edit');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      if (branchFieldsViolateConstraints(patch)) {
        return { kind: 'validationError' };
      }
      const branchRow = context.organization.branches.find(
        (candidate) => candidate.id === branchId,
      );
      if (!branchRow) {
        return { kind: 'notFound' };
      }
      if (!branchInFixtureScope(context.seatEntry, branchRow)) {
        return { kind: 'forbidden' };
      }
      if (branchRow.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const apply = <K extends 'label' | 'areaLabel' | 'addressLine' | 'city'>(
        key: K,
        value: FixtureBranchState[K] | undefined,
      ) => {
        if (value !== undefined) {
          branchRow[key] = value;
        }
      };
      apply('label', patch.label);
      apply('areaLabel', patch.areaLabel);
      apply('addressLine', patch.addressLine);
      apply('city', patch.city);
      if (patch.geoPoint !== undefined) {
        branchRow.geoPoint = patch.geoPoint;
      }
      if (patch.openingHours !== undefined) {
        branchRow.openingHours = patch.openingHours;
      }
      if (patch.facilities !== undefined) {
        branchRow.facilities = [...patch.facilities];
      }
      branchRow.version += 1;
      return { kind: 'branchUpdated', branch: copyBranch(branchRow) };
    },

    /**
     * Mirrors POST .../branches/:branchId/deactivate — idempotent on an
     * already-inactive branch (no version change), CAS otherwise. There is
     * deliberately NO reactivation operation anywhere on this port.
     */
    async deactivateBranch(
      organizationId,
      branchId,
      expectedVersion,
    ): Promise<DeactivateBranchOutcome> {
      const context = resolveBranchMutation(organizationId, 'branch.deactivate');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const branchRow = context.organization.branches.find(
        (candidate) => candidate.id === branchId,
      );
      if (!branchRow) {
        return { kind: 'notFound' };
      }
      if (!branchRow.active) {
        return { kind: 'branchDeactivated' };
      }
      if (branchRow.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      branchRow.active = false;
      branchRow.version += 1;
      return { kind: 'branchDeactivated' };
    },
  };

  const areaPort: AreaReadPort = {
    /** Mirrors GET /catalogue/areas — active areas in deterministic order. */
    async listAreas() {
      if (store.areaLoadFailurePending) {
        store.areaLoadFailurePending = false;
        return { kind: 'unavailable' as const };
      }
      return { kind: 'loaded' as const, areas: areas.map((area) => ({ ...area })) };
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
    simulateConcurrentProfileEdit(organizationId) {
      const organization = organizations.get(organizationId);
      if (organization) {
        organization.profile.version += 1;
      }
    },
    failNextProfileLoad(organizationId) {
      store.profileLoadFailures.add(organizationId);
    },
    failNextProfileSave(organizationId) {
      store.profileSaveFailures.add(organizationId);
    },
    simulateConcurrentBranchEdit(organizationId, branchId) {
      const organization = organizations.get(organizationId);
      const branchRow = organization?.branches.find((candidate) => candidate.id === branchId);
      if (branchRow) {
        branchRow.version += 1;
      }
    },
    failNextBranchMutation(organizationId) {
      store.branchMutationFailures.add(organizationId);
    },
    failNextAreaLoad() {
      store.areaLoadFailurePending = true;
    },
  };

  const seedSession = (email: string) => {
    store.current = identities.find((identity) => identity.email === email) ?? null;
  };

  const sessionStateFor = (email: string) => {
    const identity = identities.find((candidate) => candidate.email === email);
    if (!identity) {
      return null;
    }
    return {
      identity: identityView(identity),
      assurance: assuranceOf(identity),
      memberships: membershipsOf(identity),
    };
  };

  return {
    adapter,
    accessPort,
    invitationPort,
    onboardingPort,
    profilePort,
    branchPort,
    areaPort,
    controls,
    seedSession,
    sessionStateFor,
  };
}
