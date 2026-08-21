/**
 * Booking domain — S5-3 (docs/24 §3.4, §5.6, §7.1/§7.3/§7.4; docs/32 §6;
 * owner rulings D-2, D-4, D-7, D-8).
 *
 * TWO fundamentally different paths, one inventory authority:
 *
 * - **Initiation** (`initiateBooking`, the §7.4a shape MINUS the
 *   PaymentIntent insert — that insert is the payment slice's first move):
 *   creates exactly ONE Booking in `pending_payment` on an ACTIVE hold and
 *   deliberately does NOT consume it — the S5-1-pinned legitimate
 *   intermediate state. The seat stays in `held_count`; `booked_count` is
 *   untouched; the hold TTL remains the universal backstop that unwinds
 *   unpaid rests.
 *
 * - **Confirmation** (`confirmFreeBooking` for zero-price quotes per §7.3;
 *   `confirmPaidBooking` as the TRUSTED INTERNAL seam the payments slice
 *   will call on verified capture evidence per §7.4b): ONE transaction in
 *   the certified lock order (idempotency-key → unit FOR UPDATE → hold FOR
 *   UPDATE → booking FOR UPDATE) that verifies reciprocal hold↔booking
 *   identity, fails CLOSED on the D-8 policy seam BEFORE any mutation, then
 *   atomically: hold `active → consumed` + `consumed_by_booking_id`,
 *   `held_count`−1 + `booked_count`+1 in one statement (occupied inventory
 *   constant — no committed state ever double- or zero-counts the seat),
 *   booking → `confirmed` with the write-once reference code + policy
 *   snapshot + `confirmed_at`, the D-4 Enrolment row for cohort
 *   monthly/term bookings, audit + outbox. Free bookings get NO capacity
 *   shortcut: zero-price rides the identical consumption transaction.
 *
 * RECIPROCAL IDENTITY (hard acceptance invariant): consumption happens only
 * for the hold that `booking.hold_id` names, and `consumed_by_booking_id`
 * is set to that same booking in the same CAS — a service can never consume
 * Hold A with Booking B; the paid seam additionally cross-checks its caller-
 * supplied holdId against `booking.hold_id` and refuses on mismatch.
 *
 * The paid seam trusts its CALLER (the future payment slice's saga step,
 * running on verified gateway evidence). It takes identifiers + versions +
 * an idempotency key only — no gateway talk, no payment-success state is
 * invented here, and NO HTTP route exposes it (S5-3 ships no routes at all;
 * the S5-5 customer API must never mount it).
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import type { Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import {
  dbActivePolicyTemplateProvider,
  lockHold,
  lockUnitRow,
  readHold,
  settleHold,
  unitSpec,
  unitRefOf,
  applyCounterDelta,
  type BookingServiceDeps,
  type CustomerActor,
  type LockedUnitRow,
  type UnitRef,
} from './booking-shared';

// ---------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------

interface BookingRow {
  id: string;
  account_id: string;
  participant_id: string;
  program_id: string;
  organization_id: string;
  branch_id: string;
  option_kind: string;
  session_id: string | null;
  camp_week_id: string | null;
  cohort_id: string | null;
  quote_id: string;
  hold_id: string;
  state: string;
  reference_code: string | null;
  version: number;
}

const BOOKING_COLUMNS = [
  'id',
  'account_id',
  'participant_id',
  'program_id',
  'organization_id',
  'branch_id',
  'option_kind',
  'session_id',
  'camp_week_id',
  'cohort_id',
  'quote_id',
  'hold_id',
  'state',
  'reference_code',
  'version',
] as const;

function bookingUnitRef(booking: BookingRow): UnitRef {
  const kind =
    booking.session_id !== null
      ? ('session' as const)
      : booking.camp_week_id !== null
        ? ('campWeek' as const)
        : ('enrolmentCohort' as const);
  return { kind, id: (booking.session_id ?? booking.camp_week_id ?? booking.cohort_id)! };
}

/** Customer-facing reference code (docs/24 §6.12): random, non-enumerable,
 *  unambiguous alphabet, DB-unique. */
