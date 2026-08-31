/**
 * Customer-facing booking reads + the paid-checkout fail-closed boundary —
 * S5-5 (docs/32 §12; docs/21 §11 / docs/22 §11 vocabulary).
 *
 * Availability is DERIVED at read time from the authoritative unit
 * counters and never exposes them: the wire carries only the approved W1
 * projection `available | fewLeft(spotsLeft) | full | closed` — no
 * `held_count`, no `booked_count`, no lock/version mechanics, no other
 * customer's holds. Booking reads are account-scoped projections of the
 * customer's OWN bookings; foreign ids are not-found-shaped.
 *
 * Paid checkout (docs/32 §12 "paid handoff seam"): the genuine payment
 * orchestration is W5 authority and does not exist yet. The customer
 * boundary therefore FAILS CLOSED with typed `paymentUnavailable` BEFORE
 * any Booking is created — no customer can be stranded in
 * `pending_payment` with no way to pay, and no configuration flag can
 * fake payment readiness. The internal S5-3 `initiateBooking` service
 * stays available to the future trusted W5 orchestration only.
 */
import { sql } from 'kysely';

import { withTransaction } from '../../../db/transaction';
import { PLATFORM_TIMEZONE } from '../../../config/platform-timezone';
import {
  readHold,
  unitSpec,
  type BookingServiceDeps,
  type CustomerActor,
  type UnitKind,
  type UnitRef,
} from './booking-shared';

/** W1 display threshold (presentation config, docs/21 §11 `fewLeft`). */
export const FEW_LEFT_THRESHOLD = 3;

export interface AvailabilityView {
  unitId: string;
  kind: UnitKind;
  /** The unit's branch — public location identity (D-RI-4): every branch is
   *  already served on the public listing/storefront projections. */
  branchId: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  /** RI-6 — venue timezone (IANA) for truthful civil presentation. */
  timezone: string;
  registrationCutoffAt: string;
  availability: 'available' | 'fewLeft' | 'full' | 'closed';
  /** Present ONLY in the fewLeft band (derived, never a stored counter). */
  spotsLeft?: number;
}

export type ListAvailabilityResult =
  | { kind: 'availability'; units: AvailabilityView[] }
  | { kind: 'programNotFound' };

