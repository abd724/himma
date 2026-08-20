/**
 * W3-6 catalogue/revision moderation contract — the typed frontend mirror
 * of the CERTIFIED S4-2 admin moderation surface (`/admin/listings`,
 * `/admin/revisions`, and the named decision routes). Nothing here invents
 * moderation semantics: the two mutation models stay distinct (listing
 * review vs ProgramRevision decisions), approval rests at `approved`
 * (publication remains the provider's), and reviewer feedback is the
 * certified machine `reasonCode` slug — no free-text reviewer prose
 * exists in this domain.
 */

export interface ModerationQueueRow {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationDisplayName: string;
  readonly titleEn: string;
  readonly listingState: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RevisionQueueRow {
  readonly id: string;
  readonly programId: string;
  readonly organizationId: string;
  readonly programTitleEn: string;
  readonly state: string;
  readonly version: number;
  readonly createdAt: string;
}

/** The reviewer change-set exactly as the backend projects it: null =
 *  "this field is not proposed to change". */
export interface RevisionChangeSet {
  readonly id: string;
  readonly programId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly version: number;
  readonly minAge: number | null;
  readonly maxAge: number | null;
  readonly allAges: boolean | null;
  readonly genderEligibility: string | null;
  readonly skillLevel: string | null;
  readonly eligibilityNotes: string | null;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly option: {
    readonly optionId: string | null;
    readonly kind: string | null;
    readonly amountFils: number | null;
    readonly sessionsCount: number | null;
    readonly labelEn: string | null;
    readonly labelAr: string | null;
    readonly sortHint: number | null;
    readonly state: string | null;
  } | null;
}

/** The listing truth the moderation workspace renders (a bounded
 *  projection of the backend's full detail view — validated on exactly
 *  the consumed fields). */
export interface ModerationListingView {
  readonly program: {
    readonly id: string;
    readonly titleEn: string;
    readonly listingState: string;
    readonly version: number;
    readonly descriptionEn: string | null;
    readonly setting: string;
    readonly genderEligibility: string;
    readonly minAge: number | null;
    readonly maxAge: number | null;
    readonly allAges: boolean;
    readonly skillLevel: string | null;
    readonly eligibilityNotes: string | null;
    readonly publishedAt: string | null;
    readonly updatedAt: string;
    readonly priceOptions: ReadonlyArray<{
      readonly kind: string;
      readonly amountFils: number | null;
      readonly labelEn: string | null;
      readonly state: string;
    }>;
    readonly branches: ReadonlyArray<{
      readonly label: string;
      readonly associationActive: boolean;
    }>;
  };
  readonly organization: {
    readonly id: string;
    readonly displayName: string;
    readonly verificationState: string;
  };
  readonly revision: RevisionChangeSet | null;
}

export type ModerationQueueOutcome =
  | {
      readonly kind: 'loaded';
      readonly rows: readonly ModerationQueueRow[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export type RevisionQueueOutcome =
  | {
      readonly kind: 'loaded';
      readonly rows: readonly RevisionQueueRow[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export type ModerationViewOutcome =
  | { readonly kind: 'loaded'; readonly view: ModerationListingView }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/** Typed action refusals — the certified backend conditions, distinct. */
export type ModerationActionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'stepUpRequired' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  /** The revision payload no longer applies cleanly (S4 typed refusals). */
  | { readonly kind: 'revisionInvalid' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type ListingReviewAction = 'start_review' | 'approve' | 'request_changes';

export interface AdminModerationPort {
  listListings(params: {
    state?: 'submitted' | 'in_review';
    cursor?: string;
  }): Promise<ModerationQueueOutcome>;
  listRevisions(params: {
    state?: 'submitted' | 'in_review';
    cursor?: string;
  }): Promise<RevisionQueueOutcome>;
  getListing(programId: string): Promise<ModerationViewOutcome>;
  reviewListing(
    programId: string,
    action: ListingReviewAction,
    input: { expectedVersion: number; reasonCode?: string },
  ): Promise<ModerationActionOutcome>;
  startRevisionReview(
    programId: string,
    revisionId: string,
    input: { expectedVersion: number },
  ): Promise<ModerationActionOutcome>;
  decideRevision(
    programId: string,
    revisionId: string,
    decision: 'approve' | 'reject',
    input: { expectedVersion: number; reasonCode?: string },
  ): Promise<ModerationActionOutcome>;
}
