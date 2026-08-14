import type { ProgramDetailRecord } from '../../catalogue/contract';
import type { OrganizationView } from '../../profile/contract';
import { listingMutableForScope } from './editor/editor-domain';
import { catalogueAuthority, completenessGaps, isListingState } from './listing-domain';

/**
 * W2-9 lifecycle-action truth — a PURE derivation of which named lifecycle
 * actions the current viewer genuinely owns for a listing, mirroring the
 * real backend authority exactly (D-S4-2):
 *
 * - submit/resubmit: `listings.manage` (Owner, Organization Manager,
 *   Listings Editor; Branch Manager only within the STRICTER every-rule
 *   mutation scope), legal from `draft` and `changes_requested`, and only
 *   once the four completeness requirements hold (the backend refuses an
 *   incomplete submit — we don't offer an action that would be refused).
 * - publish (first publication from `approved`, resume from `paused`),
 *   pause, archive: `listings.publish` — Owner + Organization Manager ONLY.
 *   Listings Editor and Branch Manager have NO publication authority and
 *   never see a publication control, disabled or otherwise (frontend
 *   visibility is usability only; the backend stays the boundary).
 * - Nothing is offered on `submitted`/`in_review` (Himma owns the next
 *   step) or `archived` (terminal), or while the organization is
 *   suspended.
 *
 * The plan also names the truthful explanations for what is NOT offered:
 * completeness blockers, the `organizationNotLive` publication gate (an
 * organization-level condition, distinct from listing completeness), and
 * the approved/paused "an authorized person publishes" note for viewers
 * without publication authority.
 */

export type LifecycleActionKind = 'submit' | 'resubmit' | 'publish' | 'resume' | 'pause' | 'archive';

export interface LifecyclePlan {
  /** Named actions the viewer truly owns right now, in display order. */
  readonly actions: readonly LifecycleActionKind[];
  /** draft/changes_requested, viewer could submit, but completeness gaps
   *  remain — the readiness list explains exactly what's missing. */
  readonly submitBlockedByCompleteness: boolean;
  /** approved/paused, viewer holds publication authority, but the listing
   *  no longer meets the completeness requirements. */
  readonly publishBlockedByCompleteness: boolean;
  /** approved/paused, viewer holds publication authority, but the
   *  ORGANIZATION isn't live on Himma — a publication gate of its own,
   *  never a listing-completeness problem. */
  readonly publishBlockedByOrganization: boolean;
  /** approved/paused and the viewer has catalogue access but NO publication
   *  authority: an Owner or Organization Manager publishes. */
  readonly awaitingPublisher: boolean;
}

const NO_PLAN: LifecyclePlan = {
  actions: [],
  submitBlockedByCompleteness: false,
  publishBlockedByCompleteness: false,
  publishBlockedByOrganization: false,
  awaitingPublisher: false,
};

export function lifecyclePlan(view: OrganizationView, program: ProgramDetailRecord): LifecyclePlan {
  const authority = catalogueAuthority(view);
  const canPublish = view.membership.capabilities.includes('listings.publish');
  if (authority.suspended || !isListingState(program.listingState)) {
    return NO_PLAN;
  }
  const state = program.listingState;
  const complete = completenessGaps(program).length === 0;
  const organizationLive = view.organization.verificationState === 'live';

  if (state === 'draft' || state === 'changes_requested') {
    const mayMutate =
      authority.canManage && listingMutableForScope(program, authority.assignedActiveBranchIds);
    if (!mayMutate) {
      return NO_PLAN;
    }
    if (!complete) {
      return { ...NO_PLAN, submitBlockedByCompleteness: true };
    }
    return { ...NO_PLAN, actions: [state === 'draft' ? 'submit' : 'resubmit'] };
  }

  if (state === 'approved' || state === 'paused') {
    if (!canPublish) {
      return { ...NO_PLAN, awaitingPublisher: true };
    }
    const archiveActions: readonly LifecycleActionKind[] = state === 'paused' ? ['archive'] : [];
    if (!organizationLive) {
      return { ...NO_PLAN, actions: archiveActions, publishBlockedByOrganization: true };
    }
    if (!complete) {
      return { ...NO_PLAN, actions: archiveActions, publishBlockedByCompleteness: true };
    }
    return {
      ...NO_PLAN,
      actions: [state === 'approved' ? 'publish' : 'resume', ...archiveActions],
    };
  }

  if (state === 'published') {
    return canPublish ? { ...NO_PLAN, actions: ['pause', 'archive'] } : NO_PLAN;
  }

  // submitted, in_review (Himma owns the next step), archived (terminal).
  return NO_PLAN;
}

