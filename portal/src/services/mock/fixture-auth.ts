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
import type {
  ListingDetailOutcome,
  ListingsReadPort,
  ListListingsOutcome,
  OfferRecord,
  OpenRevisionRecord,
  PriceOptionRecord,
  ProgramDetailRecord,
  ProgramMediaRecord,
  ProgramSummaryRecord,
} from '../../catalogue/contract';
import type {
  AddBranchAssociationOutcome,
  AddMediaOutcome,
  AddOfferOutcome,
  AddPriceOptionOutcome,
  ArchiveMediaOutcome,
  ArchivePriceOptionOutcome,
  CreateProgramOutcome,
  EndOfferOutcome,
  ListingEditorPort,
  MediaInput,
  MediaPatch,
  OfferInput,
  OfferPatch,
  PriceOptionInput,
  PriceOptionPatch,
  ProgramCreateInput,
  ProgramPatch,
  RemoveBranchAssociationOutcome,
  UpdateMediaOutcome,
  UpdateOfferOutcome,
  UpdatePriceOptionOutcome,
  UpdateProgramOutcome,
} from '../../catalogue/editor-contract';
import type {
  ArchiveProgramOutcome,
  CompletenessGap,
  ListingLifecyclePort,
  PauseProgramOutcome,
  PublishProgramOutcome,
  SubmitProgramOutcome,
} from '../../catalogue/lifecycle-contract';
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
import type {
  ActivityTypeReadPort,
  ActivityTypeRecord,
  AreaReadPort,
  AreaRecord,
} from '../../taxonomy/contract';
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
  falconQuoz: '0198a2f0-5b7a-7000-8000-2b6c3e8f7a21',
  pearlLagoon: '0198a2f0-5b7a-7000-8000-2b6c3e8f7a31',
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

/**
 * Fixture activity-type taxonomy — DB-managed reference data (D-S4-3). The
 * PRIVATE directory keeps the `active` flag (the provider detail projection
 * embeds it); the PUBLIC read (`GET /catalogue/activity-types`) serves only
 * ACTIVE rows, which is why a listing referencing a deactivated type simply
 * has no label in the public read.
 */
interface FixtureActivityType {
  readonly id: string;
  readonly slug: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly categoryId: string;
  readonly active: boolean;
}

const fixtureCategoryIds = {
  aquatics: '0198a2f0-5b7a-7000-8000-3a7b4c9d5e01',
  fitness: '0198a2f0-5b7a-7000-8000-3a7b4c9d5e02',
  education: '0198a2f0-5b7a-7000-8000-3a7b4c9d5e03',
  combat: '0198a2f0-5b7a-7000-8000-3a7b4c9d5e04',
} as const;

export const fixtureActivityTypes = {
  swimming: '0198a2f0-5b7a-7000-8000-2f6a3b8c4d01',
  aquaFitness: '0198a2f0-5b7a-7000-8000-2f6a3b8c4d02',
  learningSupport: '0198a2f0-5b7a-7000-8000-2f6a3b8c4d03',
  kickboxing: '0198a2f0-5b7a-7000-8000-2f6a3b8c4d04',
  /** Deactivated taxonomy row — absent from the public read; a listing that
   *  still references it carries `activityType.active: false` in its detail
   *  and fails the `activeTaxonomy` completeness requirement. */
  synchronizedSwimming: '0198a2f0-5b7a-7000-8000-2f6a3b8c4d05',
} as const;

