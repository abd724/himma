/**
 * W5-2 — payment-provider composition (docs/33 §13; D-W5-1/D-W5-3/D-W5-6).
 *
 * The certified fail-closed pattern (B2-6C capability gate, D-S3-3,
 * content-safety, D-8 policy provider): payment capability is COMPUTED
 * from an actual configured integration, never asserted by a flag.
 *
 * W5-2 adds the real Stripe SANDBOX driver: development/test/staging may
 * compose it from genuine TEST-mode credentials delivered through the
 * typed config boundary. PRODUCTION REMAINS UNCONFIGURED BY CONSTRUCTION:
 * the repository holds no live-charging capability (the driver refuses
 * non-test keys at construction; this resolver additionally refuses to
 * construct ANY provider for `nodeEnv === 'production'`), so there is no
 * `paymentReady=true` switch to set and no configuration value that can
 * open the paid path. Live enablement arrives as its own reviewed change
 * after the D-W5-3 UAE VAT/principal-vs-agent/invoicing ruling and the
 * docs/23 §19 lift (with G4). The certified S5-5 customer boundary
 * (`paymentUnavailable` 503 before any Booking exists) stands untouched.
 *
 * The deterministic test provider remains injectable in development/test
 * ONLY and is refused in production even when explicitly injected.
 */
import type { NodeEnv, StripeConfig } from '../../config/env';
import type { PaymentProviderPort } from './provider-port';
import { isStripeTestModeKey, StripeDriver } from './stripe-driver';

export type PaymentProviderResolution =
  | { kind: 'configured'; provider: PaymentProviderPort }
  | { kind: 'unconfigured'; reason: string };

export interface PaymentProviderSelection {
  /**
   * Deterministic test provider, injectable in development/test ONLY
   * (docs/33 §13.1). Injecting it in production is refused, not honored —
   * including under the W6-1 `paymentsMode: 'test'` opt-in.
   */
  deterministic?: PaymentProviderPort;
  /** Stripe credentials from the typed config boundary (env.ts). */
  stripe?: StripeConfig;
  /**
   * W6-1 (docs/37 §33 — the ONE owner-approved production composition
   * amendment): an EXPLICIT configuration mode, never inferred from a key
   * prefix. `'test'` lets a production runtime compose the Stripe TEST
   * driver for D-W5-6 certification (the driver still refuses non-TEST
   * keys at construction — two independent walls). Anything else keeps the
   * certified production refusal byte-for-byte. There is deliberately NO
   * `'live'` value: live enablement remains a future reviewed change
   * (docs/36 PA-06) with `productionChargingPossible` the literal false.
   */
  paymentsMode?: 'disabled' | 'test';
}