export function generateReferenceCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `HM-${code}`;
}

export interface PendingBookingView {
  bookingId: string;
  state: 'pending_payment';
  holdId: string;
  quoteId: string;
  unitKind: UnitRef['kind'];
  unitId: string;
  participantId: string;
  holdExpiresAt: string; // ISO
}

export interface ConfirmedBookingView {
  bookingId: string;
  state: 'confirmed';
  referenceCode: string;
  holdId: string;
  unitKind: UnitRef['kind'];
  unitId: string;
  participantId: string;
  policyTemplateId: string;
  confirmedAt: string; // ISO
  enrolmentCreated: boolean;
}

// ---------------------------------------------------------------------------
// Paid/free initiation — §7.4a minus PaymentIntent
// ---------------------------------------------------------------------------

export interface InitiateBookingInput {
  holdId: string;
  /** Must be the quote the hold was claimed with (the money that was shown). */
  quoteId: string;
  idempotencyKey: string;
}

export type InitiateBookingResult =
  | { kind: 'bookingPending'; booking: PendingBookingView }
  | { kind: 'holdNotFound' }
  | { kind: 'holdNotActive'; state: 'consumed' | 'expired' | 'released' }
  /** The hold had lapsed — settled as expiry in this boundary (§7.2). */
  | { kind: 'holdExpired' }
  | { kind: 'quoteMismatch' }
  /** Zero-total quote: `pending_payment` is RESERVED for bookings that
   *  actually require the later payment boundary — free/trial intents ride
   *  `confirmFreeBooking` (S5-3 owner probe invariant). */
  | { kind: 'paymentNotRequired' }
  | { kind: 'alreadyBooked' }
  | { kind: 'idempotencyConflict' };

export interface InitiateBookingRun {
  replayed: boolean;
  outcome: InitiateBookingResult;
}

const INITIATE_SCOPE = 'booking.initiate';

export async function initiateBooking(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: InitiateBookingInput,
): Promise<InitiateBookingRun> {
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: INITIATE_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ holdId: input.holdId, quoteId: input.quoteId }),
  };
  const run = await runIdempotent<InitiateBookingResult>(deps.db, ctx, async (trx) => {
    const preread = await readHold(trx, input.holdId);
    if (preread === undefined || preread.account_id !== actor.accountId) {
      return { kind: 'holdNotFound' };
    }
    const unit = unitRefOf(preread);
    const spec = unitSpec(unit.kind);
    const lockedUnit = await lockUnitRow(trx, unit);
    if (lockedUnit === undefined) return { kind: 'holdNotFound' };
    const hold = await lockHold(trx, input.holdId);

    if (hold.state !== 'active') {
      return {
        kind: 'holdNotActive',
        state: hold.state as 'consumed' | 'expired' | 'released',
      };
    }
    if (hold.quote_id !== input.quoteId) return { kind: 'quoteMismatch' };
    // The paid/free boundary (owner probe invariant): a zero-total quote has
    // no payment to await, so it may never rest at `pending_payment` —
    // refused BEFORE any booking insert/audit; hold, counters, and quote
    // untouched. Free/trial intents confirm through §7.3 instead.
    if ((await quoteTotal(trx, hold.quote_id)) === 0) {
      return { kind: 'paymentNotRequired' };
    }
    if (hold.expires_at <= lockedUnit.db_now) {
      // Lapsed under the lock: settle truthfully instead of building a
      // Booking on a dead hold (§7.2 recognized at the mutation boundary).
      await settleHold(trx, unit, hold, 'expired', { type: 'system' });
      return { kind: 'holdExpired' };
    }
    const liveBooking = await trx
      .selectFrom('booking')
      .select('id')
      .where(spec.holdColumn, '=', unit.id)
      .where('participant_id', '=', hold.participant_id)
      .where('state', 'in', ['pending_payment', 'confirmed'])
      .executeTakeFirst();
    if (liveBooking !== undefined) return { kind: 'alreadyBooked' };

    const quote = await trx
      .selectFrom('price_quote')
      .select(['option_kind'])
      .where('id', '=', hold.quote_id)
      .executeTakeFirstOrThrow();

    // Exactly ONE Booking, binding the hold's purchaser + participant + unit
    // (D-2: purchaser and participant distinct; the composite FKs re-verify
    // every binding structurally). The hold stays ACTIVE; counters untouched.
    const bookingId = newId();
    await sql`
      INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                           branch_id, option_kind, ${sql.id(spec.holdColumn)}, quote_id, hold_id)
      VALUES (${bookingId}, ${hold.account_id}, ${hold.participant_id},
              ${lockedUnit.program_id}, ${lockedUnit.organization_id}, ${lockedUnit.branch_id},
              ${quote.option_kind}, ${unit.id}, ${hold.quote_id}, ${hold.id})`.execute(trx);

    // Audit-only: the §7.1 outbox record for this checkout phase is the
    // already-emitted hold.created; booking.confirmed is the next outbox
    // event (docs/32 §17 canonical set — reconciled, no duplicate emission).
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.accountId,
      principalContext: 'customer',
      action: 'booking.created',
      entityType: 'booking',
      entityId: bookingId,
    });

    return {
      kind: 'bookingPending',
      booking: {
        bookingId,
        state: 'pending_payment',
        holdId: hold.id,
        quoteId: hold.quote_id,
        unitKind: unit.kind,
        unitId: unit.id,
        participantId: hold.participant_id,
        holdExpiresAt: hold.expires_at.toISOString(),
      },
    };
  });
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}

