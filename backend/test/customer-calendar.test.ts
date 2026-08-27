/**
 * S6-3 — the unified customer calendar (docs/35 §12; owner items 17–20,
 * 34–37, 44). Real PostgreSQL + real Fastify transport.
 *
 * The item-44 deterministic proof: one customer holding a normal confirmed
 * Session Booking, a reserved package Session, a flexible unscheduled
 * package, and a recurring membership with immutable Mon/Wed schedule
 * terms — the bounded calendar shows the Booking once, the reserved
 * Session ONCE (annotated, never duplicated from the reservation), zero
 * dates from the unscheduled package, only Mon/Wed membership occurrences
 * inside validity ∩ range, and a LATER provider schedule revision changes
 * nothing. Plus: CampWeek span representation (per-day attendance
 * occurrences are NOT invented — item 22), Cohort pattern expansion from
 * `enrolment_cohort_schedule` minus exception dates (item 23), stable
 * derived event keys, Asia/Dubai civil-date determinism, range bounding,
 * and read-only behavior (item 37).
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
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import {
  confirmEntitlementReservation,
  requestEntitlementReservationQuote,
} from '../src/modules/entitlement/services/entitlement-reservation';
import { setFulfillmentConfig } from '../src/modules/entitlement/services/fulfillment-admin';
import {
  dubaiDateOf,
  dubaiWeekdayOf,
} from '../src/modules/entitlement/services/entitlement-read';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createFulfillmentRevision,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/customer-calendar-pool';
const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;

const deps = () => ({ db: testDb.db });

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
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(url: string, bearer: string | null) {
  return app.inject({
    method: 'GET',
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
  });
}

async function httpCustomer(): Promise<Customer & { bearer: string }> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const participantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, participantId, bearer };
}

async function acquire(customer: Customer, optionId: string): Promise<string> {
  const quote = await requestEntitlementQuote(deps(), { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const run = await confirmFreeEntitlementPurchase(deps(), { accountId: customer.accountId }, {
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'purchaseConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.purchase.entitlement!.entitlementId;
}

async function freeCapacityBooking(
  customer: Customer,
  unit: { kind: 'session' | 'campWeek' | 'enrolmentCohort'; id: string },
  optionId: string,
): Promise<string> {
  const quote = await requestQuote(deps(), { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
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

async function reserve(
  customer: Customer,
  entitlementId: string,
  sessionId: string,
): Promise<string> {
  const quote = await requestEntitlementReservationQuote(deps(), {
    accountId: customer.accountId,
  }, { entitlementId, sessionId });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold(deps(), { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const run = await confirmEntitlementReservation(deps(), { accountId: customer.accountId }, {
    holdId: hold.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'reservationConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.reservation.bookingId;
}

/** The next civil date (Dubai) with the given weekday, at least `minDays`
 *  ahead of now — deterministic against the running clock. */
