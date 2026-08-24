/**
 * W5-2 — the Stripe driver behind the certified provider port (D-W5-1
 * Stripe; D-W5-2 hosted Checkout; docs/33 §6).
 *
 * EVERYTHING Stripe-specific lives here and only here: API keys, Checkout
 * Session ids, Stripe PaymentIntent ids, status vocabulary, request/response
 * shapes, signature scheme. The domain sees the port's closed Himma
 * vocabulary and opaque `gatewayRef` strings; an unmappable Stripe status
 * becomes `unrecognized` (quarantine, never guessed success).
 *
 * SANDBOX-ONLY BY CONSTRUCTION (W5-2; D-W5-3/D-W5-6, docs/23 §19): the
 * constructor refuses any secret key that is not a Stripe TEST-mode key.
 * The repository genuinely contains no live-charging capability — there is
 * no flag to flip; live-mode enablement arrives as its own reviewed change
 * after the UAE VAT/principal-vs-agent/invoicing ruling and the §19 lift.
 *
 * One-time payment-mode Checkout Sessions only (docs/33 §17 W5-2): AED,
 * server-authored amounts and references; card wallets (Apple Pay /
 * Google Pay) surface automatically on Stripe-hosted Checkout where the
 * session is eligible — no wallet-specific code exists here. No Connect,
 * no payouts, no recurring, no Stripe Tax.
 *
 * D-W5-5 timing seam: Stripe requires Checkout `expires_at` between
 * ~30 minutes and 24 hours from creation, while Himma's capacity hold
 * defaults to 10 minutes. The driver therefore CLAMPS the requested expiry
 * into Stripe's supported window and reports the ACTUAL session expiry —
 * the caller (and the D-W5-5 owner decision) must reconcile the two;
 * `expireCheckout` is the explicit-expire primitive that lets Himma kill a
 * hosted session when its hold dies. Hold-death expiry ORCHESTRATION is
 * W5-4 saga work; the primitive is proven here.
 */
import { createHash } from 'node:crypto';

import Stripe from 'stripe';

import type {
  CreateHostedCheckoutInput,
  CreateHostedCheckoutResult,
  ExpireCheckoutResult,
  NormalizedGatewayEventType,
  NormalizedPaymentStatus,
  PaymentInspection,
  PaymentProviderPort,
  ReverseResult,
  WebhookVerification,
} from './provider-port';

/** Stripe's documented Checkout Session expiry window (D-W5-5). */
const STRIPE_SESSION_MIN_MS = 30 * 60 * 1000;
const STRIPE_SESSION_MAX_MS = 24 * 60 * 60 * 1000;
/** Margin so a floor-exact request cannot lose to clock skew in flight. */
const CLAMP_MARGIN_MS = 60 * 1000;

export interface StripeDriverOptions {
  /** MUST be a Stripe TEST-mode secret key in W5-2 (sk_test_/rk_test_). */
  secretKey: string;
  /**
   * Endpoint-specific webhook signing secret (W5-3 composes it; the
   * verification primitive exists now so the port stays whole). Absent →
   * every webhook is rejected, never trusted by default.
   */
  webhookSecret?: string;
  /** Clock injection for deterministic clamp tests; defaults to real time. */
  now?: () => Date;
  /** TEST-ONLY: injected Stripe client stub. Never set in real wiring. */
  client?: Stripe;
}

export function isStripeTestModeKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
}

export class StripeDriver implements PaymentProviderPort {
  public readonly provider = 'stripe' as const;

  private readonly stripe: Stripe;
  private readonly webhookSecret: string | undefined;
  private readonly now: () => Date;

