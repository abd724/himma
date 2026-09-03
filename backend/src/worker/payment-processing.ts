/**
 * W6-2 — the authoritative cadence driver for the certified W5 async
 * passes (docs/37 §12/§13; docs/36 OP-02 worker half).
 *
 * Nothing here is payment authority: the worker CALLS the same idempotent,
 * CAS-guarded functions the webhook post-ack pass calls —
 * `processPendingGatewayEvents` (received → verified/processed/quarantined)
 * then `processTrustedPaymentResults` (verified success items → the
 * confirmation/compensation saga) — so convergence no longer depends on
 * the next webhook arriving. Claim shapes, trust boundaries, and every W5
 * semantic (duplicates, late success, terminal intents, compensation,
 * commission-once) are the certified services' own. The D-W5-5 lapsed-
 * checkout sweep is deliberately NOT driven here (W6-3).
 *
 * A pass drains in bounded rounds: while a round examined a full batch it
 * runs again immediately, up to `maxRounds`, so a backlog converges within
 * one tick without an unbounded loop.
 */
import type { Db } from '../db/kysely';
import type { PaymentProviderPort } from '../modules/payment/provider-port';
import { processTrustedPaymentResults } from '../modules/payment/services/payment-saga';
import { processPendingGatewayEvents } from '../modules/payment/services/webhook-ingestion';

export interface PaymentPassDeps {
  db: Db;
  provider: PaymentProviderPort;
}

export interface PaymentPassSummary {
  rounds: number;
  examinedPending: number;
  verified: number;
  processed: number;
  quarantinedEvents: number;
  examinedTrusted: number;
  confirmed: number;
  compensated: number;
  converged: number;
  deferred: number;
  quarantinedResults: number;
}

const PENDING_LIMIT = 50;
const TRUSTED_LIMIT = 20;

export async function runPaymentPass(
  deps: PaymentPassDeps,
  options: { maxRounds?: number } = {},
): Promise<PaymentPassSummary> {
  const maxRounds = Math.max(1, options.maxRounds ?? 10);
  const summary: PaymentPassSummary = {
    rounds: 0,
    examinedPending: 0,
    verified: 0,
    processed: 0,
    quarantinedEvents: 0,
    examinedTrusted: 0,
    confirmed: 0,
    compensated: 0,
    converged: 0,
    deferred: 0,
    quarantinedResults: 0,
  };
  for (let round = 0; round < maxRounds; round += 1) {
    summary.rounds += 1;
    const pending = await processPendingGatewayEvents(deps, { limit: PENDING_LIMIT });
    summary.examinedPending += pending.examined;
    summary.verified += pending.verified;
    summary.processed += pending.processed;
    summary.quarantinedEvents += pending.quarantined;
    const trusted = await processTrustedPaymentResults(deps, { limit: TRUSTED_LIMIT });
    summary.examinedTrusted += trusted.examined;
    summary.confirmed += trusted.confirmed;
    summary.compensated += trusted.compensated;
    summary.converged += trusted.converged;
    summary.deferred += trusted.deferred;
    summary.quarantinedResults += trusted.quarantined;
    if (pending.examined < PENDING_LIMIT && trusted.examined < TRUSTED_LIMIT) break;
  }
  return summary;
}