function nextDubaiWeekday(weekday: number, minDays = 2): string {
  let cursor = new Date(Date.now() + minDays * DAY_MS);
  for (let i = 0; i < 8; i += 1) {
    const date = dubaiDateOf(cursor);
    if (dubaiWeekdayOf(date) === weekday) return date;
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  throw new Error('unreachable');
}

/** The instant of a Dubai civil date at HH:MM (fixed +04:00). */
function instantAt(date: string, time: string): Date {
  return new Date(new Date(`${date}T${time}:00.000Z`).getTime() - 4 * 60 * 60 * 1000);
}

describe('the item-44 deterministic calendar proof', () => {
  it('booking once · reserved session once (annotated) · unscheduled package zero · membership Mon/Wed only · later provider revision changes NOTHING', async () => {
    const customer = await httpCustomer();
    const rangeFrom = dubaiDateOf(new Date(Date.now() + 1 * DAY_MS));
    const rangeTo = dubaiDateOf(new Date(Date.now() + 29 * DAY_MS));

    // 1. A normal confirmed Session Booking (free capacity, Tuesday 18:00).
    const freeOption = await createPriceOption(f, { kind: 'free' });
    const tuesday = nextDubaiWeekday(2, 3);
    const bookedStart = instantAt(tuesday, '18:00');
    const bookedSession = await createSession(f, {
      start_at: bookedStart,
      end_at: new Date(bookedStart.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: bookedStart,
    });
    const normalBooking = await freeCapacityBooking(
      customer,
      { kind: 'session', id: bookedSession },
      freeOption,
    );

    // 2. A reserved package Session (Wednesday 19:00 — a membership-pattern
    //    day, proving the dedup below).
    const packOption = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 3,
    });
    await createFulfillmentRevision(f, packOption, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 40,
      reservationRequired: true,
      walkInAllowed: true,
    });
    const packEntitlement = await acquire(customer, packOption);
    const reservedWednesday = nextDubaiWeekday(3, 4);
    const reservedStart = instantAt(reservedWednesday, '19:00');
    const reservedSession = await createSession(f, {
      start_at: reservedStart,
      end_at: new Date(reservedStart.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: reservedStart,
    });
    const reservedBooking = await reserve(customer, packEntitlement, reservedSession);

    // 3. A flexible UNSCHEDULED package — zero calendar dates.
    const flexOption = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 10,
    });
    await createFulfillmentRevision(f, flexOption, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 60,
      reservationRequired: false,
      walkInAllowed: true,
    });
    const flexEntitlement = await acquire(customer, flexOption);

    // 4. A recurring membership with IMMUTABLE Mon/Wed 19:00–20:00 terms
    //    (via the real W2-13 fulfillment service — the purchased snapshot).
    const membershipOption = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
    const ownerScope: OrgScope = {
      organizationId: f.org.orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const configured = await setFulfillmentConfig(deps(), ownerScope, { userId: newId() }, {
      programId: f.programId,
      optionId: membershipOption,
      terms: {
        usageKind: 'unlimited',
        validityKind: 'daysFromConfirmation',
        validityDays: 21,
        reservationRequired: false,
        walkInAllowed: true,
        scheduleTerms: [
          { weekday: 1, startTime: '19:00', endTime: '20:00' },
          { weekday: 3, startTime: '19:00', endTime: '20:00' },
        ],
      },
    });
    if (configured.kind !== 'revisionCreated') throw new Error(configured.kind);
    const membershipEntitlement = await acquire(customer, membershipOption);

    const read = await inject(
      `/customer/calendar?from=${rangeFrom}&to=${rangeTo}`,
      customer.bearer,
    );
    expect(read.statusCode).toBe(200);
    const events: Array<{
      eventKey: string;
      sourceType: string;
      context: string;
      startAt: string;
      endAt: string;
      bookingId?: string;
      entitlementId?: string;
      program: { id: string };
    }> = read.json().events;

    // The normal Booking appears exactly once.
    const normalEvents = events.filter((event) => event.bookingId === normalBooking);
    expect(normalEvents).toHaveLength(1);
    expect(normalEvents[0]).toMatchObject({
      eventKey: `booking:${normalBooking}`,
      sourceType: 'sessionBooking',
      context: 'booked',
      startAt: bookedStart.toISOString(),
    });

    // The reserved package Session appears ONCE — as its Booking, annotated
    // as included through the pass; NEVER a second event from the
    // reservation subtype.
    const reservedEvents = events.filter((event) => event.bookingId === reservedBooking);
    expect(reservedEvents).toHaveLength(1);
    expect(reservedEvents[0]).toMatchObject({
      sourceType: 'sessionBooking',
      context: 'reservedWithPass',
      entitlementId: packEntitlement,
      startAt: reservedStart.toISOString(),
    });

    // The flexible unscheduled package contributes ZERO dates.
    expect(events.some((event) => event.entitlementId === flexEntitlement)).toBe(false);

    // Membership occurrences: ONLY Mon/Wed civil dates (Asia/Dubai), only
    // inside validity ∩ range, at exactly 19:00 +04 (15:00Z).
    const membershipEvents = events.filter(
      (event) => event.sourceType === 'membershipOccurrence',
    );
    expect(membershipEvents.length).toBeGreaterThan(0);
    for (const event of membershipEvents) {
      expect(event.entitlementId).toBe(membershipEntitlement);
      const date = dubaiDateOf(new Date(event.startAt));
      expect([1, 3]).toContain(dubaiWeekdayOf(date));
      expect(event.startAt.endsWith('T15:00:00.000Z')).toBe(true);
      expect(event.endAt.endsWith('T16:00:00.000Z')).toBe(true);
      expect(event.eventKey).toBe(`entitlement:${membershipEntitlement}:${date}:19:00`);
    }
    // Validity bound: nothing past valid_until (21 days) even though the
    // requested range runs 29 days out.
    const lastMembership = membershipEvents[membershipEvents.length - 1]!;
    expect(new Date(lastMembership.startAt).getTime()).toBeLessThan(
      Date.now() + 21 * DAY_MS,
    );

    // DEDUP (items 19–20): the reserved Wednesday carries the REAL Booking
    // only — the derived membership occurrence for that same participant/
    // program/day is suppressed, and the reserved Session never shows twice.
    expect(
      membershipEvents.some(
        (event) => dubaiDateOf(new Date(event.startAt)) === reservedWednesday,
      ),
    ).toBe(false);

    // IMMUTABILITY (items 17, 44): the provider later revises the product
    // to Tue/Thu — the EXISTING customer's calendar is unchanged.
    const revised = await setFulfillmentConfig(deps(), ownerScope, { userId: newId() }, {
      programId: f.programId,
      optionId: membershipOption,
      terms: {
        usageKind: 'unlimited',
        validityKind: 'daysFromConfirmation',
        validityDays: 21,
        reservationRequired: false,
        walkInAllowed: true,
        scheduleTerms: [
          { weekday: 2, startTime: '07:00', endTime: '08:00' },
          { weekday: 4, startTime: '07:00', endTime: '08:00' },
        ],
      },
    });
    if (revised.kind !== 'revisionCreated') throw new Error(revised.kind);
    const reread = await inject(
      `/customer/calendar?from=${rangeFrom}&to=${rangeTo}`,
      customer.bearer,
    );
    expect(reread.json().events).toEqual(read.json().events);

    // STABLE KEYS (item 20): two reads derive identical identities.
    expect(
      reread.json().events.map((event: { eventKey: string }) => event.eventKey),
    ).toEqual(events.map((event) => event.eventKey));
  });
});