  constructor(options: StripeDriverOptions) {
    if (!isStripeTestModeKey(options.secretKey)) {
      // Structural sandbox gate (D-W5-3/D-W5-6): the platform holds NO
      // live-charging capability in W5-2. Not configuration — construction.
      throw new Error(
        'StripeDriver accepts only TEST-mode keys in W5-2: production/live charging is gated on the D-W5-3 VAT posture ruling and the docs/23 §19 lift (docs/33 §14.1).',
      );
    }
    this.stripe = options.client ?? new Stripe(options.secretKey);
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Exposed for the deterministic clamp certification (no network). */
  clampSessionExpiry(requested: Date): Date {
    const nowMs = this.now().getTime();
    const floor = nowMs + STRIPE_SESSION_MIN_MS + CLAMP_MARGIN_MS;
    const ceiling = nowMs + STRIPE_SESSION_MAX_MS - CLAMP_MARGIN_MS;
    return new Date(Math.min(Math.max(requested.getTime(), floor), ceiling));
  }

  async createHostedCheckout(
    input: CreateHostedCheckoutInput,
  ): Promise<CreateHostedCheckoutResult> {
    const gatewayExpiresAt = this.clampSessionExpiry(input.requestedExpiresAt);
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: input.intentId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'aed',
                unit_amount: input.amountFils,
                product_data: { name: input.description },
              },
            },
          ],
          success_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          expires_at: Math.floor(gatewayExpiresAt.getTime() / 1000),
          payment_intent_data: { metadata: { himma_intent_id: input.intentId } },
        },
        // Stripe request idempotency (docs/33 §9): the STABLE Himma-derived
        // key — a retried create returns the SAME session, never a second
        // charge opportunity.
        { idempotencyKey: input.idempotencyKey },
      );
      if (session.url === null || session.url === undefined) {
        return { kind: 'refused', reason: 'providerUnavailable' };
      }
      return {
        kind: 'created',
        gatewayRef: session.id,
        clientAction: { kind: 'redirect', url: session.url },
        gatewayExpiresAt:
          typeof session.expires_at === 'number'
            ? new Date(session.expires_at * 1000)
            : gatewayExpiresAt,
      };
    } catch (error) {
      return mapCreateError(error);
    }
  }

  async inspectPayment(gatewayRef: string): Promise<PaymentInspection> {
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(gatewayRef, {
        expand: ['payment_intent'],
      });
    } catch (error) {
      if (isResourceMissing(error)) return { kind: 'notFound' };
      throw error;
    }
    const status = mapSessionStatus(session);
    const transactionId = latestChargeId(session);
    return {
      kind: 'payment',
      gatewayRef,
      status,
      ...(typeof session.amount_total === 'number'
        ? { amountFils: session.amount_total }
        : {}),
      ...(typeof session.currency === 'string'
        ? { currency: session.currency.toUpperCase() }
        : {}),
      ...(transactionId !== undefined ? { gatewayTransactionId: transactionId } : {}),
    };
  }

  async expireCheckout(gatewayRef: string): Promise<ExpireCheckoutResult> {
    try {
      await this.stripe.checkout.sessions.expire(gatewayRef);
      return { kind: 'expired' };
    } catch (error) {
      if (isResourceMissing(error)) return { kind: 'notFound' };
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        // The session was not open (already complete or already expired).
        // NEVER infer financial failure from an expire error — read truth.
        const inspection = await this.inspectPayment(gatewayRef);
        if (inspection.kind === 'notFound') return { kind: 'notFound' };
        if (inspection.status === 'expired') return { kind: 'expired' };
        return { kind: 'alreadyFinalized', status: inspection.status };
      }
      return { kind: 'unknownOutcome' };
    }
  }

  async reverse(gatewayRef: string, amountFils: number): Promise<ReverseResult> {
    // Same-amount compensation primitive (A1.2 seam). DORMANT in W5-2: no
    // caller exists — compensation EXECUTION is W5-4 saga work.
    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(gatewayRef, {
        expand: ['payment_intent'],
      });
    } catch (error) {
      if (isResourceMissing(error)) return { kind: 'refused', reason: 'notCaptured' };
      return { kind: 'unknownOutcome' };
    }
    const paymentIntent = expandedPaymentIntent(session);
    if (paymentIntent === undefined || session.payment_status === 'unpaid') {
      return { kind: 'refused', reason: 'notCaptured' };
    }
    try {
      const refund = await this.stripe.refunds.create(
        { payment_intent: paymentIntent.id, amount: amountFils },
        { idempotencyKey: `himma:reverse:${gatewayRef}` },
      );
      return { kind: 'reversed', gatewayTransactionId: refund.id };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        if (error.code === 'charge_already_refunded') {
          return { kind: 'refused', reason: 'alreadyReversed' };
        }
        return { kind: 'refused', reason: 'providerRefused' };
      }
      return { kind: 'unknownOutcome' };
    }
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerification {
    // Signature primitive only (the W5-3 route composes it; Stripe requires
    // the EXACT raw body, so this must run before any JSON parsing).
    const signature = headers['stripe-signature'];
    if (signature === undefined) return { kind: 'rejected', reason: 'malformed' };
    if (this.webhookSecret === undefined) {
      // No endpoint secret configured — nothing can be trusted.
      return { kind: 'rejected', reason: 'invalidSignature' };
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return {
        kind: 'rejected',
        reason: /timestamp/i.test(message) ? 'staleTimestamp' : 'invalidSignature',
      };
    }
    const object = event.data.object as { id?: unknown };
    return {
      kind: 'verified',
      event: {
        provider: 'stripe',
        gatewayEventId: event.id,
        eventType: mapEventType(event.type),
        ...(typeof object.id === 'string' ? { gatewayRef: object.id } : {}),
        payloadDigest: rawBodyDigest(rawBody),
        occurredAt: new Date(event.created * 1000),
      },
    };
  }
}

