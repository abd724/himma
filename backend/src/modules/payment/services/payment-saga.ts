/**
 * W5-4 — the payment-success → booking-confirmation / compensation saga
 * (docs/24 §7.4b + §8.5–§8.6; docs/33 §17 W5-4; owner rulings D-W5-4/5).
 *
 * TWO INDEPENDENT TRUTHS, never forced to lie for each other:
 * financial truth = the append-only `payment_transaction` ledger converged
 * to provider evidence; Booking/capacity truth = the frozen Slice-5
 * machine. This saga composes them — it never re-implements either.
 *
 * TRANSACTIONAL BOUNDARIES (reported to the owner; no PostgreSQL lock ever
 * spans a provider network call):
 *
 *   INPUT  a durable W5-3 work item: `gateway_event` at `verified` with a
 *          success type and a linked attempt. NOTHING else can enter —
 *          there is no customer/admin/provider "mark paid" of any kind.
 *   NET-I  `inspectPayment` — trusted server-to-server reconciliation of
 *          provider truth (docs/24 §8.7/§8.9): the saga acts on CURRENT
 *          provider state (status `captured` + the unique gateway
 *          transaction id + the EXACT intent amount/currency), never on
 *          the event payload or arrival order alone. Not captured yet →
 *          the work item rests (retry later); contradicted → the event
 *          completes with no financial effect; amount mismatch →
 *          quarantine + alert. Duplicate/semantic-duplicate events all
 *          converge through this same gate.
 *   T-CONFIRM  the docs/24 §7.4b SINGLE transaction: the saga invokes the
 *          FROZEN `confirmPaidBooking` (S5-3 performs hold validity,
 *          reciprocal Booking↔hold identity, held−1/booked+1, hold
 *          consumption, Booking confirmation, D-8 policy snapshot,
 *          Enrolment, and the canonical booking audit/outbox — none of it
 *          copied here) with the W5-4 `paidSettlement` seam joined INSIDE
 *          that same idempotent transaction: exactly-once `capture`
 *          posting (unique `gateway_transaction_id`), attempt →
 *          `captured`, intent `in_progress → succeeded`, audit + outbox
 *          `payment.captured`. A settlement failure rolls back the ENTIRE
 *          confirmation with an unpoisoned key — the database can never
 *          commit a confirmed Booking with an unresolved payment, nor a
 *          succeeded intent without its confirmed Booking. The saga key is
 *          `saga:<intentId>` — every duplicate/semantic-duplicate/worker
 *          replay serializes on it and reads the stored outcome.
 *   T-COMP-A   compensation branch, step 1 (own transaction): the capture
 *          is PRESERVED exactly once (same unique-id authority), the
 *          attempt reaches `captured` where its machine still allows it,
 *          and the intent settles `in_progress → failed` (docs/24 §8.6) —
 *          an intent already terminal (`expired` via the W5-2 dead-hold
 *          wind-down) keeps its state: the durable obligation is defined
 *          by LEDGER SHAPE, not intent prose — a `capture` posting with no
 *          matching `reversal` and no confirmed Booking IS "compensation
 *          required", crash-safe and queryable.
 *   NET-R  `reverse(gatewayRef, amount)` — SAME-amount only (D-W5-4), with
 *          the driver's STABLE idempotency key (`himma:reverse:<ref>`): a
 *          retry after timeout/crash replays the SAME provider reversal,
 *          never a second refund. Unknown/refused outcomes leave the work
 *          item at `verified` — the durable retryable obligation; repeated
 *          deferrals are the operations/reconciliation signal (§8.9).
 *   T-COMP-B   reversal posting exactly-once (unique id) + audit + outbox
 *          `payment.reversed` + work-item completion.
 *   T-DONE work-item completion (`verified → processed`, CAS + audit) —
 *          separate and idempotent; a crash before it re-enters the saga,
 *          which converges through the terminal-state short-circuits
 *          (intent `succeeded`, or capture+reversal present) without any
 *          second commercial effect.
 *
 * The compensation branch NEVER: recreates holds, moves counters, steals
 * seats, marks financial success as failure, or abandons captured money.
 * Booking state transitions stay with their certified owners (S5-2 unwind
 * / TTL backstop); `payment_failed` remains untouched and unreachable in
 * W5-4 (docs/24 §5.6's customer-retry transition is not this slice's).
 */
import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { confirmPaidBooking } from '../../booking/services/booking-lifecycle';
import type { PaymentProviderPort } from '../provider-port';

