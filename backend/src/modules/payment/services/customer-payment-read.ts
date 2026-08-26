/**
 * W5-5 — the customer-safe converged payment/Booking status projection
 * (docs/33 §15 "converged-state read"; docs/24 §8.7/§10 — a browser return
 * is NEVER evidence of payment, so the return/deep-link landing only READS
 * this projection).
 *
 * PURE READ: no mutation, no provider network call, no audit/outbox
 * emission. Truth is composed from the durable domain state only — the
 * Booking machine (frozen Slice 5), the PaymentIntent machine, the
 * append-only ledger, and the durable W5-3 gateway-event work items. The
 * wire carries a SMALL CLOSED machine vocabulary — never PaymentIntent/
 * Attempt state names, never counters, never gateway internals, never
 * commission economics (D-W5-7 terms are internal commercial data):
 *
 *   awaitingPayment      the checkout window is open (booking rests
 *                        `pending_payment` on an effectively live hold);
 *                        `holdExpiresAt` is the HIMMA hold authority
 *                        (D-W5-5: ten minutes — never the hosted session's
 *                        ~30-minute-plus lifetime).
 *   processing           trusted success evidence exists but the W5-3/W5-4
 *                        resolution has not settled yet — truthful "payment
 *                        received, confirming" (docs/24 §8.7). Never claims
 *                        a confirmed booking.
 *   confirmed            the Booking is confirmed (referenceCode present).
 *   expired              the checkout window closed without success — the
 *                        effective-hold projection convention (S5-5 owner
 *                        probe): a lapsed hold reads expired immediately,
 *                        settlement stays with the certified S5-2 authority.
 *   compensationPending  money was captured but the Booking can no longer
 *                        confirm (D-W5-4): the same-amount reversal is still
 *                        being executed. NEVER projected as confirmed.
 *   compensated          the compensation reversal is posted.
 *
 * `compensationPending`/`compensated` are the smallest typed machine states
 * for the owner's D-W5-4 vocabulary; approved customer-facing COPY for them
 * is a recorded W1 frontend requirement — this projection deliberately
 * ships machine states, not prose.
 */
import { withTransaction } from '../../../db/transaction';
import type { Db } from '../../../db/kysely';

export interface CustomerPaymentReadDeps {
  db: Db;
}

export type CustomerPaymentStatusName =
  | 'awaitingPayment'
  | 'processing'
  | 'confirmed'
  | 'expired'
  | 'compensationPending'
  | 'compensated';

export interface CustomerPaymentStatusView {
  status: CustomerPaymentStatusName;
  /** Present ONLY for `awaitingPayment` — the Himma hold expiry (D-W5-5). */
  holdExpiresAt?: string;
  /** Present ONLY for `confirmed`. */
  referenceCode?: string;
}

export type CustomerPaymentStatusResult =
  | { kind: 'paymentStatus'; payment: CustomerPaymentStatusView }
  | { kind: 'bookingNotFound' };

/** The W5-3 trusted success work-item types (mirrors the saga's input set). */
const SUCCESS_EVENT_TYPES = ['checkout.completed', 'payment.captured'];

