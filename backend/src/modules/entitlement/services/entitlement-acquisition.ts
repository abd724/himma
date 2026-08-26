/**
 * S6-1 — entitlement acquisition boundaries (docs/35 §5).
 *
 * TWO acquisition paths, ONE grant authority (`grantEntitlement`):
 *
 * - **Zero-price** (`confirmFreeEntitlementPurchase`, docs/35 §5.5 /
 *   Correction B): the non-payment analogue of the certified §7.3 rule.
 *   ONE idempotent transaction validates the fresh authoritative
 *   `entitlementAcquisition` quote (total EXACTLY zero), the participant,
 *   and the immutable revision, then creates the Purchase directly AS
 *   `confirmed` plus its one Entitlement. NO PaymentIntent, NO gateway
 *   call, NO transaction/economics row, and NO observable zero-price
 *   `pending_payment` exists — zero money never enters the payment stack
 *   (the certified 0015 zero-total trigger independently refuses it).
 *
 * - **Trusted paid seam** (`confirmPaidEntitlementPurchase`, docs/35 §5.4):
 *   the EntitlementPurchase analogue of `confirmPaidBooking` — invoked
 *   ONLY by the W5-4 saga after verified capture evidence + provider
 *   corroboration; never imported by any `http/` module (source-locked
 *   beside the Booking seam). Binding rule: payment success never grants
 *   permission to violate an entitlement-domain invariant. CONFIRM iff the
 *   purchase is non-terminal, reciprocal intent↔purchase identity holds,
 *   and the participant target is still valid — a past `expires_at` on a
 *   still-pending purchase CONFIRMS (abandonment metadata, no inventory
 *   race); a TERMINAL purchase, archived/detached participant, target
 *   mismatch, or lapsed fixed-date product REFUSES typed → the saga
 *   composes the existing W5 compensation machinery (no entitlement, no
 *   settleable commission).
 *
 * One quote → at most one Purchase → at most one Entitlement, ever:
 * `uq_entitlement_purchase_quote` + `uq_entitlement_purchase` are the
 * structural authorities (Correction B2 — double-click, concurrency, and
 * free/paid cross-path attempts all die on them or replay their snapshot).
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { DbError } from '../../../db/errors';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import type { Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { CustomerActor } from '../../booking/services/booking-shared';
import {
  fulfillmentLapsed,
  generatePurchaseReferenceCode,
  grantEntitlement,
  loadFulfillmentContext,
  type EntitlementPurchaseView,
  type EntitlementServiceDeps,
  type EntitlementView,
} from './entitlement-shared';

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

interface PurchaseRow {
  id: string;
  account_id: string;
  participant_id: string;
  organization_id: string;
  program_id: string;
  price_option_id: string;
  offer_id: string | null;
  quote_id: string;
  fulfillment_revision_id: string;
  state: string;
  reference_code: string | null;
  expires_at: Date;
  confirmed_at: Date | null;
  created_at: Date;
  version: number;
}

const PURCHASE_COLUMNS = [
  'id',
  'account_id',
  'participant_id',
  'organization_id',
  'program_id',
  'price_option_id',
  'offer_id',
  'quote_id',
  'fulfillment_revision_id',
  'state',
  'reference_code',
  'expires_at',
  'confirmed_at',
  'created_at',
  'version',
] as const;

async function purchaseView(
  db: Trx,
  purchase: PurchaseRow,
  entitlement?: EntitlementView,
): Promise<EntitlementPurchaseView> {
  const quote = await db
    .selectFrom('price_quote')
    .select(['total_fils'])
    .where('id', '=', purchase.quote_id)
    .executeTakeFirstOrThrow();
  return {
    purchaseId: purchase.id,
    referenceCode: purchase.reference_code,
    state: purchase.state,
    programId: purchase.program_id,
    organizationId: purchase.organization_id,
    participantId: purchase.participant_id,
    totalFils: Number(quote.total_fils),
    currency: 'AED',
    createdAt: purchase.created_at.toISOString(),
    confirmedAt: purchase.confirmed_at?.toISOString() ?? null,
    ...(entitlement !== undefined ? { entitlement } : {}),
  };
}

// ---------------------------------------------------------------------------
// Zero-price acquisition — docs/35 §5.5 (customer-facing boundary)
// ---------------------------------------------------------------------------

export type ConfirmFreeEntitlementPurchaseResult =
  | { kind: 'purchaseConfirmed'; purchase: EntitlementPurchaseView }
  | { kind: 'quoteNotFound' }
  | { kind: 'quoteNotAcquisition' }
  | { kind: 'quoteExpired' }
  | { kind: 'notFreeQuote' }
  | { kind: 'participantNotFound' }
  | { kind: 'fulfillmentUnavailable' }
  /** The quote already produced its one Purchase (any path, any state). */
  | { kind: 'quoteAlreadyUsed' }
  | { kind: 'idempotencyConflict' };