// ---------------------------------------------------------------------------
// Confirmation core — §7.3 / §7.4b shape
// ---------------------------------------------------------------------------

type ConfirmCoreResult =
  | { kind: 'bookingConfirmed'; booking: ConfirmedBookingView }
  | { kind: 'alreadyConfirmed' }
  | { kind: 'invalidBookingState'; state: string }
  | { kind: 'holdNotActive'; state: 'expired' | 'released' }
  | { kind: 'holdExpired' }
  | { kind: 'policyUnavailable' }
  | { kind: 'reciprocalMismatch' };

/**
 * The atomic consumption+confirmation core, run under the caller's already-
 * open idempotent transaction. Precondition: NOTHING is locked yet — this
 * function acquires unit → hold → booking in the certified order.
 */
async function confirmCore(
  deps: BookingServiceDeps,
  trx: Trx,
  booking: BookingRow,
  eventActor: { type: 'user'; accountId: string } | { type: 'system' },
): Promise<ConfirmCoreResult> {
  const unit = bookingUnitRef(booking);
  const lockedUnit = (await lockUnitRow(trx, unit)) as LockedUnitRow; // FK guarantees existence
  const hold = await lockHold(trx, booking.hold_id);
  deps.onConfirmPhase?.('holdLocked');
  const lockedBooking = await sql<{ state: string; version: number }>`
    SELECT state, version FROM booking WHERE id = ${booking.id} FOR UPDATE`.execute(trx);
  const bookingState = lockedBooking.rows[0]!.state;

  if (bookingState === 'confirmed') return { kind: 'alreadyConfirmed' };
  if (bookingState !== 'pending_payment') {
    return { kind: 'invalidBookingState', state: bookingState };
  }
  if (hold.state === 'consumed') {
    // A consumed hold under a still-pending booking would mean a foreign
    // confirmation path — structurally excluded, but fail closed anyway.
    return { kind: 'reciprocalMismatch' };
  }
  if (hold.state !== 'active') {
    return { kind: 'holdNotActive', state: hold.state as 'expired' | 'released' };
  }
  if (hold.expires_at <= lockedUnit.db_now) {
    // Expiry wins truthfully: settle (unwinds THIS booking to `expired`)
    // and refuse — a booking never confirms on a lapsed hold, and the seat
    // never moves into booked_count.
    await settleHold(trx, unit, hold, 'expired', { type: 'system' });
    return { kind: 'holdExpired' };
  }

  // Reciprocal identity (hard invariant): the hold being consumed IS the
  // booking's hold, on the SAME unit, owned by the SAME purchaser +
  // participant as the original claim.
  const holdUnit = unitRefOf(hold);
  if (
    hold.id !== booking.hold_id ||
    holdUnit.kind !== unit.kind ||
    holdUnit.id !== unit.id ||
    hold.account_id !== booking.account_id ||
    hold.participant_id !== booking.participant_id
  ) {
    return { kind: 'reciprocalMismatch' };
  }

  // D-8 fail-close BEFORE any mutation: no policy template → no consumption,
  // no counter movement, no confirmation, no enrolment.
  const provider = deps.policyProvider ?? dbActivePolicyTemplateProvider;
  const policy = await provider.resolveActiveTemplate(trx);
  if (policy === undefined) return { kind: 'policyUnavailable' };

  const consumed = await trx
    .updateTable('capacity_hold')
    .set({ state: 'consumed', consumed_by_booking_id: booking.id })
    .where('id', '=', hold.id)
    .where('state', '=', 'active')
    .executeTakeFirst();
  if (consumed.numUpdatedRows !== 1n) {
    throw new Error(`capacity_hold ${hold.id} consume CAS lost under unit lock — impossible`);
  }
  deps.onConfirmPhase?.('holdConsumed');

  // The seat moves counters in ONE statement: held−1, booked+1 — occupied
  // inventory constant, the CHECK holds throughout.
  await applyCounterDelta(trx, unit, { held: -1, booked: 1 });
  deps.onConfirmPhase?.('counterMoved');

  const referenceCode = generateReferenceCode();
  const confirmedRow = await sql<{ confirmed_at: Date }>`
    UPDATE booking
    SET state = 'confirmed', reference_code = ${referenceCode},
        policy_template_id = ${policy.templateId}, confirmed_at = now()
    WHERE id = ${booking.id} AND state = 'pending_payment'
    RETURNING confirmed_at`.execute(trx);
  if (confirmedRow.rows.length !== 1) {
    throw new Error(`booking ${booking.id} confirm CAS lost under unit lock — impossible`);
  }
  deps.onConfirmPhase?.('bookingConfirmed');

  // D-4: cohort monthly/term participation gains its Enrolment subtype row
  // atomically — participation only, never billing.
  let enrolmentCreated = false;
  if (unit.kind === 'enrolmentCohort' && (booking.option_kind === 'monthly' || booking.option_kind === 'term')) {
    await trx
      .insertInto('enrolment')
      .values({
        booking_id: booking.id,
        cohort_id: unit.id,
        cadence: booking.option_kind,
      })
      .execute();
    enrolmentCreated = true;
    await appendAuditEvent(trx, {
      actorType: eventActor.type === 'user' ? 'user' : 'system',
      ...(eventActor.type === 'user' ? { actorId: eventActor.accountId } : {}),
      principalContext: eventActor.type === 'user' ? 'customer' : 'system',
      action: 'enrolment.created',
      entityType: 'enrolment',
      entityId: booking.id,
    });
  }
  deps.onConfirmPhase?.('enrolmentInserted');

  await appendAuditEvent(trx, {
    actorType: eventActor.type === 'user' ? 'user' : 'system',
    ...(eventActor.type === 'user' ? { actorId: eventActor.accountId } : {}),
    principalContext: eventActor.type === 'user' ? 'customer' : 'system',
    action: 'hold.consumed',
    entityType: 'capacity_hold',
    entityId: hold.id,
  });
  await appendAuditEvent(trx, {
    actorType: eventActor.type === 'user' ? 'user' : 'system',
    ...(eventActor.type === 'user' ? { actorId: eventActor.accountId } : {}),
    principalContext: eventActor.type === 'user' ? 'customer' : 'system',
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: booking.id,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'booking',
    aggregateId: booking.id,
    eventType: 'booking.confirmed',
    payload: {
      bookingId: booking.id,
      holdId: hold.id,
      unitKind: unit.kind,
      unitId: unit.id,
      organizationId: booking.organization_id,
      state: 'confirmed',
    },
  });
  deps.onConfirmPhase?.('beforeCommit');

  return {
    kind: 'bookingConfirmed',
    booking: {
      bookingId: booking.id,
      state: 'confirmed',
      referenceCode,
      holdId: hold.id,
      unitKind: unit.kind,
      unitId: unit.id,
      participantId: booking.participant_id,
      policyTemplateId: policy.templateId,
      confirmedAt: confirmedRow.rows[0]!.confirmed_at.toISOString(),
      enrolmentCreated,
    },
  };
}

