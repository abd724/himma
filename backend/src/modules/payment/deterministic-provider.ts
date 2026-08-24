/**
 * W5-1 — the DETERMINISTIC test payment provider (docs/33 §13.1).
 *
 * A fully in-process, clock-injected, scriptable implementation of the
 * provider port used to certify the abstraction and, in later slices, to
 * drive every §16 concurrency/failure proof: success, decline,
 * timeout/unknown outcome, late success, duplicate events, and
 * compensation failure — each scenario is explicit per intent, never
 * random. It performs no network I/O and knows nothing about Stripe; it
 * exists to prove that the PORT can represent every semantics the real
 * driver needs (D-W5-5: including requested-vs-actual expiry clamping and
 * explicit session expiry).
 *
 * NEVER selectable in production: provider-composition refuses it there by
 * construction (D-W5-6 — no fake readiness can exist), pinned by test.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  CreateHostedCheckoutInput,
  CreateHostedCheckoutResult,
  ExpireCheckoutResult,
  NormalizedGatewayEventType,
  PaymentInspection,
  PaymentProviderPort,
  ReverseResult,
  VerifiedGatewayEvent,
  WebhookVerification,
} from './provider-port';

export type DeterministicScenario =
  | 'succeed'
  | 'decline'
  | 'timeout'
  | 'lateSuccess'
  | 'compensationFailure';

interface CheckoutRecord {
  intentId: string;
  scenario: DeterministicScenario;
  amountFils: number;
  status: 'open' | 'captured' | 'declined' | 'expired' | 'reversed';
  captureTransactionId?: string;
  reverseTransactionId?: string;
}

/** Mirror of the real hosted-checkout floor (D-W5-5): ~30 minutes minimum. */
const MIN_SESSION_LIFETIME_MS = 30 * 60 * 1000;
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface DeterministicProviderOptions {
  /** Injected clock — the provider never reads the system time. */
  now: Date;
  /** Scenario per Himma intent id; unlisted intents default to 'succeed'. */
  scenarios?: Record<string, DeterministicScenario>;
  /** Fictional endpoint secret for webhook signing (test material only). */
  webhookSecret?: string;
}

export class DeterministicPaymentProvider implements PaymentProviderPort {
  public readonly provider = 'deterministicTest' as const;

  private readonly now: Date;
  private readonly scenarios: Record<string, DeterministicScenario>;
  private readonly webhookSecret: string;
  private readonly checkoutsByRef = new Map<string, CheckoutRecord>();
  private readonly createResultsByKey = new Map<string, CreateHostedCheckoutResult>();

  constructor(options: DeterministicProviderOptions) {
    this.now = options.now;
    this.scenarios = options.scenarios ?? {};
    this.webhookSecret = options.webhookSecret ?? 'dt_whsec_fictional';
  }

  private scenarioFor(intentId: string): DeterministicScenario {
    return this.scenarios[intentId] ?? 'succeed';
  }

  async createHostedCheckout(
    input: CreateHostedCheckoutInput,
  ): Promise<CreateHostedCheckoutResult> {
    // Provider-request idempotency (docs/33 §9): the SAME key replays the
    // SAME outcome — a crashed-and-retried creation never doubles a session.
    const replay = this.createResultsByKey.get(input.idempotencyKey);
    if (replay !== undefined) return replay;

    const scenario = this.scenarioFor(input.intentId);
    const gatewayRef = `dt_cs_${input.intentId}`;
    if (scenario === 'timeout') {
      // The session EXISTS provider-side; the response was lost. Resolution
      // must come from inspectPayment/webhook (docs/24 §8.3), and the same
      // key keeps returning the lost outcome deterministically.
      this.checkoutsByRef.set(gatewayRef, {
        intentId: input.intentId,
        scenario,
        amountFils: input.amountFils,
        status: 'open',
      });
      const result: CreateHostedCheckoutResult = { kind: 'unknownOutcome' };
      this.createResultsByKey.set(input.idempotencyKey, result);
      return result;
    }

    // Clamp to the hosted-session floor and report the ACTUAL expiry, so the
    // port is proven to represent requested ≠ actual timing (D-W5-5).
    const floor = new Date(this.now.getTime() + MIN_SESSION_LIFETIME_MS);
    const gatewayExpiresAt =
      input.requestedExpiresAt.getTime() >= floor.getTime() ? input.requestedExpiresAt : floor;
    this.checkoutsByRef.set(gatewayRef, {
      intentId: input.intentId,
      scenario,
      amountFils: input.amountFils,
      status: 'open',
    });
    const result: CreateHostedCheckoutResult = {
      kind: 'created',
      gatewayRef,
      clientAction: { kind: 'redirect', url: `https://deterministic.test/checkout/${gatewayRef}` },
      gatewayExpiresAt,
    };
    this.createResultsByKey.set(input.idempotencyKey, result);
    return result;
  }

  /** Test control: the customer "completes" the hosted page. */
  completeCheckout(gatewayRef: string): void {
    const record = this.checkoutsByRef.get(gatewayRef);
    if (record === undefined || record.status !== 'open') return;
    if (record.scenario === 'decline') {
      record.status = 'declined';
      return;
    }
    record.status = 'captured';
    record.captureTransactionId = `dt_txn_${gatewayRef}`;
  }

