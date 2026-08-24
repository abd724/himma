/**
 * W5-3 — trusted gateway-event ingestion + payment-domain processing
 * (docs/33 §7, §17 W5-3; docs/24 §4.1/§5.8/§7.8; owner rulings D-W5-4/5).
 *
 * RECONCILED RESPONSIBILITY (docs/33 §17): W5-3 owns durable trusted
 * receipt (§7.8) PLUS the payment-domain event lifecycle — verification,
 * attempt linking, quarantine, the catch-up sweep, and the ONLY definitive
 * non-success convergence hosted Checkout has (session expiry). It does
 * NOT own: intent `succeeded`, the `capture` PaymentTransaction posting,
 * `confirmPaidBooking`, booking `payment_failed`, or the §8.6 reversal —
 * docs/33 §5 binds all of those to the W5-4 §7.4b/§8.6 transactions.
 * A processed-success event therefore RESTS at `verified` — the durable,
 * exactly-once work item the W5-4 saga consumes.
 *
 * Trust boundary: `ingestGatewayDelivery` accepts RAW bytes + headers and
 * calls the provider's signature verification FIRST. A rejected delivery
 * creates NO row of any kind — a forged payload must never poison the
 * (provider, event id) dedup space (this narrows docs/24 §4.1's
 * "signature failures quarantine" wording: quarantine applies to VERIFIED
 * but unprocessable events; unverified bytes get nothing but a 4xx —
 * reconciliation surfaced, not silent). A verified delivery resolves its
 * attempt reference WHILE THE EVENT OBJECT IS IN HAND (the durable row is
 * digest-only by design): the opaque session ref first
 * (`payment_attempt.gateway_ref`, globally unique), else the
 * server-authored Himma intent ref → that intent's newest attempt — the
 * intent row always exists before any session does (T2 precedes NET in
 * W5-2), so ordering cannot starve resolution. The row inserts at
 * `received` with `ON CONFLICT (provider, gateway_event_id) DO NOTHING`
 * (§6.7 — duplicate delivery is a structural no-op) plus audit + outbox
 * `gateway.event.received` (§7.8) in one transaction; the HTTP 2xx may be
 * sent the moment that commits — everything after is recoverable from the
 * database, which is the ONLY queue (no in-memory anything).
 *
 * Processing (`processPendingGatewayEvents`) runs in its own per-event
 * transactions — competing consumers/sweeps are safe because the event
 * row is taken FOR UPDATE and every effect is a CAS against the 0015
 * machines:
 *   · `received → verified` + write-once attempt link (+ audit);
 *   · success family (`checkout.completed` / `payment.captured`): REST at
 *     `verified` — financial truth recorded, NOTHING confirms, nothing is
 *     posted, hold/booking/capacity untouched (late success after
 *     inventory loss is exactly this row waiting for W5-4 compensation);
 *   · `payment.failed`: NOT definitive under hosted Checkout (the session
 *     stays open and the customer may retry inside it — reconciliation
 *     surfaced per docs/33 §17 W5-3 §12), so the event is recorded
 *     `processed` with NO attempt/intent/booking transition;
 *   · `checkout.expired`: the one DEFINITIVE non-success end of a hosted
 *     session — CAS the attempt to `errored`/`checkoutExpired` if still
 *     non-terminal (a stale expiry against a terminal attempt is a
 *     truthful no-op; nothing ever regresses), then `processed`. Himma
 *     hold expiry remains the ONLY capacity authority (D-W5-5): no Stripe
 *     session state resurrects or extends a hold;
 *   · `unrecognized` types or unresolvable references: `quarantined`
 *     (+ audit) — never guessed into a financial status, no Booking
 *     effect, alert-visible.
 *
 * Ordering independence: success/failed/expired arrive in any order; every
 * branch re-reads current state under its own transaction and applies only
 * legal transitions, so stale events cannot regress later truth. Semantic
 * duplicates (distinct event ids describing one underlying payment) are
 * truthfully recorded as separate events; commercial exactly-once is the
 * W5-1 structure (one-succeeded-per-booking, unique
 * gateway_transaction_id, attempt terminal freeze) enforced when W5-4
 * consumes the work items — never the event table alone.
 */