describe('CampWeek and Cohort representation (items 21–23)', () => {
  it('a CampWeek Booking is its canonical SPAN with daily times — per-day attendance occurrences are not invented', async () => {
    const customer = await httpCustomer();
    const campOption = await createPriceOption(f, { kind: 'free' });
    const startDate = dubaiDateOf(new Date(Date.now() + 7 * DAY_MS));
    const endDate = dubaiDateOf(new Date(Date.now() + 11 * DAY_MS));
    const campId = newId();
    await sql`
      INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date, end_date,
                             daily_start_time, daily_end_time, capacity,
                             registration_cutoff_at, state)
      VALUES (${campId}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
              ${startDate}, ${endDate}, '09:00', '13:00', 10,
              now() + interval '6 days', 'open')`.execute(testDb.db);
    const bookingId = await freeCapacityBooking(
      customer,
      { kind: 'campWeek', id: campId },
      campOption,
    );

    const from = dubaiDateOf(new Date(Date.now() + 1 * DAY_MS));
    const to = dubaiDateOf(new Date(Date.now() + 20 * DAY_MS));
    const read = await inject(`/customer/calendar?from=${from}&to=${to}`, customer.bearer);
    const campEvents = read
      .json()
      .events.filter((event: { bookingId?: string }) => event.bookingId === bookingId);
    expect(campEvents).toHaveLength(1);
    expect(campEvents[0]).toMatchObject({
      eventKey: `booking:${bookingId}`,
      sourceType: 'campWeekBooking',
      context: 'booked',
      span: {
        startDate,
        endDate,
        dailyStartTime: '09:00',
        dailyEndTime: '13:00',
      },
    });
  });

  it('a Cohort Booking expands ONLY from its canonical meeting pattern (cohort ⇄ recurring_schedule) minus exception dates', async () => {
    const customer = await httpCustomer();
    const monthlyOption = await createPriceOption(f, { kind: 'free' });
    const cohortStart = dubaiDateOf(new Date(Date.now() + 2 * DAY_MS));
    const cohortEnd = dubaiDateOf(new Date(Date.now() + 30 * DAY_MS));
    // The pattern: Sundays 10:00–11:00, with ONE exception date skipped.
    const exceptionDate = nextDubaiWeekday(0, 9);
    const scheduleId = newId();
    await sql`
      INSERT INTO recurring_schedule (id, program_id, organization_id, weekdays, start_time,
                                      end_time, timezone, effective_start, effective_end,
                                      exception_dates)
      VALUES (${scheduleId}, ${f.programId}, ${f.org.orgId}, '{0}', '10:00', '11:00',
              'Asia/Dubai', ${cohortStart}, ${cohortEnd},
              ARRAY[${exceptionDate}]::date[])`.execute(testDb.db);
    const cohortId = newId();
    await sql`
      INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                    effective_start, effective_end, capacity,
                                    enrolment_cutoff_at, state)
      VALUES (${cohortId}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
              ${cohortStart}, ${cohortEnd}, 12, now() + interval '20 days', 'open')`.execute(
      testDb.db,
    );
    await sql`
      INSERT INTO enrolment_cohort_schedule (cohort_id, schedule_id, program_id)
      VALUES (${cohortId}, ${scheduleId}, ${f.programId})`.execute(testDb.db);
    const bookingId = await freeCapacityBooking(
      customer,
      { kind: 'enrolmentCohort', id: cohortId },
      monthlyOption,
    );

    const from = dubaiDateOf(new Date(Date.now() + 1 * DAY_MS));
    const to = dubaiDateOf(new Date(Date.now() + 28 * DAY_MS));
    const read = await inject(`/customer/calendar?from=${from}&to=${to}`, customer.bearer);
    const cohortEvents: Array<{ eventKey: string; startAt: string }> = read
      .json()
      .events.filter(
        (event: { sourceType: string; bookingId?: string }) =>
          event.sourceType === 'cohortOccurrence' && event.bookingId === bookingId,
      );
    expect(cohortEvents.length).toBeGreaterThan(1);
    for (const event of cohortEvents) {
      const date = dubaiDateOf(new Date(event.startAt));
      expect(dubaiWeekdayOf(date)).toBe(0); // Sundays only
      expect(date).not.toBe(exceptionDate); // the exception is skipped
      expect(event.eventKey).toBe(`booking:${bookingId}:${date}:10:00`);
      expect(event.startAt.endsWith('T06:00:00.000Z')).toBe(true); // 10:00 +04
    }
  });
});