export async function listAvailability(
  deps: BookingServiceDeps,
  input: { programId: string; unitKind: UnitKind },
): Promise<ListAvailabilityResult> {
  const spec = unitSpec(input.unitKind);
  return withTransaction(deps.db, async (trx) => {
    const program = await trx
      .selectFrom('program')
      .select(['id', 'listing_state'])
      .where('id', '=', input.programId)
      .executeTakeFirst();
    if (program === undefined || program.listing_state !== 'published') {
      return { kind: 'programNotFound' as const };
    }
    const rows = await sql<{
      id: string;
      state: string;
      branch_id: string;
      capacity: number;
      booked_count: number;
      effective_held: string;
      cutoff_at: Date;
      lapsed: boolean;
      start_at: Date | null;
      end_at: Date | null;
      start_date: Date | null;
      end_date: Date | null;
      effective_start: Date | null;
      effective_end: Date | null;
    }>`
      SELECT u.id, u.state, u.branch_id, u.capacity, u.booked_count,
             -- EFFECTIVE domain truth (owner probe): a lapsed-but-unswept
             -- hold physically keeps state='active' and its held_count seat
             -- until an authoritative S5-2 boundary settles it, but it is no
             -- longer usable — the customer projection counts only ACTIVE,
             -- UNEXPIRED holds. Pure read: no mutation, no second expiry
             -- implementation; the claim path's certified reclamation frees
             -- the seat for real when someone takes it.
             (SELECT count(*) FROM capacity_hold h
               WHERE h.${sql.id(spec.holdColumn)} = u.id
                 AND h.state = 'active' AND h.expires_at > now()) AS effective_held,
             ${sql.id(spec.cutoffColumn)} AS cutoff_at,
             ${sql.id(spec.cutoffColumn)} <= now() AS lapsed,
             ${sql.raw(
               input.unitKind === 'session'
                 ? `start_at, end_at, NULL::date AS start_date, NULL::date AS end_date,
                    NULL::date AS effective_start, NULL::date AS effective_end`
                 : input.unitKind === 'campWeek'
                   ? `NULL::timestamptz AS start_at, NULL::timestamptz AS end_at,
                      start_date, end_date, NULL::date AS effective_start,
                      NULL::date AS effective_end`
                   : `NULL::timestamptz AS start_at, NULL::timestamptz AS end_at,
                      NULL::date AS start_date, NULL::date AS end_date,
                      effective_start, effective_end`,
             )}
      FROM ${sql.id(spec.table)} u
      WHERE u.program_id = ${input.programId}
        AND u.state IN ('scheduled', 'open', 'full', 'closed')
      ORDER BY ${sql.raw(
        input.unitKind === 'session'
          ? 'start_at'
          : input.unitKind === 'campWeek'
            ? 'start_date'
            : 'effective_start',
      )}`.execute(trx);

    // node-postgres parses a DATE as a JS Date at SERVER-LOCAL midnight;
    // formatting via toISOString() shifts the civil date a day back on any
    // UTC+ host. Local components ARE the civil date (RI-4 correction).
    const isoDate = (value: Date | null): string | null => civilDateString(value);
    const units = rows.rows.map((row): AvailabilityView => {
      // Derived truth only (docs/32 §12): effective availability is
      // capacity − booked − ACTIVE UNEXPIRED holds at read time; neither
      // the stored counters nor the projection internals reach the wire,
      // and a lapsed hold can never present a unit as full until a sweep.
      const remaining = Math.max(0, row.capacity - row.booked_count - Number(row.effective_held));
      const closed = row.state === 'scheduled' || row.state === 'closed' || row.lapsed;
      const availability = closed
        ? ('closed' as const)
        : remaining === 0
          ? ('full' as const)
          : remaining <= FEW_LEFT_THRESHOLD
            ? ('fewLeft' as const)
            : ('available' as const);
      return {
        unitId: row.id,
        kind: input.unitKind,
        branchId: row.branch_id,
        startAt: row.start_at === null ? null : row.start_at.toISOString(),
        endAt: row.end_at === null ? null : row.end_at.toISOString(),
        startDate: isoDate(row.start_date),
        endDate: isoDate(row.end_date),
        effectiveStart: isoDate(row.effective_start),
        effectiveEnd: isoDate(row.effective_end),
        timezone: PLATFORM_TIMEZONE,
        registrationCutoffAt: row.cutoff_at.toISOString(),
        availability,
        ...(availability === 'fewLeft' ? { spotsLeft: remaining } : {}),
      };
    });
    return { kind: 'availability' as const, units };
  });
}

// ---------------------------------------------------------------------------
// Own-hold status
// ---------------------------------------------------------------------------

export interface HoldStatusView {
  holdId: string;
  /** Truthful effective state: an `active` hold past its TTL reports
   *  `expired` (customers are never told anything is reserved beyond the
   *  truthful window — docs/24 §3.3; the row settles at the next mutation
   *  boundary). */
  state: 'active' | 'consumed' | 'expired' | 'released';
  unitKind: UnitKind;
  unitId: string;
  participantId: string;
  expiresAt: string;
}

export type HoldStatusResult =
  | { kind: 'holdStatus'; hold: HoldStatusView }
  | { kind: 'holdNotFound' };

