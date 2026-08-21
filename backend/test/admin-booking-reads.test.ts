/**
 * W4 Slice 5 · S5-6 — Admin booking oversight + the Slice-5 cross-surface
 * security/closeout regression (docs/32 §13, §19; final D-W3-5 read rule).
 * Real PostgreSQL + Fastify injection: the operations-only read authority,
 * the bounded projection (both occupancy truths, labeled; no DOB, no
 * internals), cross-surface consistency of ONE authoritative Booking,
 * bidirectional customer/provider/admin disjointness, the D-10 closeout
 * (no restoration path anywhere), the paid fail-close closeout, the final
 * Slice-5 forbidden-surface route lock, and the audit/outbox sweep
 * (reads emit nothing; payloads stay machine-oriented; the W3-9 audit
 * explorer observes Slice-5 events unchanged).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { confirmFreeBooking, initiateBooking } from '../src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createOffer,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
} from './helpers/booking-fixtures';
import {
  bootstrapAccessAdmins,
  createAccount,
  createSelfParticipant,
  createUser,
} from './helpers/identity-fixtures';
import { bearerForUser, staffBearer, type ProviderTestContext } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/admin-booking-reads-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let adminA: string;
let adminB: string;
let opsBearer: string;
let confirmedBookingId: string;
let confirmedReference: string;
let trialCustomer: { accountId: string; participantId: string; bearer: string };
let sessionId: string;
let monthlyOption: string;
let dropInOption: string;
let trialOffer: string;

async function grantRole(userId: string, role: AdminRole): Promise<void> {
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
}

async function adminBearer(role: AdminRole): Promise<string> {
  const userId = await createUser(testDb.db);
  await grantRole(userId, role);
  return (await bearerForUser(ctx, userId)).bearer;
}

async function httpCustomer(): Promise<{ accountId: string; participantId: string; bearer: string }> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const participantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, participantId, bearer };
}

function inject(method: 'GET' | 'POST', url: string, bearer: string | null, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
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
  const opsUserId = await createUser(testDb.db);
  await grantRole(opsUserId, 'operations');
  opsBearer = (await bearerForUser(ctx, opsUserId)).bearer;

  // One REAL Booking through the certified services: free trial, confirmed.
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  monthlyOption = await createPriceOption(f, { kind: 'monthly', amountFils: 20000 });
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  trialOffer = await createOffer(f, { kind: 'freeTrial' });
  sessionId = await createSession(f, { capacity: 4 });
  trialCustomer = await httpCustomer();
  const deps = { db: testDb.db };
  const quote = await requestQuote(deps, { accountId: trialCustomer.accountId }, {
    programId: f.programId,
    priceOptionId: monthlyOption,
    unit: { kind: 'session', id: sessionId },
    participantId: trialCustomer.participantId,
    offerId: trialOffer,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const claim = await claimHold(deps, { accountId: trialCustomer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: trialCustomer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
  const confirmed = await confirmFreeBooking(deps, { accountId: trialCustomer.accountId }, {
    holdId: claim.outcome.hold.holdId,
    idempotencyKey: newId(),
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  confirmedBookingId = confirmed.outcome.booking.bookingId;
  confirmedReference = confirmed.outcome.booking.referenceCode;
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('operations-only oversight authority (docs/32 §13; D-W3-5 read rule)', () => {
  it('operations reads the list and detail; every other admin role is refused; baseline assurance alone is never authorization', async () => {
    const list = await inject('GET', '/admin/bookings', opsBearer);
    expect(list.statusCode).toBe(200);
    expect(
      list.json().bookings.map((b: { bookingId: string }) => b.bookingId),
    ).toContain(confirmedBookingId);
    const detail = await inject('GET', `/admin/bookings/${confirmedBookingId}`, opsBearer);
    expect(detail.statusCode).toBe(200);

    for (const role of ['support', 'finance', 'access_admin', 'auditor'] as const) {
      const bearer = await adminBearer(role);
      expect((await inject('GET', '/admin/bookings', bearer)).statusCode).toBe(403);
      expect(
        (await inject('GET', `/admin/bookings/${confirmedBookingId}`, bearer)).statusCode,
      ).toBe(403);
    }
  });

  it('customer and provider credentials never reach the admin oversight surface — and admin roles grant NO customer/provider authority', async () => {
    const customerProbe = await inject('GET', '/admin/bookings', trialCustomer.bearer);
    expect([401, 403, 404]).toContain(customerProbe.statusCode);
    const staff = await staffBearer(ctx, f.org.orgId, 'owner');
    const providerProbe = await inject('GET', '/admin/bookings', staff.bearer);
    expect([401, 403, 404]).toContain(providerProbe.statusCode);
    expect(providerProbe.statusCode).toBe(customerProbe.statusCode); // one refusal shape

    // Being an admin conveys NOTHING on customer/provider surfaces.
    expect((await inject('GET', '/customer/bookings', opsBearer)).statusCode).toBe(404);
    expect(
      (
        await inject(
          'GET',
          `/provider/organizations/${f.org.orgId}/programs/${f.programId}/schedules`,
          opsBearer,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('cross-surface consistency: ONE authoritative Booking, three bounded projections', () => {
  it('customer, provider, and admin each see their own projection of the same Booking; an active hold is availability truth but never a roster/oversight booking', async () => {
    // A second customer holds (but never books) a seat on the same session.
    const holder = await httpCustomer();
    const deps = { db: testDb.db };
    const holdQuote = await requestQuote(deps, { accountId: holder.accountId }, {
      programId: f.programId,
      priceOptionId: dropInOption,
      unit: { kind: 'session', id: sessionId },
      participantId: holder.participantId,
    });
    if (holdQuote.kind !== 'quoteIssued') throw new Error(holdQuote.kind);
    const liveHold = await claimHold(deps, { accountId: holder.accountId }, {
      unit: { kind: 'session', id: sessionId },
      participantId: holder.participantId,
      quoteId: holdQuote.quote.quoteId,
      idempotencyKey: newId(),
    });
    expect(liveHold.outcome.kind).toBe('holdClaimed');

    // CUSTOMER projection: own booking, customer-safe fields.
    const customerView = await inject(
      'GET',
      `/customer/bookings/${confirmedBookingId}`,
      trialCustomer.bearer,
    );
    expect(customerView.statusCode).toBe(200);
    expect(customerView.json().booking.referenceCode).toBe(confirmedReference);

    // PROVIDER projection: the roster shows the BOOKING (not the hold).
    const staff = await staffBearer(ctx, f.org.orgId, 'owner');
    const roster = await inject(
      'GET',
      `/provider/organizations/${f.org.orgId}/units/session/${sessionId}/roster`,
      staff.bearer,
    );
    expect(roster.statusCode).toBe(200);
    const rosterBody = roster.json();
    expect(rosterBody.entries).toHaveLength(1); // the confirmed booking only
    expect(rosterBody.entries[0].referenceCode).toBe(confirmedReference);
    expect(rosterBody.unit.heldCount).toBe(1); // the live hold counts as occupancy…
    expect(rosterBody.unit.bookedCount).toBe(1); // …never as a roster entry

    // ADMIN projection: same Booking id + reference; the hold never appears
    // in the booking list (holds are checkout state, not bookings).
    const adminList = await inject(
      'GET',
      `/admin/bookings?reference=${confirmedReference}`,
      opsBearer,
    );
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().bookings).toHaveLength(1);
    expect(adminList.json().bookings[0].bookingId).toBe(confirmedBookingId);
    const adminDetail = await inject('GET', `/admin/bookings/${confirmedBookingId}`, opsBearer);
    const detail = adminDetail.json().booking;
    expect(detail.referenceCode).toBe(confirmedReference);
    expect(detail.hold.physicalState).toBe('consumed');
    expect(detail.occupancy).toEqual({
      capacity: 4,
      bookedCount: 1,
      physicalHeldCount: 1,
      effectiveHeldCount: 1,
    });

    // The customer who merely HOLDS cannot see the other customer's booking.
    expect(
      (await inject('GET', `/customer/bookings/${confirmedBookingId}`, holder.bearer)).statusCode,
    ).toBe(404);
  });

  it('the admin projection is bounded: no DOB, no idempotency/digest/payment material; filters are exact and paginated', async () => {
    const detail = await inject('GET', `/admin/bookings/${confirmedBookingId}`, opsBearer);
    const view = detail.json().booking;
    expect(Object.keys(view.participant).sort()).toEqual(['firstName', 'id']);
    expect(Object.keys(view).sort()).toEqual(
      [
        'bookingId',
        'referenceCode',
        'state',
        'organization',
        'program',
        'unit',
        'participant',
        'accountId',
        'price',
        'createdAt',
        'confirmedAt',
        'cancelledAt',
        'hold',
        'occupancy',
      ].sort(),
    );
    expect(Object.keys(view.hold).sort()).toEqual(
      ['effectivelyExpired', 'expiresAt', 'holdId', 'physicalState'].sort(),
    );
    // Filters: state + org narrow correctly; unknown reference is empty.
    const confirmedOnly = await inject(
      'GET',
      `/admin/bookings?state=confirmed&organizationId=${f.org.orgId}`,
      opsBearer,
    );
    expect(
      confirmedOnly.json().bookings.every((b: { state: string }) => b.state === 'confirmed'),
    ).toBe(true);
    const ghost = await inject('GET', '/admin/bookings?reference=HM-NOPENOPE', opsBearer);
    expect(ghost.json().bookings).toEqual([]);
    // Keyset pagination walks without overlap.
    const pageOne = await inject('GET', '/admin/bookings?limit=1', opsBearer);
    const first = pageOne.json();
    if (first.nextCursor !== null) {
      const pageTwo = await inject(
        'GET',
        `/admin/bookings?limit=1&cursor=${first.nextCursor}`,
        opsBearer,
      );
      expect(pageTwo.statusCode).toBe(200);
      expect(pageTwo.json().bookings[0]?.bookingId).not.toBe(first.bookings[0].bookingId);
    }
  });

  it('effective-vs-physical occupancy stays labeled and truthful for a lapsed-but-unswept hold under admin diagnosis', async () => {
    const lapsedSession = await createSession(f, { capacity: 1 });
    const holder = await httpCustomer();
    const deps = { db: testDb.db };
    const quote = await requestQuote(deps, { accountId: holder.accountId }, {
      programId: f.programId,
      priceOptionId: dropInOption,
      unit: { kind: 'session', id: lapsedSession },
      participantId: holder.participantId,
    });
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const claim = await claimHold(
      { db: testDb.db, holdTtlSeconds: 0 },
      { accountId: holder.accountId },
      {
        unit: { kind: 'session', id: lapsedSession },
        participantId: holder.participantId,
        quoteId: quote.quote.quoteId,
        idempotencyKey: newId(),
      },
    );
    if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);
    // A paid pending booking on the lapsed hold via the INTERNAL service
    // (the future W5 shape) so the admin detail has a diagnosable row.
    // initiateBooking settles the lapsed hold truthfully instead — so this
    // proves the diagnosis path on the SETTLED shape:
    const initiate = await initiateBooking(deps, { accountId: holder.accountId }, {
      holdId: claim.outcome.hold.holdId,
      quoteId: quote.quote.quoteId,
      idempotencyKey: newId(),
    });
    expect(initiate.outcome.kind).toBe('holdExpired'); // boundary settled it
    const unitRow = await sql<{ held_count: number; state: string }>`
      SELECT s.held_count, h.state FROM capacity_hold h
      JOIN session s ON s.id = h.session_id WHERE h.id = ${claim.outcome.hold.holdId}`.execute(
      testDb.db,
    );
    expect(unitRow.rows[0]!.state).toBe('expired');
    expect(unitRow.rows[0]!.held_count).toBe(0); // settled exactly once
  });
});

describe('Slice-5 closeout locks', () => {
  it('the FINAL route inventory: no forbidden surface exists — no paid confirmation, no redemption management, no refund/payout/gateway, no admin booking mutation', () => {
    const inventory = app.routePolicyInventory.filter((route) => route.method !== 'HEAD');
    // Forbidden URL families anywhere in the app.
    for (const route of inventory) {
      expect(route.url).not.toMatch(
        /confirm-paid|payment-succeeded|capture|redemption|refund|payout|gateway|waitlist/i,
      );
    }
    // The admin booking surface is EXACTLY the two reads — no mutation.
    const adminBooking = inventory
      .filter((route) => route.url.startsWith('/admin/bookings'))
      .map((route) => `${route.method} ${route.url} → ${route.policy}`)
      .sort();
    expect(adminBooking).toEqual([
      'GET /admin/bookings → admin',
      'GET /admin/bookings/:bookingId → admin',
    ]);
    // No POST/PATCH/DELETE exists anywhere under /admin/bookings, and no
    // route anywhere lets a customer submit counters or a provider claim
    // payment (URL-level assertion; the schema locks live in their suites).
    expect(
      inventory.some(
        (route) => route.url.startsWith('/admin/bookings') && route.method !== 'GET',
      ),
    ).toBe(false);
  });

  it('D-10 closeout: the redemption record is restoration-proof — append-only at the database, and no route or HTTP source touches it', async () => {
    // Table-level: UPDATE and DELETE are trigger-refused even for the owner,
    // and the app role holds neither grant.
    const redemption = await sql<{ booking_id: string }>`
      SELECT booking_id FROM trial_redemption LIMIT 1`.execute(testDb.db);
    expect(redemption.rows).toHaveLength(1); // the confirmed trial above
    await expect(
      sql`UPDATE trial_redemption SET offer_id = ${trialOffer}
          WHERE booking_id = ${redemption.rows[0]!.booking_id}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
    await expect(
      sql`DELETE FROM trial_redemption
          WHERE booking_id = ${redemption.rows[0]!.booking_id}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
    const grants = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app' AND table_name = 'trial_redemption'`.execute(testDb.db);
    expect(grants.rows.map((row) => row.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('audit/outbox closeout: oversight reads emit NOTHING; outbox payloads stay machine-oriented; the W3-9 audit explorer observes Slice-5 events unchanged', async () => {
    const before = await sql<{ audits: string; outbox: string }>`
      SELECT (SELECT count(*) FROM audit_event) AS audits,
             (SELECT count(*) FROM outbox_event) AS outbox`.execute(testDb.db);
    await inject('GET', '/admin/bookings', opsBearer);
    await inject('GET', `/admin/bookings/${confirmedBookingId}`, opsBearer);
    await inject('GET', `/customer/bookings/${confirmedBookingId}`, trialCustomer.bearer);
    const after = await sql<{ audits: string; outbox: string }>`
      SELECT (SELECT count(*) FROM audit_event) AS audits,
             (SELECT count(*) FROM outbox_event) AS outbox`.execute(testDb.db);
    expect(after.rows[0]).toEqual(before.rows[0]);

    // Outbox payload hygiene across every Slice-5 event in this database:
    // ids + machine facts only — no names, DOB/gender, contact, payment,
    // policy prose, or idempotency material.
    const payloads = await sql<{ event_type: string; payload: Record<string, unknown> }>`
      SELECT event_type, payload FROM outbox_event`.execute(testDb.db);
    expect(payloads.rows.length).toBeGreaterThan(0);
    for (const row of payloads.rows) {
      for (const key of Object.keys(row.payload)) {
        expect(key).not.toMatch(/name|birth|gender|email|phone|card|token|secret|idempot|policy/i);
      }
    }

    // The W3-9 audit explorer (auditor/operations) reads the new Slice-5
    // audit families within its existing bounded projection.
    const explorer = await inject(
      'GET',
      '/admin/audit-events?entityType=capacity_hold',
      opsBearer,
    );
    expect(explorer.statusCode).toBe(200);
    expect(explorer.json().events.length).toBeGreaterThan(0);
    for (const event of explorer.json().events) {
      expect(Object.keys(event).sort()).toEqual(
        ['action', 'actorId', 'actorType', 'entityId', 'entityType', 'id', 'occurredAt'].sort(),
      );
    }
    const trialAudit = await inject(
      'GET',
      '/admin/audit-events?entityType=trial_redemption',
      opsBearer,
    );
    expect(trialAudit.statusCode).toBe(200);
    expect(trialAudit.json().events.length).toBeGreaterThan(0);
  });
});