describe('bounds and read-only shape (items 18, 34, 36–37)', () => {
  it('requires a bounded range: reversed and over-maximum ranges refuse typed; the read never mutates', async () => {
    const customer = await httpCustomer();
    const reversed = await inject(
      '/customer/calendar?from=2026-10-10&to=2026-10-01',
      customer.bearer,
    );
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().code).toBe('invalidRange');
    const tooWide = await inject(
      '/customer/calendar?from=2026-09-01&to=2026-12-31',
      customer.bearer,
    );
    expect(tooWide.statusCode).toBe(400);

    const before = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event`.execute(testDb.db);
    const ok = await inject('/customer/calendar?from=2026-09-01&to=2026-09-30', customer.bearer);
    expect(ok.statusCode).toBe(200);
    const after = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event`.execute(testDb.db);
    // A pure read: no audit/domain mutation of any kind.
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('the event shape is customer-safe: no capacity counters, schedule ids, payment economics, or staff identifiers', async () => {
    const customer = await httpCustomer();
    const freeOption = await createPriceOption(f, { kind: 'free' });
    const start = new Date(Date.now() + 3 * DAY_MS);
    const sessionId = await createSession(f, {
      start_at: start,
      end_at: new Date(start.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: start,
    });
    await freeCapacityBooking(customer, { kind: 'session', id: sessionId }, freeOption);
    const from = dubaiDateOf(new Date(Date.now() + 1 * DAY_MS));
    const to = dubaiDateOf(new Date(Date.now() + 10 * DAY_MS));
    const read = await inject(`/customer/calendar?from=${from}&to=${to}`, customer.bearer);
    expect(read.statusCode).toBe(200);
    expect(read.json().events.length).toBeGreaterThan(0);
    expect(read.body).not.toMatch(/capacity|booked_count|heldCount|booked" ?:|scheduleId/i);
    expect(read.body).not.toMatch(/commission|economics|staff|intent|digest|token/i);
    // Unauthenticated and cross-account: nothing leaks.
    expect((await inject(`/customer/calendar?from=${from}&to=${to}`, null)).statusCode).toBe(401);
    const stranger = await httpCustomer();
    const foreign = await inject(`/customer/calendar?from=${from}&to=${to}`, stranger.bearer);
    expect(foreign.json().events).toEqual([]);
  });
});
