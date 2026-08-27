/**
 * W4 Slice 5 · S5-5 — customer booking HTTP surface (docs/32 §12; docs/21
 * §11 / docs/22 §11 vocabulary). Real PostgreSQL + Fastify injection: the
 * full quote → hold → free-confirm journey over the wire, D-10 and
 * eligibility as typed HTTP refusals, the fail-closed paid boundary, hold
 * idempotency storms, cross-account not-found shaping, response hygiene
 * (no counters/internals), and the STRUCTURAL locks — the exact customer
 * route inventory and the impossibility of a trusted paid-confirmation
 * route.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
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
  reconcileUnit,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/booking-customer-routes-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let monthlyOption: string;
let freeOption: string;
let dropInOption: string;
let trialOffer: string;

interface HttpCustomer {
  accountId: string;
  participantId: string;
  bearer: string;
}

async function httpCustomer(): Promise<HttpCustomer> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const participantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, participantId, bearer };
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
  monthlyOption = await createPriceOption(f, { kind: 'monthly', amountFils: 20000 });
  freeOption = await createPriceOption(f, { kind: 'free' });
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  trialOffer = await createOffer(f, { kind: 'freeTrial' });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(method: 'GET' | 'POST', url: string, bearer: string | null, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function quoteViaHttp(
  customer: HttpCustomer,
  unitId: string,
  optionId: string,
  offerId?: string,
): Promise<Record<string, unknown>> {
  const response = await inject('POST', '/customer/quotes', customer.bearer, {
    programId: f.programId,
    priceOptionId: optionId,
    unitKind: 'session',
    unitId,
    participantId: customer.participantId,
    ...(offerId !== undefined ? { offerId } : {}),
  });
  expect(response.statusCode).toBe(201);
  return response.json().quote;
}

async function holdViaHttp(
  customer: HttpCustomer,
  unitId: string,
  quoteId: string,
): Promise<Record<string, unknown>> {
  const response = await inject('POST', '/customer/holds', customer.bearer, {
    unitKind: 'session',
    unitId,
    participantId: customer.participantId,
    quoteId,
    idempotencyKey: newId(),
  });
  expect(response.statusCode).toBe(201);
  return response.json().hold;
}

describe('structural locks', () => {
  it('the customer surface is EXACTLY the approved route set, all authenticatedCustomer — and no route anywhere maps to the trusted paid-confirmation seam', () => {
    const customerRoutes = app.routePolicyInventory
      // Fastify mirrors every GET as an implicit HEAD; the lock pins the
      // declared surface.
      .filter((route) => route.url.startsWith('/customer/') && route.method !== 'HEAD')
      .map((route) => `${route.method} ${route.url} → ${route.policy}`)
      .sort();
    expect(customerRoutes).toEqual([
      'GET /customer/bookings → authenticatedCustomer',
      'GET /customer/bookings/:bookingId → authenticatedCustomer',
      // W5-5 (owning-slice amendment): the converged payment-status read.
      'GET /customer/bookings/:bookingId/payment → authenticatedCustomer',
      // S6-1/S6-2 (owning-slice amendments, docs/35 §9/§13): acquisition +
      // credential surfaces. S6-3 (owning-slice amendment, docs/35 §13):
      // the derived calendar, the Passes/attendance/reservable reads, and
      // the reservation quote/confirm authority.
      'GET /customer/calendar → authenticatedCustomer',
      'GET /customer/credentials/:credentialId → authenticatedCustomer',
      'GET /customer/entitlement-purchases/:purchaseId → authenticatedCustomer',
      'GET /customer/entitlement-purchases/:purchaseId/payment → authenticatedCustomer',
      'GET /customer/entitlements → authenticatedCustomer',
      'GET /customer/entitlements/:entitlementId → authenticatedCustomer',
      'GET /customer/entitlements/:entitlementId/attendance → authenticatedCustomer',
      'GET /customer/entitlements/:entitlementId/reservable-sessions → authenticatedCustomer',
      'GET /customer/holds/:holdId → authenticatedCustomer',
      // RI-1 (owning-slice amendment): customer participant management.
      'GET /customer/participants → authenticatedCustomer',
      'GET /customer/programs/:programId/availability → authenticatedCustomer',
      'PATCH /customer/participants/:participantId → authenticatedCustomer',
      'POST /customer/bookings/:bookingId/credential → authenticatedCustomer',
      'POST /customer/bookings/confirm-free → authenticatedCustomer',
      'POST /customer/bookings/initiate → authenticatedCustomer',
      'POST /customer/entitlement-purchases/confirm-free → authenticatedCustomer',
      'POST /customer/entitlement-purchases/initiate → authenticatedCustomer',
      'POST /customer/entitlement-purchases/quote → authenticatedCustomer',
      // S6-3 (owning-slice amendment): the dedicated reservation
      // confirmation authority — the ONLY route that reaches
      // `confirmEntitlementReservation`.
      'POST /customer/entitlement-reservations/confirm → authenticatedCustomer',
      // S6-2 (owning-slice amendment, docs/35 §9/§13): credential issuance +
      // observation.
      'POST /customer/entitlements/:entitlementId/credential → authenticatedCustomer',
      'POST /customer/entitlements/:entitlementId/reservation-quote → authenticatedCustomer',
      'POST /customer/holds → authenticatedCustomer',
      'POST /customer/holds/:holdId/release → authenticatedCustomer',
      'POST /customer/participants → authenticatedCustomer',
      'POST /customer/participants/:participantId/archive → authenticatedCustomer',
      'POST /customer/quotes → authenticatedCustomer',
    ]);
    // The trusted W5 seam stays route-less: no HTTP module anywhere imports
    // or references confirmPaidBooking — locked at the source level.
    const httpDirs = [
      path.join(__dirname, '..', 'src', 'modules', 'booking', 'http'),
      path.join(__dirname, '..', 'src', 'modules', 'catalogue', 'http'),
      path.join(__dirname, '..', 'src', 'modules', 'provider', 'http'),
      path.join(__dirname, '..', 'src', 'modules', 'identity', 'http'),
      // W5-3 added the payment webhook ingress — scanned too: the trusted
      // seam stays out of EVERY http module, the new one included.
      path.join(__dirname, '..', 'src', 'modules', 'payment', 'http'),
      // S6-1 added the entitlement acquisition surface — scanned too: BOTH
      // trusted seams (Booking and EntitlementPurchase) stay route-less.
      path.join(__dirname, '..', 'src', 'modules', 'entitlement', 'http'),
    ];
    for (const dir of httpDirs) {
      for (const file of readdirSync(dir)) {
        const source = readFileSync(path.join(dir, file), 'utf8');
        expect(source).not.toContain('confirmPaidBooking');
        expect(source).not.toContain('confirmPaidEntitlementPurchase');
      }
    }
    // And no route URL even hints at a paid confirmation or payment
    // authority (W5-5 route-security lock: /payment-success, /mark-paid,
    // customer confirm-payment, refund, commission — all structurally
    // absent; the converged read is `GET …/payment`, a projection only).
    for (const route of app.routePolicyInventory) {
      expect(route.url).not.toMatch(
        /confirm-paid|payment-succeeded|payment-success|mark-paid|confirm-payment|capture|refund|commission/,
      );
    }
  });

  it('unauthenticated requests are refused; an authenticated user WITHOUT a customer account is not-found-shaped', async () => {
    expect((await inject('GET', '/customer/bookings', null)).statusCode).toBe(401);
    const bareUser = await createUser(testDb.db); // no customer_account
    const { bearer } = await bearerForUser(ctx, bareUser);
    expect((await inject('GET', '/customer/bookings', bearer)).statusCode).toBe(404);
  });
});

describe('the approved customer journey over the wire', () => {
  it('quote → hold → atomic free-trial confirmation; D-10 then refuses the next trial intent typed', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const customer = await httpCustomer();
    const quote = await quoteViaHttp(customer, sessionId, monthlyOption, trialOffer);
    expect(quote).toMatchObject({
      totalFils: 0,
      currency: 'AED',
      taxTreatment: 'notConfigured',
      offerId: trialOffer,
    });

    const hold = await holdViaHttp(customer, sessionId, quote['quoteId'] as string);
    expect(hold['state']).toBe('active');

    const confirm = await inject('POST', '/customer/bookings/confirm-free', customer.bearer, {
      holdId: hold['holdId'],
      idempotencyKey: newId(),
    });
    expect(confirm.statusCode).toBe(201);
    const booking = confirm.json().booking;
    expect(booking.state).toBe('confirmed');
    expect(booking.referenceCode).toMatch(/^HM-/);

    // D-10 over the wire: the next trial intent for the same participant +
    // Program refuses typed at quote time.
    const secondSession = await createSession(f, { capacity: 3 });
    const refused = await inject('POST', '/customer/quotes', customer.bearer, {
      programId: f.programId,
      priceOptionId: monthlyOption,
      unitKind: 'session',
      unitId: secondSession,
      participantId: customer.participantId,
      offerId: trialOffer,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('trialAlreadyRedeemed');

    // The booking read returns the customer projection — and only it.
    const detail = await inject(
      'GET',
      `/customer/bookings/${booking.bookingId}`,
      customer.bearer,
    );
    expect(detail.statusCode).toBe(200);
    const view = detail.json().booking;
    expect(Object.keys(view).sort()).toEqual(
      [
        'bookingId',
        'referenceCode',
        'state',
        'participant',
        'program',
        // RI-3 (owning-slice amendment): the booking's provider/branch
        // display identity — public names only, no commercial internals.
        'provider',
        'branch',
        'unit',
        'price',
        // S6-3 (owning-slice amendment, owner item 26): included-with-pass
        // truth — an entitlement-covered AED 0 booking is distinguishable
        // from a provider's genuinely free product. Ordinary bookings carry
        // false/null.
        'coveredByEntitlement',
        'entitlementId',
        'createdAt',
        'confirmedAt',
      ].sort(),
    );
    expect(view.provider.displayName.length).toBeGreaterThan(0);
    expect(view.price).toEqual({ totalFils: 0, currency: 'AED' });
    // List read shows the same row, own-account only.
    const list = await inject('GET', '/customer/bookings', customer.bearer);
    expect(list.statusCode).toBe(200);
    expect(list.json().bookings.map((b: { bookingId: string }) => b.bookingId)).toContain(
      booking.bookingId,
    );
  });

  it('availability projection over the wire carries derived bands only — never counters', async () => {
    const customer = await httpCustomer();
    const sessionId = await createSession(f, { capacity: 2 });
    const response = await inject(
      'GET',
      `/customer/programs/${f.programId}/availability?kind=session`,
      customer.bearer,
    );
    expect(response.statusCode).toBe(200);
    const unit = response
      .json()
      .units.find((u: { unitId: string }) => u.unitId === sessionId);
    expect(unit).toMatchObject({ availability: 'fewLeft', spotsLeft: 2 });
    expect(unit.heldCount).toBeUndefined();
    expect(unit.bookedCount).toBeUndefined();
    expect(unit.version).toBeUndefined();
  });

  it('eligibility refuses typed over the wire (child outside the age band)', async () => {
    await sql`UPDATE program SET min_age = 6, max_age = 10, all_ages = false
              WHERE id = ${f.programId}`.execute(testDb.db);
    try {
      const sessionId = await createSession(f);
      const customer = await httpCustomer();
      const childId = newId();
      await sql`INSERT INTO participant (id, account_id, kind, first_name, date_of_birth)
                VALUES (${childId}, ${customer.accountId}, 'child', 'Kid', '2024-01-01')`.execute(
        testDb.db,
      );
      const refused = await inject('POST', '/customer/quotes', customer.bearer, {
        programId: f.programId,
        priceOptionId: freeOption,
        unitKind: 'session',
        unitId: sessionId,
        participantId: childId,
        idempotencyKey: undefined,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe('participantIneligible');
    } finally {
      await sql`UPDATE program SET min_age = NULL, max_age = NULL, all_ages = true
                WHERE id = ${f.programId}`.execute(testDb.db);
    }
  });

  it('the paid boundary fails CLOSED over the wire: 503 paymentUnavailable, no Booking row, hold intact; zero-total intents are redirected typed', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const customer = await httpCustomer();
    const paidQuote = await quoteViaHttp(customer, sessionId, dropInOption);
    const paidHold = await holdViaHttp(customer, sessionId, paidQuote['quoteId'] as string);

    const refused = await inject('POST', '/customer/bookings/initiate', customer.bearer, {
      holdId: paidHold['holdId'],
      quoteId: paidQuote['quoteId'],
      idempotencyKey: newId(),
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().code).toBe('paymentUnavailable');
    const bookings = await sql<{ n: string }>`
      SELECT count(*) AS n FROM booking WHERE hold_id = ${paidHold['holdId'] as string}`.execute(
      testDb.db,
    );
    expect(Number(bookings.rows[0]!.n)).toBe(0);

    const other = await httpCustomer();
    const freeQuote = await quoteViaHttp(other, sessionId, freeOption);
    const freeHold = await holdViaHttp(other, sessionId, freeQuote['quoteId'] as string);
    const redirected = await inject('POST', '/customer/bookings/initiate', other.bearer, {
      holdId: freeHold['holdId'],
      quoteId: freeQuote['quoteId'],
      idempotencyKey: newId(),
    });
    expect(redirected.statusCode).toBe(409);
    expect(redirected.json().code).toBe('paymentNotRequired');
  });

  it('hold storm over the wire (one key × 8) claims ONE seat; release is idempotent; cross-account access is not-found-shaped', async () => {
    const sessionId = await createSession(f, { capacity: 5 });
    const unit = { kind: 'session' as const, id: sessionId };
    const customer = await httpCustomer();
    const quote = await quoteViaHttp(customer, sessionId, dropInOption);
    const key = newId();
    const storm = await Promise.all(
      Array.from({ length: 8 }, () =>
        inject('POST', '/customer/holds', customer.bearer, {
          unitKind: 'session',
          unitId: sessionId,
          participantId: customer.participantId,
          quoteId: quote['quoteId'],
          idempotencyKey: key,
        }),
      ),
    );
    expect(storm.every((response) => response.statusCode === 201)).toBe(true);
    const holdIds = new Set(storm.map((response) => response.json().hold.holdId));
    expect(holdIds.size).toBe(1);
    const rec = await reconcileUnit(testDb.db, unit);
    expect(rec.heldCount).toBe(1);
    const holdId = [...holdIds][0] as string;

    // Same key, materially different request → typed conflict.
    const conflicting = await inject('POST', '/customer/holds', customer.bearer, {
      unitKind: 'session',
      unitId: sessionId,
      participantId: customer.participantId,
      quoteId: newId(),
      idempotencyKey: key,
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe('idempotencyConflict');

    // A stranger can neither inspect nor release the hold.
    const stranger = await httpCustomer();
    expect(
      (await inject('GET', `/customer/holds/${holdId}`, stranger.bearer)).statusCode,
    ).toBe(404);
    expect(
      (
        await inject('POST', `/customer/holds/${holdId}/release`, stranger.bearer, {
          idempotencyKey: newId(),
        })
      ).statusCode,
    ).toBe(404);

    // The owner inspects and releases; releasing again stays 200 (idempotent
    // customer semantics), and capacity returned exactly once.
    const status = await inject('GET', `/customer/holds/${holdId}`, customer.bearer);
    expect(status.statusCode).toBe(200);
    expect(status.json().hold.state).toBe('active');
    const release = await inject('POST', `/customer/holds/${holdId}/release`, customer.bearer, {
      idempotencyKey: newId(),
    });
    expect(release.statusCode).toBe(200);
    const again = await inject('POST', `/customer/holds/${holdId}/release`, customer.bearer, {
      idempotencyKey: newId(),
    });
    expect(again.statusCode).toBe(200);
    expect((await reconcileUnit(testDb.db, unit)).heldCount).toBe(0);
  });

  it('OWNER PROBE over the wire: a lapsed-but-unswept hold reads as expired, and availability reflects effective capacity — never a stale full', async () => {
    const sessionId = await createSession(f, { capacity: 1 });
    const customer = await httpCustomer();
    const quote = await quoteViaHttp(customer, sessionId, dropInOption);
    // Claim with TTL 0 through the certified service (the route TTL is the
    // production 10 minutes): instantly lapsed, row NOT swept.
    const claim = await claimHold(
      { db: testDb.db, holdTtlSeconds: 0 },
      { accountId: customer.accountId },
      {
        unit: { kind: 'session', id: sessionId },
        participantId: customer.participantId,
        quoteId: quote['quoteId'] as string,
        idempotencyKey: newId(),
      },
    );
    if (claim.outcome.kind !== 'holdClaimed') throw new Error(claim.outcome.kind);

    const status = await inject(
      'GET',
      `/customer/holds/${claim.outcome.hold.holdId}`,
      customer.bearer,
    );
    expect(status.statusCode).toBe(200);
    expect(status.json().hold.state).toBe('expired'); // effective truth
    const avail = await inject(
      'GET',
      `/customer/programs/${f.programId}/availability?kind=session`,
      customer.bearer,
    );
    const view = avail.json().units.find((u: { unitId: string }) => u.unitId === sessionId);
    expect(view.availability).toBe('fewLeft'); // NOT full — the seat is reclaimable
    expect(view.spotsLeft).toBe(1);
    // The reads mutated nothing: the physical row still awaits its
    // authoritative S5-2 transition.
    const row = await sql<{ state: string }>`
      SELECT state FROM capacity_hold
      WHERE id = ${claim.outcome.hold.holdId}`.execute(testDb.db);
    expect(row.rows[0]!.state).toBe('active');
  });

  it('smuggled money/counters/state are inexpressible: a client-authored total never reaches the quote, and booking bodies strip undeclared fields', async () => {
    const sessionId = await createSession(f, { capacity: 3 });
    const customer = await httpCustomer();
    const response = await inject('POST', '/customer/quotes', customer.bearer, {
      programId: f.programId,
      priceOptionId: dropInOption,
      unitKind: 'session',
      unitId: sessionId,
      participantId: customer.participantId,
      totalFils: 1, // smuggled client price
      heldCount: 0, // smuggled counter
    });
    expect(response.statusCode).toBe(201);
    // The server-computed money stands; the smuggled fields never applied.
    expect(response.json().quote.totalFils).toBe(5000);
  });
});
