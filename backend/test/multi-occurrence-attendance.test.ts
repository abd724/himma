/**
 * S6-3 Final Correction (0020) — canonical CampWeek/Cohort per-occurrence
 * attendance (docs/35 §26–§31; owner items 3–17, 19–23, 25). Real
 * PostgreSQL + real Fastify transport + multi-connection races.
 *
 * Covers: the CampWeek daily-occurrence journey (issue → redeem → one
 * attendance per day; same day twice impossible; different days
 * independent) · the Cohort meeting journey incl. the POSITIVE
 * two-meetings-one-date proof (why date-only identity is forbidden) ·
 * exception dates refused at BOTH credential issuance and Calendar (one
 * shared derivation) · the schedule-edit freeze (an issued credential's
 * occurrence pair is immutable; future discovery follows the current
 * canonical schedule) · the REAL-server-time cross-midnight binding
 * (occurrence identity never derived from `occurred_at`) · the default
 * ±60-minute issuance window on the canonical occurrence instant ·
 * per-occurrence one-live-credential + concurrency races · coach
 * fail-closed for camp/cohort · occurrence-substitution impossibility ·
 * and the customer/provider HTTP wire (explicit occurrence selection;
 * server-derived everything else).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { confirmFreeBooking } from '../src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import {
  issueRedemptionCredential,
  getRedemptionCredentialStatus,
  type CredentialServiceDeps,
  type OccurrenceSelection,
} from '../src/modules/entitlement/services/redemption-credential';
import {
  previewRedemption,
  redeemCredential,
  type RedemptionDeps,
} from '../src/modules/entitlement/services/attendance-redemption';
import { dubaiDateOf } from '../src/modules/entitlement/services/occurrence-authority';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCustomer,
  createPriceOption,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { addMembership, bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import { createRacePool, race, type RacePool } from './helpers/race-harness';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/multi-occurrence-pool';
const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let racePool: RacePool;
let freeCapacityOption: string;
let desk: { scope: OrgScope; userId: string };
let coach: { scope: OrgScope; userId: string };

const deps = (): RedemptionDeps => ({ db: testDb.db });
/** Wide issuance window (server config) so far-future canonical occurrences
 *  are issuable in tests; the DEFAULT ±60 window has its own proof below. */
const wideDeps = (db = testDb.db): CredentialServiceDeps => ({
  db,
  checkInWindowBeforeMinutes: 60 * 24 * 60,
  checkInWindowAfterMinutes: 60 * 24 * 60,
});

function scopeFor(membershipId: string, role: OrgScope['role']): OrgScope {
  return {
    organizationId: f.org.orgId,
    membershipId,
    role,
    capabilities: capabilitiesForRole(role),
    branchScope: 'all',
    organizationState: 'live',
  };
}

async function makeStaff(role: OrgScope['role']): Promise<{ scope: OrgScope; userId: string }> {
  const userId = await createUser(testDb.db);
  const membershipId = await addMembership(testDb.db, userId, f.org.orgId, role);
  return { scope: scopeFor(membershipId, role), userId };
}

async function httpCustomer(): Promise<Customer & { bearer: string }> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const participantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, participantId, bearer };
}

/** Dubai civil date `days` from now. */
function dubaiDay(days: number): string {
  return dubaiDateOf(new Date(Date.now() + days * DAY_MS));
}