export interface ConfirmFreeEntitlementPurchaseRun {
  replayed: boolean;
  outcome: ConfirmFreeEntitlementPurchaseResult;
}

const CONFIRM_FREE_SCOPE = 'entitlement.confirm.free';

export async function confirmFreeEntitlementPurchase(
  deps: EntitlementServiceDeps,
  actor: CustomerActor,
  input: { quoteId: string; idempotencyKey: string },
): Promise<ConfirmFreeEntitlementPurchaseRun> {
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: CONFIRM_FREE_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ quoteId: input.quoteId }),
  };
  let run;
  try {
    run = await runIdempotent<ConfirmFreeEntitlementPurchaseResult>(
      deps.db,
      ctx,
      async (trx) => {
        const quote = await sql<{
          id: string;
          account_id: string;
          participant_id: string;
          organization_id: string;
          program_id: string;
          price_option_id: string | null;
          offer_id: string | null;
          fulfillment_revision_id: string | null;
          commercial_shape: string;
          total_fils: string | number | bigint;
          lapsed: boolean;
        }>`
          SELECT id, account_id, participant_id, organization_id, program_id,
                 price_option_id, offer_id, fulfillment_revision_id, commercial_shape,
                 total_fils, (expires_at <= now()) AS lapsed
          FROM price_quote WHERE id = ${input.quoteId}`.execute(trx);
        const q = quote.rows[0];
        if (q === undefined || q.account_id !== actor.accountId) {
          return { kind: 'quoteNotFound' };
        }
        if (q.commercial_shape !== 'entitlementAcquisition') {
          return { kind: 'quoteNotAcquisition' };
        }
        if (q.lapsed) return { kind: 'quoteExpired' };
        if (Number(q.total_fils) !== 0) return { kind: 'notFreeQuote' };

        const participant = await trx
          .selectFrom('participant')
          .select('id')
          .where('id', '=', q.participant_id)
          .where('account_id', '=', actor.accountId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (participant === undefined) return { kind: 'participantNotFound' };

        const context = await loadFulfillmentContext(
          trx,
          q.price_option_id!,
          q.fulfillment_revision_id!,
        );
        if (context === undefined || (await fulfillmentLapsed(trx, context.revision))) {
          return { kind: 'fulfillmentUnavailable' };
        }

        // One quote → one Purchase (the pre-read is advisory-fast; the
        // AUTHORITY is uq_entitlement_purchase_quote below).
        const existing = await trx
          .selectFrom('entitlement_purchase')
          .select('id')
          .where('quote_id', '=', q.id)
          .executeTakeFirst();
        if (existing !== undefined) return { kind: 'quoteAlreadyUsed' };

        // Created atomically AS confirmed (Correction B): no zero-price
        // pending_payment exists, not even transiently on the wire.
        const purchaseId = newId();
        const referenceCode = generatePurchaseReferenceCode();
        await sql`
          INSERT INTO entitlement_purchase
            (id, account_id, participant_id, organization_id, program_id,
             price_option_id, offer_id, quote_id, fulfillment_revision_id,
             state, reference_code, expires_at, confirmed_at)
          VALUES (${purchaseId}, ${q.account_id}, ${q.participant_id},
                  ${q.organization_id}, ${q.program_id}, ${q.price_option_id},
                  ${q.offer_id}, ${q.id}, ${q.fulfillment_revision_id},
                  'confirmed', ${referenceCode}, now(), now())`.execute(trx);
        deps.onAcquirePhase?.('purchaseInserted');

        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.accountId,
          principalContext: 'customer',
          action: 'entitlement.purchase.created',
          entityType: 'entitlement_purchase',
          entityId: purchaseId,
        });
        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: actor.accountId,
          principalContext: 'customer',
          action: 'entitlement.purchase.confirmed',
          entityType: 'entitlement_purchase',
          entityId: purchaseId,
        });
        await appendOutboxEvent(trx, {
          aggregateType: 'entitlement_purchase',
          aggregateId: purchaseId,
          eventType: 'entitlement.purchase.confirmed',
          payload: {
            purchaseId,
            quoteId: q.id,
            organizationId: q.organization_id,
            state: 'confirmed',
            acquisition: 'free',
          },
        });

        const purchase = await trx
          .selectFrom('entitlement_purchase')
          .select(PURCHASE_COLUMNS)
          .where('id', '=', purchaseId)
          .executeTakeFirstOrThrow();
        const entitlement = await grantEntitlement(
          trx,
          { ...purchase, confirmed_at: purchase.confirmed_at! },
          context,
          { type: 'user', accountId: actor.accountId },
        );
        deps.onAcquirePhase?.('entitlementInserted');
        const view = await purchaseView(trx, purchase as PurchaseRow, entitlement);
        deps.onAcquirePhase?.('beforeCommit');
        return { kind: 'purchaseConfirmed', purchase: view };
      },
    );
  } catch (error) {
    // Two concurrent free confirmations (different keys) on one quote: the
    // loser dies on the quote uniqueness and its ENTIRE transaction rolls
    // back — one Purchase, one Entitlement, ever.
    if (
      error instanceof DbError &&
      error.kind === 'uniqueViolation' &&
      error.constraint === 'uq_entitlement_purchase_quote'
    ) {
      return { replayed: false, outcome: { kind: 'quoteAlreadyUsed' } };
    }
    throw error;
  }
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}

