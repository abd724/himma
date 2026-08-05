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

/**
 * Per-code visual presentation for the CheckoutIssueCard — owner-directed
 * redesign of the revalidation states (recorded checkout-interruption
 * design, 2026-08-05): each state carries a state-appropriate icon, a small
 * state label, a headline, and supporting copy. States are deliberately not
 * visually identical because their meanings differ. Copy is presentation
 * only — codes, routes, recovery targets, and the payment prohibition are
 * unchanged; amounts never appear here (the priceChanged old → new pair is
 * structured `CheckoutPriceComparison` data from the issuing service).
 */
export interface CheckoutIssuePresentation {
  /** Ionicons name — state-appropriate, never the generic search glyph. */
  icon: string;
  stateLabel: string;
  headline: string;
  support: string;
}

export function checkoutIssuePresentation(code: CheckoutIssueCode): CheckoutIssuePresentation {
  switch (code) {
    case 'sessionFull':
      return {
        icon: 'calendar-outline',
        stateLabel: 'Session unavailable',
        headline: 'This session just filled up',
        support: 'Choose another available time to continue your booking.',
      };
    case 'registrationClosed':
      return {
        icon: 'lock-closed-outline',
        stateLabel: 'Registration closed',
        headline: 'Registration for this program has closed',
        support: 'You can review the program or browse other activities.',
      };
    case 'priceChanged':
      return {
        icon: 'pricetag-outline',
        stateLabel: 'Price updated',
        // Booking-generic (owner decision, 2026-08-05): correct for every
        // program type — sessions, enrolments, camps, and packages alike.
        headline: 'Your booking price has changed',
        support: 'Review the updated price before continuing.',
      };
    case 'offerExpired':
      return {
        icon: 'time-outline',
        stateLabel: 'Offer ended',
        headline: 'This offer has ended',
        support: 'Review your booking with the current price before continuing.',
      };
    case 'participantIneligible':
      return {
        icon: 'person-outline',
        stateLabel: 'Eligibility changed',
        headline: 'This participant can no longer join',
        support: 'Choose who is attending to continue your booking.',
      };
    case 'branchUnavailable':
      return {
        icon: 'location-outline',
        stateLabel: 'Location unavailable',
        headline: 'This location is no longer available',
        support: 'Choose another session to continue your booking.',
      };
    case 'invalidDraft':
      return {
        icon: 'refresh-outline',
        stateLabel: 'Booking out of date',
        headline: 'This booking needs to be started again',
        support: 'Start the booking again to continue.',
      };
  }
}