async function readBooking(trx: Trx, bookingId: string): Promise<BookingRow | undefined> {
  return trx
    .selectFrom('booking')
    .select(BOOKING_COLUMNS)
    .where('id', '=', bookingId)
    .executeTakeFirst();
}

async function quoteTotal(trx: Trx, quoteId: string): Promise<number> {
  const row = await trx
    .selectFrom('price_quote')
    .select('total_fils')
    .where('id', '=', quoteId)
    .executeTakeFirstOrThrow();
  return Number(row.total_fils);
}

// ---------------------------------------------------------------------------
// Free-booking confirmation — §7.3 (customer-facing service)
// ---------------------------------------------------------------------------

export type ConfirmFreeBookingResult =
  | ConfirmCoreResult
  | { kind: 'holdNotFound' }
  | { kind: 'notFreeQuote' }
  | { kind: 'alreadyBooked' }
  | { kind: 'idempotencyConflict' };

export interface ConfirmFreeBookingRun {
  replayed: boolean;
  outcome: ConfirmFreeBookingResult;
}

const CONFIRM_FREE_SCOPE = 'booking.confirm.free';

/**
 * The §7.3 free/trial boundary — creation AND confirmation in ONE
 * transaction. Because `pending_payment` is reserved for bookings that
 * actually await the payment boundary (`initiateBooking` refuses zero-total
 * quotes with `paymentNotRequired`), the zero-price Booking is inserted and
 * confirmed HERE atomically: no committed state ever holds a zero-price
 * Booking at `pending_payment`, so none can strand there. Same inventory
 * authority as the paid path — the hold is consumed through the identical
 * core, no capacity shortcut.
 */