import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { PaymentProviderPort } from '../provider-port';

export interface WebhookIngestionDeps {
  db: Db;
  provider: PaymentProviderPort;
}

export type IngestGatewayDeliveryResult =
  | {
      kind: 'accepted';
      gatewayEventRowId: string;
      /** True when this exact (provider, event id) was already durable. */
      duplicate: boolean;
    }
  | { kind: 'rejected'; reason: 'invalidSignature' | 'staleTimestamp' | 'malformed' };

/**
 * §7.8 ingest: verify → resolve references → durable receipt →
 * (audit + outbox) — one transaction, no domain processing inside it.
 */
export async function ingestGatewayDelivery(
  deps: WebhookIngestionDeps,
  rawBody: Buffer,
  headers: Record<string, string>,
): Promise<IngestGatewayDeliveryResult> {
  const verification = deps.provider.verifyWebhook(rawBody, headers);
  if (verification.kind === 'rejected') {
    return { kind: 'rejected', reason: verification.reason };
  }
  const event = verification.event;
  return await deps.db.transaction().execute(async (trx) => {
    // Resolve the attempt while the event's references are in hand — the
    // durable row is digest-only (0015): opaque session ref first, then
    // the server-authored intent ref.
    let attemptId: string | undefined;
    if (event.gatewayRef !== undefined) {
      const byRef = await trx
        .selectFrom('payment_attempt')
        .select(['id'])
        .where('gateway_ref', '=', event.gatewayRef)
        .executeTakeFirst();
      attemptId = byRef?.id;
    }
    if (attemptId === undefined && event.himmaIntentRef !== undefined) {
      const byIntent = await trx
        .selectFrom('payment_attempt')
        .select(['id'])
        .where('intent_id', '=', event.himmaIntentRef)
        .orderBy('sequence_no', 'desc')
        .limit(1)
        .executeTakeFirst();
      attemptId = byIntent?.id;
    }

    const inserted = await trx
      .insertInto('gateway_event')
      .values({
        id: newId(),
        provider: event.provider,
        gateway_event_id: event.gatewayEventId,
        event_type: event.eventType,
        payload_digest: event.payloadDigest,
        signature_verified: true,
        received_at: event.occurredAt,
        attempt_id: attemptId ?? null,
      } as never)
      .onConflict((oc) => oc.columns(['provider', 'gateway_event_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst();
    if (inserted === undefined) {
      const existing = await trx
        .selectFrom('gateway_event')
        .select(['id'])
        .where('provider', '=', event.provider)
        .where('gateway_event_id', '=', event.gatewayEventId)
        .executeTakeFirstOrThrow();
      return { kind: 'accepted' as const, gatewayEventRowId: existing.id, duplicate: true };
    }
    await appendAuditEvent(trx, {
      actorType: 'system',
      action: 'gateway.event.received',
      entityType: 'gateway_event',
      entityId: inserted.id,
    });
    // docs/24 §7.8/§9.6 — machine facts only: ids and the normalized type.
    // Never the payload, never a URL, never a secret.
    await appendOutboxEvent(trx, {
      aggregateType: 'gateway_event',
      aggregateId: inserted.id,
      eventType: 'gateway.event.received',
      payload: {
        gatewayEventId: event.gatewayEventId,
        provider: event.provider,
        eventType: event.eventType,
      },
    });
    return { kind: 'accepted' as const, gatewayEventRowId: inserted.id, duplicate: false };
  });
}

export interface ProcessPendingResult {
  examined: number;
  verified: number;
  processed: number;
  quarantined: number;
}

const SUCCESS_TYPES = ['checkout.completed', 'payment.captured'];

/**
 * The idempotent processing pass / catch-up sweep (docs/33 §10): safe to
 * run after every ingest, concurrently, and after any crash — the durable
 * `received` rows are the recovery point; every effect is a CAS.
 */
export async function processPendingGatewayEvents(
  deps: WebhookIngestionDeps,
  options: { limit?: number } = {},
): Promise<ProcessPendingResult> {
  const limit = options.limit ?? 50;
  const pending = await deps.db
    .selectFrom('gateway_event')
    .select(['id'])
    .where('processing_state', '=', 'received')
    .orderBy('received_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  const result: ProcessPendingResult = {
    examined: pending.length,
    verified: 0,
    processed: 0,
    quarantined: 0,
  };
  for (const row of pending) {
    const outcome = await deps.db.transaction().execute(async (trx) => {
      return await processOne(trx, row.id);
    });
    if (outcome === 'verified') result.verified += 1;
    if (outcome === 'processed') result.processed += 1;
    if (outcome === 'quarantined') result.quarantined += 1;
  }
  return result;
}

type ProcessOutcome = 'verified' | 'processed' | 'quarantined' | 'skipped';

async function processOne(trx: Trx, gatewayEventRowId: string): Promise<ProcessOutcome> {
  // Row-lock the event so competing sweeps serialize per event.
  const event = await trx
    .selectFrom('gateway_event')
    .select(['id', 'processing_state', 'event_type', 'attempt_id'])
    .where('id', '=', gatewayEventRowId)
    .forUpdate()
    .executeTakeFirst();
  if (event === undefined || event.processing_state !== 'received') return 'skipped';

  if (event.event_type === 'unrecognized' || event.attempt_id === null) {
    // Never guessed into a financial status; an event about an object this
    // platform never authored is alert-worthy, not actionable.
    await moveEvent(trx, event.id, 'received', 'quarantined');
    await appendAuditEvent(trx, {
      actorType: 'system',
      action: 'gateway.event.quarantined',
      entityType: 'gateway_event',
      entityId: event.id,
    });
    return 'quarantined';
  }

  await moveEvent(trx, event.id, 'received', 'verified');
  await appendAuditEvent(trx, {
    actorType: 'system',
    action: 'gateway.event.verified',
    entityType: 'gateway_event',
    entityId: event.id,
  });

  if (SUCCESS_TYPES.includes(event.event_type)) {
    // Financial truth recorded; the row RESTS at `verified` as the W5-4
    // work item. No confirmation, no posting, no capacity effect — even
    // when the hold/attempt already died (late success → compensation).
    return 'verified';
  }

  if (event.event_type === 'checkout.expired') {
    // The definitive non-success end of a hosted session. CAS-guarded:
    // a stale expiry against a terminal attempt is a truthful no-op.
    const moved = await trx
      .updateTable('payment_attempt')
      .set({ state: 'errored', failure_code: 'checkoutExpired' })
      .where('id', '=', event.attempt_id)
      .where('state', 'in', ['started', 'requires_action', 'authorized'])
      .executeTakeFirst();
    if ((moved.numUpdatedRows ?? 0n) > 0n) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'payment.attempt.errored',
        entityType: 'payment_attempt',
        entityId: event.attempt_id,
      });
    }
  }
  // `payment.failed` under hosted Checkout is deliberately non-definitive
  // (the session stays open; the customer may retry inside it): recorded
  // and processed, no state moved.

  await moveEvent(trx, event.id, 'verified', 'processed');
  await appendAuditEvent(trx, {
    actorType: 'system',
    action: 'gateway.event.processed',
    entityType: 'gateway_event',
    entityId: event.id,
  });
  return 'processed';
}

async function moveEvent(trx: Trx, id: string, from: string, to: string): Promise<void> {
  await trx
    .updateTable('gateway_event')
    .set({ processing_state: to })
    .where('id', '=', id)
    .where('processing_state', '=', from)
    .execute();
}