export interface PaymentSagaDeps {
  db: Db;
  provider: PaymentProviderPort;
  /** TEST-ONLY failure injection at named saga points. Never in wiring. */
  failpoint?: (point: SagaFailpoint) => void;
}

export type SagaFailpoint =
  | 'inSettlement'
  | 'afterCompensationCapture'
  | 'beforeReversalPosting'
  | 'beforeCompletion';

export type SagaOutcome =
  | 'confirmed'
  | 'compensated'
  | 'converged'
  | 'deferred'
  | 'quarantined'
  | 'skipped';

export interface ProcessTrustedResultsSummary {
  examined: number;
  confirmed: number;
  compensated: number;
  converged: number;
  deferred: number;
  quarantined: number;
}

const SUCCESS_TYPES = ['checkout.completed', 'payment.captured'];
const ATTEMPT_FAILED_TERMINALS = ['declined', 'errored'];

/**
 * Bounded sweep over the durable trusted work items. Safe to run from the
 * webhook post-ack pass, concurrently, and after any crash: every effect
 * below is CAS/unique-guarded, so competing workers converge instead of
 * duplicating (proven by the concurrency suite).
 */
export async function processTrustedPaymentResults(
  deps: PaymentSagaDeps,
  options: { limit?: number } = {},
): Promise<ProcessTrustedResultsSummary> {
  const pending = await deps.db
    .selectFrom('gateway_event')
    .select(['id'])
    .where('processing_state', '=', 'verified')
    .where('event_type', 'in', SUCCESS_TYPES)
    .where('attempt_id', 'is not', null)
    .orderBy('received_at', 'asc')
    .orderBy('id', 'asc')
    .limit(options.limit ?? 20)
    .execute();
  const summary: ProcessTrustedResultsSummary = {
    examined: pending.length,
    confirmed: 0,
    compensated: 0,
    converged: 0,
    deferred: 0,
    quarantined: 0,
  };
  for (const row of pending) {
    const outcome = await runPaymentResultSaga(deps, row.id);
    if (outcome !== 'skipped') summary[outcome] += 1;
  }
  return summary;
}

