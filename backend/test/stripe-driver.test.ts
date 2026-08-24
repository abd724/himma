/**
 * W5 · W5-2 — Stripe driver certification, DETERMINISTIC (no network).
 * (docs/33 §6, §17 W5-2; owner rulings D-W5-1/2/3/5, docs/33 §14.1.)
 *
 * Proves the Stripe-specific mapping in isolation via an injected client
 * stub (request shapes, idempotency-key pass-through, the D-W5-5 session
 * expiry clamp into Stripe's ~30-minute–24-hour window, status
 * normalization into the CLOSED Himma vocabulary, error-class mapping —
 * timeouts are UNKNOWN never failed, expire errors never infer financial
 * failure) plus the REAL Stripe signature verification primitive
 * (constructEvent over exact raw bytes with generated test headers). The
 * structural sandbox gate is pinned: non-test-mode keys are refused at
 * CONSTRUCTION — the repository holds no live-charging capability
 * (D-W5-3/D-W5-6). The real sandbox smoke (network) is the separate
 * operational script `scripts/stripe-sandbox-smoke.ts`, dependent on
 * owner-provided test credentials; it is NOT faked here.
 */
import Stripe from 'stripe';

import { resolvePaymentProvider } from '../src/modules/payment/provider-composition';
import { isStripeTestModeKey, StripeDriver } from '../src/modules/payment/stripe-driver';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const MIN = 60 * 1000;

interface StubCall {
  method: string;
  args: unknown[];
}

