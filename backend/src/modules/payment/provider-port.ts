/**
 * W5-1 — the NARROW Himma payment-provider port (docs/33 §6; D-W5-1).
 *
 * Purpose: keep gateway-specific identifiers, status vocabulary, signature
 * schemes, and wire formats OUT of the core domain. Core services deal in
 * exactly this Himma vocabulary; the future Stripe driver (W5-2+) owns every
 * Stripe-specific mapping. This is deliberately NOT a multi-gateway
 * framework: one production driver (Stripe, D-W5-1) plus the deterministic
 * test provider implement it, and the operation set is the minimum the
 * approved W5 slices need — hosted-checkout creation (D-W5-2), inspection/
 * reconciliation, explicit expiry (D-W5-5: Stripe Checkout sessions can be
 * expired by API and their timing must never be conflated with hold TTL),
 * same-amount reversal/void (the A1.2 compensation seam), and trusted
 * webhook verification/normalization (W5-3). Refund execution is a later
 * slice's addition; it arrives BESIDE `reverse`, never by reshaping it.
 *
 * Nothing here performs network I/O in W5-1: the port defines the contract,
 * the deterministic provider certifies it, and no Stripe SDK exists in the
 * repository yet.
 */

/** docs/24 §4.1 method vocabulary (D-W5-1 initial set). */
export type PaymentMethodKind = 'card' | 'applePay' | 'googlePay';

/** Providers the platform recognizes (0015 gateway_event CHECK mirrors this). */
export type PaymentProviderKind = 'stripe' | 'deterministicTest';

/**
 * The CLOSED normalized payment-state vocabulary a driver may report.
 * Drivers map gateway statuses INTO this set; an unmappable status is
 * `unrecognized` (the caller quarantines — docs/33 §6/§7.6, never a guess).
 */
export type NormalizedPaymentStatus =
  | 'pending'
  | 'requiresAction'
  | 'authorized'
  | 'captured'
  | 'declined'
  | 'errored'
  | 'expired'
  | 'unrecognized';

export const NORMALIZED_PAYMENT_STATUSES: readonly NormalizedPaymentStatus[] = [
  'pending',
  'requiresAction',
  'authorized',
  'captured',
  'declined',
  'errored',
  'expired',
  'unrecognized',
];

export interface CreateHostedCheckoutInput {
  /** Himma payment_intent id — the domain anchor, never a gateway concept. */
  intentId: string;
  /**
   * Provider-request idempotency key (docs/33 §9): a crashed-and-retried
   * creation re-sends the SAME key so the gateway dedupes; a driver for a
   * gateway without request idempotency must recover via `inspectPayment`
   * before ever re-creating.
   */
  idempotencyKey: string;
  amountFils: number;
  currency: 'AED';
  /** Bounded, non-PII description shown on the hosted page. */
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /**
   * REQUESTED checkout expiry. Drivers clamp to the provider's supported
   * window and report the ACTUAL expiry (D-W5-5: Stripe permits roughly
   * 30 minutes–24 hours — the hosted-session expiry is NOT the hold expiry,
   * and W5-2 must certify the timing boundary before checkout activation).
   */
  requestedExpiresAt: Date;
}

export type CreateHostedCheckoutResult =
  | {
      kind: 'created';
      /** Opaque provider reference — stored verbatim, never parsed. */
      gatewayRef: string;
      clientAction: { kind: 'redirect'; url: string };
      /** The provider's ACTUAL session expiry (may exceed the requested one). */
      gatewayExpiresAt: Date;
    }
  | { kind: 'refused'; reason: 'invalidRequest' | 'providerUnavailable' }
  /**
   * Timeout / lost response: the checkout MAY exist at the provider.
   * Resolution comes only from `inspectPayment` or a verified webhook —
   * never a retry-with-new-key guess (docs/24 §8.3).
   */
  | { kind: 'unknownOutcome' };

export type PaymentInspection =
  | {
      kind: 'payment';
      gatewayRef: string;
      status: NormalizedPaymentStatus;
      amountFils?: number;
      currency?: string;
      /** Present when the provider reports a posted financial transaction. */
      gatewayTransactionId?: string;
    }
  | { kind: 'notFound' };

export type ExpireCheckoutResult =
  | { kind: 'expired' }
  | { kind: 'alreadyFinalized'; status: NormalizedPaymentStatus }
  | { kind: 'notFound' }
  | { kind: 'unknownOutcome' };

export type ReverseResult =
  | { kind: 'reversed'; gatewayTransactionId: string }
  | { kind: 'refused'; reason: 'notCaptured' | 'alreadyReversed' | 'providerRefused' }
  | { kind: 'unknownOutcome' };

/** Normalized event types the platform understands (W5-3 processing set). */
export type NormalizedGatewayEventType =
  | 'checkout.completed'
  | 'payment.captured'
  | 'payment.failed'
  | 'checkout.expired'
  | 'unrecognized';

export interface VerifiedGatewayEvent {
  provider: PaymentProviderKind;
  /** The provider's unique event id — the (provider, id) dedup key (0015). */
  gatewayEventId: string;
  eventType: NormalizedGatewayEventType;
  /** Opaque payment/checkout reference the event concerns, when present. */
  gatewayRef?: string;
  /** Opaque financial-transaction id, when the event carries one. */
  gatewayTransactionId?: string;
  /** Digest of the exact raw payload bytes (stored; the blob is not). */
  payloadDigest: string;
  occurredAt: Date;
}

export type WebhookVerification =
  | { kind: 'verified'; event: VerifiedGatewayEvent }
  | { kind: 'rejected'; reason: 'invalidSignature' | 'staleTimestamp' | 'malformed' };

export interface PaymentProviderPort {
  readonly provider: PaymentProviderKind;
  createHostedCheckout(input: CreateHostedCheckoutInput): Promise<CreateHostedCheckoutResult>;
  inspectPayment(gatewayRef: string): Promise<PaymentInspection>;
  /** Explicit session expiry — the D-W5-5 timing seam W5-2 will calibrate. */
  expireCheckout(gatewayRef: string): Promise<ExpireCheckoutResult>;
  /** Same-amount void/reversal — the A1.2 compensation seam (execution W5-4). */
  reverse(gatewayRef: string, amountFils: number): Promise<ReverseResult>;
  /**
   * Trusted webhook verification over the EXACT raw request bytes (W5-3:
   * signature before parsing; timestamp/replay window; endpoint-specific
   * secret from runtime configuration — never a PostgreSQL row).
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerification;
}
