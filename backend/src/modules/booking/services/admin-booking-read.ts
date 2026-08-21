/**
 * Admin booking-oversight READS — S5-6 (docs/32 §13; the W3-2/AD-18
 * read-model pattern; final D-W3-5 read rule).
 *
 * Observation, not booking authority: this module is READ-ONLY and no
 * admin booking mutation exists anywhere in Slice 5 — an Admin cannot
 * create/confirm/cancel a Booking, consume or release a customer's hold,
 * claim payment success, edit counters, restore a D-10 redemption, or
 * override provider schedules (each would be a separately certified,
 * D-W3-5-classified domain action).
 *
 * Authorization: routes ride the `admin` BASELINE (the D-W3-5 read rule);
 * the SERVICE gates the designated role fresh from PostgreSQL per
 * transaction — docs/32 §13 designates `operations` (assurance is never
 * authorization; widening to other roles is an owner decision, not a
 * default).
 *
 * The projection is purpose-built and BOUNDED (never raw rows): reference,
 * state, org/program display, unit + timing, participant first name (NO
 * date of birth), account id, the immutable quote money snapshot, and the
 * hold diagnosis a support agent needs. It deliberately carries BOTH
 * occupancy truths where occupancy appears, explicitly labeled: PHYSICAL
 * counters (transactional S5-2 state — a lapsed-but-unswept hold still
 * counts until an authoritative boundary settles it) and EFFECTIVE counts
 * (active AND unexpired) — never confusing diagnostics with inventory
 * truth. No idempotency payloads, no audit digests/principal context, no
 * payment material, no lock/version internals.
 */
import { sql } from 'kysely';

import { withTransaction, type Trx } from '../../../db/transaction';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import type { BookingServiceDeps, UnitKind } from './booking-shared';
import { unitSpec } from './booking-shared';

export const ADMIN_BOOKING_STATES = [
  'pending_payment',
  'confirmed',
  'expired',
  'payment_failed',
  'cancelled_by_customer',
  'cancelled_by_provider',
  'completed',
  'no_show',
] as const;
export type AdminBookingState = (typeof ADMIN_BOOKING_STATES)[number];

export interface AdminBookingListRow {
  bookingId: string;
  referenceCode: string | null;
  state: string;
  organization: { id: string; displayName: string };
  program: { id: string; titleEn: string };
  unit: { kind: UnitKind; unitId: string; startAt: string | null };
  participant: { id: string; firstName: string };
  accountId: string;
  price: { totalFils: number; currency: 'AED' };
  createdAt: string;
  confirmedAt: string | null;
}

export interface AdminBookingDetail extends AdminBookingListRow {
  cancelledAt: string | null;
  hold: {
    holdId: string;
    /** PHYSICAL persisted state (S5-2 transactional truth). */
    physicalState: string;
    /** True when the row is still physically `active` but past its TTL —
     *  no longer usable; awaiting authoritative settlement. */
    effectivelyExpired: boolean;
    expiresAt: string;
  };
  /** Unit occupancy diagnosis — both truths, labeled. */
  occupancy: {
    capacity: number;
    /** PHYSICAL booked counter (authoritative committed bookings). */
    bookedCount: number;
    /** PHYSICAL held counter incl. lapsed-but-unswept holds. */
    physicalHeldCount: number;
    /** EFFECTIVE held count: active AND unexpired holds only. */
    effectiveHeldCount: number;
  };
}

interface ProjectionRow {
  id: string;
  reference_code: string | null;
  state: string;
  organization_id: string;
  display_name: string;
  program_id: string;
  title_en: string;
  session_id: string | null;
  camp_week_id: string | null;
  cohort_id: string | null;
  unit_start: Date | null;
  participant_id: string;
  first_name: string;
  account_id: string;
  total_fils: string | number;
  created_at: Date;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
  hold_id: string;
  hold_state: string;
  hold_lapsed: boolean;
  hold_expires_at: Date;
}

const PROJECTION = sql`
  b.id, b.reference_code, b.state, b.organization_id, opp.display_name,
  b.program_id, pr.title_en, b.session_id, b.camp_week_id, b.cohort_id,
  COALESCE(s.start_at, cw.start_date::timestamptz, ec.effective_start::timestamptz) AS unit_start,
  b.participant_id, p.first_name, b.account_id, q.total_fils,
  b.created_at, b.confirmed_at, b.cancelled_at,
  h.id AS hold_id, h.state AS hold_state,
  (h.state = 'active' AND h.expires_at <= now()) AS hold_lapsed,
  h.expires_at AS hold_expires_at
  FROM booking b
  JOIN organization_public_profile opp ON opp.organization_id = b.organization_id
  JOIN program pr ON pr.id = b.program_id
  JOIN participant p ON p.id = b.participant_id
  JOIN price_quote q ON q.id = b.quote_id
  JOIN capacity_hold h ON h.id = b.hold_id
  LEFT JOIN session s ON s.id = b.session_id
  LEFT JOIN camp_week cw ON cw.id = b.camp_week_id
  LEFT JOIN enrolment_cohort ec ON ec.id = b.cohort_id`;

