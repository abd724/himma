import type {
  AdminModerationPort,
  ModerationActionOutcome,
  ModerationListingView,
  RevisionChangeSet,
} from '../../moderation/contract';

/**
 * Deterministic FIXTURE catalogue-moderation data (W3-6) — fictional
 * listings/revisions for the demo organizations, behind the same port the
 * live runtime implements. Semantics mirror the CERTIFIED S4 machine: the
 * TWO mutation models stay distinct (listing review vs ProgramRevision),
 * start_review submitted→in_review, approve rests at `approved`
 * (publication stays with the provider), request_changes →
 * changes_requested (provider resubmits), revision approval APPLIES the
 * change-set to the listing atomically while the listing stays published,
 * rejection leaves the listing untouched. CAS/stale and the D-W3-5
 * step-up seam are representable through the runtime controls. Live mode
 * can never reach this module (composition-locked).
 */

interface FixtureListing {
  id: string;
  organizationId: string;
  organizationDisplayName: string;
  titleEn: string;
  listingState: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  descriptionEn: string | null;
  setting: string;
  genderEligibility: string;
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean;
  skillLevel: string | null;
  eligibilityNotes: string | null;
  publishedAt: string | null;
  priceOptions: Array<{
    kind: string;
    amountFils: number | null;
    labelEn: string | null;
    state: string;
  }>;
  branches: Array<{ label: string; associationActive: boolean }>;
  revision: (RevisionChangeSet & { id: string }) | null;
}

export interface FixtureModerationData {
  listings: FixtureListing[];
}

export function createFixtureModerationData(): FixtureModerationData {
  return {
    listings: [
      {
        id: 'listing-aquava-camp',
        organizationId: 'org-aquava',
        organizationDisplayName: 'Aquava Swim School',
        titleEn: 'Junior Swim Camp',
        listingState: 'submitted',
        version: 2,
        createdAt: '2026-08-10T08:00:00.000Z',
        updatedAt: '2026-08-16T11:30:00.000Z',
        descriptionEn: 'A two-week beginner swim camp with certified coaches.',
        setting: 'indoor',
        genderEligibility: 'mixed',
        minAge: 6,
        maxAge: 12,
        allAges: false,
        skillLevel: 'beginner',
        eligibilityNotes: null,
        publishedAt: null,
        priceOptions: [
          { kind: 'package', amountFils: 45_000, labelEn: 'Two-week camp', state: 'active' },
        ],
        branches: [{ label: 'JLT Pool Deck', associationActive: true }],
        revision: null,
      },
      {
        id: 'listing-bluebay-sail',
        organizationId: 'org-blue-bay',
        organizationDisplayName: 'Blue Bay Sailing',
        titleEn: 'Sunset Sailing Basics',
        listingState: 'submitted',
        version: 2,
        createdAt: '2026-08-12T08:00:00.000Z',
        updatedAt: '2026-08-17T18:05:00.000Z',
        descriptionEn: 'Evening dinghy sessions for absolute beginners.',
        setting: 'outdoor',
        genderEligibility: 'mixed',
        minAge: 10,
        maxAge: null,
        allAges: false,
        skillLevel: 'beginner',
        eligibilityNotes: 'Swimming ability required.',
        publishedAt: null,
        priceOptions: [{ kind: 'dropIn', amountFils: 9_000, labelEn: null, state: 'active' }],
        branches: [{ label: 'Harbour Point', associationActive: true }],
        revision: null,
      },
      {
        id: 'listing-marina-clinic',
        organizationId: 'org-marina-ace',
        organizationDisplayName: 'Marina Ace Tennis',
        titleEn: 'Adult Tennis Clinic',
        listingState: 'in_review',
        version: 3,
        createdAt: '2026-08-08T08:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
        descriptionEn: 'Weekly technique clinic for adult intermediates.',
        setting: 'outdoor',
        genderEligibility: 'mixed',
        minAge: 18,
        maxAge: null,
        allAges: false,
        skillLevel: 'intermediate',
        eligibilityNotes: null,
        publishedAt: null,
        priceOptions: [{ kind: 'monthly', amountFils: 60_000, labelEn: 'Monthly', state: 'active' }],
        branches: [{ label: 'Marina Courts', associationActive: true }],
        revision: null,
      },
      {
        id: 'listing-marina-term',
        organizationId: 'org-marina-ace',
        organizationDisplayName: 'Marina Ace Tennis',
        titleEn: 'Junior Tennis Term',
        listingState: 'published',
        version: 6,
        createdAt: '2026-07-20T08:00:00.000Z',
        updatedAt: '2026-08-18T12:00:00.000Z',
        descriptionEn: 'Term-long junior coaching, ages grouped by level.',
        setting: 'outdoor',
        genderEligibility: 'mixed',
        minAge: 6,
        maxAge: 14,
        allAges: false,
        skillLevel: null,
        eligibilityNotes: null,
        publishedAt: '2026-08-01T09:00:00.000Z',
        priceOptions: [{ kind: 'term', amountFils: 120_000, labelEn: 'Full term', state: 'active' }],
        branches: [
          { label: 'Marina Courts', associationActive: true },
          { label: 'JBR Beach Courts', associationActive: true },
        ],
        // A provider-submitted PROTECTED change awaiting review.
        revision: {
          id: 'rev-marina-term-1',
          programId: 'listing-marina-term',
          state: 'submitted',
          createdAt: '2026-08-18T12:00:00.000Z',
          version: 1,
          minAge: 7,
          maxAge: null,
          allAges: null,
          genderEligibility: null,
          skillLevel: null,
          eligibilityNotes: null,
          descriptionEn: 'Term-long junior coaching with weekly match play.',
          descriptionAr: null,
          option: null,
        },
      },
    ],
  };
}

