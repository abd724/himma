import type { BookingDraft, BookingSummary } from '@/services/contracts/booking';
import type { AreaId, Participant } from '@/types/domain';

/**
 * Checkout boundary — docs/22, owner decisions docs/09 §22. Checkout consumes
 * the re-derived, re-validated BookingSummary (docs/22 §2): it never copies
 * booking state and never owns an order of its own. Every field below is
 * display composition until a real backend owns it (docs/08 §14); authority
 * is called out per type. Nothing in this contract may imply a reservation,
 * a payment, or a confirmation exists.
 */

/**
 * How tax is treated in the displayed price. Owner decision (docs/09 §22.2):
 * no VAT line, no included/excluded claim, and no tax arithmetic exist until
 * backend tax configuration does — the only value this frontend ever emits
 * is 'notConfigured'. The remaining values are the future backend's.
 */
export type TaxTreatment = 'notConfigured' | 'includedInPrice' | 'addedAtCheckout' | 'providerSpecific';

export interface CheckoutPriceLine {
  id: string;
  /** Only 'base' is emitted this milestone — fees (docs/09 §22.3), discounts
   * (§22.5), taxes (§22.2), and credit (§22.12) are declared shapes for
   * future backend lines, which must reconcile per docs/22 §6. */
  kind: 'base' | 'discount' | 'fee' | 'tax' | 'credit';
  label: string; // '1 session' | 'Monthly enrolment' | 'Package of 6 sessions' | …
  value: string; // 'AED 85' | 'AED 450 per month' | 'Free'
  /**
   * Numeric participation in reconciliation, from structured price data
   * only — never parsed from copy (docs/09 §22.5). Undefined for cadence and
   * free display lines, which carry no one-off numeric amount.
   */
  amount?: number;
}

export interface CheckoutPriceSummary {
  lines: CheckoutPriceLine[];
  /** Informational only — never arithmetic (docs/09 §21.10, §22.5). */
  offerLine?: string;
  /**
   * One-off amounts reconcile numerically; cadence and free amounts have no
   * 'total' concept — and neither does anything else this milestone
   * (docs/09 §22.4: no `Total` wording until an authoritative backend
   * breakdown reconciles taxes, fees, discounts, and credits exactly).
   */
  priceKind: 'oneOff' | 'cadence' | 'free';
  /** The structured one-off amount the lines must sum to; undefined for cadence/free. */
  amount?: number;
  /**
   * 'Booking price · AED 85 per session' — continued unchanged from the
   * Booking Summary; never 'Total' (docs/09 §22.4).
   */
  bookingPriceLabel: string;
  spokenBookingPriceLabel: string;
  /** Always 'notConfigured' this milestone (docs/09 §22.2). */
  taxTreatment: TaxTreatment;
}

/**
 * applePay/googlePay are declared for docs/12 §9 readiness but are never
 * rendered as usable customer methods until real platform and gateway
 * support exist (docs/09 §22.6). Only the generic 'card' contract method is
 * composed, in Commit 17.
 */
export type PaymentMethodKind = 'card' | 'applePay' | 'googlePay';

export type PaymentMethodAvailability =
  /** Selectable; submitting stays the docs/09 §22.11 inert contract. */
  | { status: 'contractOnly' }
  /** Reserved for future honest disablement — visible, disabled, explained. */
  | { status: 'unavailable'; reason: string };

export interface PaymentMethod {
  id: string;
  kind: PaymentMethodKind;
  /**
   * 'Card payment' — generic. Never card details, last-four digits, expiry,
   * cardholder names, tokens, or fictional saved cards (docs/09 §22.6).
   */
  label: string;
  availability: PaymentMethodAvailability;
}

/** Future authoritative revalidation vocabulary — docs/09 §22.10. */
export type CheckoutIssueCode =
  | 'sessionFull'
  | 'registrationClosed'
  | 'priceChanged'
  | 'offerExpired'
  | 'participantIneligible'
  | 'branchUnavailable'
  | 'invalidDraft';

/**
 * Structured old → new price display for a 'priceChanged' issue — labels
 * composed from structured amounts by the issuing service (the future
 * backend price authority; docs/09 §22.4–5), never parsed from copy. The
 * updated label is always the current authoritative price.
 */
export interface CheckoutPriceComparison {
  previousLabel: string; // 'AED 75 per session'
  updatedLabel: string; // 'AED 85 per session'
}

export type CheckoutValidation =
  | { ok: true }
  | {
      ok: false;
      issues: {
        code: CheckoutIssueCode;
        message: string;
        /** Present only for 'priceChanged' (docs/22 §7.10 old → new). */
        priceComparison?: CheckoutPriceComparison;
      }[];
    };

export interface CheckoutPage {
  /** Re-derived at entry — the single order source (docs/22 §2); the
   * displayed cancellation policy is summary.policy (display only, no
   * acceptance model exists — docs/09 §22.7). */
  summary: BookingSummary;
  price: CheckoutPriceSummary;
  /**
   * 'Booked by you' for child bookings (docs/09 §22.8) — guardian context
   * display only; no consent mechanics exist this milestone.
   */
  guardianContextLine?: string;
  /** [generic Card payment] for paid bookings (composed in Commit 17); empty for free. */
  paymentMethods: PaymentMethod[];
  paymentRequired: boolean;
  /** Deterministic {ok: true} at entry once the access policy has passed.
   * Not-ok values are QA-only review demonstrations of the future backend
   * revalidation contract (docs/09 §22.10, docs/22 §7.10) — the screen maps
   * every issue code to an honest recovery action and renders no CTA while
   * an issue is unresolved. */
  validation: CheckoutValidation;
  /** docs/09 §22.11: paid → 'Continue to payment', free → 'Confirm booking'. */
  ctaLabel: 'Continue to payment' | 'Confirm booking';
  spokenCtaLabel: string;
}

/**
 * Declared for the future Payment milestone — never invoked, constructed, or
 * logged as though a submission occurred (docs/09 §22.11). A real submission
 * additionally requires the counsel-sourced legal acknowledgments recorded
 * in docs/22 §7.8 before it may ever be enabled.
 */
export interface PaymentSubmitRequest {
  draft: BookingDraft;
  paymentMethodId: string;
}

export type PaymentSubmitResult =
  | { status: 'notAvailable' }
  | { status: 'failed'; code: CheckoutIssueCode | 'paymentDeclined'; message: string }
  /** The confirmation handoff belongs to the Payment & Confirmation milestone (docs/09 §22.12). */
  | { status: 'succeeded'; confirmationHandoff: unknown };

export interface CheckoutPageInput {
  draft: BookingDraft;
  participants: Participant[];
  areaId: AreaId;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
  /** QA-only revalidation review states (docs/09 §22.10) — attaches a typed
   * not-ok validation to an otherwise-valid page; never customer-reachable,
   * never alters pricing or composition. */
  qaRevalidate?: CheckoutIssueCode;
}

export interface CheckoutService {
  /**
   * Undefined when the program is unknown or the draft cannot compose a
   * valid summary — the screen redirects via `checkoutStepAccess`, never
   * renders a broken checkout.
   */
  getCheckoutPage(input: CheckoutPageInput): Promise<CheckoutPage | undefined>;
}
