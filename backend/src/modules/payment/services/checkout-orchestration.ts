/**
 * W5-2 — the paid-checkout orchestration boundary (docs/33 §17 W5-2;
 * docs/24 §7.4a + §8.2–§8.3; owner rulings D-W5-1/2/3/5).
 *
 * ONE idempotent internal operation (`startPaidCheckout`) bridges the
 * FROZEN booking domain and the W5 payment domain without duplicating
 * either. It is NOT a route: customer HTTP exposure is W5-5 per docs/33
 * §17, so the certified S5-5 `paymentUnavailable` 503 boundary stands
 * untouched and nothing here is reachable from any transport.
 *
 * Transaction/network boundaries (reported to the owner; no PostgreSQL
 * lock is ever held across a Stripe request):
 *
 *   T1  initiateBooking — the CERTIFIED S5-3 §7.4a boundary, its own
 *       `runIdempotent` transaction: unit lock → hold gates → ONE Booking
 *       `pending_payment` on the ACTIVE hold. Zero-total refused there
 *       (`paymentNotRequired`); the hold stays active, `held_count` stays
 *       claimed, `booked_count` untouched. W5-2 CALLS it, never re-implements.
 *   T2  intent ensure — its own transaction: INSERT `payment_intent`
 *       (`created`, amount pinned to the quote total by the 0015 trigger,
 *       TTL = the HOLD's expiry) `ON CONFLICT (idempotency_key) DO NOTHING`
 *       + SELECT — a retry REJOINS the same commercial intent; a different
 *       command racing the same booking dies on the one-live-intent
 *       partial unique. Audit `payment.intent.created` only on real insert.
 *   T3  attempt ensure — its own transaction: resume the newest attempt or
 *       insert the next sequence (`ON CONFLICT DO NOTHING` + re-read);
 *       intent CAS `created → in_progress`. Audit `payment.attempt.started`
 *       on real insert. Effective hold liveness is re-checked here — a
 *       dead hold routes to the dead-hold path instead of the gateway.
 *   NET createHostedCheckout — BETWEEN transactions, no DB locks held:
 *       provider-request idempotency key derived STABLY as
 *       `himma:checkout:<intentId>:<sequenceNo>` — a crashed/timed-out
 *       retry re-sends the SAME key, so the provider replays the SAME
 *       session (never a second charge opportunity); a NEW attempt (after
 *       a definitive failure) carries a NEW key by construction.
 *   T4  outcome persist — its own transaction: `created` → write-once
 *       `gateway_ref` + audit `payment.checkout.created` (gateway ref only,
 *       NEVER the URL); `refused` → attempt CAS → `errored` + bounded
 *       failure code + audit; `unknownOutcome` → NOTHING persisted — the
 *       attempt stays `started` with no ref and the same command retries
 *       into the same provider key (docs/24 §8.3: never label a timeout
 *       failed, never guess).
 *
 * Failure windows (docs/33 §17 W5-2 requirement, proven in tests):
 *   A. crash after T2, before NET  → retry rejoins booking (T1 replay) and
 *      intent (T2 select), proceeds. Same commercial intent.
 *   B. session created, response lost before T4 → retry re-sends the SAME
 *      provider key → provider idempotent replay returns the SAME session
 *      → T4 persists the ref. One session, ever.
 *   C. definitive create failure → attempt `errored` truthfully; a retry
 *      opens the NEXT attempt (new provider key). Nothing stranded: the
 *      booking rests on its active hold, hold TTL is the backstop.
 *   D. persistent unknown/timeout → attempt stays `started`; retries keep
 *      the same key; no second independent session can exist.
 *   E. crash after T4 → replay returns the recorded checkout (the provider
 *      replays the session incl. its URL for the stable key).
 *
 * The redirect URL is returned to the caller ONLY — never persisted,
 * never audited (docs/33 §17 W5-2 §14). Financial truth NEVER comes from
 * this module: no inspection result confirms a booking, `confirmPaidBooking`
 * is neither imported nor called, and browser returns are UX-only (the
 * trusted gateway-result boundary is W5-3/W5-4).
 */
import { appendAuditEvent } from '../../../db/audit';
import type { Db } from '../../../db/kysely';
import { newId } from '../../../db/ids';
import {
  initiateBooking,
} from '../../booking/services/booking-lifecycle';
import type { CustomerActor } from '../../booking/services/booking-shared';
import type { PaymentProviderResolution } from '../provider-composition';
import type { PaymentProviderPort } from '../provider-port';