export function resolvePaymentProvider(
  nodeEnv: NodeEnv,
  selection: PaymentProviderSelection = {},
): PaymentProviderResolution {
  if (nodeEnv === 'production') {
    if (selection.deterministic !== undefined) {
      return {
        kind: 'unconfigured',
        reason:
          'the deterministic test payment provider is never available in production (D-W5-6)',
      };
    }
    if (selection.paymentsMode === 'test' && selection.stripe !== undefined) {
      if (!isStripeTestModeKey(selection.stripe.secretKey)) {
        return {
          kind: 'unconfigured',
          reason:
            'PAYMENTS_MODE=test accepts Stripe TEST-mode keys only — live keys are refused (live enablement is the future PA-06 slice, not configuration)',
        };
      }
      return {
        kind: 'configured',
        provider: new StripeDriver({
          secretKey: selection.stripe.secretKey,
          ...(selection.stripe.webhookSecret !== undefined
            ? { webhookSecret: selection.stripe.webhookSecret }
            : {}),
          ...(selection.stripe.webhookSecretRetiring !== undefined
            ? { retiringWebhookSecret: selection.stripe.webhookSecretRetiring }
            : {}),
        }),
      };
    }
    // Without the explicit TEST opt-in, genuine Stripe configuration still
    // composes NOTHING: live charging is gated on D-W5-3 + docs/23 §19 (a
    // future reviewed change, docs/36 PA-06), and a key alone is never a
    // mode (docs/37 §33).
    return {
      kind: 'unconfigured',
      reason:
        'production payment capability is disabled: set PAYMENTS_MODE=test with a Stripe TEST key for D-W5-6 certification; live charging remains gated on the D-W5-3 VAT posture ruling and the docs/23 §19 lift',
    };
  }
  if (selection.deterministic !== undefined) {
    return { kind: 'configured', provider: selection.deterministic };
  }
  if (selection.stripe !== undefined) {
    if (!isStripeTestModeKey(selection.stripe.secretKey)) {
      return {
        kind: 'unconfigured',
        reason:
          'only Stripe TEST-mode keys are accepted in W5-2 (sandbox capability only; D-W5-3 gates live charging)',
      };
    }
    return {
      kind: 'configured',
      provider: new StripeDriver({
        secretKey: selection.stripe.secretKey,
        ...(selection.stripe.webhookSecret !== undefined
          ? { webhookSecret: selection.stripe.webhookSecret }
          : {}),
        ...(selection.stripe.webhookSecretRetiring !== undefined
          ? { retiringWebhookSecret: selection.stripe.webhookSecretRetiring }
          : {}),
      }),
    };
  }
  return { kind: 'unconfigured', reason: 'no payment provider configured' };
}

/**
 * W5-6 — the COMPUTED payment capability report (docs/33 §17 W5-6
 * "capability report wiring"; the B2-6C pattern): readiness is derived
 * from actual configured integration, never asserted by a flag. There is
 * deliberately NO input that can force any field — in particular,
 * `productionChargingPossible` is the literal type `false` in W5: the
 * repository holds no live-charging capability (test-key-only driver,
 * production-refusing composition, D-W5-3 VAT gate, docs/23 §19), and
 * changing that is its own reviewed code change, not configuration.
 * Surfacing this report on an operations/health surface is a recorded
 * later item; W5-6 ships the computation.
 */
export interface PaymentCapabilityReport {
  provider: 'stripe' | 'deterministicTest' | 'none';
  providerConfigured: boolean;
  checkoutUrlsConfigured: boolean;
  webhookSecretConfigured: boolean;
  /** Customer paid initiation can serve (provider + server-authored URLs). */
  customerCheckoutAvailable: boolean;
  /** The webhook ingress registers (a composed provider exists). */
  webhookIngressAvailable: boolean;
  /** Structurally false in W5 — see above. */
  productionChargingPossible: false;
  reasons: string[];
}

export function paymentCapabilityReport(
  nodeEnv: NodeEnv,
  selection: PaymentProviderSelection = {},
  checkoutUrls?: { successUrl: string; cancelUrl: string },
): PaymentCapabilityReport {
  const resolution = resolvePaymentProvider(nodeEnv, selection);
  const providerConfigured = resolution.kind === 'configured';
  const reasons: string[] = [];
  if (!providerConfigured) reasons.push(resolution.reason);
  const checkoutUrlsConfigured = checkoutUrls !== undefined;
  if (!checkoutUrlsConfigured) {
    reasons.push('checkout success/cancel URLs are not configured');
  }
  const webhookSecretConfigured =
    selection.deterministic !== undefined ||
    (selection.stripe !== undefined && selection.stripe.webhookSecret !== undefined);
  if (!webhookSecretConfigured) {
    reasons.push('webhook signing secret is not configured');
  }
  return {
    provider: providerConfigured ? resolution.provider.provider : 'none',
    providerConfigured,
    checkoutUrlsConfigured,
    webhookSecretConfigured,
    customerCheckoutAvailable: providerConfigured && checkoutUrlsConfigured,
    webhookIngressAvailable: providerConfigured,
    productionChargingPossible: false,
    reasons,
  };
}