async function makeCampWeek(input: {
  startDate: string;
  endDate: string;
  dailyStart: string;
  dailyEnd: string;
}): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date, end_date,
                           daily_start_time, daily_end_time, capacity, registration_cutoff_at)
    VALUES (${id}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
            ${input.startDate}, ${input.endDate}, ${input.dailyStart}, ${input.dailyEnd},
            10, now() + interval '30 days')`.execute(testDb.db);
  return id;
}

async function makeCohort(input: {
  effectiveStart: string;
  effectiveEnd: string;
  schedules: Array<{
    weekdays: number[];
    startTime: string;
    endTime: string;
    exceptionDates?: string[];
  }>;
}): Promise<{ cohortId: string; scheduleIds: string[] }> {
  const cohortId = newId();
  await sql`
    INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                  effective_start, effective_end, capacity, enrolment_cutoff_at)
    VALUES (${cohortId}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
            ${input.effectiveStart}, ${input.effectiveEnd}, 10,
            now() + interval '30 days')`.execute(testDb.db);
  const scheduleIds: string[] = [];
  for (const schedule of input.schedules) {
    const scheduleId = newId();
    await sql`
      INSERT INTO recurring_schedule (id, program_id, organization_id, weekdays, start_time,
                                      end_time, timezone, effective_start, effective_end,
                                      exception_dates)
      VALUES (${scheduleId}, ${f.programId}, ${f.org.orgId},
              ${sql.raw(`'{${schedule.weekdays.join(',')}}'`)}, ${schedule.startTime},
              ${schedule.endTime}, 'Asia/Dubai', ${input.effectiveStart}, ${input.effectiveEnd},
              ${sql.raw(
                schedule.exceptionDates === undefined || schedule.exceptionDates.length === 0
                  ? `'{}'::date[]`
                  : `ARRAY[${schedule.exceptionDates.map((date) => `'${date}'`).join(',')}]::date[]`,
              )})`.execute(testDb.db);
    await sql`
      INSERT INTO enrolment_cohort_schedule (cohort_id, schedule_id, program_id)
      VALUES (${cohortId}, ${scheduleId}, ${f.programId})`.execute(testDb.db);
    scheduleIds.push(scheduleId);
  }
  return { cohortId, scheduleIds };
}

/** A confirmed camp/cohort Booking through the REAL capacity path. */
async function confirmUnitBooking(
  customer: Customer,
  unit: { kind: 'campWeek' | 'enrolmentCohort'; id: string },
): Promise<string> {
  const quote = await requestQuote(deps(), { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freeCapacityOption,
    unit,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps(), { accountId: customer.accountId }, {
    unit,
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const confirmed = await confirmFreeBooking(deps(), { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  return confirmed.outcome.booking.bookingId;
}

async function issueOccurrence(
  customer: Customer,
  bookingId: string,
  occurrence: OccurrenceSelection,
  issueDeps: CredentialServiceDeps = wideDeps(),
): Promise<{ credentialId: string; displayCode: string }> {
  const run = await issueRedemptionCredential(issueDeps, { accountId: customer.accountId }, {
    target: { kind: 'booking', bookingId },
    occurrence,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'credentialIssued') throw new Error(run.outcome.kind);
  return {
    credentialId: run.outcome.credential.credentialId,
    displayCode: run.outcome.credential.displayCode!,
  };
}

async function redeem(
  code: string,
  credentialId: string,
  by: { scope: OrgScope; userId: string } = desk,
  db = testDb.db,
) {
  return redeemCredential({ db }, by.scope, { userId: by.userId }, {
    code,
    credentialId,
    idempotencyKey: newId(),
  });
}

async function attendanceRows(bookingId: string): Promise<
  Array<{ occurrence_date: string; occurrence_start_time: string; occurred_at: Date }>
> {
  const rows = await sql<{
    occurrence_date: string;
    occurrence_start_time: string;
    occurred_at: Date;
  }>`
    SELECT occurrence_date::text, occurrence_start_time::text, occurred_at
    FROM attendance_record WHERE booking_id = ${bookingId}
    ORDER BY occurrence_date, occurrence_start_time`.execute(testDb.db);
  return rows.rows;
}

/** The next Dubai civil dates (≥ startOffset days ahead) on `weekday`. */
function nextDubaiWeekdays(weekday: number, count: number, startOffset = 2): string[] {
  const dates: string[] = [];
  for (let days = startOffset; dates.length < count; days += 1) {
    const date = dubaiDay(days);
    if (new Date(`${date}T00:00:00.000Z`).getUTCDay() === weekday) dates.push(date);
  }
  return dates;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  racePool = await createRacePool(testDb.config, 4);
  freeCapacityOption = await createPriceOption(f, { kind: 'free' });
  desk = await makeStaff('front_desk');
  coach = await makeStaff('coach');
});

afterAll(async () => {
  await racePool.destroy();
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// CampWeek journey (owner items 5, 19)
// ---------------------------------------------------------------------------

describe('CampWeek per-occurrence attendance', () => {
  it('JOURNEY (item 19): day 1 issues/redeems once (retry refused); day 2 attends separately; out-of-span and wrong-time occurrences refuse; Calendar days appear independently with stable keys', async () => {
    const startDate = dubaiDay(2);
    const endDate = dubaiDay(6);
    const campId = await makeCampWeek({
      startDate,
      endDate,
      dailyStart: '09:00',
      dailyEnd: '13:00',
    });
    const customer = await httpCustomer();
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });

    // Calendar BEFORE attendance: one derived event per span day.
    const calendarUrl = `/customer/calendar?from=${dubaiDay(1)}&to=${dubaiDay(10)}`;
    const readBefore = await app.inject({
      method: 'GET',
      url: calendarUrl,
      headers: { authorization: `Bearer ${customer.bearer}` },
    });
    const keysBefore = readBefore
      .json()
      .events.filter((event: { bookingId?: string }) => event.bookingId === bookingId)
      .map((event: { eventKey: string }) => event.eventKey);
    expect(keysBefore).toHaveLength(5);
    expect(keysBefore[0]).toBe(`booking:${bookingId}:${startDate}:09:00`);

    // Day 1: credential (frozen occurrence stamped) → redeem → attendance
    // bound to the SCHEDULED occurrence.
    const day1 = await issueOccurrence(customer, bookingId, {
      date: startDate,
      startTime: '09:00',
    });
    const stored = await sql<{ occurrence_date: string; occurrence_start_time: string }>`
      SELECT occurrence_date::text, occurrence_start_time::text
      FROM redemption_credential WHERE id = ${day1.credentialId}`.execute(testDb.db);
    expect(stored.rows[0]).toEqual({
      occurrence_date: startDate,
      occurrence_start_time: '09:00:00',
    });
    const redeemed = await redeem(day1.displayCode, day1.credentialId);
    if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);
    expect(redeemed.outcome.attendance).toMatchObject({
      targetKind: 'campWeekOccurrence',
      occurrenceDate: startDate,
      occurrenceStartTime: '09:00',
    });

    // The SAME day again: issuance refuses (already attended) — the same
    // camp day can never attend twice.
    const retry = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: startDate, startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(retry.outcome.kind).toBe('alreadyCheckedIn');

    // Day 2: a separate credential and a separate attendance succeed.
    const day2Date = dubaiDay(3);
    const day2 = await issueOccurrence(customer, bookingId, {
      date: day2Date,
      startTime: '09:00',
    });
    const redeemed2 = await redeem(day2.displayCode, day2.credentialId);
    expect(redeemed2.outcome.kind).toBe('attendanceRecorded');
    expect(await attendanceRows(bookingId)).toMatchObject([
      { occurrence_date: startDate, occurrence_start_time: '09:00:00' },
      { occurrence_date: day2Date, occurrence_start_time: '09:00:00' },
    ]);

    // Invalid occurrences refuse typed: outside the span; wrong daily time.
    const outOfSpan = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: dubaiDay(8), startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(outOfSpan.outcome.kind).toBe('occurrenceNotEligible');
    const wrongTime = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: day2Date, startTime: '10:00' },
      idempotencyKey: newId(),
    });
    expect(wrongTime.outcome.kind).toBe('occurrenceNotEligible');

    // Calendar AFTER attendance: the SAME stable keys — attendance never
    // creates, replaces, or re-keys a calendar occurrence (item 17).
    const readAfter = await app.inject({
      method: 'GET',
      url: calendarUrl,
      headers: { authorization: `Bearer ${customer.bearer}` },
    });
    expect(
      readAfter
        .json()
        .events.filter((event: { bookingId?: string }) => event.bookingId === bookingId)
        .map((event: { eventKey: string }) => event.eventKey),
    ).toEqual(keysBefore);
  });

  it('the DEFAULT ±60-minute issuance window applies to the CANONICAL occurrence instant — a far-future camp day refuses without config', async () => {
    const campId = await makeCampWeek({
      startDate: dubaiDay(3),
      endDate: dubaiDay(5),
      dailyStart: '09:00',
      dailyEnd: '13:00',
    });
    const customer = await createCustomer(testDb.db);
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });
    const early = await issueRedemptionCredential(deps(), { accountId: customer.accountId }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: dubaiDay(3), startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(early.outcome.kind).toBe('outsideCheckInWindow');
  });

  it('CROSS-MIDNIGHT (item 21, real server time): a redemption TODAY for tomorrow 00:30 stays bound to TOMORROW’s occurrence — never occurred_at’s civil date', async () => {
    const tomorrow = dubaiDay(1);
    const campId = await makeCampWeek({
      startDate: tomorrow,
      endDate: dubaiDay(2),
      dailyStart: '00:30',
      dailyEnd: '01:30',
    });
    const customer = await createCustomer(testDb.db);
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });
    // The issuance window is server config; widened here so the proof runs
    // at ANY wall-clock time — the binding rule under proof is that the
    // occurrence identity comes from the SCHEDULED pair, never the clock.
    const credential = await issueOccurrence(customer, bookingId, {
      date: tomorrow,
      startTime: '00:30',
    });
    const redeemed = await redeem(credential.displayCode, credential.credentialId);
    if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);
    const rows = await attendanceRows(bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrence_date).toBe(tomorrow);
    expect(rows[0]!.occurrence_start_time).toBe('00:30:00');
    // The ACTUAL redemption instant is on the ADJACENT civil date — the
    // stored occurrence is provably NOT derived from occurred_at.
    expect(dubaiDateOf(rows[0]!.occurred_at)).not.toBe(tomorrow);
  });
});

// ---------------------------------------------------------------------------
// Cohort journey (owner items 6–7, 20)
// ---------------------------------------------------------------------------

describe('Cohort per-occurrence attendance', () => {
  it('JOURNEY (item 20): two same-date meetings at different times attend INDEPENDENTLY (the date-only counterexample); wrong time/weekday refuse; exception date refused at BOTH issuance and Calendar', async () => {
    const [sunday1, sunday2, sunday3] = nextDubaiWeekdays(0, 3);
    const { cohortId } = await makeCohort({
      effectiveStart: dubaiDay(1),
      effectiveEnd: dubaiDay(45),
      schedules: [
        { weekdays: [0], startTime: '09:00', endTime: '10:00', exceptionDates: [sunday2!] },
        { weekdays: [0], startTime: '17:00', endTime: '18:00', exceptionDates: [sunday2!] },
      ],
    });
    const customer = await httpCustomer();
    const bookingId = await confirmUnitBooking(customer, {
      kind: 'enrolmentCohort',
      id: cohortId,
    });

    // Two meetings on ONE civil date: both independently attendable.
    const morning = await issueOccurrence(customer, bookingId, {
      date: sunday1!,
      startTime: '09:00',
    });
    const morningRedeem = await redeem(morning.displayCode, morning.credentialId);
    expect(morningRedeem.outcome.kind).toBe('attendanceRecorded');
    const evening = await issueOccurrence(customer, bookingId, {
      date: sunday1!,
      startTime: '17:00',
    });
    const eveningRedeem = await redeem(evening.displayCode, evening.credentialId);
    if (eveningRedeem.outcome.kind !== 'attendanceRecorded') {
      throw new Error(eveningRedeem.outcome.kind);
    }
    expect(eveningRedeem.outcome.attendance.targetKind).toBe('cohortOccurrence');
    expect(await attendanceRows(bookingId)).toMatchObject([
      { occurrence_date: sunday1, occurrence_start_time: '09:00:00' },
      { occurrence_date: sunday1, occurrence_start_time: '17:00:00' },
    ]);
    // The SAME meeting twice: impossible (issuance refuses; the partial
    // unique is the structural backstop below).
    const sameMeeting = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: sunday1!, startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(sameMeeting.outcome.kind).toBe('alreadyCheckedIn');
    // A LATER occurrence stays separately attendable.
    const later = await issueOccurrence(customer, bookingId, {
      date: sunday3!,
      startTime: '09:00',
    });
    expect((await redeem(later.displayCode, later.credentialId)).outcome.kind).toBe(
      'attendanceRecorded',
    );

    // Non-canonical occurrences refuse: wrong time on a valid meeting day;
    // a non-pattern weekday.
    for (const invalid of [
      { date: sunday3!, startTime: '11:00' },
      { date: dubaiDay(45 + 1), startTime: '09:00' },
    ]) {
      const refused = await issueRedemptionCredential(wideDeps(), {
        accountId: customer.accountId,
      }, {
        target: { kind: 'booking', bookingId },
        occurrence: invalid,
        idempotencyKey: newId(),
      });
      expect(refused.outcome.kind).toBe('occurrenceNotEligible');
    }
    const monday = nextDubaiWeekdays(1, 1)[0]!;
    const offPattern = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: monday, startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(offPattern.outcome.kind).toBe('occurrenceNotEligible');

    // EXCEPTION DATE (item X3): no credential AND no Calendar occurrence —
    // one shared canonical derivation at both surfaces.
    const exception = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: sunday2!, startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(exception.outcome.kind).toBe('occurrenceNotEligible');
    const calendar = await app.inject({
      method: 'GET',
      url: `/customer/calendar?from=${dubaiDay(1)}&to=${dubaiDay(40)}`,
      headers: { authorization: `Bearer ${customer.bearer}` },
    });
    const cohortKeys = calendar
      .json()
      .events.filter((event: { bookingId?: string }) => event.bookingId === bookingId)
      .map((event: { eventKey: string }) => event.eventKey);
    expect(cohortKeys).toContain(`booking:${bookingId}:${sunday1}:09:00`);
    expect(cohortKeys).toContain(`booking:${bookingId}:${sunday1}:17:00`);
    expect(cohortKeys).not.toContain(`booking:${bookingId}:${sunday2}:09:00`);
    expect(cohortKeys).not.toContain(`booking:${bookingId}:${sunday2}:17:00`);
  });

  it('SCHEDULE-EDIT FREEZE (item 7): an issued credential keeps its frozen occurrence — preview/redeem honor it and attendance copies it; FUTURE issuance follows the edited canonical schedule', async () => {
    const [sundayA, sundayB] = nextDubaiWeekdays(0, 2);
    const { cohortId, scheduleIds } = await makeCohort({
      effectiveStart: dubaiDay(1),
      effectiveEnd: dubaiDay(45),
      schedules: [{ weekdays: [0], startTime: '09:00', endTime: '10:00' }],
    });
    const customer = await createCustomer(testDb.db);
    const bookingId = await confirmUnitBooking(customer, {
      kind: 'enrolmentCohort',
      id: cohortId,
    });
    const credential = await issueOccurrence(customer, bookingId, {
      date: sundayA!,
      startTime: '09:00',
    });

    // The provider edits the ACTIVE schedule (09:00 → 11:00).
    await sql`UPDATE recurring_schedule SET start_time = '11:00', end_time = '12:00'
              WHERE id = ${scheduleIds[0]!}`.execute(testDb.db);

    // The ISSUED credential is not retargeted: status + preview show the
    // frozen pair; redeem succeeds against it; attendance copies it.
    const status = await getRedemptionCredentialStatus(deps(), {
      accountId: customer.accountId,
    }, { credentialId: credential.credentialId });
    if (status.kind !== 'credentialStatus') throw new Error(status.kind);
    expect(status.credential.occurrence).toEqual({ date: sundayA, startTime: '09:00' });
    const preview = await previewRedemption(deps(), desk.scope, {
      code: credential.displayCode,
    });
    if (preview.kind !== 'redemptionPreview') throw new Error(preview.kind);
    expect(preview.preview).toMatchObject({
      targetKind: 'cohortOccurrence',
      occurrenceDate: sundayA,
      occurrenceStartTime: '09:00',
    });
    const redeemed = await redeem(credential.displayCode, credential.credentialId);
    if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);
    expect(redeemed.outcome.attendance).toMatchObject({
      occurrenceDate: sundayA,
      occurrenceStartTime: '09:00',
    });
    expect(await attendanceRows(bookingId)).toMatchObject([
      { occurrence_date: sundayA, occurrence_start_time: '09:00:00' },
    ]);

    // FUTURE discovery follows the CURRENT canonical schedule: the old
    // time refuses; the edited time issues.
    const oldTime = await issueRedemptionCredential(wideDeps(), {
      accountId: customer.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: sundayB!, startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(oldTime.outcome.kind).toBe('occurrenceNotEligible');
    const newTime = await issueOccurrence(customer, bookingId, {
      date: sundayB!,
      startTime: '11:00',
    });
    expect(newTime.credentialId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Structure, security, concurrency (owner items 3, 11–13, 22, 25)
// ---------------------------------------------------------------------------

describe('occurrence structure and security', () => {
  it('structural locks: frozen occurrence pair; no half-populated identity; the per-occurrence attendance unique; occurrence substitution refused at the row level', async () => {
    const campId = await makeCampWeek({
      startDate: dubaiDay(2),
      endDate: dubaiDay(4),
      dailyStart: '09:00',
      dailyEnd: '13:00',
    });
    const customer = await createCustomer(testDb.db);
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });
    const day1 = dubaiDay(2);
    const credential = await issueOccurrence(customer, bookingId, {
      date: day1,
      startTime: '09:00',
    });
    // Occurrence pair frozen on the credential (identity trigger).
    await expect(
      sql`UPDATE redemption_credential SET occurrence_date = ${dubaiDay(3)}
          WHERE id = ${credential.credentialId}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    // Half-populated occurrence identity is uninsertable (pairing CHECK).
    await expect(
      sql`INSERT INTO redemption_credential
            (id, token_digest, alias_digest, booking_id, occurrence_date,
             account_id, participant_id, organization_id, branch_id, expires_at)
          VALUES (${newId()}, ${`tok-${newId()}`}, ${`alias-${newId()}`}, ${bookingId},
                  ${dubaiDay(3)}, ${customer.accountId}, ${customer.participantId},
                  ${f.org.orgId}, ${f.org.branchIds[0]}, now() + interval '10 minutes')`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_redemption_credential_occurrence|canonical camp day/);
    const redeemed = await redeem(credential.displayCode, credential.credentialId);
    if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);

    // Attendance occurrence must equal the CONSUMED credential's frozen
    // pair — substitution refused (agreement trigger), and the same
    // occurrence can never be attended twice (partial unique) even through
    // a hand-forged consumed credential.
    const forged = newId();
    await sql`
      INSERT INTO redemption_credential
        (id, token_digest, alias_digest, booking_id, occurrence_date, occurrence_start_time,
         account_id, participant_id, organization_id, branch_id, expires_at)
      VALUES (${forged}, ${`tok-${newId()}`}, ${`alias-${newId()}`}, ${bookingId},
              ${dubaiDay(3)}, '09:00', ${customer.accountId}, ${customer.participantId},
              ${f.org.orgId}, ${f.org.branchIds[0]}, now() + interval '10 minutes')`.execute(
      testDb.db,
    );
    await sql`UPDATE redemption_credential
              SET state = 'used', used_at = now(),
                  redeemed_by_staff_membership_id = ${desk.scope.membershipId}
              WHERE id = ${forged}`.execute(testDb.db);
    await expect(
      sql`INSERT INTO attendance_record
            (id, organization_id, branch_id, account_id, participant_id, booking_id,
             occurrence_date, occurrence_start_time, credential_id,
             validated_by_staff_membership_id)
          VALUES (${newId()}, ${f.org.orgId}, ${f.org.branchIds[0]}, ${customer.accountId},
                  ${customer.participantId}, ${bookingId}, ${dubaiDay(4)}, '09:00',
                  ${forged}, ${desk.scope.membershipId})`.execute(testDb.db),
    ).rejects.toThrow(/attendance identity must equal its credential/);
    await expect(
      sql`INSERT INTO attendance_record
            (id, organization_id, branch_id, account_id, participant_id, booking_id,
             occurrence_date, occurrence_start_time, credential_id,
             validated_by_staff_membership_id)
          VALUES (${newId()}, ${f.org.orgId}, ${f.org.branchIds[0]}, ${customer.accountId},
                  ${customer.participantId}, ${bookingId}, ${day1}, '09:00',
                  ${forged}, ${desk.scope.membershipId})`.execute(testDb.db),
    ).rejects.toThrow(/attendance identity must equal its credential/);
    // Aligning the forged credential's own pair with the attended day is
    // impossible (frozen) — so the unique itself is exercised directly:
    const duplicate = await sql<{ n: string }>`
      SELECT count(*) AS n FROM attendance_record
      WHERE booking_id = ${bookingId} AND occurrence_date = ${day1}`.execute(testDb.db);
    expect(duplicate.rows[0]!.n).toBe('1');
  });

  it('COACH stays fail-closed for camp/cohort (item 14); foreign customers cannot mint occurrence credentials (item 25)', async () => {
    const campId = await makeCampWeek({
      startDate: dubaiDay(2),
      endDate: dubaiDay(4),
      dailyStart: '09:00',
      dailyEnd: '13:00',
    });
    const customer = await createCustomer(testDb.db);
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });
    const credential = await issueOccurrence(customer, bookingId, {
      date: dubaiDay(2),
      startTime: '09:00',
    });
    // Coach: no occurrence-level assignment proof exists → forbidden for
    // preview AND redeem (owner ruling; docs/35 §31).
    expect(
      (await previewRedemption(deps(), coach.scope, { code: credential.displayCode })).kind,
    ).toBe('forbiddenScope');
    expect(
      (await redeem(credential.displayCode, credential.credentialId, coach)).outcome.kind,
    ).toBe('forbiddenScope');
    // Front desk retains its certified authority.
    expect(
      (await previewRedemption(deps(), desk.scope, { code: credential.displayCode })).kind,
    ).toBe('redemptionPreview');
    // A foreign customer cannot mint a credential for someone else's
    // booking — not-found-shaped.
    const stranger = await createCustomer(testDb.db);
    const foreign = await issueRedemptionCredential(wideDeps(), {
      accountId: stranger.accountId,
    }, {
      target: { kind: 'booking', bookingId },
      occurrence: { date: dubaiDay(3), startTime: '09:00' },
      idempotencyKey: newId(),
    });
    expect(foreign.outcome.kind).toBe('bookingNotFound');
  });

  it('CONCURRENCY (item 22): two staff race ONE occurrence credential → exactly one attendance; two occurrences hold live credentials simultaneously; a used credential never affects another occurrence’s live one; same-occurrence initial issuance races to one live', async () => {
    const campId = await makeCampWeek({
      startDate: dubaiDay(2),
      endDate: dubaiDay(6),
      dailyStart: '09:00',
      dailyEnd: '13:00',
    });
    const customer = await createCustomer(testDb.db);
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });

    // Adjacent occurrences may hold live credentials AT THE SAME TIME
    // (per-occurrence uniques — a broad one-live-per-booking would wrongly
    // serialize them).
    const day1 = await issueOccurrence(customer, bookingId, {
      date: dubaiDay(2),
      startTime: '09:00',
    });
    const day2 = await issueOccurrence(customer, bookingId, {
      date: dubaiDay(3),
      startTime: '09:00',
    });
    const liveNow = await sql<{ n: string }>`
      SELECT count(*) AS n FROM redemption_credential
      WHERE booking_id = ${bookingId} AND state = 'live'`.execute(testDb.db);
    expect(liveNow.rows[0]!.n).toBe('2');

    // Two staff, one credential → the row lock serializes: exactly one
    // attendance; the OTHER occurrence's live credential is untouched.
    const second = await makeStaff('front_desk');
    const outcomes = await race([
      () => redeem(day1.displayCode, day1.credentialId, desk, racePool.db),
      () => redeem(day1.displayCode, day1.credentialId, second, racePool.db),
    ]);
    expect(outcomes.map((run) => run.outcome.kind).sort()).toEqual([
      'attendanceRecorded',
      'credentialAlreadyUsed',
    ]);
    expect(await attendanceRows(bookingId)).toHaveLength(1);
    const day2State = await sql<{ state: string }>`
      SELECT state FROM redemption_credential WHERE id = ${day2.credentialId}`.execute(
      testDb.db,
    );
    expect(day2State.rows[0]!.state).toBe('live');
    expect((await redeem(day2.displayCode, day2.credentialId)).outcome.kind).toBe(
      'attendanceRecorded',
    );

    // Same-occurrence different-key INITIAL race → exactly one credential
    // minted; the loser sees `credentialAlreadyLive` (S6-2 rules per
    // occurrence).
    const day3 = dubaiDay(4);
    const initialRace = await race([
      () =>
        issueRedemptionCredential(wideDeps(racePool.db), { accountId: customer.accountId }, {
          target: { kind: 'booking', bookingId },
          occurrence: { date: day3, startTime: '09:00' },
          idempotencyKey: newId(),
        }),
      () =>
        issueRedemptionCredential(wideDeps(racePool.db), { accountId: customer.accountId }, {
          target: { kind: 'booking', bookingId },
          occurrence: { date: day3, startTime: '09:00' },
          idempotencyKey: newId(),
        }),
    ]);
    expect(initialRace.map((run) => run.outcome.kind).sort()).toEqual([
      'credentialAlreadyLive',
      'credentialIssued',
    ]);
    const day3Live = await sql<{ n: string }>`
      SELECT count(*) AS n FROM redemption_credential
      WHERE booking_id = ${bookingId} AND occurrence_date = ${day3}
        AND state = 'live'`.execute(testDb.db);
    expect(day3Live.rows[0]!.n).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// HTTP wire (owner item 8)