/** Runs the saga for ONE durable trusted work item. */
export async function runPaymentResultSaga(
  deps: PaymentSagaDeps,
  gatewayEventRowId: string,
): Promise<SagaOutcome> {
  const event = await deps.db
    .selectFrom('gateway_event')
    .select(['id', 'processing_state', 'event_type', 'attempt_id'])
    .where('id', '=', gatewayEventRowId)
    .executeTakeFirst();
  if (
    event === undefined ||
    event.processing_state !== 'verified' ||
    !SUCCESS_TYPES.includes(event.event_type) ||
    event.attempt_id === null
  ) {
    return 'skipped';
  }

  const context = await loadContext(deps.db, event.attempt_id);
  if (context === undefined) return 'skipped';

  // Terminal-state convergence short-circuits (duplicates, replays, and
  // crash-after-effect recoveries all land here).
  if (context.intentState === 'succeeded') {
    await completeWorkItem(deps, event.id);
    return 'converged';
  }
  const reversalExists = await hasPosting(deps.db, context.attemptId, 'reversal');
  if (reversalExists) {
    await completeWorkItem(deps, event.id);
    return 'converged';
  }

  if (context.gatewayRef === null) {
    // No provider reference yet (a W5-2 recovery window still open) — the
    // durable item simply waits; nothing to inspect, nothing to guess.
    return 'deferred';
  }

  // NET-I: reconcile CURRENT provider truth before any commercial effect.
  const inspection = await deps.provider.inspectPayment(context.gatewayRef);
  if (inspection.kind === 'notFound') return 'deferred';
  if (inspection.status === 'pending' || inspection.status === 'requiresAction'
      || inspection.status === 'authorized' || inspection.status === 'unrecognized') {
    // Not (yet) captured provider-side: a premature/ambiguous event never
    // becomes a commercial effect. The item rests for a later pass.
    return 'deferred';
  }
  if (inspection.status === 'declined' || inspection.status === 'errored'
      || inspection.status === 'expired') {
    // The provider CONTRADICTS the success event: no captured money exists.
    // Complete the item with zero financial effect — truth wins.
    await completeWorkItem(deps, event.id);
    return 'converged';
  }
  // status === 'captured' from here on.
  const gatewayTransactionId = inspection.gatewayTransactionId;
  if (gatewayTransactionId === undefined) return 'deferred';
  if (
    inspection.amountFils !== context.amountFils ||
    (inspection.currency !== undefined && inspection.currency !== 'AED')
  ) {
    // Money truth mismatch: NEVER acted on — quarantined loudly.
    await quarantineWorkItem(deps, event.id);
    return 'quarantined';
  }

  // Anomaly gate: a terminally-failed attempt means Himma's commercial
  // trail for this session already ended truthfully (mutually exclusive at
  // the provider; reachable only through anomalous event combinations) —
  // captured money on it is compensated, never force-confirmed.
  const attemptTerminallyFailed = ATTEMPT_FAILED_TERMINALS.includes(context.attemptState);

  if (!attemptTerminallyFailed) {
    // T-CONFIRM — the §7.4b single transaction via the FROZEN seam.
    const run = await confirmPaidBooking(
      {
        db: deps.db,
        paidSettlement: async (trx) => {
          deps.failpoint?.('inSettlement');
          await postCaptureOnce(trx, context, gatewayTransactionId);
          await casAttemptCaptured(trx, context.attemptId);
          await settleIntentSucceeded(trx, context.intentId);
        },
      },
      {
        bookingId: context.bookingId,
        holdId: context.holdId,
        idempotencyKey: `saga:${context.intentId}`,
      },
    );
    const outcome = run.outcome;
    if (outcome.kind === 'bookingConfirmed' || outcome.kind === 'alreadyConfirmed') {
      deps.failpoint?.('beforeCompletion');
      await completeWorkItem(deps, event.id);
      return 'confirmed';
    }
    if (outcome.kind === 'idempotencyConflict' || outcome.kind === 'staleVersion') {
      return 'deferred';
    }
    // holdExpired · holdNotActive · policyUnavailable · reciprocalMismatch ·
    // invalidBookingState · bookingNotFound · notPaidQuote → the certified
    // machine says this Booking cannot legally confirm → compensation.
  }

  // COMPENSATION (docs/24 §8.6; D-W5-4/D-W5-5): money is real, inventory
  // is not confirmable. Preserve the capture, settle the intent, reverse
  // the same amount — never touch holds/counters/bookings.
  await deps.db.transaction().execute(async (trx) => {
    await postCaptureOnce(trx, context, gatewayTransactionId);
    if (!attemptTerminallyFailed) {
      await casAttemptCaptured(trx, context.attemptId);
    }
    const moved = await trx
      .updateTable('payment_intent')
      .set({ state: 'failed' })
      .where('id', '=', context.intentId)
      .where('state', 'in', ['in_progress'])
      .executeTakeFirst();
    if ((moved.numUpdatedRows ?? 0n) > 0n) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'payment.intent.failed',
        entityType: 'payment_intent',
        entityId: context.intentId,
      });
    }
  });
  deps.failpoint?.('afterCompensationCapture');

  // NET-R: same-amount reversal with the driver's STABLE idempotency key.
  const reversal = await deps.provider.reverse(context.gatewayRef, context.amountFils);
  if (reversal.kind !== 'reversed') {
    // Durable retryable obligation: capture without reversal, item still
    // `verified`. The sweep retries with the SAME key; repeated deferral
    // is the operations/reconciliation signal — never a fresh refund op.
    await appendAuditEvent(deps.db, {
      actorType: 'system',
      action: 'payment.compensation.deferred',
      entityType: 'payment_attempt',
      entityId: context.attemptId,
    });
    return 'deferred';
  }

  deps.failpoint?.('beforeReversalPosting');
  await deps.db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('payment_transaction')
      .values({
        id: newId(),
        attempt_id: context.attemptId,
        kind: 'reversal',
        amount_fils: context.amountFils,
        gateway_transaction_id: reversal.gatewayTransactionId,
      } as never)
      .onConflict((oc) => oc.column('gateway_transaction_id').doNothing())
      .returning(['id'])
      .executeTakeFirst();
    if (inserted !== undefined) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'payment.reversed',
        entityType: 'payment_transaction',
        entityId: inserted.id,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'payment_intent',
        aggregateId: context.intentId,
        eventType: 'payment.reversed',
        payload: {
          intentId: context.intentId,
          attemptId: context.attemptId,
          amountFils: context.amountFils,
        },
      });
    }
  });
  await completeWorkItem(deps, event.id);
  return 'compensated';
}

interface SagaContext {
  attemptId: string;
  attemptState: string;
  gatewayRef: string | null;
  intentId: string;
  intentState: string;
  amountFils: number;
  bookingId: string;
  holdId: string;
}