export interface FixtureModerationAuthority {
  currentAuthority(): { hasCatalogueCapability: boolean } | null;
  takeFailure(): boolean;
  stepUpDemanded(): boolean;
}

function viewOf(listing: FixtureListing): ModerationListingView {
  return {
    program: {
      id: listing.id,
      titleEn: listing.titleEn,
      listingState: listing.listingState,
      version: listing.version,
      descriptionEn: listing.descriptionEn,
      setting: listing.setting,
      genderEligibility: listing.genderEligibility,
      minAge: listing.minAge,
      maxAge: listing.maxAge,
      allAges: listing.allAges,
      skillLevel: listing.skillLevel,
      eligibilityNotes: listing.eligibilityNotes,
      publishedAt: listing.publishedAt,
      updatedAt: listing.updatedAt,
      priceOptions: listing.priceOptions,
      branches: listing.branches,
    },
    organization: {
      id: listing.organizationId,
      displayName: listing.organizationDisplayName,
      // Deterministic fixture truth: the demo orgs with published listings
      // are live; pre-live orgs show their onboarding state.
      verificationState: listing.publishedAt !== null ? 'live' : 'submitted',
    },
    revision: listing.revision,
  };
}

export function createFixtureModerationPort(
  authority: FixtureModerationAuthority,
  data: FixtureModerationData,
): AdminModerationPort {
  const admit = (): ModerationActionOutcome | null => {
    const auth = authority.currentAuthority();
    if (auth === null) return { kind: 'unavailable' };
    if (authority.takeFailure()) return { kind: 'unavailable' };
    if (!auth.hasCatalogueCapability) return { kind: 'forbidden' };
    return null;
  };

  const listingOf = (programId: string): FixtureListing | undefined =>
    data.listings.find((entry) => entry.id === programId);

  return {
    async listListings(params) {
      const refused = admit();
      if (refused !== null) {
        return refused.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
      }
      const reviewable = data.listings.filter((entry) =>
        params.state !== undefined
          ? entry.listingState === params.state
          : entry.listingState === 'submitted' || entry.listingState === 'in_review',
      );
      return {
        kind: 'loaded',
        rows: reviewable.map((entry) => ({
          id: entry.id,
          organizationId: entry.organizationId,
          organizationDisplayName: entry.organizationDisplayName,
          titleEn: entry.titleEn,
          listingState: entry.listingState,
          version: entry.version,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        })),
        nextCursor: null,
      };
    },

    async listRevisions(params) {
      const refused = admit();
      if (refused !== null) {
        return refused.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
      }
      const rows = data.listings
        .filter(
          (entry) =>
            entry.revision !== null &&
            (params.state === undefined || entry.revision.state === params.state),
        )
        .map((entry) => ({
          id: entry.revision!.id,
          programId: entry.id,
          organizationId: entry.organizationId,
          programTitleEn: entry.titleEn,
          state: entry.revision!.state,
          version: entry.revision!.version,
          createdAt: entry.revision!.createdAt,
        }));
      return { kind: 'loaded', rows, nextCursor: null };
    },

    async getListing(programId) {
      const refused = admit();
      if (refused !== null) {
        return refused.kind === 'forbidden' ? { kind: 'forbidden' } : { kind: 'unavailable' };
      }
      const listing = listingOf(programId);
      return listing === undefined ? { kind: 'notFound' } : { kind: 'loaded', view: viewOf(listing) };
    },

    async reviewListing(programId, action, input) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      const listing = listingOf(programId);
      if (listing === undefined) return { kind: 'notFound' };
      const legal =
        (action === 'start_review' && listing.listingState === 'submitted') ||
        ((action === 'approve' || action === 'request_changes') &&
          listing.listingState === 'in_review');
      if (!legal) return { kind: 'lifecycleConflict' };
      if (listing.version !== input.expectedVersion) return { kind: 'staleVersion' };
      listing.listingState =
        action === 'start_review'
          ? 'in_review'
          : action === 'approve'
            ? 'approved' // approval RESTS here — publication is the provider's
            : 'changes_requested';
      listing.version += 1;
      return { kind: 'completed' };
    },

    async startRevisionReview(programId, revisionId, input) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      const listing = listingOf(programId);
      const revision = listing?.revision;
      if (listing === undefined || revision === null || revision === undefined || revision.id !== revisionId) {
        return { kind: 'notFound' };
      }
      if (revision.state !== 'submitted') return { kind: 'lifecycleConflict' };
      if (revision.version !== input.expectedVersion) return { kind: 'staleVersion' };
      listing.revision = { ...revision, state: 'in_review', version: revision.version + 1 };
      return { kind: 'completed' };
    },

    async decideRevision(programId, revisionId, decision, input) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      const listing = listingOf(programId);
      const revision = listing?.revision;
      if (listing === undefined || revision === null || revision === undefined || revision.id !== revisionId) {
        return { kind: 'notFound' };
      }
      if (revision.state !== 'in_review') return { kind: 'lifecycleConflict' };
      if (revision.version !== input.expectedVersion) return { kind: 'staleVersion' };
      if (decision === 'approve') {
        // Atomic application of the change-set to the LISTING (the S4
        // semantics) — the listing stays published throughout.
        if (revision.descriptionEn !== null) listing.descriptionEn = revision.descriptionEn;
        if (revision.minAge !== null) listing.minAge = revision.minAge;
        if (revision.maxAge !== null) listing.maxAge = revision.maxAge;
        if (revision.allAges !== null) listing.allAges = revision.allAges;
        if (revision.genderEligibility !== null) {
          listing.genderEligibility = revision.genderEligibility;
        }
        if (revision.skillLevel !== null) listing.skillLevel = revision.skillLevel;
        if (revision.eligibilityNotes !== null) {
          listing.eligibilityNotes = revision.eligibilityNotes;
        }
        listing.version += 1;
      }
      // Approved or rejected, the round is closed; the listing itself is
      // untouched on rejection.
      listing.revision = null;
      return { kind: 'completed' };
    },
  };
}
