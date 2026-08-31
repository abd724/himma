/**
 * S6-3 — customer fulfillment reads (docs/35 §8, §12; owner items 12–20,
 * 26, 33–36).
 *
 * - Passes & Memberships list/detail: the four DERIVED finite truths
 *   (`used / remaining / reservedUpcoming / availableToReserve`) beside the
 *   purchased immutable terms; unlimited products expose validity + methods
 *   and NEVER fake counters. Status is derived from authoritative facts
 *   only (`active | exhausted | expired` — D-S6-4 validity starts at
 *   confirmation, so no activation state can occur).
 * - Attendance history: the customer's own append-only truth, paged.
 * - Reservable occurrences: purchased immutable terms ∩ real upcoming
 *   Session availability (the certified derived-availability rule) — an
 *   authenticated Entitlement-specific projection that never modifies
 *   public availability truth. `availableToReserve` (finite) is reported
 *   separately from seat availability: a seat can be open while credit
 *   availability is zero.
 * - Calendar: a bounded derived READ combining confirmed Bookings (each
 *   once — a reserved Session is its Booking, annotated), CampWeek spans,
 *   Cohort pattern expansion from `enrolment_cohort_schedule`, and
 *   membership occurrences from the entitlement's immutable schedule
 *   snapshot ∩ validity. No calendar table exists; event keys derive from
 *   canonical source identity; expansion happens in service memory after
 *   bounded reads. All civil-date math uses the platform's canonical
 *   Asia/Dubai timezone (structurally pinned by `recurring_schedule`'s
 *   CHECK; a fixed +04:00 zone with no DST) — never the device timezone.
 *
 * Queries are bounded aggregations (page-scoped correlated counts + one
 * grouped schedule-term read) — never N+1 per entitlement×attendance.
 */
import { sql } from 'kysely';

import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import {
  finiteCommitmentCounts,
  finiteProjection,
  type FiniteProjection,
} from './entitlement-reservation';
import type { EntitlementServiceDeps } from './entitlement-shared';
import {
  civilDates,
  dubaiDateOf,
  dubaiInstant,
  dubaiWeekdayOf,
  expandCampOccurrences,
  expandCohortOccurrences,
  PLATFORM_TIMEZONE,
} from './occurrence-authority';

// ---------------------------------------------------------------------------
// Canonical civil-time + occurrence helpers: the SHARED derivation authority
// (occurrence-authority.ts) — the same helpers credential issuance validates
// with, so Calendar and check-in can never drift (docs/35 §28).
// ---------------------------------------------------------------------------

export { dubaiDateOf, dubaiInstant, dubaiWeekdayOf };

const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Passes & Memberships
// ---------------------------------------------------------------------------

export type EntitlementStatus = 'active' | 'exhausted' | 'expired';