// ---------------------------------------------------------------------------
// Trusted paid-confirmation seam — docs/35 §5.4 (W5-4 saga ONLY)
// ---------------------------------------------------------------------------

export interface ConfirmPaidEntitlementPurchaseDeps extends EntitlementServiceDeps {
  /** The W5-4 §7.4b-analogue atomicity seam: joins THIS transaction only
   *  after the grant has fully succeeded; a throw rolls back everything
   *  (purchase, entitlement, events) with an unpoisoned key. */
  paidSettlement?: (trx: Trx, confirmed: { purchaseId: string }) => Promise<void>;
}

export interface ConfirmPaidEntitlementPurchaseInput {
  purchaseId: string;
  /** The saga's intent — reciprocal identity is re-proven inside. */
  intentId: string;
  idempotencyKey: string;
}

export type ConfirmPaidEntitlementPurchaseResult =
  | { kind: 'purchaseConfirmed'; purchase: EntitlementPurchaseView }
  | { kind: 'alreadyConfirmed' }
  | { kind: 'purchaseNotFound' }
  | { kind: 'reciprocalMismatch' }
  /** Terminal purchase (swept `expired`, or `compensated`): never
   *  resurrected — the saga compensates the captured money. */
  | { kind: 'purchaseTerminal'; state: string }
  /** The participant target is no longer valid under canonical acquisition
   *  rules (archived / detached) — refuse → compensation. */
  | { kind: 'participantInvalid' }
  /** The fixed-date product lapsed before trusted success — the immutable
   *  terms can no longer produce a valid entitlement → compensation. */
  | { kind: 'fulfillmentLapsed' }
  | { kind: 'notPaidQuote' }
  | { kind: 'idempotencyConflict' };