export async function customerPaymentStatus(
  deps: CustomerPaymentReadDeps,
  actor: { accountId: string },
  input: { bookingId: string },
): Promise<CustomerPaymentStatusResult> {
  return withTransaction(deps.db, async (trx) => {
    const booking = await trx
      .selectFrom('booking')
      .select(['id', 'state', 'reference_code', 'hold_id'])
      .where('id', '=', input.bookingId)
      .where('account_id', '=', actor.accountId)
      .executeTakeFirst();
    if (booking === undefined) return { kind: 'bookingNotFound' as const };

    if (booking.state === 'confirmed') {
      return {
        kind: 'paymentStatus' as const,
        payment: { status: 'confirmed' as const, referenceCode: booking.reference_code! },
      };
    }

    // The commercial intent for this Booking (one live / one succeeded by
    // structure; the newest row is the current commercial trail).
    const intent = await trx
      .selectFrom('payment_intent')
      .select(['id', 'state'])
      .where('booking_id', '=', booking.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (intent !== undefined) {
      // Ledger shape first (docs/24 §8.6): a capture on an unconfirmed
      // Booking IS the compensation obligation; its reversal completes it.
      const postings = await trx
        .selectFrom('payment_transaction as t')
        .innerJoin('payment_attempt as a', 'a.id', 't.attempt_id')
        .select(['t.kind'])
        .where('a.intent_id', '=', intent.id)
        .execute();
      const captured = postings.some((posting) => posting.kind === 'capture');
      if (captured) {
        const reversed = postings.some((posting) => posting.kind === 'reversal');
        return {
          kind: 'paymentStatus' as const,
          payment: {
            status: reversed ? ('compensated' as const) : ('compensationPending' as const),
          },
        };
      }

      // Durable trusted success evidence awaiting W5-3/W5-4 resolution.
      const evidence = await trx
        .selectFrom('gateway_event as e')
        .innerJoin('payment_attempt as a', 'a.id', 'e.attempt_id')
        .select(['e.id'])
        .where('a.intent_id', '=', intent.id)
        .where('e.event_type', 'in', SUCCESS_EVENT_TYPES)
        .where('e.processing_state', 'in', ['received', 'verified'])
        .limit(1)
        .executeTakeFirst();
      if (evidence !== undefined) {
        return { kind: 'paymentStatus' as const, payment: { status: 'processing' as const } };
      }

      if (intent.state !== 'created' && intent.state !== 'in_progress') {
        // Terminal without success/capture: the checkout window is over.
        return { kind: 'paymentStatus' as const, payment: { status: 'expired' as const } };
      }
    }

    // Open (or not-yet-created) commercial trail: the Himma hold is the
    // customer-facing authority — projected effectively (a lapsed hold
    // reads expired NOW; the S5-2 boundary settles it later).
    const hold = await trx
      .selectFrom('capacity_hold')
      .select(({ eb }) => ['state', 'expires_at', eb.fn<Date>('now', []).as('db_now')])
      .where('id', '=', booking.hold_id)
      .executeTakeFirstOrThrow();
    if (hold.state === 'active' && hold.expires_at > hold.db_now) {
      return {
        kind: 'paymentStatus' as const,
        payment: {
          status: 'awaitingPayment' as const,
          holdExpiresAt: hold.expires_at.toISOString(),
        },
      };
    }
    return { kind: 'paymentStatus' as const, payment: { status: 'expired' as const } };
  });
}

// ---------------------------------------------------------------------------
// Entitlement-purchase status — the SAME converged projection over the
// purchase commercial target (S6-1, docs/35 §5.3/§13): identical machine
// vocabulary, never a fake Booking id, never economics/gateway internals.
// `purchaseExpiresAt` is the abandonment window (commercial metadata only —
// a Purchase owns no inventory).
// ---------------------------------------------------------------------------

export interface CustomerPurchasePaymentStatusView {
  status: CustomerPaymentStatusName;
  /** Present ONLY for `awaitingPayment` — the purchase abandonment window. */
  purchaseExpiresAt?: string;
  /** Present ONLY for `confirmed`. */
  referenceCode?: string;
}

export type CustomerPurchasePaymentStatusResult =
  | { kind: 'paymentStatus'; payment: CustomerPurchasePaymentStatusView }
  | { kind: 'purchaseNotFound' };

export async function customerEntitlementPurchasePaymentStatus(
  deps: CustomerPaymentReadDeps,
  actor: { accountId: string },
  input: { purchaseId: string },
): Promise<CustomerPurchasePaymentStatusResult> {
  return withTransaction(deps.db, async (trx) => {
    const purchase = await trx
      .selectFrom('entitlement_purchase')
      .select(({ eb }) => [
        'id',
        'state',
        'reference_code',
        'expires_at',
        eb.fn<Date>('now', []).as('db_now'),
      ])
      .where('id', '=', input.purchaseId)
      .where('account_id', '=', actor.accountId)
      .executeTakeFirst();
    if (purchase === undefined) return { kind: 'purchaseNotFound' as const };

    if (purchase.state === 'confirmed') {
      return {
        kind: 'paymentStatus' as const,
        payment: { status: 'confirmed' as const, referenceCode: purchase.reference_code! },
      };
    }

    const intent = await trx
      .selectFrom('payment_intent')
      .select(['id', 'state'])
      .where('purchase_id', '=', purchase.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    if (intent !== undefined) {
      // Ledger shape first: a capture on an unconfirmed Purchase IS the
      // compensation obligation; its reversal completes it.
      const postings = await trx
        .selectFrom('payment_transaction as t')
        .innerJoin('payment_attempt as a', 'a.id', 't.attempt_id')
        .select(['t.kind'])
        .where('a.intent_id', '=', intent.id)
        .execute();
      const captured = postings.some((posting) => posting.kind === 'capture');
      if (captured) {
        const reversed = postings.some((posting) => posting.kind === 'reversal');
        return {
          kind: 'paymentStatus' as const,
          payment: {
            status: reversed ? ('compensated' as const) : ('compensationPending' as const),
          },
        };
      }

      const evidence = await trx
        .selectFrom('gateway_event as e')
        .innerJoin('payment_attempt as a', 'a.id', 'e.attempt_id')
        .select(['e.id'])
        .where('a.intent_id', '=', intent.id)
        .where('e.event_type', 'in', SUCCESS_EVENT_TYPES)
        .where('e.processing_state', 'in', ['received', 'verified'])
        .limit(1)
        .executeTakeFirst();
      if (evidence !== undefined) {
        return { kind: 'paymentStatus' as const, payment: { status: 'processing' as const } };
      }

      if (intent.state !== 'created' && intent.state !== 'in_progress') {
        return { kind: 'paymentStatus' as const, payment: { status: 'expired' as const } };
      }
    }

    if (purchase.state === 'compensated') {
      return { kind: 'paymentStatus' as const, payment: { status: 'compensated' as const } };
    }
    if (purchase.state === 'pending_payment' && purchase.expires_at > purchase.db_now) {
      return {
        kind: 'paymentStatus' as const,
        payment: {
          status: 'awaitingPayment' as const,
          purchaseExpiresAt: purchase.expires_at.toISOString(),
        },
      };
    }
    return { kind: 'paymentStatus' as const, payment: { status: 'expired' as const } };
  });
}