export interface CheckoutOrchestrationDeps {
  db: Db;
  /** The composed provider resolution (fail-closed; docs/33 §13). */
  provider: PaymentProviderResolution;
}

export interface StartPaidCheckoutInput {
  holdId: string;
  quoteId: string;
  /** The customer command key — ONE intended checkout per key. */
  idempotencyKey: string;
  returnUrl: string;
  cancelUrl: string;
}

export type StartPaidCheckoutResult =
  | {
      kind: 'checkoutStarted';
      bookingId: string;
      intentId: string;
      attemptId: string;
      gatewayRef: string;
      /** Returned to the caller only — never persisted or audited. */
      redirectUrl: string;
      gatewayExpiresAt: Date;
      /** The HOLD's expiry — the inventory truth (≠ the session's expiry). */
      holdExpiresAt: Date;
    }
  /** Provider unconfigured — refused BEFORE any Booking/intent exists. */
  | { kind: 'paymentUnavailable'; reason: string }
  /** Passthroughs from the certified S5-3 initiation boundary. */
  | { kind: 'holdNotFound' }
  | { kind: 'holdNotActive'; state: 'consumed' | 'expired' | 'released' }
  | { kind: 'holdExpired' }
  | { kind: 'quoteMismatch' }
  | { kind: 'paymentNotRequired' }
  | { kind: 'alreadyBooked' }
  | { kind: 'idempotencyConflict' }
  /** A DIFFERENT command's live intent already owns this booking. */
  | { kind: 'checkoutAlreadyActive' }
  /** This command's intent already ended (expired/cancelled/failed). */
  | { kind: 'intentNotLive'; state: string }
  /** Definitive gateway create failure; a retry opens the next attempt. */
  | { kind: 'checkoutCreateFailed'; reason: 'invalidRequest' | 'providerUnavailable' }
  /** Gateway outcome unknown (timeout): retry the SAME command to resolve. */
  | { kind: 'checkoutPending'; intentId: string; attemptId: string };

const ATTEMPT_TERMINAL = ['captured', 'declined', 'errored'];
const INTENT_TERMINAL = ['succeeded', 'failed', 'expired', 'cancelled'];

function providerCheckoutKey(intentId: string, sequenceNo: number): string {
  return `himma:checkout:${intentId}:${sequenceNo}`;
}

