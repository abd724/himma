/**
 * W5-2 — the paid-checkout orchestration boundary (docs/33 §17 W5-2;
 * docs/24 §7.4a + §8.2–§8.3; owner rulings D-W5-1/2/3/5) — GENERALIZED by
 * S6-1 (docs/35 §5.3) over the exactly-one commercial target: capacity
 * Booking (the certified trail, byte-compatible) or unit-less
 * EntitlementPurchase. ONE payment architecture: the intent/attempt/
 * provider-session pipeline below is shared VERBATIM by both trails —
 * there is no second implementation, no second ledger, no
 * entitlement-specific gateway logic.
 *
 * BOOKING TRAIL (`startPaidCheckout`) — unchanged semantics:
 *
 *   T1  initiateBooking — the CERTIFIED S5-3 §7.4a boundary, its own
 *       `runIdempotent` transaction: unit lock → hold gates → ONE Booking
 *       `pending_payment` on the ACTIVE hold. Zero-total refused there
 *       (`paymentNotRequired`). W5-2 CALLS it, never re-implements.
 *   T2  intent ensure — its own transaction: INSERT `payment_intent`
 *       (`created`, amount pinned to the quote total by the 0015 trigger,
 *       TTL = the HOLD's expiry) `ON CONFLICT (idempotency_key) DO NOTHING`
 *       + SELECT — a retry REJOINS the same commercial intent; a different
 *       command racing the same booking dies on the one-live-intent
 *       partial unique. Economics snapshot atomically on real insert.
 *   T3  attempt ensure — resume the newest attempt or insert the next
 *       sequence; intent CAS `created → in_progress`. Effective hold
 *       liveness re-checked BEFORE T3 — a dead hold winds down instead of
 *       reaching the gateway.
 *   NET createHostedCheckout — BETWEEN transactions, no DB locks held;
 *       STABLE provider key `himma:checkout:<intentId>:<sequenceNo>` — a
 *       crashed/timed-out retry replays the SAME session, never a second
 *       charge opportunity.
 *   T4  outcome persist — write-once `gateway_ref` / attempt `errored` /
 *       nothing on unknownOutcome (never label a timeout failed).
 *
 * ENTITLEMENT TRAIL (`startPaidEntitlementCheckout`, docs/35 §5.3/§13):
 *
 *   T1′ ensure the ONE Purchase for the acquisition quote — its own
 *       `runIdempotent` transaction (`entitlement.purchase.initiate`):
 *       quote must be an unexpired `entitlementAcquisition` quote owned by
 *       the caller with a nonzero SERVER total; the Purchase is inserted
 *       `pending_payment` with the abandonment window (docs/35 §5.1 —
 *       commercial metadata, never inventory); `payment_failed` re-enters
 *       `pending_payment` for a retried checkout; a DIFFERENT command's
 *       live purchase is arbitrated by the one-live-intent partial unique
 *       in T2′. NO hold is created; NO capacity state is touched.
 *   T2′ intent ensure — the SAME transaction shape as T2 with the purchase
 *       target columns (`purchase_id`, no hold), TTL = the purchase
 *       window; economics snapshot identical (target-neutral D-W5-7 org
 *       binding). One live / one succeeded intent per purchase by partial
 *       unique.
 *   T3′/NET/T4′ — the SHARED pipeline (`runGatewaySessionLeg`).
 *
 * Failure windows and the redirect-URL discipline are the certified W5-2
 * rules for both trails; financial truth NEVER originates here — the
 * trusted seams (`confirmPaidBooking` / `confirmPaidEntitlementPurchase`)
 * are invoked only by the W5-4 saga and are neither imported nor called.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import type { Db } from '../../../db/kysely';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { computeCommissionSplit } from '../commission';
import {
  initiateBooking,
} from '../../booking/services/booking-lifecycle';
import type { CustomerActor } from '../../booking/services/booking-shared';
import {
  DEFAULT_PURCHASE_WINDOW_SECONDS,
} from '../../entitlement/services/entitlement-shared';
import type { PaymentProviderResolution } from '../provider-composition';
import type { PaymentProviderPort } from '../provider-port';

export interface CheckoutOrchestrationDeps {
  db: Db;
  /** The composed provider resolution (fail-closed; docs/33 §13). */
  provider: PaymentProviderResolution;
  /** Purchase checkout-abandonment window (docs/35 §5.1); default 1800 s. */
  purchaseWindowSeconds?: number;
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
  /**
   * D-W5-7: no ACTIVE agreed commission term exists for the provider —
   * paid checkout fails closed BEFORE any Booking/intent/money (rates are
   * provider-specific and NEVER defaulted).
   */
  | { kind: 'commissionTermsUnavailable' }
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