/** Minimal Stripe-client stub: scripted responses + call capture. */
function stubClient(script: {
  create?: () => Promise<unknown>;
  retrieve?: () => Promise<unknown>;
  expire?: () => Promise<unknown>;
  refundCreate?: () => Promise<unknown>;
}): { client: Stripe; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const client = {
    checkout: {
      sessions: {
        create: async (...args: unknown[]) => {
          calls.push({ method: 'sessions.create', args });
          return script.create ? await script.create() : {};
        },
        retrieve: async (...args: unknown[]) => {
          calls.push({ method: 'sessions.retrieve', args });
          return script.retrieve ? await script.retrieve() : {};
        },
        expire: async (...args: unknown[]) => {
          calls.push({ method: 'sessions.expire', args });
          return script.expire ? await script.expire() : {};
        },
      },
    },
    refunds: {
      create: async (...args: unknown[]) => {
        calls.push({ method: 'refunds.create', args });
        return script.refundCreate ? await script.refundCreate() : {};
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

function driverWith(script: Parameters<typeof stubClient>[0]): {
  driver: StripeDriver;
  calls: StubCall[];
} {
  const { client, calls } = stubClient(script);
  return {
    driver: new StripeDriver({ secretKey: 'sk_test_stub', now: () => NOW, client }),
    calls,
  };
}

function invalidRequestError(code?: string): Stripe.errors.StripeInvalidRequestError {
  return new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    message: 'stubbed',
    ...(code !== undefined ? { code } : {}),
  } as never);
}

const CHECKOUT_INPUT = {
  intentId: 'intent-1',
  idempotencyKey: 'himma:checkout:intent-1:1',
  amountFils: 5000,
  currency: 'AED' as const,
  description: 'Himma booking',
  returnUrl: 'https://himma.test/return',
  cancelUrl: 'https://himma.test/cancel',
  requestedExpiresAt: new Date(NOW.getTime() + 10 * MIN),
};

describe('structural sandbox gate (D-W5-3/D-W5-6)', () => {
  it('refuses every non-test-mode key at CONSTRUCTION — no live-charging capability exists in the repository', () => {
    for (const key of ['sk_live_x', 'rk_live_x', 'pk_test_x', 'whatever']) {
      expect(() => new StripeDriver({ secretKey: key })).toThrow(/TEST-mode/i);
      expect(isStripeTestModeKey(key)).toBe(false);
    }
    expect(isStripeTestModeKey('sk_test_x')).toBe(true);
    expect(isStripeTestModeKey('rk_test_x')).toBe(true);
  });

  it('composition: production never configures Stripe (test OR live key); non-production refuses live keys with a typed reason', () => {
    expect(
      resolvePaymentProvider('production', { stripe: { secretKey: 'sk_test_x' } }).kind,
    ).toBe('unconfigured');
    expect(
      resolvePaymentProvider('production', { stripe: { secretKey: 'sk_live_x' } }).kind,
    ).toBe('unconfigured');
    const live = resolvePaymentProvider('test', { stripe: { secretKey: 'sk_live_x' } });
    expect(live.kind).toBe('unconfigured');
    const sandbox = resolvePaymentProvider('test', { stripe: { secretKey: 'sk_test_x' } });
    if (sandbox.kind !== 'configured') throw new Error(sandbox.kind);
    expect(sandbox.provider.provider).toBe('stripe');
  });
});

describe('hosted-checkout creation mapping (D-W5-2)', () => {
  it('sends a one-time payment-mode AED session with server-authored amount/references, the D-W5-5 clamped expiry, and the stable idempotency key', async () => {
    const { driver, calls } = driverWith({
      create: async () => ({
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/c/pay/cs_test_1',
        expires_at: Math.floor((NOW.getTime() + 31 * MIN) / 1000),
      }),
    });
    const result = await driver.createHostedCheckout(CHECKOUT_INPUT);
    if (result.kind !== 'created') throw new Error(result.kind);
    expect(result.gatewayRef).toBe('cs_test_1');
    expect(result.clientAction).toEqual({
      kind: 'redirect',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });

    const [params, options] = calls[0]!.args as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params.mode).toBe('payment');
    expect(params.client_reference_id).toBe('intent-1');
    const lineItems = params.line_items as Array<{
      quantity: number;
      price_data: { currency: string; unit_amount: number };
    }>;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0]!.quantity).toBe(1);
    expect(lineItems[0]!.price_data.currency).toBe('aed');
    expect(lineItems[0]!.price_data.unit_amount).toBe(5000);
    // 10 minutes requested → clamped to the floor (30 min + margin), sent
    // as epoch seconds. The hosted session provably outlives the hold —
    // the D-W5-5 mismatch this slice certifies.
    expect(params.expires_at).toBe(Math.floor((NOW.getTime() + 31 * MIN) / 1000));
    expect(options.idempotencyKey).toBe('himma:checkout:intent-1:1');
    // No card-data-shaped field exists anywhere in the request.
    expect(JSON.stringify(params)).not.toMatch(/card|pan|cvv|cvc/i);
  });

  it('clamps requested expiry into [now+31min, now+24h−1min] and passes through in-window values', () => {
    const { driver } = driverWith({});
    expect(driver.clampSessionExpiry(new Date(NOW.getTime() + 10 * MIN)).getTime()).toBe(
      NOW.getTime() + 31 * MIN,
    );
    expect(driver.clampSessionExpiry(new Date(NOW.getTime() + 120 * MIN)).getTime()).toBe(
      NOW.getTime() + 120 * MIN,
    );
    expect(driver.clampSessionExpiry(new Date(NOW.getTime() + 30 * 60 * MIN)).getTime()).toBe(
      NOW.getTime() + 24 * 60 * MIN - MIN,
    );
  });

  it('maps error classes: invalid request → refused, auth/rate-limit → providerUnavailable, connection/unknown → unknownOutcome (never failed)', async () => {
    const invalid = driverWith({
      create: async () => {
        throw invalidRequestError();
      },
    });
    expect(await invalid.driver.createHostedCheckout(CHECKOUT_INPUT)).toEqual({
      kind: 'refused',
      reason: 'invalidRequest',
    });

    const auth = driverWith({
      create: async () => {
        throw new Stripe.errors.StripeAuthenticationError({
          type: 'authentication_error',
          message: 'bad key',
        } as never);
      },
    });
    expect(await auth.driver.createHostedCheckout(CHECKOUT_INPUT)).toEqual({
      kind: 'refused',
      reason: 'providerUnavailable',
    });

    const timeout = driverWith({
      create: async () => {
        throw new Stripe.errors.StripeConnectionError({
          type: 'api_error',
          message: 'ETIMEDOUT',
        } as never);
      },
    });
    expect(await timeout.driver.createHostedCheckout(CHECKOUT_INPUT)).toEqual({
      kind: 'unknownOutcome',
    });
  });
});

describe('inspection mapping — the closed vocabulary, never guessed success', () => {
  const session = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'cs_test_1',
    amount_total: 5000,
    currency: 'aed',
    payment_intent: null,
    ...over,
  });

  it('open/unpaid → pending; complete/paid → captured with the charge id; expired → expired; novel shapes → unrecognized; missing → notFound', async () => {
    const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
      [session({ status: 'open', payment_status: 'unpaid' }), 'pending', undefined],
      [
        session({
          status: 'complete',
          payment_status: 'paid',
          payment_intent: { id: 'pi_1', latest_charge: 'ch_1' },
        }),
        'captured',
        'ch_1',
      ],
      [session({ status: 'expired', payment_status: 'unpaid' }), 'expired', undefined],
      [session({ status: 'complete', payment_status: 'unpaid' }), 'pending', undefined],
      [session({ status: 'something_new', payment_status: 'paid' }), 'unrecognized', undefined],
    ];
    for (const [payload, expected, txn] of cases) {
      const { driver } = driverWith({ retrieve: async () => payload });
      const inspection = await driver.inspectPayment('cs_test_1');
      if (inspection.kind !== 'payment') throw new Error(inspection.kind);
      expect(inspection.status).toBe(expected);
      expect(inspection.gatewayTransactionId).toBe(txn);
      expect(inspection.amountFils).toBe(5000);
      expect(inspection.currency).toBe('AED');
    }

    const missing = driverWith({
      retrieve: async () => {
        throw invalidRequestError('resource_missing');
      },
    });
    expect(await missing.driver.inspectPayment('cs_gone')).toEqual({ kind: 'notFound' });
  });
});