export async function confirmFreeBooking(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: { holdId: string; idempotencyKey: string },
): Promise<ConfirmFreeBookingRun> {
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: CONFIRM_FREE_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ holdId: input.holdId }),
  };
  const run = await runIdempotent<ConfirmFreeBookingResult>(deps.db, ctx, async (trx) => {
    const preread = await readHold(trx, input.holdId);
    if (preread === undefined || preread.account_id !== actor.accountId) {
      return { kind: 'holdNotFound' };
    }
    // §7.3 precondition: this path exists ONLY for a zero-total quote — a
    // paid intent can never confirm here, whatever the client claims.
    if ((await quoteTotal(trx, preread.quote_id)) !== 0) return { kind: 'notFreeQuote' };

    const unit = unitRefOf(preread);
    const spec = unitSpec(unit.kind);
    const lockedUnit = await lockUnitRow(trx, unit);
    if (lockedUnit === undefined) return { kind: 'holdNotFound' };
    const hold = await lockHold(trx, input.holdId);

    // A consumed hold means this free intent already confirmed (a fresh key
    // against a finished operation); expired/released holds are dead.
    if (hold.state === 'consumed') return { kind: 'alreadyConfirmed' };
    if (hold.state !== 'active') {
      return { kind: 'holdNotActive', state: hold.state as 'expired' | 'released' };
    }
    if (hold.expires_at <= lockedUnit.db_now) {
      await settleHold(trx, unit, hold, 'expired', { type: 'system' });
      return { kind: 'holdExpired' };
    }
    const liveBooking = await trx
      .selectFrom('booking')
      .select('id')
      .where(spec.holdColumn, '=', unit.id)
      .where('participant_id', '=', hold.participant_id)
      .where('state', 'in', ['pending_payment', 'confirmed'])
      .executeTakeFirst();
    if (liveBooking !== undefined) return { kind: 'alreadyBooked' };

    // D-8 fail-close BEFORE the booking insert — a missing policy template
    // must leave NO booking row of any kind behind.
    const provider = deps.policyProvider ?? dbActivePolicyTemplateProvider;
    if ((await provider.resolveActiveTemplate(trx)) === undefined) {
      return { kind: 'policyUnavailable' };
    }

    const quote = await trx
      .selectFrom('price_quote')
      .select('option_kind')
      .where('id', '=', hold.quote_id)
      .executeTakeFirstOrThrow();
    const bookingId = newId();
    await sql`
      INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                           branch_id, option_kind, ${sql.id(spec.holdColumn)}, quote_id, hold_id)
      VALUES (${bookingId}, ${hold.account_id}, ${hold.participant_id},
              ${lockedUnit.program_id}, ${lockedUnit.organization_id}, ${lockedUnit.branch_id},
              ${quote.option_kind}, ${unit.id}, ${hold.quote_id}, ${hold.id})`.execute(trx);
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.accountId,
      principalContext: 'customer',
      action: 'booking.created',
      entityType: 'booking',
      entityId: bookingId,
    });
    const booking = await readBooking(trx, bookingId);
    return confirmCore(deps, trx, booking!, { type: 'user', accountId: actor.accountId });
  });
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}

