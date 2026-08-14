import type { ProgramDetailRecord } from '../../../catalogue/contract';
import type { OrganizationView } from '../../../profile/contract';
import { catalogueAuthority, type CatalogueAuthority } from '../listing-domain';

/**
 * W2-8 editor authority + edit-state truth — derived ONLY from the backend
 * vocabulary the ports already carry; the backend stays the boundary.
 */

/** docs/24 §5.3 edit-state matrix (catalogue-shared.ts editModeOf, exact). */
export type EditorMode = 'direct' | 'reviewGated' | 'locked';

export function editorModeOf(listingState: string): EditorMode {
  if (listingState === 'draft' || listingState === 'changes_requested') return 'direct';
  if (listingState === 'approved' || listingState === 'published' || listingState === 'paused') {
    return 'reviewGated';
  }
  return 'locked';
}

/**
 * The MUTATION branch-scope rule (programInBranchScope — the stricter
 * `every` rule, deliberately different from the W2-7 read rule): a
 * branch-scoped membership may mutate a listing only while EVERY active
 * association lies inside its assigned ACTIVE branches (vacuously true for
 * branchless drafts). Reading a listing NEVER implies editing it.
 */
export function listingMutableForScope(
  program: ProgramDetailRecord,
  assignedActiveBranchIds: readonly string[] | null,
): boolean {
  if (assignedActiveBranchIds === null) {
    return true;
  }
  return program.branches
    .filter((branch) => branch.associationActive)
    .every((branch) => assignedActiveBranchIds.includes(branch.branchId));
}

export interface EditorAuthority extends CatalogueAuthority {
  /** `media.manage` present — the media section's own capability. */
  readonly canManageMedia: boolean;
}

export function editorAuthority(view: OrganizationView): EditorAuthority {
  return {
    ...catalogueAuthority(view),
    canManageMedia: view.membership.capabilities.includes('media.manage'),
  };
}

/** docs/28 §7 admin-designated sensitive PATCH fields (exact backend set).
 *  Price options are sensitive too — handled by their own operations. */
export const SENSITIVE_PROGRAM_FIELDS = [
  'descriptionEn',
  'descriptionAr',
  'minAge',
  'maxAge',
  'allAges',
  'genderEligibility',
  'skillLevel',
  'eligibilityNotes',
] as const;

export const EDITOR_NO_ACCESS_COPY =
  'Your role can’t create or edit listings. Owners, Organization Managers, Branch Managers, and Listings Editors manage the catalogue.';

export const EDITOR_SCOPE_COPY =
  'This listing runs at branches outside your assigned branches, so it can’t be edited from your branch scope. You can still read it.';

export const SUSPENDED_EDITOR_COPY =
  'This organization is currently suspended. Listings stay readable, but changes are unavailable.';

export const REVIEW_REQUIRED_COPY =
  'Protected details — like descriptions, eligibility, and pricing — need Himma review before they change on an approved listing.';

export const REVISION_PENDING_COPY =
  'A change is already awaiting Himma review. Further protected changes unlock after that review.';

export const LOCKED_STATE_COPY: Record<string, string> = {
  submitted:
    'This listing is with Himma for review. Editing unlocks when the review finishes.',
  in_review: 'Himma is reviewing this listing right now. Editing unlocks when the review finishes.',
  archived:
    'This listing is archived. Archiving is final — its content stays here as a read-only record.',
};

/** Shared human copy for the common mutation refusals (per-outcome copy
 *  that isn't operation-specific stays in the sections). */
export function commonMutationErrorCopy(kind: string): string {
  switch (kind) {
    case 'staleVersion':
      return 'Someone else saved this listing first. Reload the latest version, then apply your change again.';
    case 'lifecycleConflict':
      return 'This listing’s state changed and no longer allows that action. Reload to see the latest state.';
    case 'revisionPending':
      return REVISION_PENDING_COPY;
    case 'organizationSuspended':
      return SUSPENDED_EDITOR_COPY;
    case 'forbidden':
      return 'Your role can’t make that change.';
    case 'notFound':
      return 'This listing isn’t available any more.';
    default:
      return 'That didn’t save right now — nothing was changed. Try again in a moment.';
  }
}

export const CHANGES_REQUESTED_EDITOR_COPY =
  'Himma asked for changes before this listing can be approved. Make your corrections here, then resubmit it for review from the listing page.';