export interface ConfirmPaidEntitlementPurchaseRun {
  replayed: boolean;
  outcome: ConfirmPaidEntitlementPurchaseResult;
}

const CONFIRM_PAID_SCOPE = 'entitlement.confirm.paid';

export async function confirmPaidEntitlementPurchase(
  deps: ConfirmPaidEntitlementPurchaseDeps,
  input: ConfirmPaidEntitlementPurchaseInput,
): Promise<ConfirmPaidEntitlementPurchaseRun> {
  const ctx = {
    principalRef: 'system:payments',
    endpointScope: CONFIRM_PAID_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ purchaseId: input.purchaseId, intentId: input.intentId }),
  };
  const run = await runIdempotent<ConfirmPaidEntitlementPurchaseResult>(
    deps.db,
    ctx,
    async (trx) => {
      // The entitlement lock IS the purchase-row lock here (the §7 canonical
      // hierarchy: no unit/hold/credential participates in acquisition).
      const locked = await sql<PurchaseRow>`
        SELECT ${sql.join(PURCHASE_COLUMNS.map((column) => sql.id(column)))}
        FROM entitlement_purchase WHERE id = ${input.purchaseId} FOR UPDATE`.execute(trx);
      const purchase = locked.rows[0];
      if (purchase === undefined) return { kind: 'purchaseNotFound' };

      // Reciprocal identity: the trusted evidence names an intent — it must
      // be THIS purchase's intent on THIS purchase's quote (composite-FK
      // guaranteed; re-proven caller-side like confirmPaidBooking).
      const intent = await trx
        .selectFrom('payment_intent')
        .select(['id', 'purchase_id', 'quote_id', 'account_id'])
        .where('id', '=', input.intentId)
        .executeTakeFirst();
      if (
        intent === undefined ||
        intent.purchase_id !== purchase.id ||
        intent.quote_id !== purchase.quote_id ||
        intent.account_id !== purchase.account_id
      ) {
        return { kind: 'reciprocalMismatch' };
      }

      if (purchase.state === 'confirmed') return { kind: 'alreadyConfirmed' };
      if (purchase.state === 'expired' || purchase.state === 'compensated') {
        return { kind: 'purchaseTerminal', state: purchase.state };
      }

      // A zero-total quote can never reach this seam (no intent can exist
      // for it) — fail closed anyway, symmetrically with the Booking seam.
      const quoteTotal = await trx
        .selectFrom('price_quote')
        .select('total_fils')
        .where('id', '=', purchase.quote_id)
        .executeTakeFirstOrThrow();
      if (Number(quoteTotal.total_fils) === 0) return { kind: 'notPaidQuote' };

      // §5.4 CONFIRM set: participant still valid under canonical rules.
      const participant = await trx
        .selectFrom('participant')
        .select('id')
        .where('id', '=', purchase.participant_id)
        .where('account_id', '=', purchase.account_id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (participant === undefined) return { kind: 'participantInvalid' };

      const context = await loadFulfillmentContext(
        trx,
        purchase.price_option_id,
        purchase.fulfillment_revision_id,
      );
      if (context === undefined) return { kind: 'fulfillmentLapsed' }; // structurally impossible
      if (await fulfillmentLapsed(trx, context.revision)) {
        return { kind: 'fulfillmentLapsed' };
      }

      // Late success on a STILL-PENDING purchase confirms even past
      // expires_at — the window is abandonment metadata, not inventory
      // (docs/35 §5.4); terminal purchases were refused above.
      const referenceCode = generatePurchaseReferenceCode();
      const confirmed = await sql<{ confirmed_at: Date }>`
        UPDATE entitlement_purchase
        SET state = 'confirmed', reference_code = ${referenceCode}, confirmed_at = now()
        WHERE id = ${purchase.id} AND state IN ('pending_payment', 'payment_failed')
        RETURNING confirmed_at`.execute(trx);
      if (confirmed.rows.length !== 1) {
        throw new Error(`entitlement_purchase ${purchase.id} confirm CAS lost under lock`);
      }
      const confirmedAt = confirmed.rows[0]!.confirmed_at;

      await appendAuditEvent(trx, {
        actorType: 'system',
        principalContext: 'system',
        action: 'entitlement.purchase.confirmed',
        entityType: 'entitlement_purchase',
        entityId: purchase.id,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'entitlement_purchase',
        aggregateId: purchase.id,
        eventType: 'entitlement.purchase.confirmed',
        payload: {
          purchaseId: purchase.id,
          quoteId: purchase.quote_id,
          organizationId: purchase.organization_id,
          state: 'confirmed',
          acquisition: 'paid',
        },
      });

      const entitlement = await grantEntitlement(
        trx,
        { ...purchase, confirmed_at: confirmedAt },
        context,
        { type: 'system' },
      );
      deps.onAcquirePhase?.('entitlementInserted');

      // W5-4 atomicity seam: the payment-domain settlement (capture posting,
      // attempt capture, intent success) commits WITH the grant or not at all.
      if (deps.paidSettlement !== undefined) {
        await deps.paidSettlement(trx, { purchaseId: purchase.id });
      }
      const view = await purchaseView(
        trx,
        { ...purchase, state: 'confirmed', reference_code: referenceCode, confirmed_at: confirmedAt },
        entitlement,
      );
      deps.onAcquirePhase?.('beforeCommit');
      return { kind: 'purchaseConfirmed', purchase: view };
    },
  );
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}