// ---------------------------------------------------------------------------
// Trusted paid-confirmation seam — §7.4b shape (INTERNAL; payments slice only)
// ---------------------------------------------------------------------------

export interface ConfirmPaidBookingInput {
  bookingId: string;
  /** Cross-check against booking.hold_id — reciprocal identity, caller-side. */
  holdId: string;
  idempotencyKey: string;
  /** Optional optimistic guard on the booking row (docs/24 §6.11). */
  expectedVersion?: number;
}

export type ConfirmPaidBookingResult =
  | ConfirmCoreResult
  | { kind: 'bookingNotFound' }
  | { kind: 'notPaidQuote' }
  | { kind: 'staleVersion'; currentVersion: number }
  | { kind: 'idempotencyConflict' };

export interface ConfirmPaidBookingRun {
  replayed: boolean;
  outcome: ConfirmPaidBookingResult;
}

const CONFIRM_PAID_SCOPE = 'booking.confirm.paid';

/**
 * TRUSTED INTERNAL SEAM — docs/32 §2/§6 payment boundary. The future
 * payments slice invokes this inside its §8.5 saga step AFTER verified
 * capture evidence exists (webhook/synchronous confirmation, stored first).
 * It accepts trusted identifiers + version + idempotency key ONLY: no
 * gateway interaction, no payment state, no client-claimable "payment
 * succeeded" input exists here, and no HTTP route may ever mount it for
 * production clients. If the hold lapsed before this transaction, it
 * refuses — the §8.6 reversal path (payments slice) compensates the charge;
 * nothing here resurrects an expired or released hold.
 */
export async function confirmPaidBooking(
  deps: BookingServiceDeps,
  input: ConfirmPaidBookingInput,
): Promise<ConfirmPaidBookingRun> {
  const ctx = {
    principalRef: 'system:payments',
    endpointScope: CONFIRM_PAID_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      bookingId: input.bookingId,
      holdId: input.holdId,
      expectedVersion: input.expectedVersion ?? null,
    }),
  };
  const run = await runIdempotent<ConfirmPaidBookingResult>(deps.db, ctx, async (trx) => {
    const booking = await readBooking(trx, input.bookingId);
    if (booking === undefined) return { kind: 'bookingNotFound' };
    // Reciprocal identity, caller side: the payment evidence names a hold —
    // it must be exactly the booking's hold. Booking B can never consume
    // Hold A.
    if (booking.hold_id !== input.holdId) return { kind: 'reciprocalMismatch' };
    if (input.expectedVersion !== undefined && input.expectedVersion !== booking.version) {
      return { kind: 'staleVersion', currentVersion: booking.version };
    }
    // A zero-total quote has no payment to confirm — that is §7.3's path.
    if ((await quoteTotal(trx, booking.quote_id)) === 0) return { kind: 'notPaidQuote' };
    return confirmCore(deps, trx, booking, { type: 'system' });
  });
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}