export interface ScheduleTermView {
  weekday: number;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

export interface CustomerEntitlementView {
  entitlementId: string;
  participant: { id: string; firstName: string };
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  /** The purchased branch limitation, customer-safe (null = any branch). */
  branch: { id: string; label: string } | null;
  productLabel: string;
  optionKind: string;
  usageKind: 'finite' | 'unlimited';
  status: EntitlementStatus;
  validFrom: string; // ISO
  validUntil: string | null; // ISO
  walkInAllowed: boolean;
  reservationRequired: boolean;
  /** Finite products ONLY — unlimited passes carry no counters at all. */
  finite?: FiniteProjection;
  /** The purchased immutable schedule promise, where schedule-bound. */
  scheduleTerms: ScheduleTermView[];
  /** Earliest upcoming reserved occurrence, if any. */
  nextReservedSessionAt: string | null;
}

interface EntitlementListRow {
  id: string;
  participant_id: string;
  first_name: string;
  program_id: string;
  title_en: string;
  organization_id: string;
  display_name: string;
  branch_id: string | null;
  branch_label: string | null;
  option_kind: string;
  option_label: string | null;
  fulfillment_revision_id: string;
  usage_kind: 'finite' | 'unlimited';
  uses_total: number | null;
  valid_from: Date;
  valid_until: Date | null;
  reservation_required: boolean;
  walk_in_allowed: boolean;
  lapsed: boolean;
  used: string;
  reserved: string;
  next_reserved_at: Date | null;
}

const ENTITLEMENT_PROJECTION = sql`
  e.id, e.participant_id, p.first_name, e.program_id, pr.title_en,
  e.organization_id, opp.display_name,
  e.branch_id, br.label AS branch_label,
  o.kind AS option_kind, o.label_en AS option_label,
  e.fulfillment_revision_id, e.usage_kind, e.uses_total,
  e.valid_from, e.valid_until, e.reservation_required, e.walk_in_allowed,
  (e.valid_until IS NOT NULL AND e.valid_until <= now()) AS lapsed,
  (SELECT count(*) FROM attendance_record a WHERE a.entitlement_id = e.id) AS used,
  (SELECT count(*) FROM entitlement_reservation er
     JOIN booking b ON b.id = er.booking_id
     JOIN session s ON s.id = b.session_id
    WHERE er.entitlement_id = e.id AND b.state = 'confirmed' AND s.end_at > now()
      AND NOT EXISTS (SELECT 1 FROM attendance_record ar
                       WHERE ar.booking_id = er.booking_id)) AS reserved,
  (SELECT min(s.start_at) FROM entitlement_reservation er
     JOIN booking b ON b.id = er.booking_id
     JOIN session s ON s.id = b.session_id
    WHERE er.entitlement_id = e.id AND b.state = 'confirmed' AND s.start_at > now()
      AND NOT EXISTS (SELECT 1 FROM attendance_record ar
                       WHERE ar.booking_id = er.booking_id)) AS next_reserved_at
  FROM entitlement e
  JOIN participant p ON p.id = e.participant_id
  JOIN program pr ON pr.id = e.program_id
  JOIN organization_public_profile opp ON opp.organization_id = e.organization_id
  JOIN program_price_option o ON o.id = e.price_option_id
  LEFT JOIN branch br ON br.id = e.branch_id`;

function statusOf(row: EntitlementListRow): EntitlementStatus {
  if (row.lapsed) return 'expired';
  if (row.uses_total !== null && Number(row.used) >= row.uses_total) return 'exhausted';
  return 'active';
}

async function scheduleTermsByRevision(
  trx: Trx,
  revisionIds: string[],
): Promise<Map<string, ScheduleTermView[]>> {
  const map = new Map<string, ScheduleTermView[]>();
  if (revisionIds.length === 0) return map;
  const rows = await sql<{
    revision_id: string;
    weekday: number;
    start_time: string;
    end_time: string;
  }>`
    SELECT revision_id, weekday, start_time::text, end_time::text
    FROM price_option_fulfillment_schedule_term
    WHERE revision_id = ANY(${revisionIds}::uuid[])
    ORDER BY weekday, start_time`.execute(trx);
  for (const row of rows.rows) {
    const terms = map.get(row.revision_id) ?? [];
    terms.push({
      weekday: row.weekday,
      startTime: row.start_time.slice(0, 5),
      endTime: row.end_time.slice(0, 5),
    });
    map.set(row.revision_id, terms);
  }
  return map;
}

function toEntitlementView(
  row: EntitlementListRow,
  scheduleTerms: ScheduleTermView[],
): CustomerEntitlementView {
  const used = Number(row.used);
  const reserved = Number(row.reserved);
  return {
    entitlementId: row.id,
    participant: { id: row.participant_id, firstName: row.first_name },
    program: { id: row.program_id, titleEn: row.title_en },
    provider: { id: row.organization_id, displayName: row.display_name },
    branch:
      row.branch_id === null || row.branch_label === null
        ? null
        : { id: row.branch_id, label: row.branch_label },
    productLabel: row.option_label ?? row.option_kind,
    optionKind: row.option_kind,
    usageKind: row.usage_kind,
    status: statusOf(row),
    validFrom: row.valid_from.toISOString(),
    validUntil: row.valid_until === null ? null : row.valid_until.toISOString(),
    walkInAllowed: row.walk_in_allowed,
    reservationRequired: row.reservation_required,
    ...(row.uses_total !== null
      ? { finite: finiteProjection(row.uses_total, { used, reservedUpcoming: reserved }) }
      : {}),
    scheduleTerms,
    nextReservedSessionAt:
      row.next_reserved_at === null ? null : row.next_reserved_at.toISOString(),
  };
}

export async function listCustomerEntitlements(
  deps: EntitlementServiceDeps,
  actor: { accountId: string },
  input: { limit?: number; cursor?: string } = {},
): Promise<{
  kind: 'entitlements';
  entitlements: CustomerEntitlementView[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<EntitlementListRow>`
      SELECT ${ENTITLEMENT_PROJECTION}
      WHERE e.account_id = ${actor.accountId}
        ${input.cursor !== undefined ? sql`AND e.id < ${input.cursor}` : sql``}
      ORDER BY e.id DESC
      LIMIT ${limit + 1}`.execute(trx);
    const page = rows.rows.slice(0, limit);
    const terms = await scheduleTermsByRevision(
      trx,
      [...new Set(page.map((row) => row.fulfillment_revision_id))],
    );
    return {
      kind: 'entitlements' as const,
      entitlements: page.map((row) =>
        toEntitlementView(row, terms.get(row.fulfillment_revision_id) ?? []),
      ),
      nextCursor: rows.rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });
}

export async function getCustomerEntitlement(
  deps: EntitlementServiceDeps,
  actor: { accountId: string },
  input: { entitlementId: string },
): Promise<
  | { kind: 'entitlement'; entitlement: CustomerEntitlementView }
  | { kind: 'entitlementNotFound' }
> {
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<EntitlementListRow>`
      SELECT ${ENTITLEMENT_PROJECTION}
      WHERE e.id = ${input.entitlementId} AND e.account_id = ${actor.accountId}`.execute(trx);
    if (rows.rows.length === 0) return { kind: 'entitlementNotFound' as const };
    const row = rows.rows[0]!;
    const terms = await scheduleTermsByRevision(trx, [row.fulfillment_revision_id]);
    return {
      kind: 'entitlement' as const,
      entitlement: toEntitlementView(row, terms.get(row.fulfillment_revision_id) ?? []),
    };
  });
}