interface IntentRow {
  id: string;
  state: string;
  expires_at: Date;
  amount_fils: string | number | bigint;
}

type GatewaySessionLeg =
  | {
      kind: 'sessionReady';
      attemptId: string;
      gatewayRef: string;
      redirectUrl: string;
      gatewayExpiresAt: Date;
    }
  | { kind: 'checkoutCreateFailed'; reason: 'invalidRequest' | 'providerUnavailable' }
  | { kind: 'checkoutPending'; intentId: string; attemptId: string };

/**
 * The SHARED T3/NET/T4 pipeline — attempt ensure, provider session with the
 * stable idempotency key, outcome persist. Target-agnostic by construction:
 * it sees only the intent (both trails' intents are the same machine).
 */
async function runGatewaySessionLeg(
  db: Db,
  provider: PaymentProviderPort,
  actor: CustomerActor,
  intent: IntentRow,
  requestedExpiresAt: Date,
  returnUrl: string,
  cancelUrl: string,
): Promise<GatewaySessionLeg> {
  // T3 — ensure the working attempt; intent created → in_progress.
  const attempt = await db.transaction().execute(async (trx) => {
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
    returnUrl,
    cancelUrl,
    requestedExpiresAt,
  });

  // T4 — persist the outcome.
  if (creation.kind === 'unknownOutcome') {
    // Nothing is persisted: the same command retries into the same key.
    return { kind: 'checkoutPending', intentId: intent.id, attemptId: attempt.id };
  }
  if (creation.kind === 'refused') {
    await db.transaction().execute(async (trx) => {
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
    await db.transaction().execute(async (trx) => {
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
    kind: 'sessionReady',
    attemptId: attempt.id,
    gatewayRef: creation.gatewayRef,
    redirectUrl: creation.clientAction.url,
    gatewayExpiresAt: creation.gatewayExpiresAt,
  };
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

  // D-W5-7 commission gate — BEFORE any Booking/intent/money: a paid
  // checkout may proceed only when the provider has an ACTIVE agreed
  // commission term (provider-specific bps; never hard-coded, never
  // defaulted). The rate/basis/split are entirely SERVER-derived — no
  // input field exists for any of them. Zero-total quotes fall through to
  // the certified S5-3 `paymentNotRequired` refusal (the free path owns
  // them); missing/mismatched quotes fall through to its typed gates.
  const quote = await deps.db
    .selectFrom('price_quote')
    .select(['total_fils', 'organization_id'])
    .where('id', '=', input.quoteId)
    .executeTakeFirst();
  let commissionTerm: { id: string; organization_id: string; rate_bps: number } | undefined;
  if (quote !== undefined && Number(quote.total_fils) > 0) {
    commissionTerm = await deps.db
      .selectFrom('organization_commission_term')
      .select(['id', 'organization_id', 'rate_bps'])
      .where('organization_id', '=', quote.organization_id)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (commissionTerm === undefined) {
      return { kind: 'commissionTermsUnavailable' };
    }
  }

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
  if (quote === undefined || commissionTerm === undefined) {
    // Unreachable: `bookingPending` implies the quote exists with a
    // nonzero total, and the D-W5-7 gate above resolved the term.
    throw new Error('paid initiation succeeded without quote/commission context');
  }
  const commissionSplit = computeCommissionSplit(
    Number(quote.total_fils),
    commissionTerm.rate_bps,
  );

  let intent: IntentRow;
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
        // D-W5-7: the immutable economics snapshot commits ATOMICALLY with
        // the commercial intent — an idempotent retry finds both and
        // writes neither again (1:1 by primary key). Basis = the certified
        // pre-tax quote amount; split via the owner round-half-up rule;
        // organization pinned to the TARGET's org by trigger + the term
        // composite FK (cross-provider substitution impossible).
        await trx
          .insertInto('payment_intent_economics')
          .values({
            intent_id: inserted.id,
            organization_id: commissionTerm.organization_id,
            commission_term_id: commissionTerm.id,
            commission_basis_amount_fils: commissionSplit.commissionBasisAmountFils,
            platform_commission_rate_bps: commissionSplit.platformCommissionRateBps,
            platform_commission_amount_fils: commissionSplit.platformCommissionAmountFils,
            provider_share_amount_fils: commissionSplit.providerShareAmountFils,
          } as never)
          .execute();
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
    await windDownIntent(deps.db, provider, intent.id, 'holdExpired');
    return { kind: 'holdExpired' };
  }

  const leg = await runGatewaySessionLeg(
    deps.db,
    provider,
    actor,
    intent,
    hold.expires_at,
    input.returnUrl,
    input.cancelUrl,
  );
  if (leg.kind !== 'sessionReady') return leg;

  return {
    kind: 'checkoutStarted',
    bookingId: booking.bookingId,
    intentId: intent.id,
    attemptId: leg.attemptId,
    gatewayRef: leg.gatewayRef,
    redirectUrl: leg.redirectUrl,
    gatewayExpiresAt: leg.gatewayExpiresAt,
    holdExpiresAt: hold.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Entitlement-acquisition checkout — the purchase trail (docs/35 §5.3/§13)
// ---------------------------------------------------------------------------

export interface StartEntitlementCheckoutInput {
  quoteId: string;
  idempotencyKey: string;
  returnUrl: string;
  cancelUrl: string;
}

export type StartEntitlementCheckoutResult =
  | {
      kind: 'checkoutStarted';
      purchaseId: string;
      intentId: string;
      attemptId: string;
      gatewayRef: string;
      redirectUrl: string;
      gatewayExpiresAt: Date;
      /** The purchase abandonment window — commercial metadata only. */
      purchaseExpiresAt: Date;
    }
  | { kind: 'paymentUnavailable'; reason: string }
  | { kind: 'commissionTermsUnavailable' }
  | { kind: 'quoteNotFound' }
  | { kind: 'quoteNotAcquisition' }
  | { kind: 'quoteExpired' }
  | { kind: 'paymentNotRequired' }
  | { kind: 'participantNotFound' }
  | { kind: 'fulfillmentUnavailable' }
  /** The quote's one Purchase is already confirmed. */
  | { kind: 'alreadyAcquired' }
  /** The quote's one Purchase concluded without acquisition. */
  | { kind: 'purchaseConcluded'; state: string }
  | { kind: 'idempotencyConflict' }
  | { kind: 'checkoutAlreadyActive' }
  | { kind: 'intentNotLive'; state: string }
  | { kind: 'checkoutCreateFailed'; reason: 'invalidRequest' | 'providerUnavailable' }
  | { kind: 'checkoutPending'; intentId: string; attemptId: string };

const PURCHASE_INITIATE_SCOPE = 'entitlement.purchase.initiate';

type EnsurePurchaseResult =
  | {
      kind: 'purchasePending';
      purchaseId: string;
      quoteId: string;
      organizationId: string;
      expiresAt: string; // ISO
    }
  | { kind: 'quoteNotFound' }
  | { kind: 'quoteNotAcquisition' }
  | { kind: 'quoteExpired' }
  | { kind: 'paymentNotRequired' }
  | { kind: 'participantNotFound' }
  | { kind: 'fulfillmentUnavailable' }
  | { kind: 'alreadyAcquired' }
  | { kind: 'purchaseConcluded'; state: string }
  | { kind: 'checkoutAlreadyActive' };

export async function startPaidEntitlementCheckout(
  deps: CheckoutOrchestrationDeps,
  actor: CustomerActor,
  input: StartEntitlementCheckoutInput,
): Promise<StartEntitlementCheckoutResult> {
  // 0. Capability + D-W5-7 gates FIRST — refused before any Purchase/intent.
  if (deps.provider.kind !== 'configured') {
    return { kind: 'paymentUnavailable', reason: deps.provider.reason };
  }
  const provider = deps.provider.provider;
  const quote = await deps.db
    .selectFrom('price_quote')
    .select(['id', 'account_id', 'commercial_shape', 'total_fils', 'organization_id'])
    .where('id', '=', input.quoteId)
    .executeTakeFirst();
  if (quote === undefined || quote.account_id !== actor.accountId) {
    return { kind: 'quoteNotFound' };
  }
  if (quote.commercial_shape !== 'entitlementAcquisition') {
    return { kind: 'quoteNotAcquisition' };
  }
  if (Number(quote.total_fils) === 0) {
    // Zero money never enters the payment stack — §5.5 owns free acquisition.
    return { kind: 'paymentNotRequired' };
  }
  const commissionTerm = await deps.db
    .selectFrom('organization_commission_term')
    .select(['id', 'organization_id', 'rate_bps'])
    .where('organization_id', '=', quote.organization_id)
    .where('state', '=', 'active')
    .executeTakeFirst();
  if (commissionTerm === undefined) return { kind: 'commissionTermsUnavailable' };

  // T1′ — ensure the ONE Purchase for this command (replays rejoin).
  const windowSeconds = deps.purchaseWindowSeconds ?? DEFAULT_PURCHASE_WINDOW_SECONDS;
  const ensure = await runIdempotent<EnsurePurchaseResult>(
    deps.db,
    {
      principalRef: `customer:${actor.accountId}`,
      endpointScope: PURCHASE_INITIATE_SCOPE,
      idempotencyKey: input.idempotencyKey,
      requestDigest: requestDigest({ quoteId: input.quoteId }),
    },
    async (trx) => {
      const q = await sql<{
        id: string;
        account_id: string;
        participant_id: string;
        organization_id: string;
        program_id: string;
        price_option_id: string | null;
        offer_id: string | null;
        fulfillment_revision_id: string | null;
        commercial_shape: string;
        total_fils: string;
        lapsed: boolean;
      }>`
        SELECT id, account_id, participant_id, organization_id, program_id,
               price_option_id, offer_id, fulfillment_revision_id, commercial_shape,
               total_fils, (expires_at <= now()) AS lapsed
        FROM price_quote WHERE id = ${input.quoteId}`.execute(trx);
      const row = q.rows[0];
      if (row === undefined || row.account_id !== actor.accountId) {
        return { kind: 'quoteNotFound' };
      }
      if (row.commercial_shape !== 'entitlementAcquisition') {
        return { kind: 'quoteNotAcquisition' };
      }
      if (Number(row.total_fils) === 0) return { kind: 'paymentNotRequired' };
      if (row.lapsed) return { kind: 'quoteExpired' };
      const participant = await trx
        .selectFrom('participant')
        .select('id')
        .where('id', '=', row.participant_id)
        .where('account_id', '=', actor.accountId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (participant === undefined) return { kind: 'participantNotFound' };

      const existing = await trx
        .selectFrom('entitlement_purchase')
        .select(['id', 'state', 'organization_id', 'expires_at'])
        .where('quote_id', '=', row.id)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.state === 'confirmed') return { kind: 'alreadyAcquired' };
        if (existing.state === 'expired' || existing.state === 'compensated') {
          return { kind: 'purchaseConcluded', state: existing.state };
        }
        if (existing.state === 'payment_failed') {
          // W5-5 re-entry: a retried checkout re-opens the SAME purchase.
          await trx
            .updateTable('entitlement_purchase')
            .set({ state: 'pending_payment' })
            .where('id', '=', existing.id)
            .where('state', '=', 'payment_failed')
            .execute();
          return {
            kind: 'purchasePending',
            purchaseId: existing.id,
            quoteId: row.id,
            organizationId: existing.organization_id,
            expiresAt: existing.expires_at.toISOString(),
          };
        }
        // pending_payment under a DIFFERENT key (same-key replays never
        // re-enter this function): another command owns the live checkout.
        return { kind: 'checkoutAlreadyActive' };
      }

      const purchaseId = newId();
      const inserted = await sql<{ expires_at: Date }>`
        INSERT INTO entitlement_purchase
          (id, account_id, participant_id, organization_id, program_id,
           price_option_id, offer_id, quote_id, fulfillment_revision_id,
           expires_at)
        VALUES (${purchaseId}, ${row.account_id}, ${row.participant_id},
                ${row.organization_id}, ${row.program_id}, ${row.price_option_id},
                ${row.offer_id}, ${row.id}, ${row.fulfillment_revision_id},
                now() + make_interval(secs => ${windowSeconds}))
        RETURNING expires_at`.execute(trx);
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.accountId,
        principalContext: 'customer',
        action: 'entitlement.purchase.created',
        entityType: 'entitlement_purchase',
        entityId: purchaseId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'entitlement_purchase',
        aggregateId: purchaseId,
        eventType: 'entitlement.purchase.created',
        payload: {
          purchaseId,
          quoteId: row.id,
          organizationId: row.organization_id,
          state: 'pending_payment',
        },
      });
      return {
        kind: 'purchasePending',
        purchaseId,
        quoteId: row.id,
        organizationId: row.organization_id,
        expiresAt: inserted.rows[0]!.expires_at.toISOString(),
      };
    },
  );
  if (ensure.kind === 'idempotencyConflict') return { kind: 'idempotencyConflict' };
  const ensured = ensure.result;
  if (ensured.kind !== 'purchasePending') return ensured;
  const purchaseExpiresAt = new Date(ensured.expiresAt);

  // T2′ — ensure the ONE commercial intent (purchase target; no hold).
  const intentKey = `cs:${actor.accountId}:${input.idempotencyKey}`;
  const commissionSplit = computeCommissionSplit(
    Number(quote.total_fils),
    commissionTerm.rate_bps,
  );
  let intent: IntentRow;
  try {
    intent = await deps.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('payment_intent')
        .values({
          id: newId(),
          purchase_id: ensured.purchaseId,
          account_id: actor.accountId,
          quote_id: ensured.quoteId,
          amount_fils: quote.total_fils,
          idempotency_key: intentKey,
          // The commercial window IS the purchase's abandonment window —
          // never the gateway session's lifetime.
          expires_at: purchaseExpiresAt,
        } as never)
        .onConflict((oc) => oc.columns(['idempotency_key']).doNothing())
        .returning(['id'])
        .executeTakeFirst();
      if (inserted !== undefined) {
        await trx
          .insertInto('payment_intent_economics')
          .values({
            intent_id: inserted.id,
            organization_id: commissionTerm.organization_id,
            commission_term_id: commissionTerm.id,
            commission_basis_amount_fils: commissionSplit.commissionBasisAmountFils,
            platform_commission_rate_bps: commissionSplit.platformCommissionRateBps,
            platform_commission_amount_fils: commissionSplit.platformCommissionAmountFils,
            provider_share_amount_fils: commissionSplit.providerShareAmountFils,
          } as never)
          .execute();
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
        .select(['id', 'state', 'expires_at', 'amount_fils'])
        .where('idempotency_key', '=', intentKey)
        .executeTakeFirstOrThrow();
    });
  } catch (error) {
    if (error instanceof Error && /uq_payment_intent_live_purchase/.test(error.message)) {
      return { kind: 'checkoutAlreadyActive' };
    }
    throw error;
  }
  if (INTENT_TERMINAL.includes(intent.state)) {
    return { kind: 'intentNotLive', state: intent.state };
  }

  // Purchase liveness re-check: a swept/terminal purchase must not reach
  // the gateway; its open checkout winds down truthfully.
  const purchaseState = await deps.db
    .selectFrom('entitlement_purchase')
    .select(['state'])
    .where('id', '=', ensured.purchaseId)
    .executeTakeFirstOrThrow();
  if (purchaseState.state !== 'pending_payment') {
    await windDownIntent(deps.db, provider, intent.id, 'purchaseExpired');
    return { kind: 'purchaseConcluded', state: purchaseState.state };
  }

  const leg = await runGatewaySessionLeg(
    deps.db,
    provider,
    actor,
    intent,
    purchaseExpiresAt,
    input.returnUrl,
    input.cancelUrl,
  );
  if (leg.kind !== 'sessionReady') return leg;

  return {
    kind: 'checkoutStarted',
    purchaseId: ensured.purchaseId,
    intentId: intent.id,
    attemptId: leg.attemptId,
    gatewayRef: leg.gatewayRef,
    redirectUrl: leg.redirectUrl,
    gatewayExpiresAt: leg.gatewayExpiresAt,
    purchaseExpiresAt,
  };
}

/**
 * The bounded lapsed-paid-checkout wind-down sweep (D-W5-5 final ruling:
 * "at hold expiry: attempt explicit Stripe Checkout expiration PROMPTLY;
 * correctness NEVER depends on that call succeeding or arriving first"),
 * generalized by S6-1 over both commercial trails:
 *
 *   BOOKING trail — unchanged: LIVE intents whose Himma hold is effectively
 *   dead wind down (the certified S5-2/W5-3 sweep convention; holds/
 *   counters/bookings untouched).
 *
 *   PURCHASE trail — LIVE intents whose purchase window lapsed (or whose
 *   purchase left `pending_payment`) AND which carry NO capture posting
 *   wind down; the purchase terminalizes `expired` truthfully. A CAPTURED
 *   intent is NEVER swept (docs/35 §5.4 — the guard that makes late
 *   success confirm instead of colliding with abandonment): captured money
 *   converges only through the W5-4 saga (confirm or compensation).
 */
export interface PaidCheckoutSweepDeps {
  db: Db;
  provider: PaymentProviderPort;
}

export interface LapsedCheckoutSweepSummary {
  examined: number;
  woundDown: number;
}

export async function sweepLapsedPaidCheckouts(
  deps: PaidCheckoutSweepDeps,
  options: { limit?: number } = {},
): Promise<LapsedCheckoutSweepSummary> {
  const limit = options.limit ?? 20;
  const bookingCandidates = await deps.db
    .selectFrom('payment_intent as i')
    .innerJoin('capacity_hold as h', 'h.id', 'i.hold_id')
    .select(['i.id'])
    .where('i.state', 'in', ['created', 'in_progress'])
    .where((eb) =>
      eb.or([
        eb('h.state', '!=', 'active'),
        eb('h.expires_at', '<=', eb.fn<Date>('now', [])),
      ]),
    )
    .orderBy('i.created_at', 'asc')
    .orderBy('i.id', 'asc')
    .limit(limit)
    .execute();
  let woundDown = 0;
  for (const candidate of bookingCandidates) {
    const result = await windDownIntent(deps.db, deps.provider, candidate.id, 'holdExpired');
    if (result) woundDown += 1;
  }

  // Purchase trail: capture-less lapsed purchase checkouts only.
  const purchaseCandidates = await sql<{ id: string; purchase_id: string }>`
    SELECT i.id, i.purchase_id FROM payment_intent i
    JOIN entitlement_purchase p ON p.id = i.purchase_id
    WHERE i.state IN ('created', 'in_progress')
      AND (p.expires_at <= now() OR p.state NOT IN ('pending_payment', 'payment_failed'))
      AND NOT EXISTS (
        SELECT 1 FROM payment_transaction t
        JOIN payment_attempt a ON a.id = t.attempt_id
        WHERE a.intent_id = i.id AND t.kind = 'capture')
    ORDER BY i.created_at ASC, i.id ASC LIMIT ${limit}`.execute(deps.db);
  for (const candidate of purchaseCandidates.rows) {
    const wound = await windDownIntent(
      deps.db,
      deps.provider,
      candidate.id,
      'purchaseExpired',
    );
    if (wound) {
      woundDown += 1;
      await deps.db.transaction().execute(async (trx) => {
        const moved = await trx
          .updateTable('entitlement_purchase')
          .set({ state: 'expired' })
          .where('id', '=', candidate.purchase_id)
          .where('state', 'in', ['pending_payment', 'payment_failed'])
          .executeTakeFirst();
        if ((moved.numUpdatedRows ?? 0n) > 0n) {
          await appendAuditEvent(trx, {
            actorType: 'system',
            action: 'entitlement.purchase.expired',
            entityType: 'entitlement_purchase',
            entityId: candidate.purchase_id,
          });
          await appendOutboxEvent(trx, {
            aggregateType: 'entitlement_purchase',
            aggregateId: candidate.purchase_id,
            eventType: 'entitlement.purchase.expired',
            payload: { purchaseId: candidate.purchase_id, state: 'expired' },
          });
        }
      });
    }
  }
  return {
    examined: bookingCandidates.length + purchaseCandidates.rows.length,
    woundDown,
  };
}

/**
 * The dead-checkout wind-down core (D-W5-5 Option-A primitive): the intent
 * ends truthfully (`expired`), the working attempt records the abandonment
 * with a bounded failure code, and the provider session is BEST-EFFORT
 * expired — correctness NEVER depends on that network call (a completion
 * that slips through is exactly the W5-4 compensation case). Inventory and
 * purchase state stay with their certified owners.
 */
async function windDownIntent(
  db: Db,
  provider: PaymentProviderPort,
  intentId: string,
  failureCode: 'holdExpired' | 'purchaseExpired',
): Promise<boolean> {
  const gatewayRefs: string[] = [];
  let intentMoved = false;
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
          .set({ state: 'errored', failure_code: failureCode })
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
      intentMoved = true;
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
  return intentMoved;
}
