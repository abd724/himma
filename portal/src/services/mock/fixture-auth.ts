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
import { ORG_WIDE_ONLY_ROLES } from '../../provider-access/contract';
import type { AreaReadPort, AreaRecord } from '../../taxonomy/contract';
import type {
  IssueInvitationOutcome,
  RevokeInvitationOutcome,
  RevokeMembershipOutcome,
  StaffInvitationRecord,
  StaffInvitationState,
  StaffLoadOutcome,
  StaffMembershipRecord,
  StaffMembershipState,
  TeamPort,
} from '../../team/contract';
import { INVITATION_FIELD_LIMITS } from '../../team/contract';

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

/**
 * Stable fictional Himma user ids — the ONLY member identity the real staff
 * read returns (`StaffMembershipView.userId`). Shared between the identity
 * directory (sign-in personas) and each organization's staff rows so the
 * caller's own membership is recognizable ("You") and W2-6 mutations stay
 * coherent with W2-2 provider-access truth.
 */
const fixtureUsers = {
  ranaOwner: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c01',
  omarDirector: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c02',
  hudaStages: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c03',
  amalNewOwner: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c04',
  yaraNewCoach: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c05',
  ramiAssistant: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c06',
  salemManager: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c07',
  danaFrontDesk: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c08',
  tariqFinance: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c09',
  linaCoach: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c10',
  samiFormer: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c11',
  nadiaListings: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c12',
  karimSuspended: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c13',
  // Members with no sign-in persona (real teams outnumber demo identities).
  faisalCoOwner: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c14',
  aquaCoach: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c15',
  formerFrontDesk: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c16',
  falconFrontDesk: '0198a2f0-5b7a-7000-8000-4d8e5f0a9c17',
} as const;

/** Mirrors the real `StaffMembershipView` row (mutable state/version). */
interface FixtureStaffMembership {
  readonly id: string;
  readonly userId: string;
  readonly role: ProviderRole;
  branchScopeKind: 'all' | 'branches';
  branchIds: string[];
  state: StaffMembershipState;
  readonly createdAt: string;
  version: number;
}

/**
 * Mirrors the real `StaffInvitationView` row. `token` is INTERNAL fixture
 * state modelling the digest-matched one-time code the target types on
 * `/invitation/:token` — it is never projected into any staff read
 * (the real response carries no token either).
 */