  async inspectPayment(gatewayRef: string): Promise<PaymentInspection> {
    const record = this.checkoutsByRef.get(gatewayRef);
    if (record === undefined) return { kind: 'notFound' };
    const status =
      record.status === 'open'
        ? 'pending'
        : record.status === 'captured' || record.status === 'reversed'
          ? 'captured'
          : record.status === 'declined'
            ? 'declined'
            : 'expired';
    return {
      kind: 'payment',
      gatewayRef,
      status,
      amountFils: record.amountFils,
      currency: 'AED',
      ...(record.captureTransactionId !== undefined
        ? { gatewayTransactionId: record.captureTransactionId }
        : {}),
    };
  }

  async expireCheckout(gatewayRef: string): Promise<ExpireCheckoutResult> {
    const record = this.checkoutsByRef.get(gatewayRef);
    if (record === undefined) return { kind: 'notFound' };
    if (record.status !== 'open') {
      const inspection = await this.inspectPayment(gatewayRef);
      return {
        kind: 'alreadyFinalized',
        status: inspection.kind === 'payment' ? inspection.status : 'unrecognized',
      };
    }
    record.status = 'expired';
    return { kind: 'expired' };
  }

  async reverse(gatewayRef: string, amountFils: number): Promise<ReverseResult> {
    const record = this.checkoutsByRef.get(gatewayRef);
    if (record === undefined || record.status === 'open' || record.status === 'declined'
        || record.status === 'expired') {
      return { kind: 'refused', reason: 'notCaptured' };
    }
    if (record.status === 'reversed') return { kind: 'refused', reason: 'alreadyReversed' };
    if (record.scenario === 'compensationFailure') return { kind: 'unknownOutcome' };
    if (amountFils !== record.amountFils) return { kind: 'refused', reason: 'providerRefused' };
    record.status = 'reversed';
    record.reverseTransactionId = `dt_rev_${gatewayRef}`;
    return { kind: 'reversed', gatewayTransactionId: record.reverseTransactionId };
  }

  /**
   * Test control: build a signed webhook delivery exactly as the future
   * ingress will receive one — raw bytes + signature/timestamp headers.
   * Duplicate deliveries are produced by calling this twice with the same
   * `gatewayEventId` (dedup is the DATABASE'S job, never the provider's).
   */
  buildWebhookDelivery(input: {
    gatewayEventId: string;
    eventType: NormalizedGatewayEventType;
    gatewayRef?: string;
    gatewayTransactionId?: string;
    occurredAt?: Date;
    /** Overrides for adversarial tests. */
    timestampSeconds?: number;
    corruptSignature?: boolean;
  }): { rawBody: Buffer; headers: Record<string, string> } {
    const payload = {
      id: input.gatewayEventId,
      type: input.eventType,
      gatewayRef: input.gatewayRef ?? null,
      gatewayTransactionId: input.gatewayTransactionId ?? null,
      occurredAt: (input.occurredAt ?? this.now).toISOString(),
    };
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    const timestamp = input.timestampSeconds ?? Math.floor(this.now.getTime() / 1000);
    const signature = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    return {
      rawBody,
      headers: {
        'dt-timestamp': String(timestamp),
        'dt-signature': input.corruptSignature === true ? `bad${signature.slice(3)}` : signature,
      },
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerification {
    const timestampRaw = headers['dt-timestamp'];
    const signature = headers['dt-signature'];
    if (timestampRaw === undefined || signature === undefined) {
      return { kind: 'rejected', reason: 'malformed' };
    }
    const timestamp = Number(timestampRaw);
    if (!Number.isInteger(timestamp)) return { kind: 'rejected', reason: 'malformed' };
    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      return { kind: 'rejected', reason: 'invalidSignature' };
    }
    const ageSeconds = Math.abs(Math.floor(this.now.getTime() / 1000) - timestamp);
    if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
      return { kind: 'rejected', reason: 'staleTimestamp' };
    }
    let parsed: {
      id?: unknown;
      type?: unknown;
      gatewayRef?: unknown;
      gatewayTransactionId?: unknown;
      occurredAt?: unknown;
    };
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as typeof parsed;
    } catch {
      return { kind: 'rejected', reason: 'malformed' };
    }
    if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
      return { kind: 'rejected', reason: 'malformed' };
    }
    const knownTypes: readonly NormalizedGatewayEventType[] = [
      'checkout.completed',
      'payment.captured',
      'payment.failed',
      'checkout.expired',
    ];
    const eventType: NormalizedGatewayEventType = (
      knownTypes as readonly string[]
    ).includes(parsed.type)
      ? (parsed.type as NormalizedGatewayEventType)
      : 'unrecognized';
    const event: VerifiedGatewayEvent = {
      provider: 'deterministicTest',
      gatewayEventId: parsed.id,
      eventType,
      ...(typeof parsed.gatewayRef === 'string' ? { gatewayRef: parsed.gatewayRef } : {}),
      ...(typeof parsed.gatewayTransactionId === 'string'
        ? { gatewayTransactionId: parsed.gatewayTransactionId }
        : {}),
      payloadDigest: createHmac('sha256', 'dt-digest').update(rawBody).digest('hex'),
      occurredAt:
        typeof parsed.occurredAt === 'string' ? new Date(parsed.occurredAt) : this.now,
    };
    return { kind: 'verified', event };
  }
}