export async function startPaidCheckout(
  deps: CheckoutOrchestrationDeps,
  actor: CustomerActor,
  input: StartPaidCheckoutInput,
): Promise<StartPaidCheckoutResult> {
  // 0. Capability gate FIRST (D-W5-6/docs/33 §13): an unconfigured platform
  //    refuses before any state exists — no dead-end pending Booking, no
  //    intent, nothing to unwind.
  if (deps.provider.kind !== 'configured') {
    return { kind: 'paymentUnavailable', reason: deps.provider.reason };
  }
  const provider = deps.provider.provider;

  // T1 — the certified S5-3 boundary (nonzero quote, active hold, one
  // pending_payment Booking; replays rejoin).
  const initiation = await initiateBooking({ db: deps.db }, actor, {
    holdId: input.holdId,
    quoteId: input.quoteId,
    idempotencyKey: input.idempotencyKey,
  });
  if (initiation.outcome.kind !== 'bookingPending') {
    return initiation.outcome.kind === 'idempotencyConflict'
      ? { kind: 'idempotencyConflict' }
      : initiation.outcome;
  }
  const booking = initiation.outcome.booking;

  // T2 — ensure the ONE commercial intent for this command.
  const intentKey = `cs:${actor.accountId}:${input.idempotencyKey}`;
  const hold = await deps.db
    .selectFrom('capacity_hold')
    .select(['id', 'state', 'expires_at'])
    .where('id', '=', input.holdId)
    .executeTakeFirstOrThrow();
  const quote = await deps.db
    .selectFrom('price_quote')
    .select(['total_fils'])
    .where('id', '=', booking.quoteId)
    .executeTakeFirstOrThrow();

  let intent: { id: string; state: string; expires_at: Date; amount_fils: string | number | bigint };
  try {
    intent = await deps.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('payment_intent')
        .values({
          id: newId(),
          booking_id: booking.bookingId,
          account_id: actor.accountId,
          quote_id: booking.quoteId,
          hold_id: booking.holdId,
          amount_fils: quote.total_fils,
          idempotency_key: intentKey,
          // The commercial window IS the hold's window (docs/24 §8.2: hold
          // TTL is the universal backstop) — never the gateway session's.
          expires_at: hold.expires_at,
        } as never)
        .onConflict((oc) => oc.columns(['idempotency_key']).doNothing())
        .returning(['id'])
        .executeTakeFirst();
      if (inserted !== undefined) {
        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.accountId,
          principalContext: 'customer',
          action: 'payment.intent.created',
          entityType: 'payment_intent',
          entityId: inserted.id,
        });
      }
      return await trx
        .selectFrom('payment_intent')
        .select(['id', 'state', 'expires_at', 'amount_fils', 'booking_id'])
        .where('idempotency_key', '=', intentKey)
        .executeTakeFirstOrThrow();
    });
  } catch (error) {
    if (error instanceof Error && /uq_payment_intent_live_booking/.test(error.message)) {
      return { kind: 'checkoutAlreadyActive' };
    }
    throw error;
  }
  if (INTENT_TERMINAL.includes(intent.state)) {
    return { kind: 'intentNotLive', state: intent.state };
  }

  // Effective hold-liveness re-check (projection only — the S5-2 lifecycle
  // primitives stay the ONLY settlement authority): a dead hold must not
  // reach the gateway, and an open checkout on a dead hold winds down.
  const liveness = await deps.db
    .selectFrom('capacity_hold')
    .select(({ eb }) => [
      'state',
      'expires_at',
      eb.fn<Date>('now', []).as('db_now'),
    ])
    .where('id', '=', input.holdId)
    .executeTakeFirstOrThrow();
  if (liveness.state !== 'active' || liveness.expires_at <= liveness.db_now) {
    return await windDownDeadHoldCheckout(deps.db, provider, intent.id);
  }

  // T3 — ensure the working attempt; intent created → in_progress.
  const attempt = await deps.db.transaction().execute(async (trx) => {
    const newest = await trx
      .selectFrom('payment_attempt')
      .select(['id', 'sequence_no', 'state', 'gateway_ref'])
      .where('intent_id', '=', intent.id)
      .orderBy('sequence_no', 'desc')
      .limit(1)
      .executeTakeFirst();
    let working = newest;
    if (working === undefined || ATTEMPT_TERMINAL.includes(working.state)) {
      const nextSequence = (working?.sequence_no ?? 0) + 1;
      const inserted = await trx
        .insertInto('payment_attempt')
        .values({
          id: newId(),
          intent_id: intent.id,
          sequence_no: nextSequence,
        } as never)
        .onConflict((oc) => oc.columns(['intent_id', 'sequence_no']).doNothing())
        .returning(['id'])
        .executeTakeFirst();
      if (inserted !== undefined) {
        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.accountId,
          principalContext: 'customer',
          action: 'payment.attempt.started',
          entityType: 'payment_attempt',
          entityId: inserted.id,
        });
      }
      // Winner's row either way (a concurrent duplicate joins, never forks).
      working = await trx
        .selectFrom('payment_attempt')
        .select(['id', 'sequence_no', 'state', 'gateway_ref'])
        .where('intent_id', '=', intent.id)
        .where('sequence_no', '=', nextSequence)
        .executeTakeFirstOrThrow();
    }
    await trx
      .updateTable('payment_intent')
      .set({ state: 'in_progress' })
      .where('id', '=', intent.id)
      .where('state', '=', 'created')
      .execute();
    return working;
  });

  // NET — between transactions; the STABLE provider idempotency key binds
  // this attempt to at most one provider session, across every retry.
  const creation = await provider.createHostedCheckout({
    intentId: intent.id,
    idempotencyKey: providerCheckoutKey(intent.id, attempt.sequence_no),
    amountFils: Number(intent.amount_fils),
    currency: 'AED',
    description: 'Himma booking',
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
    requestedExpiresAt: hold.expires_at,
  });

  // T4 — persist the outcome.
  if (creation.kind === 'unknownOutcome') {
    // Nothing is persisted: the same command retries into the same key.
    return { kind: 'checkoutPending', intentId: intent.id, attemptId: attempt.id };
  }
  if (creation.kind === 'refused') {
    await deps.db.transaction().execute(async (trx) => {
      const moved = await trx
        .updateTable('payment_attempt')
        .set({ state: 'errored', failure_code: creation.reason })
        .where('id', '=', attempt.id)
        .where('state', 'in', ['started', 'requires_action'])
        .executeTakeFirst();
      if ((moved.numUpdatedRows ?? 0n) > 0n) {
        await appendAuditEvent(trx, {
          actorType: 'system',
          action: 'payment.attempt.errored',
          entityType: 'payment_attempt',
          entityId: attempt.id,
        });
      }
    });
    return { kind: 'checkoutCreateFailed', reason: creation.reason };
  }

  if (attempt.gateway_ref === null || attempt.gateway_ref === undefined) {
    await deps.db.transaction().execute(async (trx) => {
      const moved = await trx
        .updateTable('payment_attempt')
        .set({ gateway_ref: creation.gatewayRef })
        .where('id', '=', attempt.id)
        .where('gateway_ref', 'is', null)
        .executeTakeFirst();
      if ((moved.numUpdatedRows ?? 0n) > 0n) {
        await appendAuditEvent(trx, {
          actorType: 'system',
          action: 'payment.checkout.created',
          entityType: 'payment_attempt',
          entityId: attempt.id,
          // Machine facts only: the opaque ref. NEVER the redirect URL.
          afterDigest: creation.gatewayRef,
        });
      }
    });
  } else if (attempt.gateway_ref !== creation.gatewayRef) {
    // Structurally impossible with stable keys; fail loudly, never fork.
    throw new Error(
      `provider returned a different session for a bound attempt (${attempt.id})`,
    );
  }

  return {
    kind: 'checkoutStarted',
    bookingId: booking.bookingId,
    intentId: intent.id,
    attemptId: attempt.id,
    gatewayRef: creation.gatewayRef,
    redirectUrl: creation.clientAction.url,
    gatewayExpiresAt: creation.gatewayExpiresAt,
    holdExpiresAt: hold.expires_at,
  };
}