interface FixtureStaffInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: ProviderRole;
  readonly branchScopeKind: 'all' | 'branches';
  readonly branchIds: string[];
  state: StaffInvitationState;
  expiresAt: string;
  version: number;
  readonly token?: string;
}

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
  /** The org's staff truth — memberships incl. revoked history plus every
   *  invitation lifecycle state, exactly like the real staff read. */
  staff: {
    memberships: FixtureStaffMembership[];
    invitations: FixtureStaffInvitation[];
  };
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

  const daysFromNow = (days: number): string =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  const membershipRow = (
    suffix: string,
    userId: string,
    role: ProviderRole,
    createdAt: string,
    options: Partial<
      Pick<FixtureStaffMembership, 'branchScopeKind' | 'branchIds' | 'state' | 'version'>
    > = {},
  ): FixtureStaffMembership => ({
    id: `0198a2f0-5b7a-7000-8000-5e9f6a1b8d${suffix}`,
    userId,
    role,
    branchScopeKind: options.branchScopeKind ?? 'all',
    branchIds: options.branchIds ?? [],
    state: options.state ?? 'active',
    createdAt,
    version: options.version ?? 1,
  });

  const invitationRow = (
    suffix: string,
    email: string,
    role: ProviderRole,
    state: StaffInvitationState,
    expiresAt: string,
    options: Partial<
      Pick<FixtureStaffInvitation, 'branchScopeKind' | 'branchIds' | 'token' | 'version'>
    > = {},
  ): FixtureStaffInvitation => ({
    id: `0198a2f0-5b7a-7000-8000-6f0a7b2c9e${suffix}`,
    email,
    role,
    branchScopeKind: options.branchScopeKind ?? 'all',
    branchIds: options.branchIds ?? [],
    state,
    expiresAt,
    version: options.version ?? 1,
    ...(options.token !== undefined ? { token: options.token } : {}),
  });

  const soleOwnerStaff = (
    suffix: string,
    userId: string,
  ): FixtureOrganizationState['staff'] => ({
    memberships: [membershipRow(suffix, userId, 'owner', '2026-02-01T08:00:00.000Z')],
    invitations: [],
  });

  const org = (
    ref: { organizationId: string; displayName: string },
    verificationState: string,
    options: {
      legalName?: string;
      profile?: Partial<FixtureProfileState>;
      branches?: FixtureBranchState[];
      listingCount?: number;
      staff?: FixtureOrganizationState['staff'];
    } = {},
  ): FixtureOrganizationState => ({
    organizationId: ref.organizationId,
    tradeName: ref.displayName,
    legalName: options.legalName ?? `${ref.displayName} LLC`,
    verificationState,
    version: 3,
    staff: options.staff ?? { memberships: [], invitations: [] },
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
        staff: {
          memberships: [
            membershipRow('01', fixtureUsers.ranaOwner, 'owner', '2026-03-02T08:00:00.000Z'),
            // Second ACTIVE owner: proves multiple-owner truth and that
            // revoking a NON-last owner is permitted by the invariant.
            membershipRow('02', fixtureUsers.faisalCoOwner, 'owner', '2026-03-05T08:00:00.000Z'),
            membershipRow('03', fixtureUsers.omarDirector, 'org_manager', '2026-03-10T08:00:00.000Z'),
            membershipRow('04', fixtureUsers.salemManager, 'branch_manager', '2026-04-01T08:00:00.000Z', {
              branchScopeKind: 'branches',
              branchIds: [fixtureBranches.blueWaveMarina],
              version: 2,
            }),
            // Revoked row BETWEEN active ones: history stays in the read.
            membershipRow('05', fixtureUsers.formerFrontDesk, 'front_desk', '2026-04-03T08:00:00.000Z', {
              state: 'revoked',
              version: 2,
            }),
            membershipRow('06', fixtureUsers.nadiaListings, 'listings_editor', '2026-04-12T08:00:00.000Z'),
            membershipRow('07', fixtureUsers.aquaCoach, 'coach', '2026-05-06T08:00:00.000Z', {
              branchScopeKind: 'branches',
              branchIds: [fixtureBranches.blueWaveBay],
            }),
            membershipRow('08', fixtureUsers.danaFrontDesk, 'front_desk', '2026-05-20T08:00:00.000Z'),
            membershipRow('09', fixtureUsers.tariqFinance, 'finance', '2026-06-01T08:00:00.000Z'),
          ],
          invitations: [
            // Accepted long ago (the aqua coach's origin); finalized rows
            // are permanently immutable in the backend.
            invitationRow('01', 'aqua.coach@bluewave.example', 'coach', 'accepted', '2026-05-08T08:00:00.000Z', {
              branchScopeKind: 'branches',
              branchIds: [fixtureBranches.blueWaveBay],
            }),
            invitationRow('02', 'newcoach@bluewave.demo', 'coach', 'revoked', daysFromNow(4), {
              token: FIXTURE_INVITATIONS.revoked,
            }),
            // Live pending invitation — the same one the W2-3 acceptance
            // flow consumes (HIMMA-INVITE-STAFF-BLUEWAVE).
            invitationRow('03', 'newcoach@bluewave.demo', 'coach', 'sent', daysFromNow(5), {
              token: FIXTURE_INVITATIONS.staff,
            }),
            // Overdue but still `sent`: expiry is TIME truth before the
            // sweep finalizes it — not acceptable, still revocable.
            invitationRow('04', 'weekend.coach@bluewave.example', 'coach', 'sent', daysFromNow(-2), {
              branchScopeKind: 'branches',
              branchIds: [fixtureBranches.blueWaveMarina],
            }),
            // Sweep-finalized `expired` row.
            invitationRow('05', 'holiday.helper@bluewave.example', 'front_desk', 'expired', daysFromNow(-30)),
          ],
        },
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
        // Exactly ONE active owner: the last-active-owner invariant makes
        // this owner's own removal impossible until another owner exists.
        staff: {
          memberships: [
            membershipRow('0a', fixtureUsers.omarDirector, 'owner', '2026-02-10T08:00:00.000Z'),
            membershipRow('0b', fixtureUsers.linaCoach, 'coach', '2026-03-15T08:00:00.000Z', {
              branchScopeKind: 'branches',
              branchIds: [NOOR_BRANCH_ID],
            }),
          ],
          invitations: [],
        },
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
        // Suspended: the staff READ still works; every staff mutation is
        // refused with the canonical organizationSuspended outcome.
        staff: {
          memberships: [
            membershipRow('0c', fixtureUsers.omarDirector, 'owner', '2026-01-20T08:00:00.000Z'),
            membershipRow('0d', fixtureUsers.falconFrontDesk, 'front_desk', '2026-02-14T08:00:00.000Z'),
          ],
          invitations: [
            invitationRow('06', 'coach@falcon.example', 'coach', 'sent', daysFromNow(5)),
          ],
        },
        profile: {
          descriptionEn: 'Combat sports classes for teens and adults.',
          published: true,
        },
      }),
      // Fresh admin-created draft: profile shell empty, no branch yet, and
      // NO active owner membership until the founding invitation is
      // accepted (a pending owner invitation never counts as an owner).
      org(fixtureOrganizations.coral, 'draft', {
        profile: { displayName: '' },
        branches: [],
        staff: {
          memberships: [
            membershipRow('0e', fixtureUsers.ramiAssistant, 'coach', '2026-07-01T08:00:00.000Z'),
          ],
          invitations: [
            invitationRow('07', 'newowner@coral.demo', 'owner', 'sent', daysFromNow(6), {
              token: FIXTURE_INVITATIONS.foundingOwner,
            }),
            invitationRow('08', 'newowner@coral.demo', 'owner', 'expired', daysFromNow(-30), {
              token: FIXTURE_INVITATIONS.expired,
            }),
          ],
        },
      }),
      org(fixtureOrganizations.sunrise, 'submitted', {
        staff: soleOwnerStaff('0f', fixtureUsers.hudaStages),
      }),
      org(fixtureOrganizations.marina, 'in_review', {
        staff: soleOwnerStaff('10', fixtureUsers.hudaStages),
      }),
      org(fixtureOrganizations.desertBloom, 'rejected', {
        profile: { descriptionEn: 'Yoga and mindfulness studio for all levels.' },
        staff: soleOwnerStaff('11', fixtureUsers.hudaStages),
      }),
      // Verified + published storefront, NOT yet live: publication alone
      // never makes a provider publicly visible (live AND published).
      org(fixtureOrganizations.pearl, 'verified', {
        profile: {
          descriptionEn: 'Freediving courses and guided open-water sessions.',
          published: true,
        },
        staff: soleOwnerStaff('12', fixtureUsers.hudaStages),
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
  readonly userId: string;
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
      userId: fixtureUsers.ranaOwner,
      email: 'owner@bluewave.demo',
      displayName: 'Rana Haddad',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'owner')],
    },
    {
      userId: fixtureUsers.omarDirector,
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
      userId: fixtureUsers.hudaStages,
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
      userId: fixtureUsers.amalNewOwner,
      email: 'newowner@coral.demo',
      displayName: 'Amal Kassem',
      mfaEnrolled: true,
      memberships: [],
    },
    {
      userId: fixtureUsers.yaraNewCoach,
      email: 'newcoach@bluewave.demo',
      displayName: 'Yara Habib',
      mfaEnrolled: true,
      memberships: [],
    },
    {
      userId: fixtureUsers.ramiAssistant,
      email: 'assistant@coral.demo',
      displayName: 'Rami Odeh',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.coral, 'coach')],
    },
    {
      // Branch-scoped Branch Manager: edit reach = Dubai Marina pool ONLY
      // (the real org view still lists every branch — scope limits
      // MUTATION, never the org.read projection).
      userId: fixtureUsers.salemManager,
      email: 'manager@bluewave.demo',
      displayName: 'Salem Qassim',
      mfaEnrolled: true,
      memberships: [
        seat(fixtureOrganizations.blueWave, 'branch_manager', [fixtureBranches.blueWaveMarina]),
      ],
    },
    {
      userId: fixtureUsers.danaFrontDesk,
      email: 'frontdesk@bluewave.demo',
      displayName: 'Dana Mansour',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'front_desk')],
    },
    {
      userId: fixtureUsers.tariqFinance,
      email: 'finance@bluewave.demo',
      displayName: 'Tariq Aswad',
      mfaEnrolled: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'finance')],
    },
    {
      userId: fixtureUsers.linaCoach,
      email: 'coach@noor.demo',
      displayName: 'Lina Aziz',
      mfaEnrolled: false,
      memberships: [seat(fixtureOrganizations.noor, 'coach', [NOOR_BRANCH_ID])],
    },
    {
      userId: fixtureUsers.samiFormer,
      email: 'former@himma.demo',
      displayName: 'Sami Idris',
      mfaEnrolled: true,
      memberships: [],
    },
    {
      userId: fixtureUsers.nadiaListings,
      email: 'flaky@bluewave.demo',
      displayName: 'Nadia Rahman',
      mfaEnrolled: true,
      flakyAccess: true,
      memberships: [seat(fixtureOrganizations.blueWave, 'listings_editor')],
    },
    {
      userId: fixtureUsers.karimSuspended,
      email: 'suspended@himma.demo',
      displayName: 'Karim Nassar',
      mfaEnrolled: true,
      accountSuspended: true,
      memberships: [],
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
  staffLoadFailures: Set<string>;
  staffMutationFailures: Set<string>;
  invitationMailFailures: Set<string>;
  areaLoadFailurePending: boolean;
  createdBranchCount: number;
  createdStaffRowCount: number;
  /**
   * The Slice-2 recent-step-up window the `providerStepUp` policy checks:
   * a fresh MFA sign-in or a completed `/step-up` grant opens it (the real
   * HIMMA_MFA_STEP_UP_TTL default, 900 s); `providerStepUp` mutations refuse
   * with `stepUpRequired` once it has lapsed. Milliseconds epoch or null.
   */
  stepUpValidUntil: number | null;
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
  /**
   * Simulate the Slice-2 recent-step-up window lapsing (time passing since
   * the last MFA verification): the next `providerStepUp` staff mutation
   * receives the canonical `stepUpRequired` and the UI must route through
   * `/step-up` before retrying.
   */
  expireStepUpWindow(): void;
  /**
   * Simulate ANOTHER owner changing this membership row first (bumps its
   * version): the next revoke carrying the old `expectedVersion` receives
   * the canonical `staleVersion`.
   */
  simulateConcurrentStaffChange(organizationId: string, membershipId: string): void;
  /**
   * Simulate ANOTHER owner's session REVOKING a membership while this list
   * stays stale (row revoked + the person's access seat removed) — the way
   * a second-to-last owner disappears and the next owner revocation hits
   * the backend's last-active-owner refusal.
   */
  simulateConcurrentStaffRevocation(organizationId: string, membershipId: string): void;
  /** Make the next staff read fail transiently. */
  failNextStaffLoad(organizationId: string): void;
  /** Make the next staff/invitation mutation fail transiently. */
  failNextStaffMutation(organizationId: string): void;
  /** Make the next issued invitation report `mailDelivery: 'failed'`
   *  (the invitation is still created — exactly the real semantics). */
  failNextInvitationMail(organizationId: string): void;
}