// ---------------------------------------------------------------------------
// Own-purchase read (customer-safe; cross-account not-found-shaped)
// ---------------------------------------------------------------------------

export type GetEntitlementPurchaseResult =
  | { kind: 'purchase'; purchase: EntitlementPurchaseView }
  | { kind: 'purchaseNotFound' };

export async function getEntitlementPurchase(
  deps: EntitlementServiceDeps,
  actor: CustomerActor,
  input: { purchaseId: string },
): Promise<GetEntitlementPurchaseResult> {
  return await deps.db.transaction().execute(async (trx) => {
    const purchase = await trx
      .selectFrom('entitlement_purchase')
      .select(PURCHASE_COLUMNS)
      .where('id', '=', input.purchaseId)
      .where('account_id', '=', actor.accountId)
      .executeTakeFirst();
    if (purchase === undefined) return { kind: 'purchaseNotFound' as const };
    let entitlement: EntitlementView | undefined;
    const grant = await trx
      .selectFrom('entitlement')
      .select([
        'id',
        'usage_kind',
        'uses_total',
        'valid_from',
        'valid_until',
        'reservation_required',
        'walk_in_allowed',
      ])
      .where('purchase_id', '=', purchase.id)
      .executeTakeFirst();
    if (grant !== undefined) {
      entitlement = {
        entitlementId: grant.id,
        usageKind: grant.usage_kind as 'finite' | 'unlimited',
        ...(grant.uses_total !== null ? { usesTotal: Number(grant.uses_total) } : {}),
        validFrom: grant.valid_from.toISOString(),
        ...(grant.valid_until !== null
          ? { validUntil: grant.valid_until.toISOString() }
          : {}),
        reservationRequired: grant.reservation_required,
        walkInAllowed: grant.walk_in_allowed,
      };
    }
    return {
      kind: 'purchase' as const,
      purchase: await purchaseView(trx, purchase as PurchaseRow, entitlement),
    };
  });
}
