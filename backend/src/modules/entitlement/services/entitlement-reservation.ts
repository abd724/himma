/**
 * S6-3 — the operational Entitlement reservation authority (docs/35 §7;
 * owner items 2–10, 30–32).
 *
 * Activates the structure S6-0/S6-1/S6-2 deliberately left unavailable:
 *
 * - `requestEntitlementReservationQuote` — the `entitlementReservation`
 *   quote (Correction A/A1/A2): zero-total, bound to the EXACT purchased
 *   Entitlement (the five-column ownership FK), its account, participant,
 *   provider organization, Program, and ONE canonical Session occurrence.
 *   Eligibility derives from the PURCHASED immutable terms frozen on the
 *   entitlement row + its fulfillment-revision schedule snapshot — never
 *   the provider's currently-active product configuration. Quote-time
 *   `availableToReserve` is an advisory projection (the D-10 precedent);
 *   confirmation is the atomic authority.
 *
 * - `confirmEntitlementReservation` — the dedicated confirmation boundary
 *   (Correction A3): accepts ONLY an `entitlementReservation` quote with
 *   its live matching hold, reuses the certified S5 `confirmCore`
 *   (idempotency → unit → hold → booking locks, hold consumption, counter
 *   movement, policy snapshot), then takes the Entitlement lock LAST,
 *   recomputes the finite commitment state in a FRESH statement after lock
 *   acquisition (READ COMMITTED — a waiter observes the prior holder's
 *   committed reservation), verifies `availableToReserve > 0`, and only
 *   then inserts the ONE `entitlement_reservation` commitment. A refusal
 *   at the Entitlement rolls the provisional Booking/capacity effects back
 *   ATOMICALLY (sentinel throw — the idempotent transaction never commits
 *   a refused reservation's capacity mutations).
 *
 * No PaymentIntent, no Stripe, no commission event, no AttendanceRecord,
 * and no usage consumption exist anywhere on this path — a reservation
 * COMMITS a use; only successful attendance consumes one (V1 no-show
 * consumes nothing and is derived, docs/35 §7 Correction C).
 *
 * V1 unit scope: Session occurrences only — the entitlement product forms
 * (package visit / membership visit) map to single class occurrences.
 * CampWeek/EnrolmentCohort units are refused typed (`occurrenceNotEligible`)
 * — consistent with the recorded S6-2 occurrence gate.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import { withTransaction, type Trx } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import {
  confirmCore,
  readBooking,
  type ConfirmCoreResult,
} from '../../booking/services/booking-lifecycle';
import type { BookingServiceDeps } from '../../booking/services/booking-shared';
import type { EntitlementServiceDeps } from './entitlement-shared';

const DEFAULT_QUOTE_TTL_SECONDS = 900;

export type ReservationDeps = EntitlementServiceDeps & {
  /** Passed through to the certified S5 confirmation core (policy seam +
   *  failure injection); never a second capacity implementation. */
  policyProvider?: BookingServiceDeps['policyProvider'];
  onConfirmPhase?: BookingServiceDeps['onConfirmPhase'];
  /** TEST-ONLY failure injection at named reservation points. */
  onReservePhase?: (phase: 'bookingConfirmed' | 'entitlementLocked' | 'commitmentInserted') => void;
};

// ---------------------------------------------------------------------------
// Finite commitment truth (docs/35 §7 vocabulary — all DERIVED)
// ---------------------------------------------------------------------------

export interface FiniteCommitmentCounts {
  used: number;
  reservedUpcoming: number;
}

/**
 * The authoritative finite commitment query. `used` = consuming attendance
 * rows; `reservedUpcoming` = commitments on a confirmed Booking whose
 * Session occurrence has not concluded and that no attendance fulfilled.
 * A fulfilled reservation moves from the reserved-count into the used-count
 * atomically by the attendance INSERT itself; a concluded no-show drops out
 * derivationally (consuming nothing in V1). Callers needing the ATOMIC
 * truth must run this AFTER acquiring the entitlement row lock.
 */