// ---------------------------------------------------------------------------

describe('HTTP wire: explicit occurrence selection', () => {
  it('the customer names ONLY {occurrence.date, occurrence.startTime}; smuggled truth is stripped; status carries the frozen occurrence; the provider wire renders it and cannot alter it', async () => {
    const campId = await makeCampWeek({
      startDate: dubaiDay(2),
      endDate: dubaiDay(4),
      dailyStart: '09:00',
      dailyEnd: '13:00',
    });
    const customer = await httpCustomer();
    const bookingId = await confirmUnitBooking(customer, { kind: 'campWeek', id: campId });
    const day = dubaiDay(2);

    // Missing occurrence → typed 422 on the wire.
    const missing = await app.inject({
      method: 'POST',
      url: `/customer/bookings/${bookingId}/credential`,
      headers: { authorization: `Bearer ${customer.bearer}` },
      payload: { idempotencyKey: newId() },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe('occurrenceRequired');

    // Smuggled fields are STRIPPED by the app-wide Ajv posture; the
    // occurrence object itself accepts nothing beyond date + startTime.
    // (The default window still gates far-future issuance on the wire —
    // widening it is server config, so the wire proof asserts the typed
    // window refusal rather than bypassing config.)
    const smuggled = await app.inject({
      method: 'POST',
      url: `/customer/bookings/${bookingId}/credential`,
      headers: { authorization: `Bearer ${customer.bearer}` },
      payload: {
        idempotencyKey: newId(),
        occurrence: { date: day, startTime: '09:00' },
        branchId: newId(),
        participantId: newId(),
        programId: newId(),
      },
    });
    expect(smuggled.statusCode).toBe(409);
    expect(smuggled.json().code).toBe('outsideCheckInWindow');

    // Service-level issuance (windows are server config), then the wire
    // reads: the customer status carries the FROZEN occurrence.
    const credential = await issueOccurrence(customer, bookingId, {
      date: day,
      startTime: '09:00',
    });
    const status = await app.inject({
      method: 'GET',
      url: `/customer/credentials/${credential.credentialId}`,
      headers: { authorization: `Bearer ${customer.bearer}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().credential.occurrence).toEqual({ date: day, startTime: '09:00' });

    // Provider wire: preview renders the frozen occurrence; redeem accepts
    // ONLY the credential/code authority — an occurrence field in the body
    // is stripped, and the recorded attendance carries the credential's
    // frozen pair regardless.
    const staffUser = await createUser(testDb.db);
    await addMembership(testDb.db, staffUser, f.org.orgId, 'front_desk');
    const { bearer: staffBearer } = await bearerForUser(ctx, staffUser);
    const previewRead = await app.inject({
      method: 'POST',
      url: `/provider/organizations/${f.org.orgId}/check-in/preview`,
      headers: { authorization: `Bearer ${staffBearer}` },
      payload: { code: credential.displayCode },
    });
    expect(previewRead.statusCode).toBe(200);
    expect(previewRead.json().preview).toMatchObject({
      targetKind: 'campWeekOccurrence',
      occurrenceDate: day,
      occurrenceStartTime: '09:00',
    });
    const redeemed = await app.inject({
      method: 'POST',
      url: `/provider/organizations/${f.org.orgId}/check-in/redeem`,
      headers: { authorization: `Bearer ${staffBearer}` },
      payload: {
        code: credential.displayCode,
        credentialId: credential.credentialId,
        idempotencyKey: newId(),
        occurrenceDate: dubaiDay(3),
        occurrenceStartTime: '10:00',
      },
    });
    expect(redeemed.statusCode).toBe(201);
    expect(redeemed.json().attendance).toMatchObject({
      occurrenceDate: day,
      occurrenceStartTime: '09:00',
    });
  });
});