export async function holdStatus(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: { holdId: string },
): Promise<HoldStatusResult> {
  return withTransaction(deps.db, async (trx) => {
    const hold = await readHold(trx, input.holdId);
    if (hold === undefined || hold.account_id !== actor.accountId) {
      return { kind: 'holdNotFound' as const };
    }
    const now = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
    const lapsed = hold.state === 'active' && hold.expires_at <= now.rows[0]!.now;
    const unit: UnitRef =
      hold.session_id !== null
        ? { kind: 'session', id: hold.session_id }
        : hold.camp_week_id !== null
          ? { kind: 'campWeek', id: hold.camp_week_id }
          : { kind: 'enrolmentCohort', id: hold.cohort_id! };
    return {
      kind: 'holdStatus' as const,
      hold: {
        holdId: hold.id,
        state: (lapsed ? 'expired' : hold.state) as HoldStatusView['state'],
        unitKind: unit.kind,
        unitId: unit.id,
        participantId: hold.participant_id,
        expiresAt: hold.expires_at.toISOString(),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Own-booking projections
// ---------------------------------------------------------------------------

export interface CustomerBookingView {
  bookingId: string;
  referenceCode: string | null;
  state: string;
  participant: { id: string; firstName: string };
  program: { id: string; titleEn: string };
  /** RI-3 (additive, owning-slice amendment): the provider/branch identity
   *  of the customer's OWN booking — the same public display names already
   *  served on discovery surfaces; needed by confirmation/My Bookings. */
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  unit: {
    kind: UnitKind;
    unitId: string;
    startAt: string | null;
    startDate: string | null;
    effectiveStart: string | null;
    /** RI-6 — venue timezone (IANA): the app presents `startAt` in venue-
     *  local civil terms on ANY device timezone (a Dubai-midnight session
     *  never drifts onto the wrong customer-facing day). */
    timezone: string;
  };
  price: { totalFils: number; currency: 'AED' };
  /** S6-3 (owner item 26): TRUE when this Booking's AED 0 quote is covered
   *  by an Entitlement reservation — the customer paid via their pass, so
   *  the projection must never read as a provider's free product. */
  coveredByEntitlement: boolean;
  /** The covering Entitlement, for customer navigation (never internals). */
  entitlementId: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

interface BookingProjectionRow {
  id: string;
  reference_code: string | null;
  state: string;
  participant_id: string;
  first_name: string;
  program_id: string;
  title_en: string;
  organization_id: string;
  display_name: string;
  branch_id: string | null;
  branch_label: string | null;
  session_id: string | null;
  camp_week_id: string | null;
  cohort_id: string | null;
  start_at: Date | null;
  start_date: Date | null;
  effective_start: Date | null;
  total_fils: string | number;
  reserved_entitlement_id: string | null;
  created_at: Date;
  confirmed_at: Date | null;
}

/** The CIVIL date of a pg DATE value: node-postgres parses DATE columns to
 *  a JS Date at server-local midnight, so the local components ARE the
 *  stored civil date — `toISOString()` would shift it a day back on any
 *  UTC+ host (the Asia/Dubai off-by-one this corrects, RI-4). */
function civilDateString(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function toBookingView(row: BookingProjectionRow): CustomerBookingView {
  const kind: UnitKind =
    row.session_id !== null
      ? 'session'
      : row.camp_week_id !== null
        ? 'campWeek'
        : 'enrolmentCohort';
  return {
    bookingId: row.id,
    referenceCode: row.reference_code,
    state: row.state,
    participant: { id: row.participant_id, firstName: row.first_name },
    program: { id: row.program_id, titleEn: row.title_en },
    provider: { id: row.organization_id, displayName: row.display_name },
    branch:
      row.branch_id === null || row.branch_label === null
        ? null
        : { id: row.branch_id, label: row.branch_label },
    unit: {
      kind,
      unitId: (row.session_id ?? row.camp_week_id ?? row.cohort_id)!,
      startAt: row.start_at === null ? null : row.start_at.toISOString(),
      startDate: civilDateString(row.start_date),
      effectiveStart:
        civilDateString(row.effective_start),
      timezone: PLATFORM_TIMEZONE,
    },
    price: { totalFils: Number(row.total_fils), currency: 'AED' },
    coveredByEntitlement: row.reserved_entitlement_id !== null,
    entitlementId: row.reserved_entitlement_id,
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at === null ? null : row.confirmed_at.toISOString(),
  };
}

const BOOKING_PROJECTION = sql`
  b.id, b.reference_code, b.state, b.participant_id, p.first_name,
  b.program_id, pr.title_en, b.session_id, b.camp_week_id, b.cohort_id,
  b.organization_id, opp.display_name,
  br.id AS branch_id, br.label AS branch_label,
  s.start_at, cw.start_date, ec.effective_start,
  q.total_fils, er.entitlement_id AS reserved_entitlement_id,
  b.created_at, b.confirmed_at
  FROM booking b
  JOIN participant p ON p.id = b.participant_id
  JOIN program pr ON pr.id = b.program_id
  JOIN organization_public_profile opp ON opp.organization_id = b.organization_id
  JOIN price_quote q ON q.id = b.quote_id
  LEFT JOIN session s ON s.id = b.session_id
  LEFT JOIN camp_week cw ON cw.id = b.camp_week_id
  LEFT JOIN enrolment_cohort ec ON ec.id = b.cohort_id
  LEFT JOIN branch br ON br.id = COALESCE(s.branch_id, cw.branch_id, ec.branch_id)
  LEFT JOIN entitlement_reservation er ON er.booking_id = b.id`;

export async function listBookings(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: { limit?: number; cursor?: string } = {},
): Promise<{ kind: 'bookings'; bookings: CustomerBookingView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<BookingProjectionRow>`
      SELECT ${BOOKING_PROJECTION}
      WHERE b.account_id = ${actor.accountId}
        ${input.cursor !== undefined ? sql`AND b.id < ${input.cursor}` : sql``}
      ORDER BY b.id DESC
      LIMIT ${limit + 1}`.execute(trx);
    const page = rows.rows.slice(0, limit);
    return {
      kind: 'bookings' as const,
      bookings: page.map(toBookingView),
      nextCursor: rows.rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });
}

export async function getBooking(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: { bookingId: string },
): Promise<{ kind: 'booking'; booking: CustomerBookingView } | { kind: 'bookingNotFound' }> {
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<BookingProjectionRow>`
      SELECT ${BOOKING_PROJECTION}
      WHERE b.id = ${input.bookingId} AND b.account_id = ${actor.accountId}`.execute(trx);
    if (rows.rows.length === 0) return { kind: 'bookingNotFound' as const };
    return { kind: 'booking' as const, booking: toBookingView(rows.rows[0]!) };
  });
}

// ---------------------------------------------------------------------------
// Paid-checkout fail-closed boundary (W5 absent — docs/32 §12 seam)
// ---------------------------------------------------------------------------

export type PaidCheckoutBoundaryResult =
  | { kind: 'holdNotFound' }
  | { kind: 'quoteMismatch' }
  /** Zero-total intents belong to the free confirmation boundary. */
  | { kind: 'paymentNotRequired' }
  /** The genuine W5 payment orchestration does not exist: refused BEFORE
   *  any Booking is created — nothing rests, nothing is charged. */
  | { kind: 'paymentUnavailable' };

/**
 * The production customer paid-checkout boundary while W5 is absent. It
 * NEVER calls `initiateBooking` (that internal S5-3 service is reserved
 * for the future trusted payment orchestration) and there is deliberately
 * no readiness flag to flip: real availability arrives as code — the W5
 * slice replaces this refusal with the genuine orchestration.
 */
export async function paidCheckoutBoundary(
  deps: BookingServiceDeps,
  actor: CustomerActor,
  input: { holdId: string; quoteId: string },
): Promise<PaidCheckoutBoundaryResult> {
  return withTransaction(deps.db, async (trx) => {
    const hold = await readHold(trx, input.holdId);
    if (hold === undefined || hold.account_id !== actor.accountId) {
      return { kind: 'holdNotFound' as const };
    }
    if (hold.quote_id !== input.quoteId) return { kind: 'quoteMismatch' as const };
    const quote = await trx
      .selectFrom('price_quote')
      .select('total_fils')
      .where('id', '=', input.quoteId)
      .executeTakeFirstOrThrow();
    if (Number(quote.total_fils) === 0) return { kind: 'paymentNotRequired' as const };
    return { kind: 'paymentUnavailable' as const };
  });
}
