import { bookingExtras } from '@/data/mock/booking-extras';
import type { BookingOption, BookingSummary } from '@/services/contracts/booking';
import type {
  CheckoutIssueCode,
  CheckoutPage,
  CheckoutPageInput,
  CheckoutPriceComparison,
  CheckoutPriceLine,
  CheckoutPriceSummary,
  CheckoutService,
  CheckoutValidation,
  PaymentMethod,
} from '@/services/contracts/checkout';
import { MockBookingService } from '@/services/mock/mock-booking-service';
import type { PriceModel } from '@/types/domain';
import { priceLabel, spokenLabel } from '@/utils/price';

/**
 * Deterministic checkout mock — docs/22, owner decisions docs/09 §22.
 * Composes display data over the re-derived BookingSummary (docs/22 §2):
 * no VAT, no fees, no discount arithmetic, no `Total` wording, and no
 * payment or reservation behavior of any kind exist here. The real backend
 * later owns pricing authority, revalidation, and submission (docs/08 §14).
 */

/**
 * The structured one-off amount for reconciliation — from price data and
 * booking extras only, never parsed from labels (docs/09 §22.5). Undefined
 * for cadence (monthly/term) and free shapes.
 */
function oneOffAmount(summary: BookingSummary, option: BookingOption): number | undefined {
  const price = summary.program.price;
  if (price === undefined) return undefined;
  switch (option.kind) {
    case 'single-session':
      return price.kind === 'dropIn' ? price.amount : undefined;
    case 'membership':
    case 'package':
      return price.kind === 'package' ? price.amount : undefined;
    case 'camp-week':
      return price.kind === 'camp' ? price.amountPerWeek : undefined;
    case 'trial':
      // Free trials carry no amount; paid trials use the structured extra.
      return option.priceLabel === 'Free'
        ? undefined
        : bookingExtras[summary.program.id]?.trialAmount;
    case 'free-session':
    case 'recurring':
    case 'term':
      return undefined;
  }
}

function priceKindFor(option: BookingOption): CheckoutPriceSummary['priceKind'] {
  switch (option.kind) {
    case 'recurring':
    case 'term':
      return 'cadence';
    case 'free-session':
      return 'free';
    case 'trial':
      return option.priceLabel === 'Free' ? 'free' : 'oneOff';
    case 'single-session':
    case 'camp-week':
    case 'membership':
    case 'package':
      return 'oneOff';
  }
}

/**
 * The checkout price summary — docs/22 §6. Base lines continue the summary's
 * price lines verbatim (label continuity), gaining structured amounts where a
 * one-off charge exists so every visible line reconciles to `amount`.
 */
function buildPriceSummary(summary: BookingSummary): CheckoutPriceSummary {
  const priceKind = priceKindFor(summary.option);
  const amount = oneOffAmount(summary, summary.option);
  const lines: CheckoutPriceLine[] = summary.priceLines.map((line, index) => ({
    id: `base-${index}`,
    kind: 'base',
    label: line.label,
    value: line.value,
    // One base line today, so it carries the whole one-off amount; future
    // backend lines (fee/tax/discount/credit) join the same reconciliation.
    amount: priceKind === 'oneOff' && index === 0 ? amount : undefined,
  }));
  return {
    lines,
    offerLine: summary.offerLine,
    priceKind,
    amount: priceKind === 'oneOff' ? amount : undefined,
    bookingPriceLabel: summary.bookingPriceLabel,
    spokenBookingPriceLabel: spokenLabel(summary.bookingPriceLabel),
    taxTreatment: 'notConfigured',
  };
}

/**
 * The single selectable contract method for paid bookings — docs/09 §22.6.
 * Composed statically here (docs/22 §10: no payment-methods data module
 * exists — there is nothing to store): a generic labelled row with no card
 * details of any kind. Apple Pay / Google Pay kinds stay declared-only and
 * are never composed until real platform and gateway support exist.
 * Selecting it changes nothing but checkout-local UI state; submitting
 * remains the docs/09 §22.11 inert contract.
 */
const cardPaymentContractMethod: PaymentMethod = {
  id: 'card',
  kind: 'card',
  label: 'Card payment',
  availability: { status: 'contractOnly' },
};

/**
 * QA-only demonstration of a superseded price for the `priceChanged` review
 * state (docs/22 §7.10: "shows old → new"). The demo previous amount is the
 * current structured amount minus a fixed AED 10 — a display fixture like
 * the `sessionSpots` full-session override, reachable only through
 * `qaRevalidate`. The current, payable price everywhere remains the true
 * catalogue price; no arithmetic exists on any customer-reachable path.
 */
