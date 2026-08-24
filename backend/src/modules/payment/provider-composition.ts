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
   * (docs/33 §13.1). Injecting it in production is refused, not honored.
   */
  deterministic?: PaymentProviderPort;
  /** Stripe credentials from the typed config boundary (env.ts). */
  stripe?: StripeConfig;
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
    // Even genuine Stripe configuration cannot open production in W5-2:
    // live charging is gated on D-W5-3 + docs/23 §19 (a future reviewed
    // change), and test-mode keys have no business in production at all.
    return {
      kind: 'unconfigured',
      reason:
        'production payment capability does not exist in W5-2: live charging is gated on the D-W5-3 VAT posture ruling and the docs/23 §19 lift; the paid path stays fail-closed',
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
      provider: new StripeDriver({ secretKey: selection.stripe.secretKey }),
    };
  }
  return { kind: 'unconfigured', reason: 'no payment provider configured' };
}
