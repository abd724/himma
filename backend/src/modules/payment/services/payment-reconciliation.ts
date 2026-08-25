/**
 * W5-6 — the reconciliation SKELETON and stuck-state alerting hooks
 * (docs/33 §17 W5-6; docs/23 §12.10; docs/24 §8.9).
 *
 * These are bounded, PURE-READ operational diagnostics — the smallest
 * honest versions of the docs/33-assigned "daily ledger-vs-gateway"
 * reconciliation job and stuck-state detection:
 *
 * - They mutate NOTHING: no Booking/hold/counter, no payment row, no
 *   audit/outbox emission. Convergence stays with the certified owners
 *   (W5-3 lifecycle, W5-4 saga, the D-W5-5 wind-down sweep, S5-2
 *   settlement). A reconciliation finding is a SIGNAL for operations,
 *   never an authority.
 * - `reconciliation_event` persistence is EXPLICITLY DEFERRED to the
 *   future reconciliation/operations slice (creating the table needs a
 *   migration; W5-6 requires none — the structural forbidden-entity lock
 *   keeps forbidding it until its owning slice).
 * - The scheduled daily/periodic runner is W6-era operational
 *   infrastructure (like the outbox relay and the D-W5-5 wind-down
 *   runner); these functions are directly callable by it.
 */
import { sql } from 'kysely';

import type { Db } from '../../../db/kysely';
import type { PaymentProviderPort } from '../provider-port';

export interface PaymentReconciliationDeps {
  db: Db;
  provider: PaymentProviderPort;
}

export type ReconciliationFindingKind =
  /** Provider reports captured money the ledger has not posted yet — the
   *  normal in-flight window; PERSISTENT recurrence is the §8.9 signal. */
  | 'captureUnposted'
  /** A recorded gateway ref the provider does not know — alert-worthy. */
  | 'providerMissing'
  /** Provider money truth disagrees with the intent amount/currency. */
  | 'amountMismatch'
  /** The ledger posted a capture the provider does not corroborate. */
  | 'captureUncorroborated';

export interface ReconciliationFinding {
  kind: ReconciliationFindingKind;
  attemptId: string;
  intentId: string;
  gatewayRef: string;
  intentState: string;
  providerStatus?: string;
}

export interface ReconciliationSummary {
  examined: number;
  consistent: number;
  findings: ReconciliationFinding[];
}

/**
 * Bounded ledger-vs-provider comparison over the most recent ref-bearing
 * attempts. Provider truth is read through the certified `inspectPayment`
 * port operation; nothing is written, nothing converges here.
 */
