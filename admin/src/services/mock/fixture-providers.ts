import type {
  AdminProvidersReadPort,
  ListOrganizationsParams,
  OrganizationDetail,
  OrganizationState,
  OrganizationSummary,
  ReviewState,
  ListingState,
} from '../../providers/contract';
import { LISTING_STATES } from '../../providers/contract';

/**
 * Deterministic FIXTURE provider directory (W3-2) — fictional
 * organizations covering every canonical state, behind the same
 * AdminProvidersReadPort seam the live runtime implements. The port
 * mirrors the SERVER semantics exactly (authoritative search/filter before
 * pagination, (createdAt, id) keyset cursor, operations-capability
 * authority) so frontend tests prove server-driven behavior; fixtures
 * model reality, they never define it. Live mode can never reach this
 * module (composition-locked).
 */

/** Mirror of backend reviewStateOf — state-driven, nothing persisted. */
export function fixtureReviewState(state: OrganizationState): ReviewState {
  switch (state) {
    case 'submitted':
      return 'awaiting_review';
    case 'in_review':
      return 'in_review';
    case 'verified':
      return 'awaiting_go_live';
    default:
      return 'none';
  }
}

interface FixtureOrg {
  readonly id: string;
  readonly displayName: string;
  readonly tradeName: string;
  readonly legalName: string;
  readonly state: OrganizationState;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly branches: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly areaLabel: string;
    readonly city: string | null;
    readonly addressLine: string | null;
    readonly active: boolean;
    readonly createdAt: string;
  }>;
  readonly team: ReadonlyArray<{
    readonly membershipId: string;
    readonly displayName: string | null;
    readonly role: string;
    readonly branchScopeKind: string;
    readonly createdAt: string;
  }>;
  readonly listings: Readonly<Partial<Record<ListingState, number>>>;
}

const branch = (
  orgSlug: string,
  n: number,
  label: string,
  areaLabel: string,
  active = true,
): FixtureOrg['branches'][number] => ({
  id: `branch-${orgSlug}-${n}`,
  label,
  areaLabel,
  city: 'Dubai',
  addressLine: null,
  active,
  createdAt: `2026-07-0${n}T09:00:00.000Z`,
});

const member = (
  orgSlug: string,
  n: number,
  displayName: string,
  role: string,
): FixtureOrg['team'][number] => ({
  membershipId: `member-${orgSlug}-${n}`,
  displayName,
  role,
  branchScopeKind: 'all',
  createdAt: `2026-07-0${n}T10:00:00.000Z`,
});