export async function finiteCommitmentCounts(
  trx: Trx,
  entitlementId: string,
): Promise<FiniteCommitmentCounts> {
  const row = await sql<{ used: string; reserved: string }>`
    SELECT
      (SELECT count(*) FROM attendance_record
        WHERE entitlement_id = ${entitlementId}) AS used,
      (SELECT count(*) FROM entitlement_reservation er
         JOIN booking b ON b.id = er.booking_id
         JOIN session s ON s.id = b.session_id
        WHERE er.entitlement_id = ${entitlementId}
          AND b.state = 'confirmed'
          AND s.end_at > now()
          AND NOT EXISTS (SELECT 1 FROM attendance_record ar
                           WHERE ar.booking_id = er.booking_id)) AS reserved`.execute(trx);
  return {
    used: Number(row.rows[0]!.used),
    reservedUpcoming: Number(row.rows[0]!.reserved),
  };
}

export interface FiniteProjection {
  usesTotal: number;
  used: number;
  remaining: number;
  reservedUpcoming: number;
  availableToReserve: number;
}

export function finiteProjection(
  usesTotal: number,
  counts: FiniteCommitmentCounts,
): FiniteProjection {
  return {
    usesTotal,
    used: counts.used,
    remaining: Math.max(0, usesTotal - counts.used),
    reservedUpcoming: counts.reservedUpcoming,
    availableToReserve: Math.max(0, usesTotal - counts.used - counts.reservedUpcoming),
  };
}

// ---------------------------------------------------------------------------
// Reservation quote
// ---------------------------------------------------------------------------

export interface ReservationQuoteView {
  quoteId: string;
  entitlementId: string;
  programId: string;
  organizationId: string;
  participantId: string;
  sessionId: string;
  totalFils: 0;
  currency: 'AED';
  expiresAt: string; // ISO
  /** ADVISORY projection at quote time (finite only) — confirmation is the
   *  atomic authority. */
  finite?: FiniteProjection;
}

export type ReservationQuoteResult =
  | { kind: 'quoteIssued'; quote: ReservationQuoteView }
  | { kind: 'entitlementNotFound' }
  | { kind: 'entitlementNotActive' }
  | { kind: 'entitlementExhausted' }
  /** Every remaining finite use is committed to other upcoming
   *  reservations — advisory here, authoritative at confirmation. */
  | { kind: 'entitlementFullyCommitted' }
  /** The purchased terms do not permit reservation (walk-in-only product). */
  | { kind: 'reservationNotPermitted' }
  /** The occurrence is not usable by THIS entitlement's purchased terms
   *  (lineage/branch/schedule/temporal), or is not a Session occurrence. */
  | { kind: 'occurrenceNotEligible' }
  /** RECORDED S6-3 gap (STOP-before-migration honored): 0013's
   *  `ck_booking_option_kind` predates the `membership` kind, so a
   *  membership-kind reservation Booking cannot be REPRESENTED until the
   *  owner approves the one-line widening (the exact 0019 pattern that
   *  fixed `ck_program_revision_option_kind`). Package reservations are
   *  fully operational; membership walk-in/calendar/passes are unaffected. */
  | { kind: 'membershipReservationUnavailable' }
  | { kind: 'participantIneligible' };

/** Full years between date of birth and the occurrence start (UTC civil —
 *  the certified S5-5 rule, applied identically). */