function activityTypeDirectory(): FixtureActivityType[] {
  return [
    {
      id: fixtureActivityTypes.swimming,
      slug: 'swimming',
      labelEn: 'Swimming',
      labelAr: null,
      categoryId: fixtureCategoryIds.aquatics,
      active: true,
    },
    {
      id: fixtureActivityTypes.aquaFitness,
      slug: 'aqua-fitness',
      labelEn: 'Aqua Fitness',
      labelAr: null,
      categoryId: fixtureCategoryIds.fitness,
      active: true,
    },
    {
      id: fixtureActivityTypes.learningSupport,
      slug: 'learning-support',
      labelEn: 'Learning Support',
      labelAr: null,
      categoryId: fixtureCategoryIds.education,
      active: true,
    },
    {
      id: fixtureActivityTypes.kickboxing,
      slug: 'kickboxing',
      labelEn: 'Kickboxing',
      labelAr: null,
      categoryId: fixtureCategoryIds.combat,
      active: true,
    },
    {
      id: fixtureActivityTypes.synchronizedSwimming,
      slug: 'synchronized-swimming',
      labelEn: 'Synchronized Swimming',
      labelAr: null,
      categoryId: fixtureCategoryIds.aquatics,
      active: false,
    },
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

/** Mirrors program_price_option (D-S4-1 child; stable id, archive-only). */
interface FixturePriceOption {
  readonly id: string;
  readonly kind: string;
  readonly amountFils: number | null;
  readonly sessionsCount: number | null;
  readonly labelEn: string | null;
  readonly labelAr: string | null;
  readonly sortHint: number;
  readonly state: 'active' | 'archived';
  readonly version: number;
}

/** Mirrors program_branch (append-only association; remove = active=false). */
interface FixtureProgramBranch {
  readonly branchId: string;
  readonly active: boolean;
  readonly version: number;
}

interface FixtureProgramMedia {
  readonly id: string;
  readonly mediaRef: string;
  readonly sortHint: number;
  readonly altTextEn: string | null;
  readonly altTextAr: string | null;
  readonly active: boolean;
  readonly version: number;
}

interface FixtureOffer {
  readonly id: string;
  readonly kind: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  readonly trialAmountFils: number | null;
  readonly effectiveStart: string | null;
  readonly effectiveEnd: string | null;
  readonly state: 'active' | 'ended';
  readonly version: number;
}

/** Mirrors the `program` row + its S4 children — exactly the fields the
 *  real provider-private projections serve; nothing operational (bookings,
 *  capacity, sessions, revenue…) exists here because the backend owns no
 *  such truth yet. */
interface FixtureProgramState {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly activityTypeId: string;
  readonly setting: 'indoor' | 'outdoor';
  readonly minAge: number | null;
  readonly maxAge: number | null;
  readonly allAges: boolean;
  readonly genderEligibility: string;
  readonly skillLevel: string | null;
  readonly eligibilityNotes: string | null;
  readonly listingState: string;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly sensitiveFieldsVersion: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly priceOptions: readonly FixturePriceOption[];
  readonly branchAssociations: readonly FixtureProgramBranch[];
  readonly media: readonly FixtureProgramMedia[];
  readonly offers: readonly FixtureOffer[];
  readonly openRevision: { id: string; state: string; createdAt: string; version: number } | null;
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
  /** The org's catalogue truth — every listing in every lifecycle state,
   *  exactly the entities the real provider-private reads serve. */
  programs: FixtureProgramState[];
  /** The org's staff truth — memberships incl. revoked history plus every
   *  invitation lifecycle state, exactly like the real staff read. */
  staff: {
    memberships: FixtureStaffMembership[];
    invitations: FixtureStaffInvitation[];
  };
}

/** Stable listing ids (exported for tests and deep-link fixtures). */
export const fixtureListings = {
  adultSwimming: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f01',
  juniorSquad: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f02',
  ladiesAqua: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f03',
  privateCoaching: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f04',
  holidayCamp: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f05',
  schoolTerm: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f06',
  strokeClinic: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f07',
  aquaTherapy: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f08',
  mastersTraining: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f09',
  sunsetOpenWater: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f10',
  synchroSquad: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f11',
  aquaExpress: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f12',
  noorAfterSchool: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f21',
  noorExamPrep: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f22',
  falconKickboxing: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f31',
  pearlFreediving: '0198a2f0-5b7a-7000-8000-7a1b8c3d9f41',
} as const;

const priceOption = (
  suffix: string,
  kind: string,
  amountFils: number | null,
  options: Partial<
    Pick<FixturePriceOption, 'sessionsCount' | 'labelEn' | 'sortHint' | 'state'>
  > = {},
): FixturePriceOption => ({
  id: `0198a2f0-5b7a-7000-8000-8b2c9d4e0a${suffix}`,
  kind,
  amountFils,
  sessionsCount: options.sessionsCount ?? null,
  labelEn: options.labelEn ?? null,
  labelAr: null,
  sortHint: options.sortHint ?? 10,
  state: options.state ?? 'active',
  version: 1,
});

const mediaRow = (
  suffix: string,
  altTextEn: string | null,
  options: Partial<Pick<FixtureProgramMedia, 'active' | 'sortHint'>> = {},
): FixtureProgramMedia => ({
  id: `0198a2f0-5b7a-7000-8000-9c3d0e5f1b${suffix}`,
  mediaRef: `0198a2f0-5b7a-7000-8000-4b8c5d0e6f${suffix}`,
  sortHint: options.sortHint ?? 10,
  altTextEn,
  altTextAr: null,
  active: options.active ?? true,
  version: 1,
});

const offerRow = (
  suffix: string,
  kind: string,
  labelEn: string,
  options: Partial<
    Pick<FixtureOffer, 'trialAmountFils' | 'effectiveStart' | 'effectiveEnd' | 'state'>
  > = {},
): FixtureOffer => ({
  id: `0198a2f0-5b7a-7000-8000-0d4e1f6a2c${suffix}`,
  kind,
  labelEn,
  labelAr: null,
  trialAmountFils: options.trialAmountFils ?? null,
  effectiveStart: options.effectiveStart ?? null,
  effectiveEnd: options.effectiveEnd ?? null,
  state: options.state ?? 'active',
  version: 1,
});

const programRow = (
  id: string,
  titleEn: string,
  activityTypeId: string,
  listingState: string,
  createdAt: string,
  options: Partial<Omit<FixtureProgramState, 'id' | 'titleEn' | 'activityTypeId' | 'listingState' | 'createdAt'>> = {},
): FixtureProgramState => ({
  id,
  titleEn,
  titleAr: options.titleAr ?? null,
  descriptionEn: options.descriptionEn ?? null,
  descriptionAr: options.descriptionAr ?? null,
  activityTypeId,
  setting: options.setting ?? 'indoor',
  minAge: options.minAge ?? null,
  maxAge: options.maxAge ?? null,
  allAges: options.allAges ?? false,
  genderEligibility: options.genderEligibility ?? 'mixed',
  skillLevel: options.skillLevel ?? null,
  eligibilityNotes: options.eligibilityNotes ?? null,
  listingState,
  publishedAt: options.publishedAt ?? null,
  archivedAt: options.archivedAt ?? null,
  sensitiveFieldsVersion: options.sensitiveFieldsVersion ?? 1,
  version: options.version ?? 2,
  createdAt,
  updatedAt: options.updatedAt ?? createdAt,
  priceOptions: options.priceOptions ?? [],
  branchAssociations: options.branchAssociations ?? [],
  media: options.media ?? [],
  offers: options.offers ?? [],
  openRevision: options.openRevision ?? null,
});

const association = (branchId: string, active = true): FixtureProgramBranch => ({
  branchId,
  active,
  version: 1,
});

/**
 * Blue Wave catalogue — every docs/24 §5.3 lifecycle state, a multi-option
 * flagship listing (ONE listing, several ProgramPriceOptions — D-S4-1), an
 * archived option, multi-branch and inactive-branch associations, offers
 * (informational — never checkout math), a pending revision, and drafts
 * with each real completeness gap. Amounts are integer fils (AED × 100).
 */
function blueWaveProgramRows(): FixtureProgramState[] {
  return [
    programRow(fixtureListings.adultSwimming, 'Adult Beginner Swimming', fixtureActivityTypes.swimming, 'published', '2026-04-02T08:00:00.000Z', {
      descriptionEn:
        'Small-group swimming classes for adults starting from zero — water confidence, breathing, and freestyle foundations with certified coaches.',
      minAge: 16,
      skillLevel: 'beginner',
      publishedAt: '2026-05-10T08:00:00.000Z',
      updatedAt: '2026-07-28T08:00:00.000Z',
      priceOptions: [
        priceOption('01', 'monthly', 45_000, { sortHint: 10 }),
        priceOption('02', 'term', 120_000, { labelEn: '3 months', sortHint: 20 }),
        priceOption('03', 'dropIn', 6_000, { sortHint: 30, state: 'archived' }),
      ],
      branchAssociations: [
        association(fixtureBranches.blueWaveMarina),
        association(fixtureBranches.blueWaveBay),
        // Historical association, removed (active=false) — history is kept.
        association(fixtureBranches.blueWaveSufouh, false),
      ],
      media: [
        mediaRow('01', 'Coach guiding an adult swimmer in the training pool', { sortHint: 10 }),
        mediaRow('02', null, { sortHint: 20, active: false }),
      ],
      offers: [offerRow('01', 'freeTrial', 'Free trial session')],
    }),
    programRow(fixtureListings.juniorSquad, 'Junior Swim Squad', fixtureActivityTypes.swimming, 'published', '2026-04-06T08:00:00.000Z', {
      descriptionEn: 'Competitive squad training for confident young swimmers.',
      minAge: 8,
      maxAge: 14,
      skillLevel: 'intermediate',
      publishedAt: '2026-05-12T08:00:00.000Z',
      updatedAt: '2026-08-01T08:00:00.000Z',
      priceOptions: [priceOption('04', 'term', 90_000, { labelEn: 'School term' })],
      branchAssociations: [association(fixtureBranches.blueWaveBay)],
      openRevision: {
        id: '0198a2f0-5b7a-7000-8000-1e5f2a7b3d01',
        state: 'submitted',
        createdAt: '2026-08-01T08:00:00.000Z',
        version: 1,
      },
    }),
    programRow(fixtureListings.ladiesAqua, 'Ladies Aqua Fitness', fixtureActivityTypes.aquaFitness, 'published', '2026-04-10T08:00:00.000Z', {
      descriptionEn: 'Low-impact water workouts in a ladies-only environment.',
      allAges: false,
      minAge: 16,
      genderEligibility: 'women',
      skillLevel: 'all-levels',
      publishedAt: '2026-05-15T08:00:00.000Z',
      priceOptions: [priceOption('05', 'dropIn', 8_000)],
      branchAssociations: [association(fixtureBranches.blueWaveMarina)],
      offers: [
        offerRow('02', 'paidTrial', 'Trial class', { trialAmountFils: 2_500 }),
      ],
    }),
    programRow(fixtureListings.privateCoaching, 'Private Swim Coaching', fixtureActivityTypes.swimming, 'approved', '2026-04-20T08:00:00.000Z', {
      descriptionEn: 'One-to-one stroke coaching tailored to your goals.',
      allAges: true,
      priceOptions: [
        priceOption('06', 'package', 160_000, { sessionsCount: 8, labelEn: '8 sessions' }),
      ],
      branchAssociations: [association(fixtureBranches.blueWaveBay)],
    }),
    programRow(fixtureListings.holidayCamp, 'Holiday Swim Camp', fixtureActivityTypes.swimming, 'draft', '2026-05-04T08:00:00.000Z', {
      descriptionEn: 'A week of water skills, games, and safety for children.',
      minAge: 6,
      maxAge: 12,
      setting: 'outdoor',
      priceOptions: [priceOption('07', 'camp', 120_000, { labelEn: 'Camp week' })],
      // No branch association yet — a draft not placed anywhere (reachable
      // by every branch scope, exactly like the real list filter).
      branchAssociations: [],
    }),
    programRow(fixtureListings.schoolTerm, 'School Term Program', fixtureActivityTypes.swimming, 'submitted', '2026-05-20T08:00:00.000Z', {
      minAge: 6,
      maxAge: 16,
      priceOptions: [priceOption('08', 'term', 75_000)],
      branchAssociations: [association(fixtureBranches.blueWaveBay)],
    }),
    programRow(fixtureListings.strokeClinic, 'Stroke Development Clinic', fixtureActivityTypes.swimming, 'in_review', '2026-06-01T08:00:00.000Z', {
      skillLevel: 'advanced',
      minAge: 12,
      priceOptions: [priceOption('09', 'dropIn', 9_000)],
      branchAssociations: [association(fixtureBranches.blueWaveMarina)],
    }),
    programRow(fixtureListings.aquaTherapy, 'Aqua Therapy Sessions', fixtureActivityTypes.aquaFitness, 'changes_requested', '2026-06-10T08:00:00.000Z', {
      descriptionEn: 'Gentle guided water therapy for recovery and mobility.',
      allAges: true,
      priceOptions: [priceOption('10', 'dropIn', 10_000)],
      branchAssociations: [association(fixtureBranches.blueWaveMarina)],
    }),
    programRow(fixtureListings.mastersTraining, 'Masters Training', fixtureActivityTypes.swimming, 'paused', '2026-06-18T08:00:00.000Z', {
      minAge: 18,
      skillLevel: 'advanced',
      publishedAt: '2026-07-01T08:00:00.000Z',
      priceOptions: [priceOption('11', 'monthly', 52_000)],
      branchAssociations: [
        association(fixtureBranches.blueWaveMarina),
        association(fixtureBranches.blueWaveBay),
      ],
      offers: [
        offerRow('03', 'discount', 'Founding members offer', {
          effectiveStart: '2026-06-20T00:00:00.000Z',
          effectiveEnd: '2026-07-20T00:00:00.000Z',
          state: 'ended',
        }),
      ],
    }),
    programRow(fixtureListings.sunsetOpenWater, 'Sunset Open Water Program', fixtureActivityTypes.swimming, 'archived', '2026-06-25T08:00:00.000Z', {
      setting: 'outdoor',
      minAge: 18,
      publishedAt: '2026-07-02T08:00:00.000Z',
      archivedAt: '2026-07-30T08:00:00.000Z',
      priceOptions: [priceOption('12', 'monthly', 40_000)],
      branchAssociations: [
        association(fixtureBranches.blueWaveBay),
        // Association still active while its BRANCH is deactivated — the
        // branch row renders truthfully as a deactivated location.
        association(fixtureBranches.blueWaveSufouh),
      ],
    }),
    programRow(fixtureListings.synchroSquad, 'Synchro Performance Squad', fixtureActivityTypes.synchronizedSwimming, 'draft', '2026-07-08T08:00:00.000Z', {
      minAge: 10,
      maxAge: 17,
      priceOptions: [priceOption('13', 'term', 110_000)],
      branchAssociations: [association(fixtureBranches.blueWaveMarina)],
    }),
    programRow(fixtureListings.aquaExpress, 'Aqua Fitness Express', fixtureActivityTypes.aquaFitness, 'draft', '2026-07-15T08:00:00.000Z', {
      allAges: false,
      minAge: 16,
      // No price option yet — the `activePriceOption` completeness gap.
      priceOptions: [],
      branchAssociations: [association(fixtureBranches.blueWaveMarina)],
    }),
  ];
}

function noorProgramRows(): FixtureProgramState[] {
  return [
    programRow(fixtureListings.noorAfterSchool, 'After-School Learning Support', fixtureActivityTypes.learningSupport, 'published', '2026-03-20T08:00:00.000Z', {
      descriptionEn: 'Daily homework help and structured learning support.',
      minAge: 6,
      maxAge: 14,
      publishedAt: '2026-04-15T08:00:00.000Z',
      priceOptions: [priceOption('21', 'monthly', 65_000)],
      branchAssociations: [association(fixtureBranches.noorBarsha)],
    }),
    programRow(fixtureListings.noorExamPrep, 'Exam Prep Intensive', fixtureActivityTypes.learningSupport, 'draft', '2026-07-01T08:00:00.000Z', {
      minAge: 13,
      maxAge: 18,
      priceOptions: [
        priceOption('22', 'package', 140_000, { sessionsCount: 10, labelEn: '10 sessions' }),
      ],
      branchAssociations: [association(fixtureBranches.noorBarsha)],
    }),
  ];
}

/**
 * Pearl Freediving — verified but NOT yet live: its complete APPROVED
 * listing exercises the real `organizationNotLive` publication gate (the
 * listing itself meets every completeness requirement; the block is the
 * ORGANIZATION's verification state, docs/28 §6).
 */
function pearlProgramRows(): FixtureProgramState[] {
  return [
    programRow(fixtureListings.pearlFreediving, 'Freediving Foundations', fixtureActivityTypes.swimming, 'approved', '2026-07-20T08:00:00.000Z', {
      descriptionEn: 'Two-day freediving foundation course — breathwork, safety, and first depth sessions.',
      minAge: 18,
      skillLevel: 'beginner',
      priceOptions: [priceOption('41', 'package', 95_000, { sessionsCount: 4, labelEn: '4 sessions' })],
      branchAssociations: [association(fixtureBranches.pearlLagoon)],
    }),
  ];
}

function falconProgramRows(): FixtureProgramState[] {
  return [
    programRow(fixtureListings.falconKickboxing, 'Teen Kickboxing Fundamentals', fixtureActivityTypes.kickboxing, 'published', '2026-02-10T08:00:00.000Z', {
      minAge: 13,
      maxAge: 17,
      publishedAt: '2026-03-01T08:00:00.000Z',
      priceOptions: [priceOption('31', 'monthly', 38_000)],
      branchAssociations: [association(fixtureBranches.falconQuoz)],
    }),
  ];
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
      programs?: FixtureProgramState[];
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
    programs: options.programs ?? [],
  });

  return new Map(
    [
      org(fixtureOrganizations.blueWave, 'live', {
        programs: blueWaveProgramRows(),
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
        programs: noorProgramRows(),
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
        programs: falconProgramRows(),
        branches: [
          branch(fixtureOrganizations.falcon.organizationId, fixtureBranches.falconQuoz, 'Al Quoz dojo', 'Al Barsha'),
        ],
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
        branches: [
          branch(fixtureOrganizations.pearl.organizationId, fixtureBranches.pearlLagoon, 'Lagoon Training Center', 'Palm Jumeirah'),
        ],
        programs: pearlProgramRows(),
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
  listingsLoadFailures: Set<string>;
  listingDetailFailures: Set<string>;
  listingMutationFailures: Set<string>;
  areaLoadFailurePending: boolean;
  activityTypesLoadFailurePending: boolean;
  createdBranchCount: number;
  createdStaffRowCount: number;
  createdCatalogueRowCount: number;
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
  /** Make the next listings-index read fail transiently. */
  failNextListingsLoad(organizationId: string): void;
  /** Make the next listing-detail read fail transiently. */
  failNextListingDetailLoad(organizationId: string): void;
  /** Make the next activity-type taxonomy read fail transiently. */
  failNextActivityTypesLoad(): void;
  /** Make the next catalogue mutation fail transiently. */
  failNextListingMutation(organizationId: string): void;
  /**
   * Simulate ANOTHER staff member saving the listing while this editor is
   * open (bumps the program row's version): the next program mutation
   * carrying the old `expectedVersion` receives the canonical `staleVersion`.
   */
  simulateConcurrentListingEdit(organizationId: string, programId: string): void;
  /** Same concurrency simulation for one ProgramPriceOption row. */
  simulateConcurrentPriceOptionEdit(
    organizationId: string,
    programId: string,
    optionId: string,
  ): void;
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
  listingsPort: ListingsReadPort;
  listingEditorPort: ListingEditorPort;
  listingLifecyclePort: ListingLifecyclePort;
  activityTypePort: ActivityTypeReadPort;
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
    listingsLoadFailures: new Set(),
    listingDetailFailures: new Set(),
    listingMutationFailures: new Set(),
    areaLoadFailurePending: false,
    activityTypesLoadFailurePending: false,
    createdBranchCount: 0,
    createdStaffRowCount: 0,
    createdCatalogueRowCount: 0,
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
      listingCount: capabilities.includes('catalogue.read')
        ? organization.programs.length
        : null,
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

  const activityTypes = activityTypeDirectory();

  const activityTypePort: ActivityTypeReadPort = {
    /** Mirrors GET /catalogue/activity-types — ACTIVE rows only, no
     *  synonyms/admin metadata (deactivated types are simply absent). */
    async listActivityTypes() {
      if (store.activityTypesLoadFailurePending) {
        store.activityTypesLoadFailurePending = false;
        return { kind: 'unavailable' as const };
      }
      const records: ActivityTypeRecord[] = activityTypes
        .filter((type) => type.active)
        .map((type) => ({
          id: type.id,
          slug: type.slug,
          labelEn: type.labelEn,
          labelAr: type.labelAr,
          categoryId: type.categoryId,
        }));
      return { kind: 'loaded' as const, activityTypes: records };
    },
  };

  /** Exactly the real seven-field list row — nothing else is projected. */
  const projectProgramSummary = (row: FixtureProgramState): ProgramSummaryRecord => ({
    id: row.id,
    titleEn: row.titleEn,
    listingState: row.listingState,
    activityTypeId: row.activityTypeId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const projectProgramDetail = (
    organization: FixtureOrganizationState,
    row: FixtureProgramState,
  ): ProgramDetailRecord => {
    const activityType = activityTypes.find((type) => type.id === row.activityTypeId);
    if (!activityType) {
      throw new Error(`fixture program ${row.id} references an unknown activity type`);
    }
    const priceOptions: PriceOptionRecord[] = [...row.priceOptions]
      .sort((a, b) => a.sortHint - b.sortHint || (a.id < b.id ? -1 : 1))
      .map((option) => ({
        id: option.id,
        kind: option.kind,
        amountFils: option.amountFils,
        currency: 'AED',
        sessionsCount: option.sessionsCount,
        labelEn: option.labelEn,
        labelAr: option.labelAr,
        sortHint: option.sortHint,
        state: option.state,
        version: option.version,
      }));
    const media: ProgramMediaRecord[] = [...row.media]
      .sort((a, b) => a.sortHint - b.sortHint || (a.id < b.id ? -1 : 1))
      .map((entry) => ({ ...entry }));
    const offers: OfferRecord[] = row.offers.map((offer) => ({ ...offer }));
    const openRevision: OpenRevisionRecord | null =
      row.openRevision === null ? null : { ...row.openRevision };
    return {
      id: row.id,
      organizationId: organization.organizationId,
      activityType: {
        id: activityType.id,
        slug: activityType.slug,
        labelEn: activityType.labelEn,
        active: activityType.active,
        categoryId: activityType.categoryId,
      },
      titleEn: row.titleEn,
      titleAr: row.titleAr,
      descriptionEn: row.descriptionEn,
      descriptionAr: row.descriptionAr,
      setting: row.setting,
      minAge: row.minAge,
      maxAge: row.maxAge,
      allAges: row.allAges,
      genderEligibility: row.genderEligibility,
      skillLevel: row.skillLevel,
      eligibilityNotes: row.eligibilityNotes,
      listingState: row.listingState,
      publishedAt: row.publishedAt,
      archivedAt: row.archivedAt,
      sensitiveFieldsVersion: row.sensitiveFieldsVersion,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      priceOptions,
      branches: row.branchAssociations.map((entry) => {
        const branchRow = organization.branches.find(
          (candidate) => candidate.id === entry.branchId,
        );
        return {
          branchId: entry.branchId,
          // Same-organization by construction (composite-FK spine); the
          // label is the same branch truth the W2-5 surfaces render.
          label: branchRow?.label ?? 'Unavailable branch',
          branchActive: branchRow?.active ?? false,
          associationActive: entry.active,
          version: entry.version,
        };
      }),
      media,
      offers,
      openRevision,
    };
  };

  /**
   * The canonical branch-scoped READ-reachability rule shared by the list
   * and the detail — mirrors the backend's one authoritative predicate
   * (catalogue-shared.ts programReadableInBranchScope): reachable = no
   * ACTIVE branch association at all (a draft not placed anywhere) OR at
   * least one active association to an assigned ACTIVE branch. The
   * resolved seat carries assigned branches only; a deactivated branch
   * grants no reach, and an empty scope never falls back to org-wide.
   */
  const programReachableForSeat = (
    organization: FixtureOrganizationState,
    seatEntry: FixtureMembershipSeat,
    row: FixtureProgramState,
  ): boolean => {
    if (seatEntry.branchScope === 'all') {
      return true;
    }
    const assignedActive = seatEntry.branchScope.filter((branchId) =>
      organization.branches.some((candidate) => candidate.id === branchId && candidate.active),
    );
    const activeAssociations = row.branchAssociations.filter((entry) => entry.active);
    return (
      activeAssociations.length === 0 ||
      activeAssociations.some((entry) => assignedActive.includes(entry.branchId))
    );
  };

  const listingsPort: ListingsReadPort = {
    /**
     * Mirrors GET /provider/organizations/:orgId/listings exactly
     * (program-management.ts listProviderPrograms): keyset pagination in
     * `(createdAt, id)` order with an opaque id cursor (an unknown or
     * foreign cursor is IGNORED — the list restarts from the beginning);
     * `limit` clamped to 1–100 (default 50). Branch-scope reachability
     * participates BEFORE the pagination window — exactly like the
     * corrected service, where the shared rule sits inside the
     * authoritative query ahead of ordering, cursor continuation, and
     * `LIMIT` — so inaccessible listings never consume page slots and the
     * cursor walks the reachable ordered set.
     */
    async listListings(organizationId, params): Promise<ListListingsOutcome> {
      const caller = store.current;
      if (!caller) {
        return { kind: 'unavailable' };
      }
      if (store.listingsLoadFailures.delete(organizationId)) {
        return { kind: 'unavailable' };
      }
      const organization = organizations.get(organizationId);
      const seatEntry = caller.memberships.find(
        (candidate) => candidate.organizationId === organizationId,
      );
      if (!organization || !seatEntry || organization.verificationState === 'offboarded') {
        return { kind: 'notFound' };
      }
      if (!ROLE_CAPABILITIES[seatEntry.role].includes('catalogue.read')) {
        return { kind: 'forbidden' };
      }
      const limit = Math.min(Math.max(params?.limit ?? 50, 1), 100);
      // Reachability filters the AUTHORITATIVE ordered set before any
      // windowing, mirroring the corrected SQL query shape.
      const sorted = [...organization.programs]
        .filter((row) => programReachableForSeat(organization, seatEntry, row))
        .sort((a, b) =>
          a.createdAt < b.createdAt
            ? -1
            : a.createdAt > b.createdAt
              ? 1
              : a.id < b.id
                ? -1
                : 1,
        );
      let afterAnchor = sorted;
      const cursor = params?.cursor;
      if (cursor !== undefined) {
        // The anchor lookup stays org-wide (an unknown or foreign cursor is
        // ignored); continuation happens over the reachable ordered set.
        const anchor = organization.programs.find((row) => row.id === cursor);
        if (anchor !== undefined) {
          afterAnchor = sorted.filter(
            (row) =>
              row.createdAt > anchor.createdAt ||
              (row.createdAt === anchor.createdAt && row.id > anchor.id),
          );
        }
      }
      const rows = afterAnchor.slice(0, limit + 1);
      const page = rows.slice(0, limit);
      return {
        kind: 'loaded',
        page: {
          programs: page.map(projectProgramSummary),
          nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    },

    /**
     * Mirrors GET .../listings/:programId exactly: organization-scoped,
     * with the SAME branch-scope reachability rule as the list — an
     * in-organization but out-of-scope listing, an unknown id, and another
     * organization's id all collapse into ONE not-found shape (no
     * enumeration oracle).
     */
    async loadListing(organizationId, programId): Promise<ListingDetailOutcome> {
      const caller = store.current;
      if (!caller) {
        return { kind: 'unavailable' };
      }
      if (store.listingDetailFailures.delete(organizationId)) {
        return { kind: 'unavailable' };
      }
      const organization = organizations.get(organizationId);
      const seatEntry = caller.memberships.find(
        (candidate) => candidate.organizationId === organizationId,
      );
      if (!organization || !seatEntry || organization.verificationState === 'offboarded') {
        return { kind: 'notFound' };
      }
      if (!ROLE_CAPABILITIES[seatEntry.role].includes('catalogue.read')) {
        return { kind: 'forbidden' };
      }
      const row = organization.programs.find((candidate) => candidate.id === programId);
      if (row === undefined || !programReachableForSeat(organization, seatEntry, row)) {
        return { kind: 'notFound' };
      }
      return { kind: 'loaded', program: projectProgramDetail(organization, row) };
    },
  };

  // -- W2-8 catalogue mutations (mirrors the S4 management services) --------

  /** Deterministic ids/timestamps for fixture-created catalogue rows. */
  const nextCatalogueId = (): string => {
    store.createdCatalogueRowCount += 1;
    return `0198a2f0-c8e1-7000-8000-${String(store.createdCatalogueRowCount).padStart(12, '0')}`;
  };
  const nextCatalogueTimestamp = (): string => {
    store.createdCatalogueRowCount += 1;
    return new Date(Date.UTC(2026, 7, 8, 12, 0, store.createdCatalogueRowCount)).toISOString();
  };

  /** docs/24 §5.3 edit-state matrix, exactly as catalogue-shared.ts. */
  const catalogueEditMode = (listingState: string): 'direct' | 'reviewGated' | 'locked' => {
    if (listingState === 'draft' || listingState === 'changes_requested') return 'direct';
    if (
      listingState === 'approved' ||
      listingState === 'published' ||
      listingState === 'paused'
    ) {
      return 'reviewGated';
    }
    return 'locked';
  };

  /** The docs/28 §7 admin-designated sensitive PATCH fields (exact backend
   *  SENSITIVE_PATCH_FIELDS order) + the non-sensitive remainder. */
  const SENSITIVE_PATCH_FIELDS = [
    'descriptionEn',
    'descriptionAr',
    'minAge',
    'maxAge',
    'allAges',
    'genderEligibility',
    'skillLevel',
    'eligibilityNotes',
  ] as const;
  const NON_SENSITIVE_PATCH_FIELDS = ['titleEn', 'titleAr', 'setting', 'activityTypeId'] as const;

  /** Policy-pipeline mirror for catalogue mutations, in the binding order:
   *  session → org/membership not-found shaping → capability → suspended
   *  mutation refusal → transient-failure control. */
  const resolveCatalogueMutation = (
    organizationId: string,
    capability: 'listings.manage' | 'media.manage' | 'listings.publish',
  ):
    | { refusal: 'unavailable' | 'notFound' | 'forbidden' | 'organizationSuspended' }
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
    if (store.listingMutationFailures.delete(organizationId)) {
      return { refusal: 'unavailable' };
    }
    return { refusal: null, organization, seatEntry };
  };

  /**
   * The MUTATION branch-scope rule (catalogue-shared.ts
   * programInBranchScope) — deliberately STRICTER than the W2-7 read rule:
   * a branch-scoped seat mutates a listing only while EVERY active
   * association lies inside its assigned ACTIVE branches (vacuously true
   * for branchless drafts). Readable never implies editable.
   */
  const programMutableForSeat = (
    organization: FixtureOrganizationState,
    seatEntry: FixtureMembershipSeat,
    row: FixtureProgramState,
  ): boolean => {
    if (seatEntry.branchScope === 'all') {
      return true;
    }
    const assignedActive = seatEntry.branchScope.filter((branchId) =>
      organization.branches.some((candidate) => candidate.id === branchId && candidate.active),
    );
    return row.branchAssociations
      .filter((entry) => entry.active)
      .every((entry) => assignedActive.includes(entry.branchId));
  };

  const findProgramIndex = (
    organization: FixtureOrganizationState,
    programId: string,
  ): number => organization.programs.findIndex((candidate) => candidate.id === programId);

  /** Exact mirror of the backend completenessGaps (program-management.ts):
   *  non-empty English title, ACTIVE taxonomy, ≥1 active association to an
   *  ACTIVE branch, ≥1 active price option — in that push order.
   *  Service-enforced at submit AND publish. Arabic is never required. */
  const fixtureCompletenessGaps = (
    organization: FixtureOrganizationState,
    row: FixtureProgramState,
  ): CompletenessGap[] => {
    const missing: CompletenessGap[] = [];
    if (row.titleEn.trim().length === 0) {
      missing.push('title');
    }
    if (!activityTypeIsActive(row.activityTypeId)) {
      missing.push('activeTaxonomy');
    }
    const hasActiveBranch = row.branchAssociations.some(
      (entry) =>
        entry.active &&
        organization.branches.some((candidate) => candidate.id === entry.branchId && candidate.active),
    );
    if (!hasActiveBranch) {
      missing.push('activeBranch');
    }
    if (!row.priceOptions.some((option) => option.state === 'active')) {
      missing.push('activePriceOption');
    }
    return missing;
  };

  const activityTypeIsActive = (activityTypeId: string): boolean =>
    activityTypeDirectory().some((row) => row.id === activityTypeId && row.active);

  /** Mirror of the service eligibilityValid + the route's 0–130 bounds —
   *  validated on the SUBMITTED fields exactly like the backend precheck. */
  const eligibilityValid = (input: {
    minAge?: number | null;
    maxAge?: number | null;
    allAges?: boolean;
  }): boolean => {
    const minAge = input.minAge ?? null;
    const maxAge = input.maxAge ?? null;
    const inRange = (value: number): boolean =>
      Number.isInteger(value) && value >= 0 && value <= 130;
    if (minAge !== null && !inRange(minAge)) return false;
    if (maxAge !== null && !inRange(maxAge)) return false;
    if (minAge !== null && maxAge !== null && minAge > maxAge) return false;
    if (input.allAges === true && (minAge !== null || maxAge !== null)) return false;
    return true;
  };

  /** The S4-1 option CHECK ties (price-option-management.ts): free ⇔ NULL
   *  amount, paid ⇒ positive integer fils, package ⇔ positive sessions. */
  const optionShapeValid = (input: {
    kind: string;
    amountFils?: number | null;
    sessionsCount?: number | null;
  }): boolean => {
    const amount = input.amountFils ?? null;
    const sessions = input.sessionsCount ?? null;
    if (input.kind === 'free') {
      if (amount !== null) return false;
    } else if (amount === null || !Number.isInteger(amount) || amount <= 0) {
      return false;
    }
    if (input.kind === 'package') {
      if (sessions === null || !Number.isInteger(sessions) || sessions <= 0) return false;
    } else if (sessions !== null) {
      return false;
    }
    return true;
  };

  /** The S4-1 offer CHECK ties: paidTrial ⇔ positive trial amount; the
   *  effective window must END strictly after it starts. */
  const offerShapeValid = (input: {
    kind: string;
    trialAmountFils?: number | null;
    effectiveStart?: string | null;
    effectiveEnd?: string | null;
  }): boolean => {
    const amount = input.trialAmountFils ?? null;
    if (input.kind === 'paidTrial') {
      if (amount === null || !Number.isInteger(amount) || amount <= 0) return false;
    } else if (amount !== null) {
      return false;
    }
    const start = input.effectiveStart ?? null;
    const end = input.effectiveEnd ?? null;
    if (start !== null && end !== null && Date.parse(end) <= Date.parse(start)) return false;
    return true;
  };

  const replaceProgram = (
    organization: FixtureOrganizationState,
    index: number,
    next: FixtureProgramState,
  ): void => {
    organization.programs[index] = next;
  };

  /** At most ONE open revision per listing (partial-unique-index mirror):
   *  returns null when a revision is already pending. */
  const createFixtureRevision = (
    organization: FixtureOrganizationState,
    index: number,
  ): { id: string } | null => {
    const row = organization.programs[index]!;
    if (row.openRevision !== null) {
      return null;
    }
    const revision = {
      id: nextCatalogueId(),
      state: 'submitted',
      createdAt: nextCatalogueTimestamp(),
      version: 1,
    };
    replaceProgram(organization, index, { ...row, openRevision: revision });
    return { id: revision.id };
  };

  const listingEditorPort: ListingEditorPort = {
    /** Mirrors POST .../listings: structural fields only — a draft may be
     *  incomplete (no branch, no option); lifecycle starts at `draft`. */
    async createProgram(organizationId, input: ProgramCreateInput): Promise<CreateProgramOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      if (!activityTypeIsActive(input.activityTypeId)) {
        return { kind: 'invalidTaxonomy' };
      }
      if (!eligibilityValid(input)) {
        return { kind: 'invalidEligibility' };
      }
      const id = nextCatalogueId();
      const createdAt = nextCatalogueTimestamp();
      const row: FixtureProgramState = {
        id,
        titleEn: input.titleEn,
        titleAr: input.titleAr ?? null,
        descriptionEn: input.descriptionEn ?? null,
        descriptionAr: input.descriptionAr ?? null,
        activityTypeId: input.activityTypeId,
        setting: input.setting,
        minAge: input.minAge ?? null,
        maxAge: input.maxAge ?? null,
        allAges: input.allAges ?? false,
        genderEligibility: input.genderEligibility,
        skillLevel: input.skillLevel ?? null,
        eligibilityNotes: input.eligibilityNotes ?? null,
        listingState: 'draft',
        publishedAt: null,
        archivedAt: null,
        sensitiveFieldsVersion: 1,
        version: 1,
        createdAt,
        updatedAt: createdAt,
        priceOptions: [],
        branchAssociations: [],
        media: [],
        offers: [],
        openRevision: null,
      };
      context.organization.programs.push(row);
      return { kind: 'programCreated', program: { id, listingState: 'draft', version: 1 } };
    },

    /**
     * Mirrors PATCH .../listings/:programId including the service order
     * (org-scoped lookup → branch-scope forbidden → locked → CAS → taxonomy
     * → eligibility) and the §7 sensitive routing: direct states apply
     * everything; review-gated states apply NON-sensitive fields directly
     * and defer sensitive ones to a ProgramRevision (live values stand).
     */
    async updateProgram(
      organizationId,
      programId,
      expectedVersion,
      patch: ProgramPatch,
    ): Promise<UpdateProgramOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const mode = catalogueEditMode(row.listingState);
      if (mode === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (row.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      if (patch.activityTypeId !== undefined && !activityTypeIsActive(patch.activityTypeId)) {
        return { kind: 'invalidTaxonomy' };
      }
      if (
        (patch.minAge !== undefined || patch.maxAge !== undefined || patch.allAges !== undefined) &&
        !eligibilityValid(patch)
      ) {
        return { kind: 'invalidEligibility' };
      }

      const patchRecord = patch as Record<string, unknown>;
      const sensitiveFields = SENSITIVE_PATCH_FIELDS.filter(
        (field) => patchRecord[field] !== undefined,
      );
      const nonSensitiveFields = NON_SENSITIVE_PATCH_FIELDS.filter(
        (field) => patchRecord[field] !== undefined,
      );
      const directFields: string[] =
        mode === 'direct' ? [...nonSensitiveFields, ...sensitiveFields] : [...nonSensitiveFields];
      const deferredFields: string[] = mode === 'reviewGated' ? [...sensitiveFields] : [];

      let version = row.version;
      if (directFields.length > 0) {
        const next: Record<string, unknown> = { ...row };
        for (const field of directFields) {
          next[field] = patchRecord[field];
        }
        version += 1;
        next.version = version;
        next.updatedAt = nextCatalogueTimestamp();
        replaceProgram(context.organization, index, next as unknown as FixtureProgramState);
      }
      if (deferredFields.length > 0) {
        const revision = createFixtureRevision(context.organization, index);
        if (revision === null) {
          return { kind: 'revisionPending' };
        }
        return {
          kind: 'revisionSubmitted',
          revisionId: revision.id,
          appliedFields: directFields,
          deferredFields,
        };
      }
      return { kind: 'programUpdated', version };
    },

    /** Mirrors POST .../price-options: options are SENSITIVE — review-gated
     *  listings route every option operation through a revision. */
    async addPriceOption(
      organizationId,
      programId,
      input: PriceOptionInput,
    ): Promise<AddPriceOptionOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const mode = catalogueEditMode(row.listingState);
      if (mode === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!optionShapeValid(input)) {
        return { kind: 'invalidPriceOption' };
      }
      if (mode === 'reviewGated') {
        const revision = createFixtureRevision(context.organization, index);
        if (revision === null) {
          return { kind: 'revisionPending' };
        }
        return { kind: 'revisionSubmitted', revisionId: revision.id };
      }
      const option: FixturePriceOption = {
        id: nextCatalogueId(),
        kind: input.kind,
        amountFils: input.amountFils ?? null,
        sessionsCount: input.sessionsCount ?? null,
        labelEn: input.labelEn ?? null,
        labelAr: input.labelAr ?? null,
        sortHint: input.sortHint ?? 0,
        state: 'active',
        version: 1,
      };
      replaceProgram(context.organization, index, {
        ...row,
        priceOptions: [...row.priceOptions, option],
      });
      return {
        kind: 'optionAdded',
        option: { ...option, currency: 'AED' },
      };
    },

    async updatePriceOption(
      organizationId,
      programId,
      optionId,
      expectedVersion,
      patch: PriceOptionPatch,
    ): Promise<UpdatePriceOptionOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const mode = catalogueEditMode(row.listingState);
      if (mode === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      const option = row.priceOptions.find((candidate) => candidate.id === optionId);
      if (option === undefined) {
        return { kind: 'notFound' };
      }
      // Archive-only retirement: an archived option is immutable history.
      if (option.state === 'archived') {
        return { kind: 'lifecycleConflict' };
      }
      if (option.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const merged = {
        kind: patch.kind ?? option.kind,
        amountFils: patch.amountFils !== undefined ? patch.amountFils : option.amountFils,
        sessionsCount:
          patch.sessionsCount !== undefined ? patch.sessionsCount : option.sessionsCount,
      };
      if (!optionShapeValid(merged)) {
        return { kind: 'invalidPriceOption' };
      }
      if (mode === 'reviewGated') {
        const revision = createFixtureRevision(context.organization, index);
        if (revision === null) {
          return { kind: 'revisionPending' };
        }
        return { kind: 'revisionSubmitted', revisionId: revision.id };
      }
      const next: FixturePriceOption = {
        ...option,
        kind: merged.kind,
        amountFils: merged.amountFils,
        sessionsCount: merged.sessionsCount,
        labelEn: patch.labelEn !== undefined ? patch.labelEn : option.labelEn,
        labelAr: patch.labelAr !== undefined ? patch.labelAr : option.labelAr,
        sortHint: patch.sortHint !== undefined ? patch.sortHint : option.sortHint,
        version: option.version + 1,
      };
      replaceProgram(context.organization, index, {
        ...row,
        priceOptions: row.priceOptions.map((candidate) =>
          candidate.id === optionId ? next : candidate,
        ),
      });
      return { kind: 'optionUpdated', option: { ...next, currency: 'AED' } };
    },

    async archivePriceOption(
      organizationId,
      programId,
      optionId,
      expectedVersion,
    ): Promise<ArchivePriceOptionOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const mode = catalogueEditMode(row.listingState);
      if (mode === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      const option = row.priceOptions.find((candidate) => candidate.id === optionId);
      if (option === undefined) {
        return { kind: 'notFound' };
      }
      if (option.state === 'archived') {
        return { kind: 'optionArchived' }; // idempotent
      }
      if (option.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      if (mode === 'reviewGated') {
        const revision = createFixtureRevision(context.organization, index);
        if (revision === null) {
          return { kind: 'revisionPending' };
        }
        return { kind: 'revisionSubmitted', revisionId: revision.id };
      }
      replaceProgram(context.organization, index, {
        ...row,
        priceOptions: row.priceOptions.map((candidate) =>
          candidate.id === optionId
            ? { ...candidate, state: 'archived', version: candidate.version + 1 }
            : candidate,
        ),
      });
      return { kind: 'optionArchived' };
    },

    /** Mirrors POST .../branches (service order: lookup → locked → program
     *  scope → target-branch scope → same-org ACTIVE branch). Associations
     *  are NOT sensitive — they apply directly even on review-gated
     *  listings; re-association reactivates the historical row. */
    async addBranchAssociation(
      organizationId,
      programId,
      branchId,
    ): Promise<AddBranchAssociationOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const branchRow = context.organization.branches.find(
        (candidate) => candidate.id === branchId,
      );
      // Branch-scoped staff may only associate branches they control.
      if (
        context.seatEntry.branchScope !== 'all' &&
        !(branchRow !== undefined && branchInFixtureScope(context.seatEntry, branchRow))
      ) {
        return { kind: 'forbidden' };
      }
      // Same organization AND active: a deactivated branch cannot newly
      // qualify as an offering location.
      if (branchRow === undefined || !branchRow.active) {
        return { kind: 'invalidBranch' };
      }
      const existing = row.branchAssociations.find(
        (candidate) => candidate.branchId === branchId,
      );
      if (existing !== undefined && existing.active) {
        return { kind: 'branchAssociated' }; // idempotent
      }
      replaceProgram(context.organization, index, {
        ...row,
        branchAssociations:
          existing === undefined
            ? [...row.branchAssociations, { branchId, active: true, version: 1 }]
            : row.branchAssociations.map((candidate) =>
                candidate.branchId === branchId
                  ? { ...candidate, active: true, version: candidate.version + 1 }
                  : candidate,
              ),
      });
      return { kind: 'branchAssociated' };
    },

    async removeBranchAssociation(
      organizationId,
      programId,
      branchId,
    ): Promise<RemoveBranchAssociationOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const branchRow = context.organization.branches.find(
        (candidate) => candidate.id === branchId,
      );
      if (
        context.seatEntry.branchScope !== 'all' &&
        !(branchRow !== undefined && branchInFixtureScope(context.seatEntry, branchRow))
      ) {
        return { kind: 'forbidden' };
      }
      const association = row.branchAssociations.find(
        (candidate) => candidate.branchId === branchId,
      );
      if (association === undefined) {
        return { kind: 'notFound' };
      }
      if (!association.active) {
        return { kind: 'branchAssociationRemoved' }; // idempotent
      }
      replaceProgram(context.organization, index, {
        ...row,
        branchAssociations: row.branchAssociations.map((candidate) =>
          candidate.branchId === branchId
            ? { ...candidate, active: false, version: candidate.version + 1 }
            : candidate,
        ),
      });
      return { kind: 'branchAssociationRemoved' };
    },

    /** Media metadata is NOT sensitive (the revision schema cannot even
     *  represent it): it hot-applies in every provider-editable state.
     *  Gate order mirrors media-offer-management.ts gateProgram:
     *  lookup → locked → program scope. */
    async addMedia(organizationId, programId, input: MediaInput): Promise<AddMediaOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'media.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const media: FixtureProgramMedia = {
        id: nextCatalogueId(),
        mediaRef: input.mediaRef,
        sortHint: input.sortHint ?? 0,
        altTextEn: input.altTextEn ?? null,
        altTextAr: input.altTextAr ?? null,
        active: true,
        version: 1,
      };
      replaceProgram(context.organization, index, { ...row, media: [...row.media, media] });
      return { kind: 'mediaAdded', media: { ...media } };
    },

    async updateMedia(
      organizationId,
      programId,
      mediaId,
      expectedVersion,
      patch: MediaPatch,
    ): Promise<UpdateMediaOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'media.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const media = row.media.find((candidate) => candidate.id === mediaId);
      if (media === undefined) {
        return { kind: 'notFound' };
      }
      if (media.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const next: FixtureProgramMedia = {
        ...media,
        sortHint: patch.sortHint !== undefined ? patch.sortHint : media.sortHint,
        altTextEn: patch.altTextEn !== undefined ? patch.altTextEn : media.altTextEn,
        altTextAr: patch.altTextAr !== undefined ? patch.altTextAr : media.altTextAr,
        version: media.version + 1,
      };
      replaceProgram(context.organization, index, {
        ...row,
        media: row.media.map((candidate) => (candidate.id === mediaId ? next : candidate)),
      });
      return { kind: 'mediaUpdated', media: { ...next } };
    },

    async archiveMedia(
      organizationId,
      programId,
      mediaId,
      expectedVersion,
    ): Promise<ArchiveMediaOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'media.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const media = row.media.find((candidate) => candidate.id === mediaId);
      if (media === undefined) {
        return { kind: 'notFound' };
      }
      if (!media.active) {
        return { kind: 'mediaArchived' }; // idempotent
      }
      if (media.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      replaceProgram(context.organization, index, {
        ...row,
        media: row.media.map((candidate) =>
          candidate.id === mediaId
            ? { ...candidate, active: false, version: candidate.version + 1 }
            : candidate,
        ),
      });
      return { kind: 'mediaArchived' };
    },

    /** Offers are structured catalogue metadata, never checkout math — and
     *  not sensitive: they hot-apply in every provider-editable state. */
    async addOffer(organizationId, programId, input: OfferInput): Promise<AddOfferOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      if (!offerShapeValid(input)) {
        return { kind: 'invalidOffer' };
      }
      const offer: FixtureOffer = {
        id: nextCatalogueId(),
        kind: input.kind,
        labelEn: input.labelEn,
        labelAr: input.labelAr ?? null,
        trialAmountFils: input.trialAmountFils ?? null,
        effectiveStart: input.effectiveStart ?? null,
        effectiveEnd: input.effectiveEnd ?? null,
        state: 'active',
        version: 1,
      };
      replaceProgram(context.organization, index, { ...row, offers: [...row.offers, offer] });
      return { kind: 'offerAdded', offer: { ...offer } };
    },

    async updateOffer(
      organizationId,
      programId,
      offerId,
      expectedVersion,
      patch: OfferPatch,
    ): Promise<UpdateOfferOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const offer = row.offers.find((candidate) => candidate.id === offerId);
      if (offer === undefined) {
        return { kind: 'notFound' };
      }
      if (offer.state === 'ended') {
        return { kind: 'lifecycleConflict' }; // ended offers are history
      }
      if (offer.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const merged = {
        kind: offer.kind,
        trialAmountFils:
          patch.trialAmountFils !== undefined ? patch.trialAmountFils : offer.trialAmountFils,
        effectiveStart:
          patch.effectiveStart !== undefined ? patch.effectiveStart : offer.effectiveStart,
        effectiveEnd: patch.effectiveEnd !== undefined ? patch.effectiveEnd : offer.effectiveEnd,
      };
      if (!offerShapeValid(merged)) {
        return { kind: 'invalidOffer' };
      }
      const next: FixtureOffer = {
        ...offer,
        labelEn: patch.labelEn !== undefined ? patch.labelEn : offer.labelEn,
        labelAr: patch.labelAr !== undefined ? patch.labelAr : offer.labelAr,
        trialAmountFils: merged.trialAmountFils,
        effectiveStart: merged.effectiveStart,
        effectiveEnd: merged.effectiveEnd,
        version: offer.version + 1,
      };
      replaceProgram(context.organization, index, {
        ...row,
        offers: row.offers.map((candidate) => (candidate.id === offerId ? next : candidate)),
      });
      return { kind: 'offerUpdated', offer: { ...next } };
    },

    async endOffer(
      organizationId,
      programId,
      offerId,
      expectedVersion,
    ): Promise<EndOfferOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (catalogueEditMode(row.listingState) === 'locked') {
        return { kind: 'lifecycleConflict' };
      }
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      const offer = row.offers.find((candidate) => candidate.id === offerId);
      if (offer === undefined) {
        return { kind: 'notFound' };
      }
      if (offer.state === 'ended') {
        return { kind: 'offerEnded' }; // idempotent
      }
      if (offer.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      replaceProgram(context.organization, index, {
        ...row,
        offers: row.offers.map((candidate) =>
          candidate.id === offerId
            ? { ...candidate, state: 'ended', version: candidate.version + 1 }
            : candidate,
        ),
      });
      return { kind: 'offerEnded' };
    },
  };

  // -- W2-9 listing lifecycle actions (mirrors the S4 named actions) --------

  const listingLifecyclePort: ListingLifecyclePort = {
    /**
     * Mirrors POST .../listings/:programId/submit (`listings.manage`) with
     * the exact service order: org-scoped lookup → branch-scope `every`-rule
     * forbidden → state (draft | changes_requested only — resubmission IS
     * this action) → CAS → completeness. A submitted listing moves to
     * `submitted` and waits for Himma; nothing here ever publishes.
     */
    async submitProgram(organizationId, programId, expectedVersion): Promise<SubmitProgramOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.manage');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (!programMutableForSeat(context.organization, context.seatEntry, row)) {
        return { kind: 'forbidden' };
      }
      if (row.listingState !== 'draft' && row.listingState !== 'changes_requested') {
        return { kind: 'lifecycleConflict' };
      }
      if (row.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const missing = fixtureCompletenessGaps(context.organization, row);
      if (missing.length > 0) {
        return { kind: 'programIncomplete', missing };
      }
      replaceProgram(context.organization, index, {
        ...row,
        listingState: 'submitted',
        version: row.version + 1,
        updatedAt: nextCatalogueTimestamp(),
      });
      return { kind: 'programSubmitted', version: row.version + 1 };
    },

    /**
     * Mirrors POST .../listings/:programId/publish (`listings.publish`) with
     * the exact service order: org-scoped lookup → state (approved for first
     * publication | paused for resume) → organization verification state
     * must be `live` (`organizationNotLive`) → CAS → completeness.
     * `publishedAt` is stamped only on the first publication from
     * `approved`. Branch scope is NOT consulted (mirrors the service — no
     * branch-scoped role holds `listings.publish`).
     */
    async publishProgram(
      organizationId,
      programId,
      expectedVersion,
    ): Promise<PublishProgramOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.publish');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (row.listingState !== 'approved' && row.listingState !== 'paused') {
        return { kind: 'lifecycleConflict' };
      }
      if (context.organization.verificationState !== 'live') {
        return { kind: 'organizationNotLive' };
      }
      if (row.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      const missing = fixtureCompletenessGaps(context.organization, row);
      if (missing.length > 0) {
        return { kind: 'programIncomplete', missing };
      }
      replaceProgram(context.organization, index, {
        ...row,
        listingState: 'published',
        publishedAt: row.listingState === 'approved' ? nextCatalogueTimestamp() : row.publishedAt,
        version: row.version + 1,
        updatedAt: nextCatalogueTimestamp(),
      });
      return { kind: 'programPublished', version: row.version + 1 };
    },

    /**
     * Mirrors POST .../listings/:programId/pause (`listings.publish`):
     * legal from `published` only → CAS. Pause is the canonical unpublish —
     * reversible through the publish action.
     */
    async pauseProgram(organizationId, programId, expectedVersion): Promise<PauseProgramOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.publish');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (row.listingState !== 'published') {
        return { kind: 'lifecycleConflict' };
      }
      if (row.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      replaceProgram(context.organization, index, {
        ...row,
        listingState: 'paused',
        version: row.version + 1,
        updatedAt: nextCatalogueTimestamp(),
      });
      return { kind: 'programPaused', version: row.version + 1 };
    },

    /**
     * Mirrors POST .../listings/:programId/archive (`listings.publish`):
     * legal from `published` | `paused` only → CAS. Terminal — the row
     * freezes permanently and, exactly like the wire, the outcome carries
     * no version.
     */
    async archiveProgram(
      organizationId,
      programId,
      expectedVersion,
    ): Promise<ArchiveProgramOutcome> {
      const context = resolveCatalogueMutation(organizationId, 'listings.publish');
      if (context.refusal !== null) {
        return { kind: context.refusal };
      }
      const index = findProgramIndex(context.organization, programId);
      if (index === -1) {
        return { kind: 'notFound' };
      }
      const row = context.organization.programs[index]!;
      if (row.listingState !== 'published' && row.listingState !== 'paused') {
        return { kind: 'lifecycleConflict' };
      }
      if (row.version !== expectedVersion) {
        return { kind: 'staleVersion' };
      }
      replaceProgram(context.organization, index, {
        ...row,
        listingState: 'archived',
        archivedAt: nextCatalogueTimestamp(),
        version: row.version + 1,
        updatedAt: nextCatalogueTimestamp(),
      });
      return { kind: 'programArchived' };
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
    failNextListingsLoad(organizationId) {
      store.listingsLoadFailures.add(organizationId);
    },
    failNextListingMutation(organizationId) {
      store.listingMutationFailures.add(organizationId);
    },
    simulateConcurrentListingEdit(organizationId, programId) {
      const organization = organizations.get(organizationId);
      if (!organization) {
        return;
      }
      const index = organization.programs.findIndex((candidate) => candidate.id === programId);
      if (index === -1) {
        return;
      }
      const row = organization.programs[index]!;
      organization.programs[index] = { ...row, version: row.version + 1 };
    },
    simulateConcurrentPriceOptionEdit(organizationId, programId, optionId) {
      const organization = organizations.get(organizationId);
      if (!organization) {
        return;
      }
      const index = organization.programs.findIndex((candidate) => candidate.id === programId);
      if (index === -1) {
        return;
      }
      const row = organization.programs[index]!;
      organization.programs[index] = {
        ...row,
        priceOptions: row.priceOptions.map((candidate) =>
          candidate.id === optionId
            ? { ...candidate, version: candidate.version + 1 }
            : candidate,
        ),
      };
    },
    failNextListingDetailLoad(organizationId) {
      store.listingDetailFailures.add(organizationId);
    },
    failNextActivityTypesLoad() {
      store.activityTypesLoadFailurePending = true;
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
    listingsPort,
    listingEditorPort,
    listingLifecyclePort,
    activityTypePort,
    controls,
    seedSession,
    sessionStateFor,
  };
}