/** Ordered by (createdAt, id) — the exact server ordering. */
const FIXTURE_ORGS: readonly FixtureOrg[] = [
  {
    id: 'org-pearl-dive',
    displayName: 'Pearl Dive Centre',
    tradeName: 'Pearl Dive',
    legalName: 'Pearl Dive Centre LLC',
    state: 'draft',
    published: false,
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-02T08:00:00.000Z',
    branches: [branch('pearl-dive', 1, 'Jumeirah Marina', 'Dubai Marina')],
    team: [member('pearl-dive', 1, 'Huda Rahimi', 'owner')],
    listings: {},
  },
  {
    id: 'org-aquava',
    displayName: 'Aquava Swim School',
    tradeName: 'Aquava',
    legalName: 'Aquava Aquatics LLC',
    state: 'submitted',
    published: false,
    createdAt: '2026-07-03T08:00:00.000Z',
    updatedAt: '2026-08-16T11:30:00.000Z',
    branches: [
      branch('aquava', 1, 'JLT Pool Deck', 'Jumeirah Lakes Towers'),
      branch('aquava', 2, 'Mirdif Indoor Pool', 'Mirdif'),
    ],
    team: [member('aquava', 1, 'Salma Nasser', 'owner'), member('aquava', 2, 'Omar Adly', 'org_manager')],
    listings: { draft: 3 },
  },
  {
    id: 'org-crestpeak',
    displayName: 'Crestpeak Climbing',
    tradeName: 'Crestpeak',
    legalName: 'Crestpeak Sports LLC',
    state: 'in_review',
    published: false,
    createdAt: '2026-07-05T08:00:00.000Z',
    updatedAt: '2026-08-17T09:15:00.000Z',
    branches: [branch('crestpeak', 1, 'Al Quoz Wall', 'Al Quoz')],
    team: [member('crestpeak', 1, 'Tariq Mansour', 'owner')],
    listings: { draft: 1, submitted: 1 },
  },
  {
    id: 'org-falcon-kick',
    displayName: 'Falcon Kick Karate',
    tradeName: 'Falcon Kick',
    legalName: 'Falcon Kick Martial Arts LLC',
    state: 'verified',
    published: true,
    createdAt: '2026-07-07T08:00:00.000Z',
    updatedAt: '2026-08-15T14:00:00.000Z',
    branches: [
      branch('falcon-kick', 1, 'Deira Dojo', 'Deira'),
      branch('falcon-kick', 2, 'Barsha Dojo', 'Al Barsha'),
    ],
    team: [member('falcon-kick', 1, 'Layth Haddad', 'owner')],
    listings: { approved: 2, draft: 1 },
  },
  {
    id: 'org-marina-ace',
    displayName: 'Marina Ace Tennis',
    tradeName: 'Marina Ace',
    legalName: 'Marina Ace Sports Academy LLC',
    state: 'live',
    published: true,
    createdAt: '2026-07-09T08:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
    branches: [
      branch('marina-ace', 1, 'Marina Courts', 'Dubai Marina'),
      branch('marina-ace', 2, 'JBR Beach Courts', 'JBR'),
      branch('marina-ace', 3, 'Old Town Courts', 'Downtown', false),
    ],
    team: [
      member('marina-ace', 1, 'Rania Aboud', 'owner'),
      member('marina-ace', 2, 'Karim Fathi', 'listings_editor'),
    ],
    listings: { published: 4, paused: 1, draft: 2 },
  },
  {
    id: 'org-oasis-flow',
    displayName: 'Oasis Flow Yoga',
    tradeName: 'Oasis Flow',
    legalName: 'Oasis Flow Wellness LLC',
    state: 'rejected',
    published: false,
    createdAt: '2026-07-11T08:00:00.000Z',
    updatedAt: '2026-08-10T16:45:00.000Z',
    branches: [branch('oasis-flow', 1, 'Satwa Studio', 'Al Satwa')],
    team: [member('oasis-flow', 1, 'Dina Kassab', 'owner')],
    listings: {},
  },
  {
    id: 'org-sunridge',
    displayName: 'Sunridge Riding School',
    tradeName: 'Sunridge',
    legalName: 'Sunridge Equestrian LLC',
    state: 'suspended',
    published: true,
    createdAt: '2026-07-13T08:00:00.000Z',
    updatedAt: '2026-08-12T08:20:00.000Z',
    branches: [branch('sunridge', 1, 'Al Ain Stables', 'Al Ain')],
    team: [member('sunridge', 1, 'Yusuf Qadri', 'owner')],
    listings: { published: 2 },
  },
  {
    id: 'org-former-gym',
    displayName: 'Former Gym Co',
    tradeName: 'Former Gym',
    legalName: 'Former Gym Company LLC',
    state: 'offboarded',
    published: false,
    createdAt: '2026-07-15T08:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    branches: [branch('former-gym', 1, 'Closed Facility', 'Bur Dubai', false)],
    team: [],
    listings: { archived: 3 },
  },
  {
    id: 'org-little-kicks',
    displayName: 'Little Kicks Football',
    tradeName: 'Little Kicks',
    legalName: 'Little Kicks Sports LLC',
    state: 'submitted',
    published: false,
    createdAt: '2026-07-17T08:00:00.000Z',
    updatedAt: '2026-08-18T07:40:00.000Z',
    branches: [branch('little-kicks', 1, 'Nad Al Sheba Pitch', 'Nad Al Sheba')],
    team: [member('little-kicks', 1, 'Maha Serry', 'owner')],
    listings: { draft: 2 },
  },
  {
    id: 'org-blue-bay',
    displayName: 'Blue Bay Sailing',
    tradeName: 'Blue Bay',
    legalName: 'Blue Bay Marine LLC',
    state: 'live',
    published: true,
    createdAt: '2026-07-19T08:00:00.000Z',
    updatedAt: '2026-08-17T18:05:00.000Z',
    branches: [branch('blue-bay', 1, 'Harbour Point', 'Dubai Harbour')],
    team: [member('blue-bay', 1, 'Nour El Din', 'owner')],
    listings: { published: 3 },
  },
  {
    id: 'org-desert-padel',
    displayName: 'Desert Padel Hub',
    tradeName: 'Desert Padel',
    legalName: 'Desert Padel Hub LLC',
    state: 'in_review',
    published: false,
    createdAt: '2026-07-21T08:00:00.000Z',
    updatedAt: '2026-08-18T13:25:00.000Z',
    branches: [
      branch('desert-padel', 1, 'Al Quoz Courts', 'Al Quoz'),
      branch('desert-padel', 2, 'DIP Courts', 'Dubai Investment Park'),
    ],
    team: [member('desert-padel', 1, 'Ziad Hilal', 'owner')],
    listings: { submitted: 2, draft: 1 },
  },
  {
    id: 'org-skyjump',
    displayName: 'Skyjump Trampoline Park',
    tradeName: 'Skyjump',
    legalName: 'Skyjump Leisure LLC',
    state: 'submitted',
    published: false,
    createdAt: '2026-07-23T08:00:00.000Z',
    updatedAt: '2026-08-18T15:55:00.000Z',
    branches: [branch('skyjump', 1, 'Festival City Arena', 'Festival City')],
    team: [member('skyjump', 1, 'Hala Wazir', 'owner')],
    listings: { draft: 4 },
  },
];