async function loadContext(db: Db, attemptId: string): Promise<SagaContext | undefined> {
  const row = await db
    .selectFrom('payment_attempt as a')
    .innerJoin('payment_intent as i', 'i.id', 'a.intent_id')
    .select([
      'a.id as attemptId',
      'a.state as attemptState',
      'a.gateway_ref as gatewayRef',
      'i.id as intentId',
      'i.state as intentState',
      'i.amount_fils as amountFils',
      'i.booking_id as bookingId',
      'i.hold_id as holdId',
    ])
    .where('a.id', '=', attemptId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { ...row, amountFils: Number(row.amountFils) } as SagaContext;
}

async function hasPosting(db: Db, attemptId: string, kind: string): Promise<boolean> {
  const row = await db
    .selectFrom('payment_transaction')
    .select(['id'])
    .where('attempt_id', '=', attemptId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  return row !== undefined;
}

/** ONE commercial capture for ONE gateway financial transaction, ever. */
async function postCaptureOnce(
  trx: Trx,
  context: SagaContext,
  gatewayTransactionId: string,
): Promise<void> {
  const inserted = await trx
    .insertInto('payment_transaction')
    .values({
      id: newId(),
      attempt_id: context.attemptId,
      kind: 'capture',
      amount_fils: context.amountFils,
      gateway_transaction_id: gatewayTransactionId,
    } as never)
    .onConflict((oc) => oc.column('gateway_transaction_id').doNothing())
    .returning(['id'])
    .executeTakeFirst();
  if (inserted === undefined) {
    // The posting exists — it must be OURS (same attempt), never another
    // trail's: the unique gateway id is the cross-check, not a shrug.
    const existing = await trx
      .selectFrom('payment_transaction')
      .select(['attempt_id', 'kind'])
      .where('gateway_transaction_id', '=', gatewayTransactionId)
      .executeTakeFirstOrThrow();
    if (existing.attempt_id !== context.attemptId || existing.kind !== 'capture') {
      throw new Error(
        `gateway transaction ${gatewayTransactionId} is already posted for a different trail`,
      );
    }
    return;
  }
  await appendAuditEvent(trx, {
    actorType: 'system',
    action: 'payment.captured',
    entityType: 'payment_transaction',
    entityId: inserted.id,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'payment_intent',
    aggregateId: context.intentId,
    eventType: 'payment.captured',
    payload: {
      intentId: context.intentId,
      attemptId: context.attemptId,
      amountFils: context.amountFils,
    },
  });
}

async function casAttemptCaptured(trx: Trx, attemptId: string): Promise<void> {
  // Tolerant CAS: already-captured is a legal replay; terminal-failed rows
  // are never rewritten (their history stands; the ledger carries truth).
  await trx
    .updateTable('payment_attempt')
    .set({ state: 'captured' })
    .where('id', '=', attemptId)
    .where('state', 'in', ['started', 'requires_action', 'authorized'])
    .execute();
}

async function settleIntentSucceeded(trx: Trx, intentId: string): Promise<void> {
  const moved = await trx
    .updateTable('payment_intent')
    .set({ state: 'succeeded' })
    .where('id', '=', intentId)
    .where('state', '=', 'in_progress')
    .executeTakeFirst();
  if ((moved.numUpdatedRows ?? 0n) === 0n) {
    const current = await trx
      .selectFrom('payment_intent')
      .select(['state'])
      .where('id', '=', intentId)
      .executeTakeFirstOrThrow();
    if (current.state !== 'succeeded') {
      throw new Error(
        `payment_intent ${intentId} cannot settle succeeded from "${current.state}"`,
      );
    }
  }
}

async function completeWorkItem(deps: PaymentSagaDeps, eventRowId: string): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    const moved = await trx
      .updateTable('gateway_event')
      .set({ processing_state: 'processed' })
      .where('id', '=', eventRowId)
      .where('processing_state', '=', 'verified')
      .executeTakeFirst();
    if ((moved.numUpdatedRows ?? 0n) > 0n) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'gateway.event.processed',
        entityType: 'gateway_event',
        entityId: eventRowId,
      });
    }
  });
}

async function quarantineWorkItem(deps: PaymentSagaDeps, eventRowId: string): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    const moved = await trx
      .updateTable('gateway_event')
      .set({ processing_state: 'quarantined' })
      .where('id', '=', eventRowId)
      .where('processing_state', '=', 'verified')
      .executeTakeFirst();
    if ((moved.numUpdatedRows ?? 0n) > 0n) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'gateway.event.quarantined',
        entityType: 'gateway_event',
        entityId: eventRowId,
      });
    }
  });
}