function qaDemoPreviousPrice(price: PriceModel): PriceModel | undefined {
  switch (price.kind) {
    case 'dropIn':
    case 'monthly':
    case 'term':
    case 'package':
      return { ...price, amount: price.amount - 10 };
    case 'camp':
      return { ...price, amountPerWeek: price.amountPerWeek - 10 };
    case 'free':
    case 'freeTrial':
      return undefined;
  }
}

/**
 * Deterministic issue composition for the docs/09 §22.10 codes — typed
 * development contracts for the future server implementation (docs/23 §12.2
 * names these codes the platform vocabulary). Copy is honest and specific:
 * no reservation, payment, confirmation, or success implication; spec-worded
 * states use the docs/22 §7.10 copy verbatim. Only sessionFull /
 * priceChanged / offerExpired are QA-reachable; the rest are composed so the
 * screen's full code → recovery mapping is exercised by tests today and by
 * the real backend later.
 */
function revalidationIssue(
  code: CheckoutIssueCode,
  price: PriceModel,
): { code: CheckoutIssueCode; message: string; priceComparison?: CheckoutPriceComparison } {
  switch (code) {
    case 'sessionFull':
      return { code, message: 'This session filled up while you were checking out.' };
    case 'priceChanged': {
      const previous = qaDemoPreviousPrice(price);
      // The structured old → new pair the CheckoutIssueCard renders — from
      // structured amounts only; the updated label is always the current
      // authoritative catalogue price. The message stays the contract's
      // transport string (future backend-supplied).
      return {
        code,
        message:
          previous === undefined
            ? 'The booking price changed while you were checking out.'
            : `The booking price changed from ${priceLabel(previous)} to ${priceLabel(price)} while you were checking out.`,
        priceComparison:
          previous === undefined
            ? undefined
            : { previousLabel: priceLabel(previous), updatedLabel: priceLabel(price) },
      };
    }
    case 'offerExpired':
      return { code, message: 'This offer ended while you were checking out.' };
    case 'registrationClosed':
      return { code, message: 'Registration for this program has closed.' };
    case 'participantIneligible':
      return { code, message: 'This participant can no longer join this program.' };
    case 'branchUnavailable':
      return { code, message: 'This location is no longer available for this program.' };
    case 'invalidDraft':
      return { code, message: 'This booking needs to be started again.' };
  }
}

export class MockCheckoutService implements CheckoutService {
  private readonly booking = new MockBookingService(0);

  constructor(private readonly delayMs: number = 300) {}

  async getCheckoutPage(input: CheckoutPageInput): Promise<CheckoutPage | undefined> {
    await this.delay();
    if (input.simulateFailure) throw new Error('Simulated network failure (QA only)');
    return this.buildCheckoutPage(input);
  }

  /**
   * Pure and synchronous so behavior is directly testable. Re-derives the
   * BookingSummary from the live draft (docs/22 §2) — every invalid or stale
   * draft that cannot compose a summary resolves undefined, and the screen
   * redirects via `checkoutStepAccess` instead of rendering a broken page.
   * `qaRevalidate` (Commit 18) attaches a typed not-ok CheckoutValidation to
   * an otherwise-valid page — the QA-only demonstration of the future
   * backend revalidation contract (docs/22 §7.10); it never alters pricing,
   * methods, or any other composed field, and access-policy redirects take
   * precedence (an invalid draft still resolves undefined).
   */
  buildCheckoutPage(input: CheckoutPageInput): CheckoutPage | undefined {
    const summary = this.booking.buildBookingSummary({
      draft: input.draft,
      participants: input.participants,
      areaId: input.areaId,
    });
    if (summary === undefined) return undefined;

    const price = buildPriceSummary(summary);
    const paymentRequired = price.priceKind !== 'free';
    // docs/09 §22.11: the paid CTA continues toward payment; the free CTA
    // confirms — both remain inert contracts until real payment exists.
    const ctaLabel = paymentRequired ? 'Continue to payment' : 'Confirm booking';

    const participantEntry = input.participants.find(
      (candidate) => candidate.id === summary.participant.participantId,
    );

    const validation: CheckoutValidation =
      input.qaRevalidate === undefined
        ? { ok: true }
        : { ok: false, issues: [revalidationIssue(input.qaRevalidate, summary.program.price!)] };

    return {
      summary,
      price,
      // Guardian context display only (docs/09 §22.8) — no consent mechanics.
      guardianContextLine: participantEntry?.kind === 'child' ? 'Booked by you' : undefined,
      // Paid bookings get the one generic contract method; free bookings
      // have no payment-method section at all (docs/22 §4, §7.5–7.6).
      paymentMethods: paymentRequired ? [cardPaymentContractMethod] : [],
      paymentRequired,
      validation,
      ctaLabel,
      spokenCtaLabel: `${ctaLabel}, ${price.spokenBookingPriceLabel}`,
    };
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

export const checkoutService: CheckoutService = new MockCheckoutService();