// -- mutable per-runtime state (W3-5) ----------------------------------------
// The directory/detail/verification ports share ONE mutable copy of the
// seed data per fixture runtime, so the review journey (open round → start
// review → decide → organization state changes) is exercisable end-to-end
// deterministically. The static seeds above never mutate.

export interface FixtureEvidence {
  evidenceId: string;
  state: 'pending_upload' | 'stored';
  originalFilename: string;
  declaredContentType: string;
  byteSize: number | null;
  storedAt: string | null;
  version: number;
}

export interface FixtureRequirement {
  requirementId: string;
  requirementKey: string;
  labelEn: string;
  descriptionEn: string | null;
  required: boolean;
  evidence: FixtureEvidence | null;
}

export interface FixtureRound {
  caseId: string;
  round: number;
  state: 'open' | 'in_review' | 'decided' | 'superseded';
  policyVersion: string;
  requirements: FixtureRequirement[];
  decision: {
    outcome: 'approved' | 'rejected';
    reasonCode: string | null;
    providerSafeMessage: string | null;
    internalNote: string | null;
    decidedBy: string;
    decidedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface FixtureOrgRecord {
  org: {
    id: string;
    displayName: string;
    tradeName: string;
    legalName: string;
    state: OrganizationState;
    published: boolean;
    createdAt: string;
    updatedAt: string;
    branches: FixtureOrg['branches'];
    team: FixtureOrg['team'];
    listings: FixtureOrg['listings'];
  };
  verification: FixtureRound[];
}

export interface FixtureProviderData {
  orgs: FixtureOrgRecord[];
}

const requirement = (
  slug: string,
  key: string,
  labelEn: string,
  required: boolean,
  evidence: FixtureEvidence | null,
): FixtureRequirement => ({
  requirementId: `req-${slug}-${key}`,
  requirementKey: key,
  labelEn,
  descriptionEn: null,
  required,
  evidence,
});

const storedEvidence = (slug: string, key: string): FixtureEvidence => ({
  evidenceId: `evidence-${slug}-${key}`,
  state: 'stored',
  originalFilename: `${key}.pdf`,
  declaredContentType: 'application/pdf',
  byteSize: 24_680,
  storedAt: '2026-08-15T10:00:00.000Z',
  version: 2,
});

/** Fictional deterministic requirements (D-W3-3 remains deferred). */
function seedRound(
  slug: string,
  round: number,
  state: FixtureRound['state'],
  options: {
    storedKeys?: readonly string[];
    decision?: FixtureRound['decision'];
  } = {},
): FixtureRound {
  const stored = new Set(options.storedKeys ?? []);
  return {
    caseId: `case-${slug}-${round}`,
    round,
    state,
    policyVersion: 'fixture-policy-v1',
    requirements: [
      requirement(
        slug,
        'business_document',
        'Business document',
        true,
        stored.has('business_document') ? storedEvidence(slug, 'business_document') : null,
      ),
      requirement(
        slug,
        'operating_license',
        'Operating licence',
        true,
        stored.has('operating_license') ? storedEvidence(slug, 'operating_license') : null,
      ),
      requirement(slug, 'optional_reference', 'Optional reference', false, null),
    ],
    decision: options.decision ?? null,
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-15T10:00:00.000Z',
    version: state === 'open' ? 1 : 2,
  };
}

const SEED_VERIFICATION: Readonly<Record<string, FixtureRound[]>> = {
  // Submitted, round open, one required document still missing.
  'org-aquava': [seedRound('aquava', 1, 'open', { storedKeys: ['business_document'] })],
  // Under review with COMPLETE evidence — decidable in the fixture demo.
  'org-desert-padel': [
    seedRound('desert-padel', 1, 'in_review', {
      storedKeys: ['business_document', 'operating_license'],
    }),
  ],
  // Under review with missing evidence — the reject-path demo.
  'org-crestpeak': [
    seedRound('crestpeak', 1, 'in_review', { storedKeys: ['business_document'] }),
  ],
  // Verified: an approved decided round — go-live is the remaining action.
  'org-falcon-kick': [
    seedRound('falcon-kick', 1, 'decided', {
      storedKeys: ['business_document', 'operating_license'],
      decision: {
        outcome: 'approved',
        reasonCode: null,
        providerSafeMessage: null,
        internalNote: 'All documents matched the registry.',
        decidedBy: 'fixture-ops@himma.demo',
        decidedAt: '2026-08-15T14:00:00.000Z',
      },
    }),
  ],
  // Rejected: the three-layer decision is visible internally.
  'org-oasis-flow': [
    seedRound('oasis-flow', 1, 'decided', {
      storedKeys: ['business_document'],
      decision: {
        outcome: 'rejected',
        reasonCode: 'expired_document',
        providerSafeMessage: 'Your operating licence has expired — upload a current one.',
        internalNote: 'Licence lapsed in 2025; do not fast-track.',
        decidedBy: 'fixture-ops@himma.demo',
        decidedAt: '2026-08-10T16:45:00.000Z',
      },
    }),
  ],
};

export function createFixtureProviderData(): FixtureProviderData {
  return {
    orgs: FIXTURE_ORGS.map((seed) => ({
      org: {
        id: seed.id,
        displayName: seed.displayName,
        tradeName: seed.tradeName,
        legalName: seed.legalName,
        state: seed.state,
        published: seed.published,
        createdAt: seed.createdAt,
        updatedAt: seed.updatedAt,
        branches: seed.branches,
        team: seed.team,
        listings: seed.listings,
      },
      verification: JSON.parse(
        JSON.stringify(SEED_VERIFICATION[seed.id] ?? []),
      ) as FixtureRound[],
    })),
  };
}

function summaryOf(org: FixtureOrg): OrganizationSummary {
  return {
    organizationId: org.id,
    displayName: org.displayName,
    tradeName: org.tradeName,
    verificationState: org.state,
    reviewState: fixtureReviewState(org.state),
    storefront: {
      published: org.published,
      publiclyVisible: org.state === 'live' && org.published,
    },
    activeBranchCount: org.branches.filter((entry) => entry.active).length,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

function detailOf(org: FixtureOrg): OrganizationDetail {
  const byState = Object.fromEntries(LISTING_STATES.map((state) => [state, 0])) as Record<
    ListingState,
    number
  >;
  let total = 0;
  for (const state of LISTING_STATES) {
    const count = org.listings[state] ?? 0;
    byState[state] = count;
    total += count;
  }
  return {
    organization: {
      id: org.id,
      legalName: org.legalName,
      tradeName: org.tradeName,
      orgKind: 'provider',
      verificationState: org.state,
      reviewState: fixtureReviewState(org.state),
      suspendedAt: org.state === 'suspended' ? org.updatedAt : null,
      offboardedAt: org.state === 'offboarded' ? org.updatedAt : null,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      version: 1,
    },
    profile: {
      displayName: org.displayName,
      descriptionEn: `${org.displayName} — a fictional demo provider for the Himma fixture environment.`,
      descriptionAr: null,
      publicPhone: null,
      publicEmail: null,
      publicWebsite: null,
      publicInstagram: null,
      published: org.published,
      publiclyVisible: org.state === 'live' && org.published,
    },
    branches: org.branches,
    team: org.team,
    catalogue: { total, byState },
  };
}

/** Same normalization/escaping intent as the server: case-insensitive
 *  literal substring over display, trade, and legal names. */
function matchesSearch(org: FixtureOrg, q: string | undefined): boolean {
  const normalized = (q ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized === '') return true;
  return [org.displayName, org.tradeName, org.legalName].some((name) =>
    name.toLowerCase().includes(normalized),
  );
}

export interface FixtureProvidersAuthority {
  /** null = no session held (unavailable); otherwise whether the current
   *  identity holds the providers.operate capability (forbidden if not). */
  currentAuthority(): { hasProvidersCapability: boolean } | null;
  /** One-shot transient-failure seam for error-state tests/demos. */
  takeFailure(): boolean;
}

export function createFixtureProvidersPort(
  authority: FixtureProvidersAuthority,
  data?: FixtureProviderData,
): AdminProvidersReadPort {
  const source = (): readonly FixtureOrg[] =>
    data === undefined ? FIXTURE_ORGS : data.orgs.map((record) => record.org);
  return {
    async listOrganizations(params: ListOrganizationsParams) {
      const auth = authority.currentAuthority();
      if (auth === null) return { kind: 'unavailable' as const };
      if (authority.takeFailure()) return { kind: 'unavailable' as const };
      if (!auth.hasProvidersCapability) return { kind: 'forbidden' as const };
      // Server semantics: filters over the COMPLETE set, then the
      // (createdAt, id) keyset window.
      const filtered = source().filter(
        (org) =>
          matchesSearch(org, params.q) &&
          (params.state === undefined || org.state === params.state) &&
          (params.needsReview !== true || fixtureReviewState(org.state) !== 'none'),
      );
      const start =
        params.cursor === undefined
          ? 0
          : (() => {
              const anchor = filtered.findIndex((org) => org.id === params.cursor);
              return anchor === -1 ? 0 : anchor + 1;
            })();
      const limit = Math.min(Math.max(params.limit, 1), 100);
      const page = filtered.slice(start, start + limit);
      const hasMore = start + limit < filtered.length;
      return {
        kind: 'loaded' as const,
        page: {
          organizations: page.map(summaryOf),
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    },

    async getOrganization(organizationId: string) {
      const auth = authority.currentAuthority();
      if (auth === null) return { kind: 'unavailable' as const };
      if (authority.takeFailure()) return { kind: 'unavailable' as const };
      if (!auth.hasProvidersCapability) return { kind: 'forbidden' as const };
      const org = source().find((entry) => entry.id === organizationId);
      return org === undefined
        ? { kind: 'notFound' as const }
        : { kind: 'loaded' as const, detail: detailOf(org) };
    },
  };
}
