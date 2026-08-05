import { bookingExtras } from '@/data/mock/booking-extras';
import type { BookingOption, BookingSummary } from '@/services/contracts/booking';
import type {
  CheckoutPage,
  CheckoutPageInput,
  CheckoutPriceLine,
  CheckoutPriceSummary,
  CheckoutService,
  PaymentMethod,
} from '@/services/contracts/checkout';
import { MockBookingService } from '@/services/mock/mock-booking-service';
import { spokenLabel } from '@/utils/price';

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
  switch (option.kind) {
    case 'single-session':
      return price.kind === 'dropIn' ? price.amount : undefined;
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
   * `qaRevalidate` is declared in the contract and wired in Commit 18.
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

    return {
      summary,
      price,
      // Guardian context display only (docs/09 §22.8) — no consent mechanics.
      guardianContextLine: participantEntry?.kind === 'child' ? 'Booked by you' : undefined,
      // Paid bookings get the one generic contract method; free bookings
      // have no payment-method section at all (docs/22 §4, §7.5–7.6).
      paymentMethods: paymentRequired ? [cardPaymentContractMethod] : [],
      paymentRequired,
      validation: { ok: true },
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