function unitOf(row: ProjectionRow): { kind: UnitKind; unitId: string; startAt: string | null } {
  const kind: UnitKind =
    row.session_id !== null
      ? 'session'
      : row.camp_week_id !== null
        ? 'campWeek'
        : 'enrolmentCohort';
  return {
    kind,
    unitId: (row.session_id ?? row.camp_week_id ?? row.cohort_id)!,
    startAt: row.unit_start === null ? null : row.unit_start.toISOString(),
  };
}

function toListRow(row: ProjectionRow): AdminBookingListRow {
  return {
    bookingId: row.id,
    referenceCode: row.reference_code,
    state: row.state,
    organization: { id: row.organization_id, displayName: row.display_name },
    program: { id: row.program_id, titleEn: row.title_en },
    unit: unitOf(row),
    participant: { id: row.participant_id, firstName: row.first_name },
    accountId: row.account_id,
    price: { totalFils: Number(row.total_fils), currency: 'AED' },
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at === null ? null : row.confirmed_at.toISOString(),
  };
}

async function operationsAuthorized(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

export interface ListAdminBookingsInput {
  /** Exact reference-code match (unique-indexed — never a substring scan). */
  reference?: string;
  organizationId?: string;
  programId?: string;
  accountId?: string;
  state?: AdminBookingState;
  limit?: number;
  cursor?: string;
}

export type ListAdminBookingsResult =
  | { kind: 'bookings'; bookings: AdminBookingListRow[]; nextCursor: string | null }
  | { kind: 'forbidden' };

export async function listAdminBookings(
  deps: BookingServiceDeps,
  actor: { userId: string },
  input: ListAdminBookingsInput,
): Promise<ListAdminBookingsResult> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return withTransaction(deps.db, async (trx) => {
    if (!(await operationsAuthorized(trx, actor.userId))) return { kind: 'forbidden' as const };
    const rows = await sql<ProjectionRow>`
      SELECT ${PROJECTION}
      WHERE TRUE
        ${input.reference !== undefined ? sql`AND b.reference_code = ${input.reference}` : sql``}
        ${input.organizationId !== undefined ? sql`AND b.organization_id = ${input.organizationId}` : sql``}
        ${input.programId !== undefined ? sql`AND b.program_id = ${input.programId}` : sql``}
        ${input.accountId !== undefined ? sql`AND b.account_id = ${input.accountId}` : sql``}
        ${input.state !== undefined ? sql`AND b.state = ${input.state}` : sql``}
        ${input.cursor !== undefined ? sql`AND b.id < ${input.cursor}` : sql``}
      ORDER BY b.id DESC
      LIMIT ${limit + 1}`.execute(trx);
    const page = rows.rows.slice(0, limit);
    return {
      kind: 'bookings' as const,
      bookings: page.map(toListRow),
      nextCursor: rows.rows.length > limit ? page[page.length - 1]!.id : null,
    };
  });
}

export type GetAdminBookingResult =
  | { kind: 'booking'; booking: AdminBookingDetail }
  | { kind: 'bookingNotFound' }
  | { kind: 'forbidden' };

export async function getAdminBooking(
  deps: BookingServiceDeps,
  actor: { userId: string },
  input: { bookingId: string },
): Promise<GetAdminBookingResult> {
  return withTransaction(deps.db, async (trx) => {
    if (!(await operationsAuthorized(trx, actor.userId))) return { kind: 'forbidden' as const };
    const rows = await sql<ProjectionRow>`
      SELECT ${PROJECTION}
      WHERE b.id = ${input.bookingId}`.execute(trx);
    const row = rows.rows[0];
    if (row === undefined) return { kind: 'bookingNotFound' as const };
    const unit = unitOf(row);
    const spec = unitSpec(unit.kind);
    const occupancy = await sql<{
      capacity: number;
      booked_count: number;
      held_count: number;
      effective_held: string;
    }>`
      SELECT u.capacity, u.booked_count, u.held_count,
             (SELECT count(*) FROM capacity_hold h
               WHERE h.${sql.id(spec.holdColumn)} = u.id
                 AND h.state = 'active' AND h.expires_at > now()) AS effective_held
      FROM ${sql.id(spec.table)} u WHERE u.id = ${unit.unitId}`.execute(trx);
    const occ = occupancy.rows[0]!;
    return {
      kind: 'booking' as const,
      booking: {
        ...toListRow(row),
        cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
        hold: {
          holdId: row.hold_id,
          physicalState: row.hold_state,
          effectivelyExpired: row.hold_lapsed,
          expiresAt: row.hold_expires_at.toISOString(),
        },
        occupancy: {
          capacity: occ.capacity,
          bookedCount: occ.booked_count,
          physicalHeldCount: occ.held_count,
          effectiveHeldCount: Number(occ.effective_held),
        },
      },
    };
  });
}