function mapCreateError(error: unknown): CreateHostedCheckoutResult {
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return { kind: 'refused', reason: 'invalidRequest' };
  }
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return { kind: 'refused', reason: 'providerUnavailable' };
  }
  // Connection failures, timeouts, 5xx: the session MAY exist provider-side.
  // Only an idempotent re-send or inspection resolves it (docs/24 §8.3).
  return { kind: 'unknownOutcome' };
}

function isResourceMissing(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError &&
    error.code === 'resource_missing'
  );
}

/** Stripe session/payment_status → the CLOSED Himma vocabulary. */
function mapSessionStatus(session: Stripe.Checkout.Session): NormalizedPaymentStatus {
  if (session.status === 'expired') return 'expired';
  if (session.status === 'open') {
    return session.payment_status === 'unpaid' ? 'pending' : 'unrecognized';
  }
  if (session.status === 'complete') {
    if (session.payment_status === 'paid') return 'captured';
    // Delayed/async payment methods: complete but not yet paid.
    if (session.payment_status === 'unpaid') return 'pending';
    return 'unrecognized';
  }
  return 'unrecognized';
}

function expandedPaymentIntent(
  session: Stripe.Checkout.Session,
): Stripe.PaymentIntent | undefined {
  const pi = session.payment_intent;
  return typeof pi === 'object' && pi !== null ? pi : undefined;
}

function latestChargeId(session: Stripe.Checkout.Session): string | undefined {
  const pi = expandedPaymentIntent(session);
  if (pi === undefined) return undefined;
  const charge = pi.latest_charge;
  if (typeof charge === 'string') return charge;
  return typeof charge === 'object' && charge !== null ? charge.id : undefined;
}

function mapEventType(stripeType: string): NormalizedGatewayEventType {
  switch (stripeType) {
    case 'checkout.session.completed':
      return 'checkout.completed';
    case 'checkout.session.expired':
      return 'checkout.expired';
    case 'payment_intent.succeeded':
      return 'payment.captured';
    case 'payment_intent.payment_failed':
      return 'payment.failed';
    default:
      return 'unrecognized';
  }
}

function rawBodyDigest(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}