describe('explicit expire (D-W5-5 primitive) — never infers financial failure', () => {
  it('open → expired; not-open → reads TRUTH and reports alreadyFinalized/expired; missing → notFound; network → unknownOutcome', async () => {
    const open = driverWith({ expire: async () => ({ id: 'cs_test_1', status: 'expired' }) });
    expect(await open.driver.expireCheckout('cs_test_1')).toEqual({ kind: 'expired' });

    // Expire error + retrieve shows the customer COMPLETED first: the race
    // resolves to the financial truth, never an inferred failure.
    const completed = driverWith({
      expire: async () => {
        throw invalidRequestError();
      },
      retrieve: async () => ({
        id: 'cs_test_1',
        status: 'complete',
        payment_status: 'paid',
        payment_intent: { id: 'pi_1', latest_charge: 'ch_1' },
      }),
    });
    expect(await completed.driver.expireCheckout('cs_test_1')).toEqual({
      kind: 'alreadyFinalized',
      status: 'captured',
    });

    const alreadyExpired = driverWith({
      expire: async () => {
        throw invalidRequestError();
      },
      retrieve: async () => ({ id: 'cs_test_1', status: 'expired', payment_status: 'unpaid' }),
    });
    expect(await alreadyExpired.driver.expireCheckout('cs_test_1')).toEqual({ kind: 'expired' });

    const missing = driverWith({
      expire: async () => {
        throw invalidRequestError('resource_missing');
      },
    });
    expect(await missing.driver.expireCheckout('cs_gone')).toEqual({ kind: 'notFound' });

    const network = driverWith({
      expire: async () => {
        throw new Stripe.errors.StripeConnectionError({
          type: 'api_error',
          message: 'reset',
        } as never);
      },
    });
    expect(await network.driver.expireCheckout('cs_test_1')).toEqual({ kind: 'unknownOutcome' });
  });
});

describe('webhook signature primitive — REAL constructEvent over raw bytes (W5-3 contract)', () => {
  const webhookSecret = 'whsec_test_fictional';
  const realClient = new Stripe('sk_test_offline_utilities');
  const driver = new StripeDriver({
    secretKey: 'sk_test_stub',
    webhookSecret,
    client: realClient,
  });

  const eventPayload = (type: string): string =>
    JSON.stringify({
      id: 'evt_test_1',
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      type,
      data: { object: { id: 'cs_test_1', object: 'checkout.session' } },
    });

  const signedHeaders = (payload: string, timestamp?: number): Record<string, string> => ({
    'stripe-signature': realClient.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
      ...(timestamp !== undefined ? { timestamp } : {}),
    }),
  });

  it('verifies a correctly signed body and normalizes known event types; unknown types become `unrecognized`', () => {
    const payload = eventPayload('checkout.session.completed');
    const verified = driver.verifyWebhook(Buffer.from(payload), signedHeaders(payload));
    if (verified.kind !== 'verified') throw new Error(verified.kind);
    expect(verified.event).toMatchObject({
      provider: 'stripe',
      gatewayEventId: 'evt_test_1',
      eventType: 'checkout.completed',
      gatewayRef: 'cs_test_1',
    });
    expect(verified.event.payloadDigest).toHaveLength(64);

    const novel = eventPayload('billing_portal.session.created');
    const verifiedNovel = driver.verifyWebhook(Buffer.from(novel), signedHeaders(novel));
    if (verifiedNovel.kind !== 'verified') throw new Error(verifiedNovel.kind);
    expect(verifiedNovel.event.eventType).toBe('unrecognized');
  });

  it('rejects tampered bodies, stale timestamps, missing headers, and refuses to trust anything without a configured secret', () => {
    const payload = eventPayload('payment_intent.succeeded');
    const headers = signedHeaders(payload);

    const tampered = Buffer.from(payload.replace('evt_test_1', 'evt_forged'));
    expect(driver.verifyWebhook(tampered, headers)).toEqual({
      kind: 'rejected',
      reason: 'invalidSignature',
    });

    const stale = signedHeaders(payload, Math.floor(Date.now() / 1000) - 3600);
    expect(driver.verifyWebhook(Buffer.from(payload), stale)).toEqual({
      kind: 'rejected',
      reason: 'staleTimestamp',
    });

    expect(driver.verifyWebhook(Buffer.from(payload), {})).toEqual({
      kind: 'rejected',
      reason: 'malformed',
    });

    const secretless = new StripeDriver({ secretKey: 'sk_test_stub', client: realClient });
    expect(secretless.verifyWebhook(Buffer.from(payload), headers)).toEqual({
      kind: 'rejected',
      reason: 'invalidSignature',
    });
  });
});