function ageAtDate(dateOfBirth: Date, at: Date): number {
  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

interface EntitlementRow {
  id: string;
  account_id: string;
  participant_id: string;
  organization_id: string;
  program_id: string;
  price_option_id: string;
  fulfillment_revision_id: string;
  usage_kind: 'finite' | 'unlimited';
  uses_total: number | null;
  valid_from: Date;
  valid_until: Date | null;
  reservation_required: boolean;
  branch_id: string | null;
  active_now: boolean;
}

async function readOwnEntitlement(
  trx: Trx,
  accountId: string,
  entitlementId: string,
): Promise<EntitlementRow | undefined> {
  const rows = await sql<EntitlementRow>`
    SELECT id, account_id, participant_id, organization_id, program_id,
           price_option_id, fulfillment_revision_id, usage_kind, uses_total,
           valid_from, valid_until, reservation_required, branch_id,
           (now() >= valid_from AND (valid_until IS NULL OR now() < valid_until)) AS active_now
    FROM entitlement WHERE id = ${entitlementId}`.execute(trx);
  const row = rows.rows[0];
  // Cross-account entitlement ids stay NOT-FOUND-shaped (owner item 3).
  if (row === undefined || row.account_id !== accountId) return undefined;
  return row;
}

export async function requestEntitlementReservationQuote(
  deps: ReservationDeps,
  actor: { accountId: string },
  input: { entitlementId: string; sessionId: string },
): Promise<ReservationQuoteResult> {
  const ttlSeconds = deps.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  return withTransaction(deps.db, async (trx) => {
    const entitlement = await readOwnEntitlement(trx, actor.accountId, input.entitlementId);
    if (entitlement === undefined) return { kind: 'entitlementNotFound' as const };
    if (!entitlement.active_now) return { kind: 'entitlementNotActive' as const };
    // Purchased-snapshot permission (docs/35 §38): reservation exists only
    // where the PURCHASED terms require it; walk-in-only products do not
    // reserve. The provider's current active revision is never consulted.
    if (!entitlement.reservation_required) return { kind: 'reservationNotPermitted' as const };

    // The occurrence: a real Session of the SAME Program, permitted by the
    // purchased branch limitation and (where schedule-bound) the immutable
    // schedule snapshot, starting in the future and inside validity.
    const sessionRows = await sql<{
      id: string;
      program_id: string;
      organization_id: string;
      branch_id: string;
      start_at: Date;
      state: string;
      override_min_age: number | null;
      override_max_age: number | null;
      override_all_ages: boolean | null;
      has_terms: boolean;
      matches_terms: boolean;
    }>`
      SELECT s.id, s.program_id, s.organization_id, s.branch_id, s.start_at, s.state,
             s.override_min_age, s.override_max_age, s.override_all_ages,
             EXISTS (SELECT 1 FROM price_option_fulfillment_schedule_term t
                      WHERE t.revision_id = ${entitlement.fulfillment_revision_id}) AS has_terms,
             EXISTS (SELECT 1 FROM price_option_fulfillment_schedule_term t
                      WHERE t.revision_id = ${entitlement.fulfillment_revision_id}
                        AND t.weekday = EXTRACT(DOW FROM (s.start_at AT TIME ZONE 'Asia/Dubai'))::int
                        AND (s.start_at AT TIME ZONE 'Asia/Dubai')::time >= t.start_time
                        AND (s.start_at AT TIME ZONE 'Asia/Dubai')::time <  t.end_time) AS matches_terms
      FROM session s WHERE s.id = ${input.sessionId}`.execute(trx);
    const session = sessionRows.rows[0];
    if (
      session === undefined ||
      session.program_id !== entitlement.program_id ||
      session.organization_id !== entitlement.organization_id
    ) {
      // An entitlement can never reserve another Program's Session — the
      // refusal is occurrence-shaped, revealing nothing about the foreign
      // session (owner item 29).
      return { kind: 'occurrenceNotEligible' as const };
    }
    if (entitlement.branch_id !== null && session.branch_id !== entitlement.branch_id) {
      return { kind: 'occurrenceNotEligible' as const };
    }
    if (session.has_terms && !session.matches_terms) {
      return { kind: 'occurrenceNotEligible' as const };
    }
    const now = new Date();
    if (session.start_at <= now) return { kind: 'occurrenceNotEligible' as const };
    if (entitlement.valid_until !== null && session.start_at >= entitlement.valid_until) {
      // The use would occur outside the purchased validity — truthfully
      // refused now rather than at the door.
      return { kind: 'occurrenceNotEligible' as const };
    }
    if (session.state === 'cancelled_by_provider' || session.state === 'completed') {
      return { kind: 'occurrenceNotEligible' as const };
    }

    // Certified participant eligibility (the exact S5-5 age rule) — the
    // beneficiary is the ENTITLEMENT's participant, never caller-chosen.
    const participant = await trx
      .selectFrom('participant')
      .select(['kind', 'date_of_birth'])
      .where('id', '=', entitlement.participant_id)
      .where('account_id', '=', actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (participant === undefined) return { kind: 'entitlementNotFound' as const };
    if (participant.kind === 'child') {
      const program = await trx
        .selectFrom('program')
        .select(['min_age', 'max_age', 'all_ages'])
        .where('id', '=', entitlement.program_id)
        .executeTakeFirstOrThrow();
      const allAges = session.override_all_ages ?? program.all_ages;
      if (!allAges) {
        const minAge = session.override_min_age ?? program.min_age;
        const maxAge = session.override_max_age ?? program.max_age;
        if (minAge !== null || maxAge !== null) {
          if (participant.date_of_birth === null) {
            return { kind: 'participantIneligible' as const };
          }
          const age = ageAtDate(participant.date_of_birth, session.start_at);
          if ((minAge !== null && age < minAge) || (maxAge !== null && age > maxAge)) {
            return { kind: 'participantIneligible' as const };
          }
        }
      }
    }

    // Finite advisory projection (quote-time; the D-10 advisory precedent —
    // the atomic authority is confirmation under the entitlement lock).
    let finite: FiniteProjection | undefined;
    if (entitlement.uses_total !== null) {
      const counts = await finiteCommitmentCounts(trx, entitlement.id);
      finite = finiteProjection(entitlement.uses_total, counts);
      if (counts.used >= entitlement.uses_total) {
        return { kind: 'entitlementExhausted' as const };
      }
      if (finite.availableToReserve <= 0) {
        return { kind: 'entitlementFullyCommitted' as const };
      }
    }

    const optionKind = await trx
      .selectFrom('program_price_option')
      .select('kind')
      .where('id', '=', entitlement.price_option_id)
      .executeTakeFirstOrThrow();
    // Recorded gap (see the result type): the reservation BOOKING could not
    // carry `option_kind = 'membership'` past 0013's CHECK — refuse typed
    // instead of 500ing at confirmation; migration awaits the owner.
    if (optionKind.kind === 'membership') {
      return { kind: 'membershipReservationUnavailable' as const };
    }

    const quoteId = newId();
    const inserted = await sql<{ expires_at: Date }>`
      INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                               option_kind, price_option_id, session_id, commercial_shape,
                               entitlement_id, total_fils, price_kind, expires_at)
      VALUES (${quoteId}, ${entitlement.organization_id}, ${entitlement.program_id},
              ${actor.accountId}, ${entitlement.participant_id}, ${optionKind.kind},
              ${entitlement.price_option_id}, ${session.id}, 'entitlementReservation',
              ${entitlement.id}, 0, 'oneOff',
              now() + make_interval(secs => ${ttlSeconds}))
      RETURNING expires_at`.execute(trx);
    await sql`
      INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
      VALUES (${newId()}, ${quoteId}, 1, 'base', 'Included with your pass', 0)`.execute(trx);
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.accountId,
      principalContext: 'customer',
      action: 'quote.created',
      entityType: 'price_quote',
      entityId: quoteId,
    });

    return {
      kind: 'quoteIssued' as const,
      quote: {
        quoteId,
        entitlementId: entitlement.id,
        programId: entitlement.program_id,
        organizationId: entitlement.organization_id,
        participantId: entitlement.participant_id,
        sessionId: session.id,
        totalFils: 0,
        currency: 'AED',
        expiresAt: inserted.rows[0]!.expires_at.toISOString(),
        ...(finite !== undefined ? { finite } : {}),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Reservation confirmation — the atomic commitment authority
// ---------------------------------------------------------------------------

export interface ReservationView {
  bookingId: string;
  referenceCode: string;
  state: 'confirmed';
  entitlementId: string;
  sessionId: string;
  participantId: string;
  confirmedAt: string; // ISO
  /** Post-commit finite truth (finite entitlements only). */
  finite?: FiniteProjection;
}

export type ConfirmReservationResult =
  | { kind: 'reservationConfirmed'; reservation: ReservationView }
  | { kind: 'holdNotFound' }
  | { kind: 'notReservationQuote' }
  | { kind: 'alreadyBooked' }
  | { kind: 'entitlementNotActive' }
  | { kind: 'entitlementExhausted' }
  | { kind: 'entitlementFullyCommitted' }
  | { kind: 'idempotencyConflict' }
  | Exclude<ConfirmCoreResult, { kind: 'bookingConfirmed' }>;

export interface ConfirmReservationRun {
  replayed: boolean;
  outcome: ConfirmReservationResult;
}

const CONFIRM_RESERVATION_SCOPE = 'entitlement.reservation.confirm';

/** Sentinel: an entitlement-level refusal AFTER provisional capacity
 *  mutations — the whole transaction (booking, counters, hold consumption,
 *  idempotency row) must roll back atomically. */
class ReservationRefusal extends Error {
  constructor(
    readonly refusal: 'entitlementNotActive' | 'entitlementExhausted' | 'entitlementFullyCommitted',
  ) {
    super(`reservation refused: ${refusal}`);
  }
}

export async function confirmEntitlementReservation(
  deps: ReservationDeps,
  actor: { accountId: string },
  input: { holdId: string; idempotencyKey: string },
): Promise<ConfirmReservationRun> {
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: CONFIRM_RESERVATION_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ holdId: input.holdId }),
  };
  const coreDeps: BookingServiceDeps = {
    db: deps.db,
    ...(deps.policyProvider !== undefined ? { policyProvider: deps.policyProvider } : {}),
    ...(deps.onConfirmPhase !== undefined ? { onConfirmPhase: deps.onConfirmPhase } : {}),
  };
  let run;
  try {
    run = await runIdempotent<ConfirmReservationResult>(deps.db, ctx, async (trx) => {
      const hold = await trx
        .selectFrom('capacity_hold')
        .select(['id', 'account_id', 'participant_id', 'quote_id', 'session_id', 'state'])
        .where('id', '=', input.holdId)
        .executeTakeFirst();
      if (hold === undefined || hold.account_id !== actor.accountId) {
        return { kind: 'holdNotFound' };
      }
      // This boundary accepts ONLY the reservation shape — a capacity or
      // acquisition quote can never enter (Correction A4; proofs 14–15).
      const quote = await sql<{
        commercial_shape: string;
        entitlement_id: string | null;
        session_id: string | null;
        account_id: string;
        participant_id: string;
      }>`
        SELECT commercial_shape, entitlement_id, session_id, account_id, participant_id
        FROM price_quote WHERE id = ${hold.quote_id}`.execute(trx);
      const quoteRow = quote.rows[0]!;
      if (
        quoteRow.commercial_shape !== 'entitlementReservation' ||
        quoteRow.entitlement_id === null ||
        quoteRow.session_id === null ||
        quoteRow.account_id !== actor.accountId
      ) {
        return { kind: 'notReservationQuote' };
      }
      const entitlementId = quoteRow.entitlement_id;
      const sessionId = quoteRow.session_id;

      // Duplicate-live-booking check (the certified free-confirm rule).
      const liveBooking = await trx
        .selectFrom('booking')
        .select('id')
        .where('session_id', '=', sessionId)
        .where('participant_id', '=', hold.participant_id)
        .where('state', 'in', ['pending_payment', 'confirmed'])
        .executeTakeFirst();
      if (liveBooking !== undefined) return { kind: 'alreadyBooked' };

      // The provisional Booking + the certified confirmation core
      // (key → unit → hold → booking locks; hold consumption; counters;
      // policy snapshot). Everything it does is provisional until the
      // Entitlement authority below holds.
      const session = await trx
        .selectFrom('session')
        .select(['program_id', 'organization_id', 'branch_id'])
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow();
      const optionKind = await sql<{ option_kind: string }>`
        SELECT option_kind FROM price_quote WHERE id = ${hold.quote_id}`.execute(trx);
      const bookingId = newId();
      await sql`
        INSERT INTO booking (id, account_id, participant_id, program_id, organization_id,
                             branch_id, option_kind, session_id, quote_id, hold_id)
        VALUES (${bookingId}, ${hold.account_id}, ${hold.participant_id},
                ${session.program_id}, ${session.organization_id}, ${session.branch_id},
                ${optionKind.rows[0]!.option_kind}, ${sessionId}, ${hold.quote_id},
                ${hold.id})`.execute(trx);
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.accountId,
        principalContext: 'customer',
        action: 'booking.created',
        entityType: 'booking',
        entityId: bookingId,
      });
      const bookingRow = await readBooking(trx, bookingId);
      const core = await confirmCore(coreDeps, trx, bookingRow!, {
        type: 'user',
        accountId: actor.accountId,
      });
      if (core.kind !== 'bookingConfirmed') return core;
      deps.onReservePhase?.('bookingConfirmed');

      // Entitlement lock LAST (the canonical hierarchy: key → unit → hold
      // → booking → [credential] → entitlement).
      const locked = await sql<{
        uses_total: number | null;
        reservation_required: boolean;
        active_now: boolean;
        participant_id: string;
      }>`
        SELECT uses_total, reservation_required, participant_id,
               (now() >= valid_from AND (valid_until IS NULL OR now() < valid_until))
                 AS active_now
        FROM entitlement WHERE id = ${entitlementId}
        FOR UPDATE`.execute(trx);
      const entitlement = locked.rows[0]!; // FK-pinned by the quote
      deps.onReservePhase?.('entitlementLocked');
      if (!entitlement.active_now || !entitlement.reservation_required) {
        throw new ReservationRefusal('entitlementNotActive');
      }

      // FRESH post-lock commitment recount — a NEW statement after the lock
      // was actually acquired (READ COMMITTED: a waiter sees the previous
      // holder's committed reservation; never a pre-wait snapshot).
      let finite: FiniteProjection | undefined;
      if (entitlement.uses_total !== null) {
        const counts = await finiteCommitmentCounts(trx, entitlementId);
        if (counts.used >= entitlement.uses_total) {
          throw new ReservationRefusal('entitlementExhausted');
        }
        if (entitlement.uses_total - counts.used - counts.reservedUpcoming <= 0) {
          throw new ReservationRefusal('entitlementFullyCommitted');
        }
        finite = finiteProjection(entitlement.uses_total, {
          used: counts.used,
          reservedUpcoming: counts.reservedUpcoming + 1,
        });
      }

      // The ONE commitment — inserted while the Entitlement lock is HELD.
      await sql`
        INSERT INTO entitlement_reservation (booking_id, entitlement_id, account_id,
                                             participant_id, organization_id, program_id)
        VALUES (${bookingId}, ${entitlementId}, ${hold.account_id},
                ${entitlement.participant_id}, ${session.organization_id},
                ${session.program_id})`.execute(trx);
      deps.onReservePhase?.('commitmentInserted');
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.accountId,
        principalContext: 'customer',
        action: 'entitlement.reservation.created',
        entityType: 'entitlement_reservation',
        entityId: bookingId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'entitlement_reservation',
        aggregateId: bookingId,
        eventType: 'entitlement.reservation.created',
        payload: {
          bookingId,
          entitlementId,
          sessionId,
          organizationId: session.organization_id,
        },
      });

      return {
        kind: 'reservationConfirmed',
        reservation: {
          bookingId,
          referenceCode: core.booking.referenceCode,
          state: 'confirmed',
          entitlementId,
          sessionId,
          participantId: entitlement.participant_id,
          confirmedAt: core.booking.confirmedAt,
          ...(finite !== undefined ? { finite } : {}),
        },
      };
    });
  } catch (error) {
    if (error instanceof ReservationRefusal) {
      // The ENTIRE provisional transaction (booking, counters, hold
      // consumption, idempotency row) rolled back — the hold is still live
      // and the refusal is truthful.
      return { replayed: false, outcome: { kind: error.refusal } };
    }
    throw error;
  }
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}