export interface FixtureAuthRuntime {
  adapter: PortalAuthAdapter;
  accessPort: ProviderAccessPort;
  invitationPort: InvitationPort;
  onboardingPort: OnboardingPort;
  profilePort: OrganizationProfilePort;
  branchPort: BranchPort;
  areaPort: AreaReadPort;
  teamPort: TeamPort;
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

  const store: FixtureSessionStore = {
    current: null,
    pendingChallenge: null,
    revokedAccess: false,
    flakyFailuresRemaining: 0,
    usedRecoveryCodes: new Set(),
    profileLoadFailures: new Set(),
    profileSaveFailures: new Set(),
    branchMutationFailures: new Set(),
    staffLoadFailures: new Set(),
    staffMutationFailures: new Set(),
    invitationMailFailures: new Set(),
    areaLoadFailurePending: false,
    createdBranchCount: 0,
    createdStaffRowCount: 0,
    stepUpValidUntil: null,
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

  /** Mirrors HIMMA_MFA_STEP_UP_TTL_SECONDS default (900 s). */
  const STEP_UP_WINDOW_MS = 900_000;

  const openStepUpWindow = () => {
    store.stepUpValidUntil = Date.now() + STEP_UP_WINDOW_MS;
  };

  const hasRecentStepUp = (): boolean =>
    store.stepUpValidUntil !== null && store.stepUpValidUntil > Date.now();

  const stepUp = (valid: boolean): StepUpOutcome => {
    if (!store.current) {
      return { kind: 'failure' };
    }
    if (!valid) {
      return { kind: 'invalidCode' };
    }
    openStepUpWindow();
    return { kind: 'completed', expiresAt: new Date(store.stepUpValidUntil ?? 0).toISOString() };
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
      store.stepUpValidUntil = null;
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
      // A fresh MFA verification also satisfies the recent-step-up window
      // (exactly how the real providerStepUp policy composes).
      openStepUpWindow();
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
      store.stepUpValidUntil = null;
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
      // The invitation rows live on their organizations (the same rows the
      // owner's Team surface manages) — acceptance is the digest lookup.
      let organization: FixtureOrganizationState | undefined;
      let invitation: FixtureStaffInvitation | undefined;
      for (const candidate of organizations.values()) {
        invitation = candidate.staff.invitations.find((row) => row.token === token);
        if (invitation) {
          organization = candidate;
          break;
        }
      }
      if (!organization || !invitation || invitation.state !== 'sent') {
        return { kind: 'invitationInvalid' };
      }
      // Time truth: an overdue `sent` row refuses acceptance pre-sweep.
      if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
        return { kind: 'invitationInvalid' };
      }
      if (
        organization.verificationState === 'suspended' ||
        organization.verificationState === 'offboarded'
      ) {
        return { kind: 'invitationInvalid' };
      }
      // D-S3-1: verified-email match (fixture emails model verified emails).
      if (invitation.email !== caller.email) {
        return { kind: 'invitationInvalid' };
      }
      if (caller.memberships.some((seatEntry) => seatEntry.organizationId === organization.organizationId)) {
        return { kind: 'invitationInvalid' };
      }
      invitation.state = 'accepted';
      invitation.version += 1;
      store.createdStaffRowCount += 1;
      const membershipRow: FixtureStaffMembership = {
        id: `${organization.organizationId.slice(0, 8)}-staff-${store.createdStaffRowCount}`,
        userId: caller.userId,
        role: invitation.role,
        branchScopeKind: invitation.branchScopeKind,
        branchIds: [...invitation.branchIds],
        state: 'active',
        createdAt: new Date().toISOString(),
        version: 1,
      };
      organization.staff.memberships.push(membershipRow);
      caller.memberships = [
        ...caller.memberships,
        {
          organizationId: organization.organizationId,
          role: invitation.role,
          branchScope:
            invitation.branchScopeKind === 'all' ? 'all' : [...invitation.branchIds],
        },
      ];
      emit({ kind: 'accessChanged' });
      return {
        kind: 'invitationAccepted',
        organizationId: organization.organizationId,
        membershipId: membershipRow.id,
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
          // The caller's own ACTIVE staff row — the same id the staff read
          // returns, so the Team surface can recognize "You".
          id:
            organization.staff.memberships.find(
              (row) => row.userId === caller.userId && row.state === 'active',
            )?.id ?? `${organization.organizationId.slice(0, 8)}-membership-demo`,
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

  const projectMembership = (row: FixtureStaffMembership): StaffMembershipRecord => ({
    id: row.id,
    userId: row.userId,
    role: row.role,
    branchScopeKind: row.branchScopeKind,
    branchIds: [...row.branchIds],
    state: row.state,
    createdAt: row.createdAt,
    version: row.version,
  });

  /** The staff read carries NO token — enforced by construction here. */
  const projectInvitation = (row: FixtureStaffInvitation): StaffInvitationRecord => ({
    id: row.id,
    email: row.email,
    role: row.role,
    branchScopeKind: row.branchScopeKind,
    branchIds: [...row.branchIds],
    state: row.state,
    expiresAt: row.expiresAt,
    version: row.version,
  });

  /**
   * Shared staff-mutation gate mirroring the real `providerStepUp` pipeline
   * ORDER (identity/http/auth-plugin.ts): live session → org-scope
   * resolution (not-found shaping) → recent step-up → declared capability →
   * suspended-organization mutation refusal. The fixture's transient-failure
   * seam runs last, like a network fault on an authorized call.
   */
  const resolveStaffMutation = (
    organizationId: string,
  ):
    | {
        refusal:
          | 'unavailable'
          | 'notFound'
          | 'stepUpRequired'
          | 'forbidden'
          | 'organizationSuspended';
      }
    | { refusal: null; organization: FixtureOrganizationState; caller: FixtureIdentity } => {
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
    if (!hasRecentStepUp()) {
      return { refusal: 'stepUpRequired' };
    }
    if (!ROLE_CAPABILITIES[seatEntry.role].includes('staff.manage')) {
      return { refusal: 'forbidden' };
    }
    if (organization.verificationState === 'suspended') {
      return { refusal: 'organizationSuspended' };
    }
    if (store.staffMutationFailures.delete(organizationId)) {
      return { refusal: 'unavailable' };
    }
    return { refusal: null, organization, caller };
  };

  const removeSeatFor = (membershipRow: FixtureStaffMembership, organizationId: string) => {
    const identity = identities.find((candidate) => candidate.userId === membershipRow.userId);
    if (!identity) {
      return;
    }
    identity.memberships = identity.memberships.filter(
      (seatEntry) => seatEntry.organizationId !== organizationId,
    );
    if (store.current?.userId === identity.userId) {
      // The caller changed their OWN access — the portal must re-resolve
      // rather than continue on stale authority (task §19).
      emit({ kind: 'accessChanged' });
    }
  };

  const teamPort: TeamPort = {
    /**
     * Mirrors GET /provider/organizations/:organizationId/staff (policy
     * `provider`, capability `staff.read` — owner only). Reads still work
     * for a suspended organization; every row and every lifecycle state is
     * returned, exactly like the real composed read.
     */
    async loadStaff(organizationId): Promise<StaffLoadOutcome> {
      const caller = store.current;
      if (!caller) {
        return { kind: 'unavailable' };
      }
      if (store.staffLoadFailures.delete(organizationId)) {
        return { kind: 'unavailable' };
      }
      const organization = organizations.get(organizationId);
      const seatEntry = caller.memberships.find(
        (candidate) => candidate.organizationId === organizationId,
      );
      if (!organization || !seatEntry || organization.verificationState === 'offboarded') {
        return { kind: 'notFound' };
      }
      if (!ROLE_CAPABILITIES[seatEntry.role].includes('staff.read')) {
        return { kind: 'forbidden' };
      }
      return {
        kind: 'loaded',
        staff: {
          memberships: organization.staff.memberships.map(projectMembership),
          invitations: organization.staff.invitations.map(projectInvitation),
        },
      };
    },

    /**
     * Mirrors POST .../staff/invitations (policy `providerStepUp`,
     * capability `staff.manage`), including the service semantics: TypeBox
     * body validation → org-wide-only role scope rule → branch existence +
     * active check against THIS organization → supersede any still-`sent`
     * invitation for the same normalized address → insert → mail delivery
     * reported without rolling back. No token in the response, ever.
     */
    async issueInvitation(organizationId, input): Promise<IssueInvitationOutcome> {
      const context = resolveStaffMutation(organizationId);
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const email = input.email.trim().toLowerCase();
      if (
        email.length === 0 ||
        email.length > INVITATION_FIELD_LIMITS.email ||
        email.indexOf('@') < 1 ||
        email.includes(' ')
      ) {
        return { kind: 'validationError' };
      }
      if (ORG_WIDE_ONLY_ROLES.includes(input.role) && input.branchScope !== 'all') {
        return { kind: 'invalidBranchScope' };
      }
      let branchScopeKind: 'all' | 'branches' = 'all';
      let branchIds: string[] = [];
      if (input.branchScope !== 'all') {
        const uniqueIds = [...new Set(input.branchScope)];
        if (uniqueIds.length === 0 || uniqueIds.length > INVITATION_FIELD_LIMITS.branchScopeMax) {
          return { kind: 'invalidBranchScope' };
        }
        const rows = uniqueIds.map((branchId) =>
          context.organization.branches.find((candidate) => candidate.id === branchId),
        );
        // Every scoped branch must belong to THIS organization and be
        // active at issue time — foreign ids are indistinguishable from
        // unknown ones (no enumeration oracle).
        if (rows.some((row) => row === undefined || !row.active)) {
          return { kind: 'invalidBranchScope' };
        }
        branchScopeKind = 'branches';
        branchIds = uniqueIds;
      }
      // Approved resend policy: a still-`sent` invitation for the same
      // address is revoked in the same transaction (superseded).
      for (const row of context.organization.staff.invitations) {
        if (row.email === email && row.state === 'sent') {
          row.state = 'revoked';
          row.version += 1;
        }
      }
      store.createdStaffRowCount += 1;
      const invitation: FixtureStaffInvitation = {
        id: `${organizationId.slice(0, 8)}-invite-${store.createdStaffRowCount}`,
        email,
        role: input.role,
        branchScopeKind,
        branchIds,
        state: 'sent',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        version: 1,
      };
      context.organization.staff.invitations.push(invitation);
      const mailDelivery = store.invitationMailFailures.delete(organizationId)
        ? ('failed' as const)
        : ('delivered' as const);
      return {
        kind: 'invitationIssued',
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt,
        mailDelivery,
      };
    },

    /**
     * Mirrors POST .../staff/invitations/:invitationId/revoke — idempotent
     * on an already-revoked row; accepted/expired rows are finalized
     * (`lifecycleConflict`); org-scoped lookup keeps foreign ids
     * not-found-shaped.
     */
    async revokeInvitation(organizationId, invitationId): Promise<RevokeInvitationOutcome> {
      const context = resolveStaffMutation(organizationId);
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const invitation = context.organization.staff.invitations.find(
        (candidate) => candidate.id === invitationId,
      );
      if (!invitation) {
        return { kind: 'notFound' };
      }
      if (invitation.state === 'revoked') {
        return { kind: 'invitationRevoked' };
      }
      if (invitation.state !== 'sent') {
        return { kind: 'lifecycleConflict' };
      }
      invitation.state = 'revoked';
      invitation.version += 1;
      return { kind: 'invitationRevoked' };
    },

    /**
     * Mirrors POST .../staff/memberships/:membershipId/revoke — version CAS
     * (`staleVersion`), idempotent on an already-revoked row, and the
     * database-level last-active-owner refusal (`lastOwnerProtected`).
     * Self-revocation is permitted exactly like the backend (the invariant
     * is the only blocker); a revoked identity's access seat disappears and
     * the portal re-resolves if it was the caller's own.
     */
    async revokeMembership(
      organizationId,
      membershipId,
      expectedVersion,
    ): Promise<RevokeMembershipOutcome> {
      const context = resolveStaffMutation(organizationId);
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const membership = context.organization.staff.memberships.find(
        (candidate) => candidate.id === membershipId,
      );
      if (!membership) {
        return { kind: 'notFound' };
      }
      if (membership.state === 'revoked') {
        return { kind: 'membershipRevoked' };
      }
      if (membership.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      if (membership.role === 'owner') {
        const otherActiveOwner = context.organization.staff.memberships.some(
          (candidate) =>
            candidate.id !== membership.id &&
            candidate.role === 'owner' &&
            candidate.state === 'active',
        );
        // Pending owner INVITATIONS never count toward the invariant.
        if (!otherActiveOwner) {
          return { kind: 'lastOwnerProtected' };
        }
      }
      membership.state = 'revoked';
      membership.version += 1;
      removeSeatFor(membership, organizationId);
      return { kind: 'membershipRevoked' };
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
      store.stepUpValidUntil = null;
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
    expireStepUpWindow() {
      store.stepUpValidUntil = null;
    },
    simulateConcurrentStaffChange(organizationId, membershipId) {
      const membership = organizations
        .get(organizationId)
        ?.staff.memberships.find((candidate) => candidate.id === membershipId);
      if (membership) {
        membership.version += 1;
      }
    },
    simulateConcurrentStaffRevocation(organizationId, membershipId) {
      const organization = organizations.get(organizationId);
      const membership = organization?.staff.memberships.find(
        (candidate) => candidate.id === membershipId,
      );
      if (!organization || !membership || membership.state !== 'active') {
        return;
      }
      membership.state = 'revoked';
      membership.version += 1;
      const identity = identities.find((candidate) => candidate.userId === membership.userId);
      if (identity) {
        identity.memberships = identity.memberships.filter(
          (seatEntry) => seatEntry.organizationId !== organizationId,
        );
      }
    },
    failNextStaffLoad(organizationId) {
      store.staffLoadFailures.add(organizationId);
    },
    failNextStaffMutation(organizationId) {
      store.staffMutationFailures.add(organizationId);
    },
    failNextInvitationMail(organizationId) {
      store.invitationMailFailures.add(organizationId);
    },
  };

  const seedSession = (email: string) => {
    store.current = identities.find((identity) => identity.email === email) ?? null;
    // A seeded session models a FRESH MFA sign-in (the render harness's
    // authenticated seam); tests exercising the lapsed-window choreography
    // call controls.expireStepUpWindow() explicitly.
    store.stepUpValidUntil = store.current?.mfaEnrolled ? Date.now() + STEP_UP_WINDOW_MS : null;
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
    teamPort,
    controls,
    seedSession,
    sessionStateFor,
  };
}
