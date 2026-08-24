/**
 * W5-1 — payment-provider composition (docs/33 §13; D-W5-6).
 *
 * The certified fail-closed pattern (B2-6C capability gate, D-S3-3,
 * content-safety, D-8 policy provider): payment capability is COMPUTED
 * from an actual configured integration, never asserted by a flag.
 *
 * In W5-1 no live Stripe driver exists, so PRODUCTION IS UNCONFIGURED BY
 * CONSTRUCTION: `resolvePaymentProvider` cannot return a configured
 * provider for `nodeEnv === 'production'` no matter what is requested or
 * injected — there is no `paymentReady=true` switch to set, and the
 * deterministic test provider is refused there explicitly. The certified
 * S5-5 customer boundary (`paymentUnavailable` 503 before any Booking
 * exists) therefore stands untouched. W5-2+ replaces this seam with the
 * genuine Stripe driver constructed from real runtime secret
 * configuration; only that construction can ever make production
 * configured.
 */
import type { NodeEnv } from '../../config/env';
import type { PaymentProviderPort } from './provider-port';

export type PaymentProviderResolution =
  | { kind: 'configured'; provider: PaymentProviderPort }
  | { kind: 'unconfigured'; reason: string };

export interface PaymentProviderSelection {
  /**
   * Deterministic test provider, injectable in development/test ONLY
   * (docs/33 §13.1). Injecting it in production is refused, not honored.
   */
  deterministic?: PaymentProviderPort;
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
    return {
      kind: 'unconfigured',
      reason:
        'no production payment provider integration exists yet (D-W5-1 Stripe driver is W5-2+ work); the paid path stays fail-closed',
    };
  }
  if (selection.deterministic !== undefined) {
    return { kind: 'configured', provider: selection.deterministic };
  }
  return { kind: 'unconfigured', reason: 'no payment provider configured' };
}