// ---------------------------------------------------------------------------
// Attendance history (append-only truth; customer-safe)
// ---------------------------------------------------------------------------

export interface CustomerAttendanceView {
  attendanceId: string;
  occurredAt: string; // ISO
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  /** The scheduled occurrence start, where the visit was session-backed. */
  sessionStartAt: string | null;
  targetKind: 'session' | 'reservedEntitlementUse' | 'walkIn';
}

export async function listEntitlementAttendance(
  deps: EntitlementServiceDeps,
  actor: { accountId: string },
  input: { entitlementId: string; limit?: number; cursor?: string },
): Promise<
  | { kind: 'attendance'; attendance: CustomerAttendanceView[]; nextCursor: string | null }
  | { kind: 'entitlementNotFound' }
> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    const owned = await trx
      .selectFrom('entitlement')
      .select('id')
      .where('id', '=', input.entitlementId)
      .where('account_id', '=', actor.accountId)
      .executeTakeFirst();
    if (owned === undefined) return { kind: 'entitlementNotFound' as const };
    const rows = await sql<{
      id: string;
      occurred_at: Date;
      booking_id: string | null;
      program_id: string;
      title_en: string;
      organization_id: string;
      display_name: string;
      branch_id: string | null;
      branch_label: string | null;
      session_start_at: Date | null;
      reserved: boolean;
    }>`
      SELECT a.id, a.occurred_at, a.booking_id,
             pr.id AS program_id, pr.title_en,
             a.organization_id, opp.display_name,
             a.branch_id, br.label AS branch_label,
             s.start_at AS session_start_at,
             (a.booking_id IS NOT NULL) AS reserved
      FROM attendance_record a
      JOIN entitlement e ON e.id = a.entitlement_id
      JOIN program pr ON pr.id = e.program_id
      JOIN organization_public_profile opp ON opp.organization_id = a.organization_id
      LEFT JOIN branch br ON br.id = a.branch_id
      LEFT JOIN session s ON s.id = a.session_id
      WHERE a.entitlement_id = ${input.entitlementId}
        ${input.cursor !== undefined ? sql`AND a.id < ${input.cursor}` : sql``}
      ORDER BY a.id DESC
      LIMIT ${limit + 1}`.execute(trx);
    const page = rows.rows.slice(0, limit);
    return {
      kind: 'attendance' as const,
      attendance: page.map((row) => ({
        attendanceId: row.id,
        occurredAt: row.occurred_at.toISOString(),
        program: { id: row.program_id, titleEn: row.title_en },
        provider: { id: row.organization_id, displayName: row.display_name },
        branch:
          row.branch_id === null || row.branch_label === null
            ? null
            : { id: row.branch_id, label: row.branch_label },
        sessionStartAt:
          row.session_start_at === null ? null : row.session_start_at.toISOString(),
        targetKind: row.reserved ? ('reservedEntitlementUse' as const) : ('walkIn' as const),
      })),
      nextCursor: rows.rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reservable occurrences (purchased terms ∩ real availability)
// ---------------------------------------------------------------------------

const FEW_LEFT_THRESHOLD = 3;
const RESERVABLE_DEFAULT_DAYS = 30;
const RESERVABLE_MAX_DAYS = 60;

export interface ReservableSessionView {
  sessionId: string;
  branchId: string;
  startAt: string; // ISO
  endAt: string; // ISO
  /** RI-6 — the venue timezone for truthful civil presentation. */
  timezone: string;
  registrationCutoffAt: string; // ISO
  availability: 'available' | 'fewLeft' | 'full' | 'closed';
  spotsLeft?: number;
}

export type ReservableSessionsResult =
  | {
      kind: 'reservableSessions';
      sessions: ReservableSessionView[];
      /** AUTHORITATIVE credit availability, SEPARATE from seat
       *  availability (finite only) — a seat can be open while this is 0. */
      finite?: FiniteProjection;
    }
  | { kind: 'entitlementNotFound' }
  | { kind: 'reservationNotPermitted' }
  | { kind: 'entitlementNotActive' };

export async function listReservableSessions(
  deps: EntitlementServiceDeps,
  actor: { accountId: string },
  input: { entitlementId: string; from?: string; to?: string },
): Promise<ReservableSessionsResult> {
  return withTransaction(deps.db, async (trx) => {
    const rows = await sql<{
      id: string;
      program_id: string;
      fulfillment_revision_id: string;
      branch_id: string | null;
      uses_total: number | null;
      reservation_required: boolean;
      valid_until: Date | null;
      active_now: boolean;
    }>`
      SELECT id, program_id, fulfillment_revision_id, branch_id, uses_total,
             reservation_required, valid_until,
             (now() >= valid_from AND (valid_until IS NULL OR now() < valid_until))
               AS active_now
      FROM entitlement
      WHERE id = ${input.entitlementId} AND account_id = ${actor.accountId}`.execute(trx);
    const entitlement = rows.rows[0];
    if (entitlement === undefined) return { kind: 'entitlementNotFound' as const };
    if (!entitlement.reservation_required) return { kind: 'reservationNotPermitted' as const };
    if (!entitlement.active_now) return { kind: 'entitlementNotActive' as const };

    const now = Date.now();
    const from = input.from !== undefined ? Date.parse(`${input.from}T00:00:00.000Z`) : now;
    const requestedTo =
      input.to !== undefined
        ? Date.parse(`${input.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
        : now + RESERVABLE_DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    const cappedTo = Math.min(
      requestedTo,
      Math.max(from, now) + RESERVABLE_MAX_DAYS * 24 * 60 * 60 * 1000,
    );
    const windowStart = new Date(Math.max(from, now));
    const windowEnd = new Date(
      entitlement.valid_until === null
        ? cappedTo
        : Math.min(cappedTo, entitlement.valid_until.getTime()),
    );

    const sessions = await sql<{
      id: string;
      branch_id: string;
      start_at: Date;
      end_at: Date;
      cutoff_at: Date;
      state: string;
      capacity: number;
      booked_count: number;
      effective_held: string;
      lapsed: boolean;
    }>`
      SELECT s.id, s.branch_id, s.start_at, s.end_at,
             s.registration_cutoff_at AS cutoff_at, s.state,
             s.capacity, s.booked_count,
             (SELECT count(*) FROM capacity_hold h
               WHERE h.session_id = s.id AND h.state = 'active'
                 AND h.expires_at > now()) AS effective_held,
             s.registration_cutoff_at <= now() AS lapsed
      FROM session s
      WHERE s.program_id = ${entitlement.program_id}
        AND s.state IN ('scheduled', 'open', 'full', 'closed')
        AND s.start_at >= ${windowStart}
        AND s.start_at < ${windowEnd}
        AND (${entitlement.branch_id}::uuid IS NULL OR s.branch_id = ${entitlement.branch_id})
        AND (NOT EXISTS (SELECT 1 FROM price_option_fulfillment_schedule_term t
                          WHERE t.revision_id = ${entitlement.fulfillment_revision_id})
             OR EXISTS (SELECT 1 FROM price_option_fulfillment_schedule_term t
                         WHERE t.revision_id = ${entitlement.fulfillment_revision_id}
                           AND t.weekday = EXTRACT(DOW FROM (s.start_at AT TIME ZONE 'Asia/Dubai'))::int
                           AND (s.start_at AT TIME ZONE 'Asia/Dubai')::time >= t.start_time
                           AND (s.start_at AT TIME ZONE 'Asia/Dubai')::time <  t.end_time))
      ORDER BY s.start_at`.execute(trx);

    let finite: FiniteProjection | undefined;
    if (entitlement.uses_total !== null) {
      const counts = await finiteCommitmentCounts(trx, entitlement.id);
      finite = finiteProjection(entitlement.uses_total, counts);
    }

    return {
      kind: 'reservableSessions' as const,
      sessions: sessions.rows.map((row): ReservableSessionView => {
        const remaining = Math.max(
          0,
          row.capacity - row.booked_count - Number(row.effective_held),
        );
        const closed = row.state === 'scheduled' || row.state === 'closed' || row.lapsed;
        const availability = closed
          ? ('closed' as const)
          : remaining === 0
            ? ('full' as const)
            : remaining <= FEW_LEFT_THRESHOLD
              ? ('fewLeft' as const)
              : ('available' as const);
        return {
          sessionId: row.id,
          branchId: row.branch_id,
          startAt: row.start_at.toISOString(),
          endAt: row.end_at.toISOString(),
          timezone: PLATFORM_TIMEZONE,
          registrationCutoffAt: row.cutoff_at.toISOString(),
          availability,
          ...(availability === 'fewLeft' ? { spotsLeft: remaining } : {}),
        };
      }),
      ...(finite !== undefined ? { finite } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Calendar (derived read — never a second calendar database)
// ---------------------------------------------------------------------------

export const CALENDAR_MAX_RANGE_DAYS = 62;

export type CalendarEventContext = 'booked' | 'reservedWithPass' | 'includedSchedule';

export interface CalendarEventView {
  /** Stable server-derived identity from canonical source identity. */
  eventKey: string;
  sourceType: 'sessionBooking' | 'campWeekOccurrence' | 'cohortOccurrence' | 'membershipOccurrence';
  context: CalendarEventContext;
  participant: { id: string; firstName: string };
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  startAt: string; // ISO instant
  endAt: string; // ISO instant
  /** RI-6 — the venue timezone (IANA) for truthful civil presentation of
   *  the instants above on ANY device timezone: canonical UAE scheduled
   *  activity never moves onto the wrong customer-facing civil day merely
   *  because the device clock is elsewhere. */
  timezone: string;
  /** CampWeek presentation metadata: the overall span each daily occurrence
   *  belongs to (never a REPLACEMENT for the occurrence truth — docs/35
   *  §30). */
  span?: { startDate: string; endDate: string; dailyStartTime: string; dailyEndTime: string };
  /**
   * RI-4 correction — the EXPLICIT canonical occurrence authority for
   * camp/cohort Booking occurrences: the exact `date + startTime` pair the
   * 0020 credential issuance requires, authored by the SAME canonical
   * derivation that produced this event (occurrence-authority.ts). The
   * event key stays an OPAQUE identity — clients never parse it.
   */
  occurrence?: { date: string; startTime: string };
  bookingId?: string;
  entitlementId?: string;
}

export type CalendarResult =
  | { kind: 'calendar'; events: CalendarEventView[] }
  | { kind: 'invalidRange' };

export async function getCustomerCalendar(
  deps: EntitlementServiceDeps,
  actor: { accountId: string },
  input: { from: string; to: string },
): Promise<CalendarResult> {
  const fromMs = Date.parse(`${input.from}T00:00:00.000Z`);
  const toMsExclusive = Date.parse(`${input.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  if (
    Number.isNaN(fromMs) ||
    Number.isNaN(toMsExclusive) ||
    toMsExclusive <= fromMs ||
    toMsExclusive - fromMs > CALENDAR_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000
  ) {
    return { kind: 'invalidRange' };
  }
  // Civil-range instants: the Dubai day starts 4 h before the UTC date.
  const rangeStart = new Date(fromMs - DUBAI_OFFSET_MS);
  const rangeEnd = new Date(toMsExclusive - DUBAI_OFFSET_MS);
  const toDateExclusive = new Date(toMsExclusive).toISOString().slice(0, 10);

  return withTransaction(deps.db, async (trx) => {
    const events: CalendarEventView[] = [];

    // ---- 1. Confirmed Bookings intersecting the range (each ONE source).
    const bookings = await sql<{
      id: string;
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
      s_start: Date | null;
      s_end: Date | null;
      cw_start: string | null;
      cw_end: string | null;
      cw_daily_start: string | null;
      cw_daily_end: string | null;
      ec_start: string | null;
      ec_end: string | null;
      reserved_entitlement_id: string | null;
    }>`
      SELECT b.id, b.participant_id, p.first_name, b.program_id, pr.title_en,
             b.organization_id, opp.display_name,
             br.id AS branch_id, br.label AS branch_label,
             b.session_id, b.camp_week_id, b.cohort_id,
             s.start_at AS s_start, s.end_at AS s_end,
             cw.start_date::text AS cw_start, cw.end_date::text AS cw_end,
             cw.daily_start_time::text AS cw_daily_start,
             cw.daily_end_time::text AS cw_daily_end,
             ec.effective_start::text AS ec_start, ec.effective_end::text AS ec_end,
             er.entitlement_id AS reserved_entitlement_id
      FROM booking b
      JOIN participant p ON p.id = b.participant_id
      JOIN program pr ON pr.id = b.program_id
      JOIN organization_public_profile opp ON opp.organization_id = b.organization_id
      LEFT JOIN session s ON s.id = b.session_id
      LEFT JOIN camp_week cw ON cw.id = b.camp_week_id
      LEFT JOIN enrolment_cohort ec ON ec.id = b.cohort_id
      LEFT JOIN branch br ON br.id = COALESCE(s.branch_id, cw.branch_id, ec.branch_id)
      LEFT JOIN entitlement_reservation er ON er.booking_id = b.id
      WHERE b.account_id = ${actor.accountId}
        AND b.state = 'confirmed'
        AND (
          (s.id IS NOT NULL AND s.end_at > ${rangeStart} AND s.start_at < ${rangeEnd})
          OR (cw.id IS NOT NULL AND cw.end_date >= ${input.from}::date
              AND cw.start_date < ${toDateExclusive}::date)
          OR (ec.id IS NOT NULL AND ec.effective_end >= ${input.from}::date
              AND ec.effective_start < ${toDateExclusive}::date)
        )`.execute(trx);

    const cohortBookings = bookings.rows.filter((row) => row.cohort_id !== null);
    const cohortSchedules =
      cohortBookings.length === 0
        ? []
        : (
            await sql<{
              cohort_id: string;
              weekdays: number[];
              start_time: string;
              end_time: string;
              effective_start: string;
              effective_end: string | null;
              exception_dates: string[];
            }>`
        SELECT ecs.cohort_id, rs.weekdays, rs.start_time::text, rs.end_time::text,
               rs.effective_start::text, rs.effective_end::text,
               rs.exception_dates::text[] AS exception_dates
        FROM enrolment_cohort_schedule ecs
        JOIN recurring_schedule rs ON rs.id = ecs.schedule_id
        WHERE ecs.cohort_id = ANY(${cohortBookings.map((row) => row.cohort_id!)}::uuid[])
          AND ecs.active = true AND rs.state = 'active'`.execute(trx)
          ).rows;

    /** Booking occupancy for membership-occurrence deduplication:
     *  (participantId, programId, dubaiDate) of every real Session event. */
    const sessionOccupancy = new Set<string>();

    for (const row of bookings.rows) {
      const base = {
        participant: { id: row.participant_id, firstName: row.first_name },
        program: { id: row.program_id, titleEn: row.title_en },
        provider: { id: row.organization_id, displayName: row.display_name },
        branch:
          row.branch_id === null || row.branch_label === null
            ? null
            : { id: row.branch_id, label: row.branch_label },
        timezone: PLATFORM_TIMEZONE,
        bookingId: row.id,
      };
      if (row.session_id !== null) {
        // A reserved Session IS its Booking — exactly one event, annotated.
        sessionOccupancy.add(
          `${row.participant_id}:${row.program_id}:${dubaiDateOf(row.s_start!)}`,
        );
        events.push({
          eventKey: `booking:${row.id}`,
          sourceType: 'sessionBooking',
          context: row.reserved_entitlement_id !== null ? 'reservedWithPass' : 'booked',
          ...base,
          startAt: row.s_start!.toISOString(),
          endAt: row.s_end!.toISOString(),
          ...(row.reserved_entitlement_id !== null
            ? { entitlementId: row.reserved_entitlement_id }
            : {}),
        });
      } else if (row.camp_week_id !== null) {
        // CampWeek: one derived event per CANONICAL DAILY OCCURRENCE (the
        // ratified §30 correction) — each day is independently attended
        // and independently real; the overall span rides every event as
        // presentation metadata, never as a replacement for the
        // occurrence truth. Identity converges with attendance:
        // booking:<id>:<date>:<HH:MM daily start>.
        const startDate = row.cw_start!;
        const endDate = row.cw_end!;
        const dailyStart = row.cw_daily_start!.slice(0, 5);
        const dailyEnd = row.cw_daily_end!.slice(0, 5);
        const span = {
          startDate,
          endDate,
          dailyStartTime: dailyStart,
          dailyEndTime: dailyEnd,
        };
        for (const occurrence of expandCampOccurrences(
          { startDate, endDate, dailyStartTime: dailyStart, dailyEndTime: dailyEnd },
          input.from,
          toDateExclusive,
        )) {
          events.push({
            eventKey: `booking:${row.id}:${occurrence.date}:${occurrence.startTime}`,
            sourceType: 'campWeekOccurrence',
            context: 'booked',
            ...base,
            startAt: dubaiInstant(occurrence.date, occurrence.startTime).toISOString(),
            endAt: dubaiInstant(occurrence.date, occurrence.endTime).toISOString(),
            span,
            // The explicit credential-occurrence DTO — the same canonical
            // values, never re-derived (one authority, two projections).
            occurrence: { date: occurrence.date, startTime: occurrence.startTime },
          });
        }
      } else if (row.cohort_id !== null) {
        // Cohort: expansion ONLY through the SHARED canonical derivation
        // (occurrence-authority.ts — the same authority credential
        // issuance validates against; docs/35 §28): active associations →
        // active recurring_schedule ∩ cohort window ∩ range, minus
        // exception dates.
        for (const occurrence of expandCohortOccurrences(
          cohortSchedules.filter((candidate) => candidate.cohort_id === row.cohort_id),
          { effectiveStart: row.ec_start!, effectiveEnd: row.ec_end! },
          input.from,
          toDateExclusive,
        )) {
          events.push({
            eventKey: `booking:${row.id}:${occurrence.date}:${occurrence.startTime}`,
            sourceType: 'cohortOccurrence',
            context: 'booked',
            ...base,
            startAt: dubaiInstant(occurrence.date, occurrence.startTime).toISOString(),
            endAt: dubaiInstant(occurrence.date, occurrence.endTime).toISOString(),
            // The explicit credential-occurrence DTO — the same canonical
            // values, never re-derived (one authority, two projections).
            occurrence: { date: occurrence.date, startTime: occurrence.startTime },
          });
        }
      }
    }

    // ---- 2. Membership occurrences: the entitlement's IMMUTABLE purchased
    // schedule snapshot ∩ validity ∩ range. Later provider schedule
    // revisions never appear here — the snapshot is frozen per purchase.
    const scheduled = await sql<{
      id: string;
      participant_id: string;
      first_name: string;
      program_id: string;
      title_en: string;
      organization_id: string;
      display_name: string;
      branch_id: string | null;
      branch_label: string | null;
      valid_from: Date;
      valid_until: Date | null;
      weekday: number;
      start_time: string;
      end_time: string;
    }>`
      SELECT e.id, e.participant_id, p.first_name, e.program_id, pr.title_en,
             e.organization_id, opp.display_name,
             br.id AS branch_id, br.label AS branch_label,
             e.valid_from, e.valid_until,
             t.weekday, t.start_time::text, t.end_time::text
      FROM entitlement e
      JOIN price_option_fulfillment_schedule_term t
        ON t.revision_id = e.fulfillment_revision_id
      JOIN participant p ON p.id = e.participant_id
      JOIN program pr ON pr.id = e.program_id
      JOIN organization_public_profile opp ON opp.organization_id = e.organization_id
      LEFT JOIN branch br ON br.id = e.branch_id
      WHERE e.account_id = ${actor.accountId}
        AND e.valid_from < ${rangeEnd}
        AND (e.valid_until IS NULL OR e.valid_until > ${rangeStart})`.execute(trx);
    for (const term of scheduled.rows) {
      const startTime = term.start_time.slice(0, 5);
      for (const date of civilDates(input.from, toDateExclusive)) {
        if (dubaiWeekdayOf(date) !== term.weekday) continue;
        const startAt = dubaiInstant(date, startTime);
        if (startAt < term.valid_from) continue;
        if (term.valid_until !== null && startAt >= term.valid_until) continue;
        // Deduplication: a REAL booked/reserved Session for the same
        // participant + program + civil day dominates the derived
        // schedule occurrence — the same underlying visit appears once.
        if (sessionOccupancy.has(`${term.participant_id}:${term.program_id}:${date}`)) {
          continue;
        }
        events.push({
          eventKey: `entitlement:${term.id}:${date}:${startTime}`,
          sourceType: 'membershipOccurrence',
          context: 'includedSchedule',
          participant: { id: term.participant_id, firstName: term.first_name },
          program: { id: term.program_id, titleEn: term.title_en },
          provider: { id: term.organization_id, displayName: term.display_name },
          branch:
            term.branch_id === null || term.branch_label === null
              ? null
              : { id: term.branch_id, label: term.branch_label },
          startAt: startAt.toISOString(),
          endAt: dubaiInstant(date, term.end_time).toISOString(),
          timezone: PLATFORM_TIMEZONE,
          entitlementId: term.id,
        });
      }
    }

    events.sort((a, b) =>
      a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.eventKey < b.eventKey ? -1 : 1,
    );
    return { kind: 'calendar' as const, events };
  });
}