// -- provider-facing copy -----------------------------------------------------

export const LIFECYCLE_ACTION_LABELS: Record<LifecycleActionKind, string> = {
  submit: 'Submit for review',
  resubmit: 'Resubmit for review',
  publish: 'Publish listing',
  resume: 'Resume publishing',
  pause: 'Pause listing',
  archive: 'Archive listing',
};

export const LIFECYCLE_ACTION_BUSY_LABELS: Record<LifecycleActionKind, string> = {
  submit: 'Submitting…',
  resubmit: 'Resubmitting…',
  publish: 'Publishing…',
  resume: 'Resuming…',
  pause: 'Pausing…',
  archive: 'Archiving…',
};

/** Success announcements — made ONLY after the port confirms the outcome. */
export const LIFECYCLE_SUCCESS_COPY: Record<LifecycleActionKind, string> = {
  submit: 'Submitted to Himma for review.',
  resubmit: 'Resubmitted to Himma for review.',
  publish: 'Published. Customers can find it subject to the visibility checks shown here.',
  resume: 'Publishing resumed. Customers can find it subject to the visibility checks shown here.',
  pause: 'Paused. Customers can no longer find this listing until publishing resumes.',
  archive: 'Archived. This listing is permanently retired.',
};

/** The organizationNotLive publication gate — an organization-level
 *  condition, deliberately worded apart from listing completeness. */
export const ORGANIZATION_NOT_LIVE_COPY =
  'Your organization isn’t live on Himma yet, so listings can’t be published. Publishing opens up once Himma completes your organization’s verification.';

export const AWAITING_PUBLISHER_COPY: Record<'approved' | 'paused', string> = {
  approved:
    'Himma approved this listing. Publishing is a separate step that an Owner or Organization Manager takes — it isn’t visible to customers yet.',
  paused:
    'An Owner or Organization Manager can resume publishing this listing.',
};

export const PUBLISH_BLOCKED_BY_COMPLETENESS_COPY =
  'Publishing is unavailable until this listing meets the catalogue requirements again:';

export const SUBMIT_READY_COPY = 'This listing meets the submission requirements.';

/** Refusal copy per lifecycle outcome (success outcomes never route here).
 *  `programIncomplete` renders its structured missing items separately. */
export function lifecycleErrorCopy(kind: string): string {
  switch (kind) {
    case 'staleVersion':
      return 'This listing changed since you opened it. The latest details are shown now — review them, then try again.';
    case 'lifecycleConflict':
      return 'That action isn’t available for this listing’s current status. The latest status is shown now.';
    case 'organizationNotLive':
      return ORGANIZATION_NOT_LIVE_COPY;
    case 'organizationSuspended':
      return 'This organization is currently suspended. Changes are unavailable.';
    case 'forbidden':
      return 'Your role can’t take that action.';
    case 'notFound':
      return 'This listing isn’t available any more.';
    default:
      return 'That didn’t go through — nothing was changed. Try again in a moment.';
  }
}

export const LIFECYCLE_INCOMPLETE_INTRO =
  'This listing isn’t ready yet. It still needs:';

/** Confirmation dialogs — only where they genuinely help (task §10). */
export const PAUSE_CONFIRM = {
  title: 'Pause this listing?',
  body: 'Customers will no longer find it on Himma while it’s paused. You can resume publishing at any time.',
  confirmLabel: 'Pause listing',
} as const;

export const ARCHIVE_CONFIRM = {
  title: 'Archive this listing permanently?',
  body: 'Archiving is final and can’t be reversed. The listing comes off the catalogue for good and can never be published or edited again. Its details stay available as a read-only record.',
  confirmLabel: 'Archive permanently',
} as const;