/**
 * The dead-hold wind-down (D-W5-5 Option-A primitive): the intent ends
 * truthfully (`expired`), the working attempt records the abandonment, and
 * the provider session is BEST-EFFORT expired so the hosted page stops
 * accepting completion — correctness NEVER depends on that network call
 * (a completion that slips through is exactly the W5-4 §8.6 compensation
 * case). The HOLD itself is untouched: S5-2 remains the only settlement
 * authority for inventory.
 */
async function windDownDeadHoldCheckout(
  db: Db,
  provider: PaymentProviderPort,
  intentId: string,
): Promise<StartPaidCheckoutResult> {
  const gatewayRefs: string[] = [];
  await db.transaction().execute(async (trx) => {
    const attempts = await trx
      .selectFrom('payment_attempt')
      .select(['id', 'state', 'gateway_ref'])
      .where('intent_id', '=', intentId)
      .execute();
    for (const attempt of attempts) {
      if (!ATTEMPT_TERMINAL.includes(attempt.state)) {
        const moved = await trx
          .updateTable('payment_attempt')
          .set({ state: 'errored', failure_code: 'holdExpired' })
          .where('id', '=', attempt.id)
          .where('state', 'in', ['started', 'requires_action', 'authorized'])
          .executeTakeFirst();
        if ((moved.numUpdatedRows ?? 0n) > 0n && attempt.gateway_ref !== null) {
          gatewayRefs.push(attempt.gateway_ref);
        }
      }
    }
    const movedIntent = await trx
      .updateTable('payment_intent')
      .set({ state: 'expired' })
      .where('id', '=', intentId)
      .where('state', 'in', ['created', 'in_progress'])
      .executeTakeFirst();
    if ((movedIntent.numUpdatedRows ?? 0n) > 0n) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'payment.intent.expired',
        entityType: 'payment_intent',
        entityId: intentId,
      });
    }
  });
  // Best-effort explicit session expiry — AFTER the transaction, no lock
  // held; every outcome (expired / alreadyFinalized / notFound / unknown)
  // is tolerable because financial truth arrives only via W5-3/W5-4.
  for (const gatewayRef of gatewayRefs) {
    await provider.expireCheckout(gatewayRef);
  }
  return { kind: 'holdExpired' };
}
