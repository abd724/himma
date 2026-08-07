import type { OnboardingSnapshot } from './contract';

/**
 * The one explicit onboarding/readiness model (task §9) — a pure derivation
 * over canonical fields only. It deliberately keeps separate concepts
 * separate: profile completeness ≠ verification ≠ lifecycle ≠ storefront
 * publication ≠ listing state. No percentages are fabricated; completeness
 * mirrors the exact backend submit rules (trimmed display name present AND
 * ≥1 ACTIVE branch). Actionability comes from the membership's REAL
 * capability list; the backend stays the authority.
 */

export type OnboardingStage =
  | 'setup'
  | 'submitted'
  | 'inReview'
  | 'rejected'
  | 'verified'
  | 'live'
  | 'suspended'
  | 'unknown';

export type RequirementState =
  | 'complete'
  | 'actionRequired'
  | 'awaitingHimma'
  | 'blocked'
  | 'optional';

export type RequirementId =
  | 'profile'
  | 'branches'
  | 'team'
  | 'review'
  | 'goLive'
  | 'firstListing';

export interface OnboardingItem {
  readonly id: RequirementId;
  readonly state: RequirementState;
  /** Whether THIS member holds the real capability behind the step's action. */
  readonly actionable: boolean;
}

export type SubmissionReadiness =
  | { readonly kind: 'ready' }
  | { readonly kind: 'incomplete'; readonly missing: ReadonlyArray<'profile' | 'branches'> }
  /** Completeness met/irrelevant, but this member lacks `org.submit`. */
  | { readonly kind: 'notAllowed' }
  /** The lifecycle state does not accept a submission at all. */
  | { readonly kind: 'notApplicable' };

export interface OnboardingView {
  readonly stage: OnboardingStage;
  readonly items: readonly OnboardingItem[];
  readonly submission: SubmissionReadiness;
}

const STAGE_BY_STATE: Record<string, OnboardingStage> = {
  draft: 'setup',
  submitted: 'submitted',
  in_review: 'inReview',
  rejected: 'rejected',
  verified: 'verified',
  live: 'live',
  suspended: 'suspended',
};

export function deriveOnboarding(snapshot: OnboardingSnapshot): OnboardingView {
  const capabilities = new Set(snapshot.membership.capabilities);
  const state = snapshot.organization.verificationState;
  const stage = STAGE_BY_STATE[state] ?? 'unknown';

  const profileComplete = snapshot.profile.displayName.trim().length > 0;
  const branchesComplete = snapshot.branches.some((branch) => branch.active);
  const complete = profileComplete && branchesComplete;
  const submittable = state === 'draft' || state === 'rejected';

  const missing: Array<'profile' | 'branches'> = [];
  if (!profileComplete) {
    missing.push('profile');
  }
  if (!branchesComplete) {
    missing.push('branches');
  }

  const items: OnboardingItem[] = [
    {
      id: 'profile',
      state: profileComplete ? 'complete' : 'actionRequired',
      actionable: capabilities.has('profile.edit'),
    },
    {
      id: 'branches',
      state: branchesComplete ? 'complete' : 'actionRequired',
      actionable: capabilities.has('branch.create'),
    },
    {
      id: 'team',
      state: 'optional',
      actionable: capabilities.has('staff.manage'),
    },
    {
      id: 'review',
      state: reviewState(stage, complete),
      actionable: capabilities.has('org.submit'),
    },
    {
      id: 'goLive',
      state: goLiveState(stage),
      actionable: false, // go-live is never provider-triggerable
    },
  ];

  if (stage === 'live') {
    items.push({
      id: 'firstListing',
      state: (snapshot.listingCount ?? 0) > 0 ? 'complete' : 'actionRequired',
      actionable: capabilities.has('listings.manage'),
    });
  }

  const submission: SubmissionReadiness = !submittable
    ? { kind: 'notApplicable' }
    : !capabilities.has('org.submit')
      ? { kind: 'notAllowed' }
      : missing.length > 0
        ? { kind: 'incomplete', missing }
        : { kind: 'ready' };

  return { stage, items, submission };
}

function reviewState(stage: OnboardingStage, complete: boolean): RequirementState {
  switch (stage) {
    case 'setup':
    case 'rejected':
      return complete ? 'actionRequired' : 'blocked';
    case 'submitted':
    case 'inReview':
      return 'awaitingHimma';
    case 'verified':
    case 'live':
      return 'complete';
    default:
      return 'blocked';
  }
}

function goLiveState(stage: OnboardingStage): RequirementState {
  switch (stage) {
    case 'verified':
      return 'awaitingHimma';
    case 'live':
      return 'complete';
    default:
      return 'blocked';
  }
}
