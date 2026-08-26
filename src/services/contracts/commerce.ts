/**
 * RI-3 — the customer COMMERCE contract over the certified W4/W5 backend
 * (docs/34 §2): authoritative quote, capacity hold, free confirmation,
 * paid checkout initiation, the converged payment status, and the
 * customer's own bookings.
 *
 * Truth rules (binding):
 * - The customer authors ONLY identifiers + idempotency context. Price,
 *   amount, currency, tax, discounts, commission, and provider share are
 *   server-derived; commission/economics never exist in these models.
 * - Nothing here implies a reservation or payment happened until the
 *   SERVER said so: holds carry the authoritative `expiresAt`, bookings
 *   confirm only via the certified paths, and browser return is
 *   navigation only (the payment STATUS read is the sole truth).
 */

export type CommerceUnitKind = 'session' | 'campWeek' | 'enrolmentCohort';

export interface QuoteRequest {
  programId: string;
  priceOptionId: string;
  unitKind: CommerceUnitKind;
  unitId: string;
  participantId: string;
  offerId?: string;
}

export interface QuoteLine {
  lineNo: number;
  kind: 'base';
  labelEn: string;
  amountFils: number;
}

/** The certified server quote — displayed verbatim, never recomputed. */
export interface Quote {
  quoteId: string;
  programId: string;
  participantId: string;
  optionKind: string;
  unitKind: CommerceUnitKind;
  unitId: string;
  offerId?: string;
  totalFils: number;
  currency: 'AED';
  priceKind: string;
  taxTreatment: 'notConfigured';
  lines: QuoteLine[];
  /** Server TTL authority — stale quotes never continue silently. */
  expiresAt: string;
}

export interface HoldRequest {
  unitKind: CommerceUnitKind;
  unitId: string;
  participantId: string;
  quoteId: string;
  idempotencyKey: string;
}

/** The authoritative Himma capacity hold (10-minute inventory authority). */
export interface CapacityHold {
  holdId: string;
  unitKind: CommerceUnitKind;
  unitId: string;
  participantId: string;
  state: 'active';
  expiresAt: string;
}

export interface HoldStatus {
  holdId: string;
  /** Effective server truth — a lapsed hold reads 'expired' immediately. */
  state: string;
  expiresAt: string;
}

export interface ConfirmedBooking {
  bookingId: string;
  state: 'confirmed';
  referenceCode: string;
  confirmedAt: string;
}

/** The customer-safe W5-5 checkout start — identifiers and navigation only. */
export interface CheckoutStart {
  bookingId: string;
  /** Hosted-checkout redirect — pure navigation, never payment truth. */
  redirectUrl: string;
  /** The HIMMA hold expiry (D-W5-5) — the checkout window authority. */
  holdExpiresAt: string;
}

export type CustomerPaymentStatusName =
  | 'awaitingPayment'
  | 'processing'
  | 'confirmed'
  | 'expired'
  | 'compensationPending'
  | 'compensated';

export interface CustomerPaymentStatus {
  status: CustomerPaymentStatusName;
  holdExpiresAt?: string;
  referenceCode?: string;
}

/** One of the customer's OWN bookings — the certified S5-5 projection. */
export interface CustomerBooking {
  bookingId: string;
  referenceCode: string | null;
  state: string;
  participant: { id: string; firstName: string };
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  unit: {
    kind: CommerceUnitKind;
    unitId: string;
    startAt: string | null;
    startDate: string | null;
    effectiveStart: string | null;
  };
  price: { totalFils: number; currency: 'AED' };
  createdAt: string;
  confirmedAt: string | null;
}

export interface CommerceApi {
  requestQuote(input: QuoteRequest): Promise<Quote>;
  claimHold(input: HoldRequest): Promise<CapacityHold>;
  holdStatus(holdId: string): Promise<HoldStatus>;
  releaseHold(holdId: string, idempotencyKey: string): Promise<'holdReleased' | 'holdExpired'>;
  confirmFree(holdId: string, idempotencyKey: string): Promise<ConfirmedBooking>;
  initiateCheckout(input: {
    holdId: string;
    quoteId: string;
    idempotencyKey: string;
  }): Promise<CheckoutStart>;
  paymentStatus(bookingId: string): Promise<CustomerPaymentStatus>;
  listBookings(input?: { limit?: number; cursor?: string }): Promise<{
    bookings: CustomerBooking[];
    nextCursor: string | null;
  }>;
  getBooking(bookingId: string): Promise<CustomerBooking | undefined>;
}
