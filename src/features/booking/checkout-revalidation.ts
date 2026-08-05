import type { CheckoutIssueCode } from '@/services/contracts/checkout';

/**
 * Revalidation recovery mapping — docs/22 §7.10.2, docs/09 §22.10. Every
 * `CheckoutValidation` issue code maps to exactly one honest recovery
 * action, so the future backend can return any code and the screen always
 * offers a way forward. Nothing here advances, confirms, or claims anything:
 * a revalidation state renders no CTA and no payment controls, and its only
 * action either re-derives the page or returns the customer to the step
 * that owns the fix (no silent repair, docs/22 §7.10).
 */
export type CheckoutRecoveryTarget =
  /** Back to the flow start — the selection route re-runs the skip rule. */
  | 'flow-start'
  /** Back to the participant step, which owns eligibility states. */
  | 'participant'
  /** Back to Program Details — the evaluation surface. */
  | 'program'
  /** Stay on checkout and re-derive the page from the live draft. */
  | 'rederive';

export interface CheckoutIssueRecovery {
  actionLabel: string;
  target: CheckoutRecoveryTarget;
}

export function checkoutIssueRecovery(code: CheckoutIssueCode): CheckoutIssueRecovery {
  switch (code) {
    case 'sessionFull':
      // docs/22 §7.10: return-to-selection action.
      return { actionLabel: 'Choose another session', target: 'flow-start' };
    case 'registrationClosed':
      return { actionLabel: 'Back to program', target: 'program' };
    case 'priceChanged':
      // docs/22 §7.10: explicit review action that re-derives.
      return { actionLabel: 'Review updated price', target: 'rederive' };
    case 'offerExpired':
      return { actionLabel: 'Review booking', target: 'rederive' };
    case 'participantIneligible':
      return { actionLabel: 'Choose who is attending', target: 'participant' };
    case 'branchUnavailable':
      return { actionLabel: 'Choose another session', target: 'flow-start' };
    case 'invalidDraft':
      return { actionLabel: 'Start booking again', target: 'flow-start' };
  }
}

/**
 * The honest reassurance line every revalidation state shows: the system
 * has not performed anything, and the copy says so without implying a
 * payment, reservation, or confirmation ever existed.
 */
export const REVALIDATION_REASSURANCE = 'No payment has been made.';