export async function reconcileLedgerAgainstProvider(
  deps: PaymentReconciliationDeps,
  options: { limit?: number } = {},
): Promise<ReconciliationSummary> {
  const attempts = await deps.db
    .selectFrom('payment_attempt as a')
    .innerJoin('payment_intent as i', 'i.id', 'a.intent_id')
    .select([
      'a.id as attemptId',
      'a.gateway_ref as gatewayRef',
      'i.id as intentId',
      'i.state as intentState',
      'i.amount_fils as amountFils',
    ])
    .where('a.gateway_ref', 'is not', null)
    .orderBy('a.created_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(options.limit ?? 50)
    .execute();

  const summary: ReconciliationSummary = {
    examined: attempts.length,
    consistent: 0,
    findings: [],
  };
  for (const attempt of attempts) {
    const capturePosted = await deps.db
      .selectFrom('payment_transaction')
      .select(['id'])
      .where('attempt_id', '=', attempt.attemptId)
      .where('kind', '=', 'capture')
      .executeTakeFirst();
    const inspection = await deps.provider.inspectPayment(attempt.gatewayRef!);

    const base = {
      attemptId: attempt.attemptId,
      intentId: attempt.intentId,
      gatewayRef: attempt.gatewayRef!,
      intentState: attempt.intentState,
    };
    if (inspection.kind === 'notFound') {
      summary.findings.push({ kind: 'providerMissing', ...base });
      continue;
    }
    if (inspection.status === 'captured') {
      if (
        (inspection.amountFils !== undefined &&
          inspection.amountFils !== Number(attempt.amountFils)) ||
        (inspection.currency !== undefined && inspection.currency !== 'AED')
      ) {
        summary.findings.push({
          kind: 'amountMismatch',
          ...base,
          providerStatus: inspection.status,
        });
        continue;
      }
      if (capturePosted !== undefined) summary.consistent += 1;
      else {
        summary.findings.push({
          kind: 'captureUnposted',
          ...base,
          providerStatus: inspection.status,
        });
      }
      continue;
    }
    // Provider says no captured money exists (open / terminal non-success).
    if (capturePosted !== undefined) {
      summary.findings.push({
        kind: 'captureUncorroborated',
        ...base,
        providerStatus: inspection.status,
      });
    } else {
      summary.consistent += 1;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Stuck-state alerting hooks (docs/23 §12.10)
// ---------------------------------------------------------------------------

export interface StuckPaymentStates {
  /** Durable gateway events resting unprocessed past the threshold. */
  unprocessedGatewayEvents: Array<{ id: string; eventType: string; processingState: string }>;
  /** Live intents on effectively dead holds — the D-W5-5 wind-down runner
   *  is missing or behind (the sweep would end these). */
  liveIntentsOnDeadHolds: Array<{ intentId: string; holdId: string }>;
  /** Captured money with neither a confirmed outcome nor a reversal — the
   *  outstanding W5-4 compensation obligation (docs/24 §8.6 ledger shape). */
  outstandingCompensations: Array<{ attemptId: string; intentId: string }>;
  /** Attempts still awaiting a provider session ref (lost create window). */
  refAwaitingAttempts: Array<{ attemptId: string; intentId: string }>;
}

/**
 * Pure-read detection of states that should not persist. Thresholds are
 * injectable so operations can tune them; nothing here mutates or emits.
 */
export async function findStuckPaymentStates(
  deps: { db: Db },
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<StuckPaymentStates> {
  const age = options.olderThanSeconds ?? 900;
  const limit = options.limit ?? 50;

  // Age is measured on Himma's own durable-receipt clock (`created_at`) —
  // `received_at` carries the PROVIDER-claimed occurrence time (untrusted
  // data; W5-3 stores it verbatim) and must not drive alerting windows.
  const events = await sql<{ id: string; event_type: string; processing_state: string }>`
    SELECT id, event_type, processing_state FROM gateway_event
    WHERE processing_state IN ('received', 'verified')
      AND created_at <= now() - make_interval(secs => ${age})
    ORDER BY created_at ASC LIMIT ${limit}`.execute(deps.db);

  const intents = await sql<{ intent_id: string; hold_id: string }>`
    SELECT i.id AS intent_id, i.hold_id FROM payment_intent i
    JOIN capacity_hold h ON h.id = i.hold_id
    WHERE i.state IN ('created', 'in_progress')
      AND (h.state <> 'active' OR h.expires_at <= now())
      AND i.updated_at <= now() - make_interval(secs => ${age})
    ORDER BY i.created_at ASC LIMIT ${limit}`.execute(deps.db);

  const compensations = await sql<{ attempt_id: string; intent_id: string }>`
    SELECT t.attempt_id, a.intent_id FROM payment_transaction t
    JOIN payment_attempt a ON a.id = t.attempt_id
    JOIN payment_intent i ON i.id = a.intent_id
    WHERE t.kind = 'capture'
      AND i.state <> 'succeeded'
      AND t.created_at <= now() - make_interval(secs => ${age})
      AND NOT EXISTS (SELECT 1 FROM payment_transaction r
                      WHERE r.attempt_id = t.attempt_id AND r.kind = 'reversal')
    ORDER BY t.created_at ASC LIMIT ${limit}`.execute(deps.db);

  const refless = await sql<{ attempt_id: string; intent_id: string }>`
    SELECT a.id AS attempt_id, a.intent_id FROM payment_attempt a
    WHERE a.state = 'started' AND a.gateway_ref IS NULL
      AND a.created_at <= now() - make_interval(secs => ${age})
    ORDER BY a.created_at ASC LIMIT ${limit}`.execute(deps.db);

  return {
    unprocessedGatewayEvents: events.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      processingState: row.processing_state,
    })),
    liveIntentsOnDeadHolds: intents.rows.map((row) => ({
      intentId: row.intent_id,
      holdId: row.hold_id,
    })),
    outstandingCompensations: compensations.rows.map((row) => ({
      attemptId: row.attempt_id,
      intentId: row.intent_id,
    })),
    refAwaitingAttempts: refless.rows.map((row) => ({
      attemptId: row.attempt_id,
      intentId: row.intent_id,
    })),
  };
}
