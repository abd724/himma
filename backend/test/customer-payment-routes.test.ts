/**
 * W5 · W5-5 — customer payment API integration (docs/33 §15, §17 W5-5;
 * docs/24 §8.7/§10; owner rulings D-W5-2/3/4/5/6/7). Real PostgreSQL +
 * real Fastify transport over the deterministic provider.
 *
 * Certifies the DELIBERATE replacement of the certified S5-5 fail-closed
 * paid boundary with the real W5 orchestration, over the wire:
 * authenticated checkout initiation returning ONLY the approved
 * hosted-Checkout data (booking ref · transient redirect · the HIMMA hold
 * expiry — never the gateway session lifetime, never economics, never
 * secrets); the CRITICAL idempotent replay + response-lost redirect
 * recovery (one commercial checkout, ever); the concurrent HTTP storm;
 * same-key/different-payload conflict; cross-account not-found shaping;
 * the D-W5-7 commission fail-close (customer-safe wire error, ZERO
 * mutations, zero provider requests); the unconfigured/production
 * fail-close; the untouched free path; smuggled money-field
 * inexpressibility; the converged payment-status projection (browser
 * returns are navigation only — no landing route exists, fabricated
 * returns have zero commercial effect; delayed webhooks leave truthful
 * state; the trusted webhook+saga eventually projects `confirmed`;
 * compensation NEVER projects `confirmed`); reads emit nothing; and the
 * W5-5 route-security lock.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { resolvePaymentProvider } from '../src/modules/payment/provider-composition';
import {
  processTrustedPaymentResults,
} from '../src/modules/payment/services/payment-saga';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../src/modules/payment/services/webhook-ingestion';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCommissionTerm,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/customer-payment-routes-pool';
const NOW = new Date('2026-08-21T12:00:00.000Z');
const SUCCESS_URL = 'https://app.himma.test/checkout/return';
const CANCEL_URL = 'https://app.himma.test/checkout/cancel';
const WEBHOOK_URL = '/payments/webhook/deterministicTest';

let testDb: TestDb;
let verifier: FakeAccessTokenVerifier;
let ctx: ProviderTestContext;
let provider: DeterministicPaymentProvider;
let app: FastifyInstance;
let f: BookingFixture;
let dropInOption: string;
let freeOption: string;

let eventSerial = 0;
const nextEventId = (): string => `evt_w55_${(eventSerial += 1)}`;

interface HttpCustomer {
  accountId: string;
  participantId: string;
  bearer: string;
}

function makeApp(paymentProvider?: DeterministicPaymentProvider, withUrls = true): FastifyInstance {
  return buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
    ...(paymentProvider !== undefined
      ? {
          payment: {
            provider: paymentProvider,
            ...(withUrls
              ? { checkoutUrls: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL } }
              : {}),
          },
        }
      : {}),
  });
}

async function httpCustomer(): Promise<HttpCustomer> {
  const userId = await createUser(testDb.db);
  const accountId = await createAccount(testDb.db, userId);
  const participantId = await createSelfParticipant(testDb.db, accountId);
  const { bearer } = await bearerForUser(ctx, userId);
  return { accountId, participantId, bearer };
}

function inject(
  on: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  bearer: string | null,
  payload?: unknown,
) {
  return on.inject({
    method,
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function quoteViaHttp(
  on: FastifyInstance,
  customer: HttpCustomer,
  unitId: string,
  optionId: string,
): Promise<string> {
  const response = await inject(on, 'POST', '/customer/quotes', customer.bearer, {
    programId: f.programId,
    priceOptionId: optionId,
    unitKind: 'session',
    unitId,
    participantId: customer.participantId,
  });
  expect(response.statusCode).toBe(201);
  return response.json().quote.quoteId as string;
}

async function holdViaHttp(
  on: FastifyInstance,
  customer: HttpCustomer,
  unitId: string,
  quoteId: string,
): Promise<string> {
  const response = await inject(on, 'POST', '/customer/holds', customer.bearer, {
    unitKind: 'session',
    unitId,
    participantId: customer.participantId,
    quoteId,
    idempotencyKey: newId(),
  });
  expect(response.statusCode).toBe(201);
  return response.json().hold.holdId as string;
}

/** A ready-to-pay checkout context on the main app (dropIn, 5000 fils). */
async function paidContext(on: FastifyInstance = app): Promise<{
  customer: HttpCustomer;
  sessionId: string;
  quoteId: string;
  holdId: string;
}> {
  const customer = await httpCustomer();
  const sessionId = await createSession(f);
  const quoteId = await quoteViaHttp(on, customer, sessionId, dropInOption);
  const holdId = await holdViaHttp(on, customer, sessionId, quoteId);
  return { customer, sessionId, quoteId, holdId };
}

async function tableCounts(): Promise<{ bookings: number; intents: number; economics: number }> {
  const result = await sql<{ bookings: string; intents: string; economics: string }>`
    SELECT (SELECT count(*) FROM booking) AS bookings,
           (SELECT count(*) FROM payment_intent) AS intents,
           (SELECT count(*) FROM payment_intent_economics) AS economics`.execute(testDb.db);
  const row = result.rows[0]!;
  return {
    bookings: Number(row.bookings),
    intents: Number(row.intents),
    economics: Number(row.economics),
  };
}

async function auditCount(): Promise<number> {
  const result = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(
    testDb.db,
  );
  return Number(result.rows[0]!.n);
}

async function attemptRefFor(bookingId: string): Promise<string> {
  const row = await sql<{ gateway_ref: string }>`
    SELECT a.gateway_ref FROM payment_attempt a
    JOIN payment_intent i ON i.id = a.intent_id
    WHERE i.booking_id = ${bookingId}
    ORDER BY a.sequence_no DESC LIMIT 1`.execute(testDb.db);
  return row.rows[0]!.gateway_ref;
}

async function postWebhook(
  on: FastifyInstance,
  delivery: { rawBody: Buffer; headers: Record<string, string> },
): Promise<number> {
  const response = await on.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    payload: delivery.rawBody,
    headers: { 'content-type': 'application/json', ...delivery.headers },
  });
  return response.statusCode;
}

async function paymentStatus(
  on: FastifyInstance,
  customer: HttpCustomer,
  bookingId: string,
): Promise<{ statusCode: number; payment?: Record<string, unknown> }> {
  const response = await inject(
    on,
    'GET',
    `/customer/bookings/${bookingId}/payment`,
    customer.bearer,
  );
  return {
    statusCode: response.statusCode,
    ...(response.statusCode === 200 ? { payment: response.json().payment } : {}),
  };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  verifier = new FakeAccessTokenVerifier();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  provider = new DeterministicPaymentProvider({ now: NOW });
  app = makeApp(provider);
  await app.ready();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  await createCommissionTerm(testDb.db, f.org.orgId, 1000); // D-W5-7: 10% — stated, never defaulted
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  freeOption = await createPriceOption(f, { kind: 'free' });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Route-security lock (docs/33 §16 test 12 finalized; owner item 17)
// ---------------------------------------------------------------------------

describe('W5-5 route-security lock', () => {
  it('the payment surface is EXACTLY webhook ingress + the two customer boundaries; every forbidden payment-authority URL is structurally absent; browser return paths are NOT routes', async () => {
    const inventory = app.routePolicyInventory.filter((route) => route.method !== 'HEAD');
    const paymentRoutes = inventory
      .filter((route) => route.url.startsWith('/payments'))
      .map((route) => `${route.method} ${route.url} → ${route.policy}`);
    // The webhook stays the ONLY /payments route — Stripe-authenticated
    // `public`, never a customer-auth surface.
    expect(paymentRoutes).toEqual(['POST /payments/webhook/deterministicTest → public']);
    const customerPayment = inventory
      .filter(
        (route) =>
          route.url === '/customer/bookings/initiate' ||
          route.url === '/customer/bookings/:bookingId/payment',
      )
      .map((route) => `${route.method} ${route.url} → ${route.policy}`)
      .sort();
    expect(customerPayment).toEqual([
      'GET /customer/bookings/:bookingId/payment → authenticatedCustomer',
      'POST /customer/bookings/initiate → authenticatedCustomer',
    ]);
    // Forbidden authority families (owner item 17): no payment-success, no
    // mark-paid, no customer confirm-payment, no refund/commission surface,
    // no capture/payment-succeeded URL of any kind.
    for (const route of inventory) {
      expect(route.url).not.toMatch(
        /payment-success|payment-succeeded|mark-paid|confirm-paid|confirm-payment|capture|refund|commission|payout/i,
      );
    }
    // The configured success/cancel URLs are NAVIGATION targets only — their
    // paths are not backend routes; loading them changes nothing (§11).
    for (const path of ['/checkout/return', '/checkout/cancel']) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Checkout initiation contract (docs/33 §15; owner items 2–3, 7–9, 12)
// ---------------------------------------------------------------------------

describe('paid checkout initiation over the wire', () => {
  it('an authenticated eligible customer starts paid checkout: 201 with ONLY the approved hosted-Checkout data; server-derived commercial truth in the database; hold expiry is the HIMMA authority', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const idempotencyKey = newId();
    const response = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey,
    });
    expect(response.statusCode).toBe(201);
    const checkout = response.json().checkout as Record<string, unknown>;
    // ONLY the approved fields — no intent/attempt ids, no gateway session
    // expiry (D-W5-5: the ~30-minute session lifetime never reaches the
    // customer), no economics, no raw gateway payloads.
    expect(Object.keys(checkout).sort()).toEqual(['bookingId', 'holdExpiresAt', 'redirectUrl']);
    expect(checkout['redirectUrl']).toMatch(/^https:\/\//);
    // Hold expiry equals the Himma capacity hold row — the 10-minute
    // inventory authority, not the provider session's window.
    const hold = await sql<{ expires_at: Date }>`
      SELECT expires_at FROM capacity_hold WHERE id = ${holdId}`.execute(testDb.db);
    expect(checkout['holdExpiresAt']).toBe(hold.rows[0]!.expires_at.toISOString());
    // Response hygiene: no secrets, no commission vocabulary on the wire.
    expect(response.body).not.toMatch(/sk_test|sk_live|whsec|dt_whsec|commission|rate_bps|bps/i);

    // Server truth: booking pending on its ACTIVE hold; ONE intent at the
    // quote amount; ONE attempt bound to ONE provider session; the D-W5-7
    // economics snapshot committed atomically with the intent.
    const truth = await sql<{
      booking_state: string;
      hold_state: string;
      intent_state: string;
      amount_fils: string;
      attempts: string;
      rate_bps: number;
      commission: string;
      share: string;
    }>`SELECT b.state AS booking_state, h.state AS hold_state, i.state AS intent_state,
              i.amount_fils,
              (SELECT count(*) FROM payment_attempt a WHERE a.intent_id = i.id) AS attempts,
              e.platform_commission_rate_bps AS rate_bps,
              e.platform_commission_amount_fils AS commission,
              e.provider_share_amount_fils AS share
       FROM booking b
       JOIN capacity_hold h ON h.id = b.hold_id
       JOIN payment_intent i ON i.booking_id = b.id
       JOIN payment_intent_economics e ON e.intent_id = i.id
       WHERE b.id = ${checkout['bookingId'] as string}`.execute(testDb.db);
    expect(truth.rows[0]).toMatchObject({
      booking_state: 'pending_payment',
      hold_state: 'active',
      intent_state: 'in_progress',
    });
    expect(Number(truth.rows[0]!.amount_fils)).toBe(5000);
    expect(Number(truth.rows[0]!.attempts)).toBe(1);
    expect(truth.rows[0]!.rate_bps).toBe(1000);
    expect(Number(truth.rows[0]!.commission)).toBe(500);
    expect(Number(truth.rows[0]!.share)).toBe(4500);

    // The converged read: awaiting payment, with the Himma hold expiry.
    const status = await paymentStatus(app, customer, checkout['bookingId'] as string);
    expect(status.payment).toEqual({
      status: 'awaitingPayment',
      holdExpiresAt: checkout['holdExpiresAt'],
    });
  });

  it('same-key replay after a successful response returns the SAME usable redirect — one booking, one intent, one attempt, one provider session, zero new audit rows', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const idempotencyKey = newId();
    const body = { holdId, quoteId, idempotencyKey };
    const first = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body);
    expect(first.statusCode).toBe(201);
    const auditBefore = await auditCount();
    const countsBefore = await tableCounts();
    const replay = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body);
    expect(replay.statusCode).toBe(201);
    // The SAME commercial checkout: identical booking and redirect.
    expect(replay.json()).toEqual(first.json());
    expect(await tableCounts()).toEqual(countsBefore);
    // Idempotent replay emits NO new commercial/audit event family.
    expect(await auditCount()).toBe(auditBefore);
    const attempts = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_attempt a
      JOIN payment_intent i ON i.id = a.intent_id
      WHERE i.booking_id = ${first.json().checkout.bookingId as string}`.execute(testDb.db);
    expect(Number(attempts.rows[0]!.n)).toBe(1);
  });

  it('THE CRITICAL RECOVERY: the provider created the session but the response was lost — the customer retry recovers a usable redirect for the SAME commercial checkout (no second session)', async () => {
    const lostProvider = new DeterministicPaymentProvider({
      now: NOW,
      defaultScenario: 'timeoutOnce',
    });
    const lostApp = makeApp(lostProvider);
    await lostApp.ready();
    try {
      const { customer, quoteId, holdId } = await paidContext(lostApp);
      const body = { holdId, quoteId, idempotencyKey: newId() };
      // First call: the session exists provider-side, the response is lost.
      // Nothing is persisted as failed; the customer is told to retry the
      // SAME checkout (typed 503, never a fake failure — docs/24 §8.3).
      const lost = await inject(lostApp, 'POST', '/customer/bookings/initiate', customer.bearer, body);
      expect(lost.statusCode).toBe(503);
      expect(lost.json().code).toBe('checkoutPending');
      expect(lostProvider.sessionCount).toBe(1);
      // The retry re-sends the SAME stable provider key → idempotent replay
      // returns the SAME session, now with its usable redirect.
      const retry = await inject(lostApp, 'POST', '/customer/bookings/initiate', customer.bearer, body);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().checkout.redirectUrl).toMatch(/^https:\/\//);
      expect(lostProvider.sessionCount).toBe(1); // ONE session, ever
      expect(lostProvider.createRequestCount).toBe(2);
      const attempts = await sql<{ n: string; refs: string }>`
        SELECT count(*) AS n, count(DISTINCT a.gateway_ref) AS refs
        FROM payment_attempt a JOIN payment_intent i ON i.id = a.intent_id
        WHERE i.booking_id = ${retry.json().checkout.bookingId as string}`.execute(testDb.db);
      expect(Number(attempts.rows[0]!.n)).toBe(1);
      expect(Number(attempts.rows[0]!.refs)).toBe(1);
    } finally {
      await lostApp.close();
    }
  });

  it('a concurrent 8-way same-key HTTP storm converges on ONE commercial checkout', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const body = { holdId, quoteId, idempotencyKey: newId() };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body),
      ),
    );
    const winners = responses.filter((response) => response.statusCode === 201);
    expect(winners.length).toBeGreaterThan(0);
    const bookingIds = new Set(winners.map((response) => response.json().checkout.bookingId));
    const redirects = new Set(winners.map((response) => response.json().checkout.redirectUrl));
    expect(bookingIds.size).toBe(1);
    expect(redirects.size).toBe(1);
    // Losers (if any) are the typed retryable refusal, never a second trail.
    for (const response of responses) {
      expect([201, 503]).toContain(response.statusCode);
    }
    const [bookingId] = bookingIds;
    const truth = await sql<{ intents: string; attempts: string; refs: string }>`
      SELECT (SELECT count(*) FROM payment_intent i WHERE i.booking_id = ${bookingId as string}) AS intents,
             (SELECT count(*) FROM payment_attempt a
               JOIN payment_intent i ON i.id = a.intent_id
               WHERE i.booking_id = ${bookingId as string}) AS attempts,
             (SELECT count(DISTINCT a.gateway_ref) FROM payment_attempt a
               JOIN payment_intent i ON i.id = a.intent_id
               WHERE i.booking_id = ${bookingId as string}) AS refs`.execute(testDb.db);
    expect(Number(truth.rows[0]!.intents)).toBe(1);
    expect(Number(truth.rows[0]!.attempts)).toBe(1);
    expect(Number(truth.rows[0]!.refs)).toBe(1);
  });

  it('same key, different payload → typed idempotency conflict', async () => {
    const first = await paidContext();
    const second = await paidContext();
    const idempotencyKey = newId();
    const ok = await inject(app, 'POST', '/customer/bookings/initiate', first.customer.bearer, {
      holdId: first.holdId,
      quoteId: first.quoteId,
      idempotencyKey,
    });
    expect(ok.statusCode).toBe(201);
    // Same account? No — conflicting payload must be the SAME customer's key
    // space. Use the first customer's key with the second context's ids.
    const conflicting = await inject(
      app,
      'POST',
      '/customer/bookings/initiate',
      first.customer.bearer,
      { holdId: second.holdId, quoteId: second.quoteId, idempotencyKey },
    );
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().code).toBe('idempotencyConflict');
  });

  it('smuggled commercial fields are inexpressible: client-authored amounts/commission/status never reach the server truth', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const response = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
      amountFils: 1,
      currency: 'USD',
      commissionRateBps: 0,
      providerShareAmountFils: 999999,
      state: 'succeeded',
    });
    // Undeclared properties are stripped by the app-wide validation; the
    // command succeeds with SERVER-derived money only.
    expect(response.statusCode).toBe(201);
    const truth = await sql<{ amount_fils: string; rate_bps: number }>`
      SELECT i.amount_fils, e.platform_commission_rate_bps AS rate_bps
      FROM payment_intent i JOIN payment_intent_economics e ON e.intent_id = i.id
      WHERE i.booking_id = ${response.json().checkout.bookingId as string}`.execute(testDb.db);
    expect(Number(truth.rows[0]!.amount_fils)).toBe(5000);
    expect(truth.rows[0]!.rate_bps).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Fail-close matrix (owner items 4–6, 10; docs/33 §13)
// ---------------------------------------------------------------------------

describe('fail-close behavior', () => {
  it('D-W5-7: a provider without an ACTIVE commission term fails closed with the customer-safe error — zero Booking, zero intent, zero provider requests, no commercial detail on the wire', async () => {
    const termless = await createBookingFixture(testDb.db);
    await publishProgram(termless);
    const option = await createPriceOption(termless, { kind: 'dropIn', amountFils: 7000 });
    const customer = await httpCustomer();
    const sessionId = await createSession(termless);
    const quote = await inject(app, 'POST', '/customer/quotes', customer.bearer, {
      programId: termless.programId,
      priceOptionId: option,
      unitKind: 'session',
      unitId: sessionId,
      participantId: customer.participantId,
    });
    expect(quote.statusCode).toBe(201);
    const quoteId = quote.json().quote.quoteId as string;
    const holdId = await holdViaHttp(app, customer, sessionId, quoteId);

    const before = await tableCounts();
    const requestsBefore = provider.createRequestCount;
    const refused = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
    });
    // The customer-safe wire error: paid checkout is unavailable. The
    // internal D-W5-7 cause (no agreed commission term) is commercial state
    // and never reaches the ordinary customer API.
    expect(refused.statusCode).toBe(503);
    expect(refused.json().code).toBe('paymentUnavailable');
    expect(refused.body).not.toMatch(/commission|rate|bps|term/i);
    expect(await tableCounts()).toEqual(before);
    expect(provider.createRequestCount).toBe(requestsBefore);
  });

  it('unconfigured payment capability (and production composition) fail closed with ZERO mutations; the certified zero-total redirect is preserved; the status read still serves', async () => {
    // Production composition can produce NO provider — pinned again here at
    // the W5-5 boundary (D-W5-3 VAT gate + docs/23 §19: no monetary request
    // can exist in production).
    expect(
      resolvePaymentProvider('production', { deterministic: provider }).kind,
    ).toBe('unconfigured');

    const bare = makeApp(); // no payment composition at all
    await bare.ready();
    try {
      const { customer, quoteId, holdId } = await paidContext(bare);
      const before = await tableCounts();
      const refused = await inject(bare, 'POST', '/customer/bookings/initiate', customer.bearer, {
        holdId,
        quoteId,
        idempotencyKey: newId(),
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().code).toBe('paymentUnavailable');
      expect(await tableCounts()).toEqual(before);

      // Zero-total intents keep the certified typed redirect to the free
      // path even while unconfigured (S5-5 behavior preserved).
      const freeCustomer = await httpCustomer();
      const sessionId = await createSession(f);
      const freeQuote = await quoteViaHttp(bare, freeCustomer, sessionId, freeOption);
      const freeHold = await holdViaHttp(bare, freeCustomer, sessionId, freeQuote);
      const redirected = await inject(
        bare,
        'POST',
        '/customer/bookings/initiate',
        freeCustomer.bearer,
        { holdId: freeHold, quoteId: freeQuote, idempotencyKey: newId() },
      );
      expect(redirected.statusCode).toBe(409);
      expect(redirected.json().code).toBe('paymentNotRequired');

      // A provider WITHOUT configured checkout URLs also fails closed —
      // there is no server-invented navigation target.
      const urlless = makeApp(new DeterministicPaymentProvider({ now: NOW }), false);
      await urlless.ready();
      try {
        const context = await paidContext(urlless);
        const noUrls = await inject(
          urlless,
          'POST',
          '/customer/bookings/initiate',
          context.customer.bearer,
          { holdId: context.holdId, quoteId: context.quoteId, idempotencyKey: newId() },
        );
        expect(noUrls.statusCode).toBe(503);
        expect(noUrls.json().code).toBe('paymentUnavailable');
      } finally {
        await urlless.close();
      }
    } finally {
      await bare.close();
    }
  });

  it('the free path is untouched: zero-total confirms atomically with NO intent, NO economics, NO provider request; a configured platform still redirects zero-total typed', async () => {
    const customer = await httpCustomer();
    const sessionId = await createSession(f);
    const quoteId = await quoteViaHttp(app, customer, sessionId, freeOption);
    const holdId = await holdViaHttp(app, customer, sessionId, quoteId);

    // Zero-total through the PAID boundary on the CONFIGURED app → the
    // certified typed redirect (D-10/free semantics stay the free path's).
    const redirected = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
    });
    expect(redirected.statusCode).toBe(409);
    expect(redirected.json().code).toBe('paymentNotRequired');

    const requestsBefore = provider.createRequestCount;
    const intentsBefore = (await tableCounts()).intents;
    const confirmed = await inject(app, 'POST', '/customer/bookings/confirm-free', customer.bearer, {
      holdId,
      idempotencyKey: newId(),
    });
    expect(confirmed.statusCode).toBe(201);
    const booking = confirmed.json().booking;
    expect(booking.state).toBe('confirmed');
    const paymentRows = await sql<{ intents: string; economics: string }>`
      SELECT (SELECT count(*) FROM payment_intent WHERE booking_id = ${booking.bookingId as string}) AS intents,
             (SELECT count(*) FROM payment_intent_economics e
               JOIN payment_intent i ON i.id = e.intent_id
               WHERE i.booking_id = ${booking.bookingId as string}) AS economics`.execute(testDb.db);
    expect(Number(paymentRows.rows[0]!.intents)).toBe(0);
    expect(Number(paymentRows.rows[0]!.economics)).toBe(0);
    expect((await tableCounts()).intents).toBe(intentsBefore);
    expect(provider.createRequestCount).toBe(requestsBefore);
    // The converged read is truthful for the free booking too.
    const status = await paymentStatus(app, customer, booking.bookingId as string);
    expect(status.payment).toMatchObject({ status: 'confirmed' });
  });
});

// ---------------------------------------------------------------------------
// Cross-account security (owner item 12)
// ---------------------------------------------------------------------------

describe('cross-account security', () => {
  it('customer B cannot initiate with A\'s hold/quote, cannot read A\'s payment status, and knowing ids conveys no authority; a session without a customer account is not-found-shaped', async () => {
    const a = await paidContext();
    const started = await inject(app, 'POST', '/customer/bookings/initiate', a.customer.bearer, {
      holdId: a.holdId,
      quoteId: a.quoteId,
      idempotencyKey: newId(),
    });
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;

    const b = await httpCustomer();
    // A's hold under B's session → not-found-shaped (no existence leak).
    const foreignHold = await inject(app, 'POST', '/customer/bookings/initiate', b.bearer, {
      holdId: a.holdId,
      quoteId: a.quoteId,
      idempotencyKey: newId(),
    });
    expect(foreignHold.statusCode).toBe(404);
    // B's own hold with A's quote → typed mismatch, nothing created.
    const bSession = await createSession(f);
    const bQuote = await quoteViaHttp(app, b, bSession, dropInOption);
    const bHold = await holdViaHttp(app, b, bSession, bQuote);
    const foreignQuote = await inject(app, 'POST', '/customer/bookings/initiate', b.bearer, {
      holdId: bHold,
      quoteId: a.quoteId,
      idempotencyKey: newId(),
    });
    expect([404, 422]).toContain(foreignQuote.statusCode);
    // A's booking/payment status under B → not-found-shaped.
    expect((await paymentStatus(app, b, bookingId)).statusCode).toBe(404);
    // An authenticated principal WITHOUT a customer account gains nothing.
    const bareUser = await createUser(testDb.db);
    const { bearer } = await bearerForUser(ctx, bareUser);
    expect(
      (
        await inject(app, 'POST', '/customer/bookings/initiate', bearer, {
          holdId: a.holdId,
          quoteId: a.quoteId,
          idempotencyKey: newId(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await inject(app, 'GET', `/customer/bookings/${bookingId}/payment`, bearer)).statusCode,
    ).toBe(404);
    // Unauthenticated → 401 (the session policy, before any shape).
    expect(
      (await inject(app, 'GET', `/customer/bookings/${bookingId}/payment`, null)).statusCode,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The converged payment-status projection (owner items 10–11, 14–16)
// ---------------------------------------------------------------------------

describe('the converged payment-status projection', () => {
  it('browser returns are NEVER evidence: fabricated/repeated returns change nothing, a delayed webhook leaves truthful awaiting state, and reads emit no audit/outbox', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const started = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
    });
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;

    // The customer "pays" on the hosted page — but the webhook is DELAYED:
    // no evidence has reached Himma, so truth remains awaiting (never a
    // fabricated success, never a fabricated failure).
    provider.completeCheckout(await attemptRefFor(bookingId));
    const auditBefore = await auditCount();
    // Fabricated/repeated browser returns: the success path is not a route;
    // hitting it (and retrying) has zero commercial effect.
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/checkout/return' })).statusCode).toBe(404);
    }
    const status = await paymentStatus(app, customer, bookingId);
    expect(status.payment).toMatchObject({ status: 'awaitingPayment' });
    const truth = await sql<{ state: string; captures: string }>`
      SELECT b.state, (SELECT count(*) FROM payment_transaction t
        JOIN payment_attempt a ON a.id = t.attempt_id
        JOIN payment_intent i ON i.id = a.intent_id
        WHERE i.booking_id = b.id) AS captures
      FROM booking b WHERE b.id = ${bookingId}`.execute(testDb.db);
    expect(truth.rows[0]!.state).toBe('pending_payment');
    expect(Number(truth.rows[0]!.captures)).toBe(0);
    // Reads emitted nothing.
    expect(await auditCount()).toBe(auditBefore);
  });

  it('trusted evidence projects `processing` before resolution, then the webhook+saga project `confirmed` — and a concluded checkout replay is typed', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const body = { holdId, quoteId, idempotencyKey: newId() };
    const started = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body);
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;
    const gatewayRef = await attemptRefFor(bookingId);
    provider.completeCheckout(gatewayRef);

    // Durable receipt WITHOUT the resolution passes (a crashed post-ack
    // pass): the projection is truthfully `processing` — payment received,
    // booking resolution pending. Never `confirmed` from evidence alone.
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef,
    });
    const ingested = await ingestGatewayDelivery(
      { db: testDb.db, provider },
      delivery.rawBody,
      delivery.headers,
    );
    expect(ingested.kind).toBe('accepted');
    const processing = await paymentStatus(app, customer, bookingId);
    expect(processing.payment).toEqual({ status: 'processing' });

    // The certified W5-3 lifecycle + W5-4 saga (the sweep the route runs
    // post-ack) resolve the durable item → confirmed.
    await processPendingGatewayEvents({ db: testDb.db, provider });
    await processTrustedPaymentResults({ db: testDb.db, provider });
    const confirmed = await paymentStatus(app, customer, bookingId);
    expect(confirmed.payment).toMatchObject({ status: 'confirmed' });
    expect(confirmed.payment!['referenceCode']).toMatch(/^HM-/);
    // The booking read agrees; counters/economics stay off this wire too.
    const detail = await inject(app, 'GET', `/customer/bookings/${bookingId}`, customer.bearer);
    expect(detail.json().booking.state).toBe('confirmed');

    // Replaying the same checkout command after conclusion is typed — it
    // can never restart or duplicate a concluded commercial trail.
    const replay = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe('checkoutConcluded');
  });

  it('the full wire journey: initiate → hosted completion → signed webhook POST → 200 → `confirmed` projection', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const started = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
    });
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;
    const gatewayRef = await attemptRefFor(bookingId);
    provider.completeCheckout(gatewayRef);
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef,
    });
    expect(await postWebhook(app, delivery)).toBe(200);
    const status = await paymentStatus(app, customer, bookingId);
    expect(status.payment).toMatchObject({ status: 'confirmed' });
  });

  it('late success on a dead hold NEVER projects confirmed: compensation runs (capture + same-amount reversal exactly once) and the projection reports the compensated machine state', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const started = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, {
      holdId,
      quoteId,
      idempotencyKey: newId(),
    });
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;
    const gatewayRef = await attemptRefFor(bookingId);

    // The Himma hold dies (the 10-minute authority) — then the money lands.
    await sql`UPDATE capacity_hold SET state = 'expired'
              WHERE id = ${holdId}`.execute(testDb.db);
    provider.completeCheckout(gatewayRef);
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef,
    });
    expect(await postWebhook(app, delivery)).toBe(200);

    const status = await paymentStatus(app, customer, bookingId);
    expect(status.payment).toEqual({ status: 'compensated' });
    const truth = await sql<{ booking_state: string; captures: string; reversals: string }>`
      SELECT b.state AS booking_state,
             (SELECT count(*) FROM payment_transaction t
               JOIN payment_attempt a ON a.id = t.attempt_id
               JOIN payment_intent i ON i.id = a.intent_id
               WHERE i.booking_id = b.id AND t.kind = 'capture') AS captures,
             (SELECT count(*) FROM payment_transaction t
               JOIN payment_attempt a ON a.id = t.attempt_id
               JOIN payment_intent i ON i.id = a.intent_id
               WHERE i.booking_id = b.id AND t.kind = 'reversal') AS reversals
      FROM booking b WHERE b.id = ${bookingId}`.execute(testDb.db);
    expect(truth.rows[0]!.booking_state).not.toBe('confirmed');
    expect(Number(truth.rows[0]!.captures)).toBe(1);
    expect(Number(truth.rows[0]!.reversals)).toBe(1);
  });

  it('while the compensation reversal is still owed, the projection is `compensationPending` — never confirmed, never silently expired', async () => {
    const owingProvider = new DeterministicPaymentProvider({
      now: NOW,
      defaultScenario: 'compensationFailure',
    });
    const owingApp = makeApp(owingProvider);
    await owingApp.ready();
    try {
      const { customer, quoteId, holdId } = await paidContext(owingApp);
      const started = await inject(owingApp, 'POST', '/customer/bookings/initiate', customer.bearer, {
        holdId,
        quoteId,
        idempotencyKey: newId(),
      });
      expect(started.statusCode).toBe(201);
      const bookingId = started.json().checkout.bookingId as string;
      const gatewayRef = await attemptRefFor(bookingId);
      await sql`UPDATE capacity_hold SET state = 'expired'
                WHERE id = ${holdId}`.execute(testDb.db);
      owingProvider.completeCheckout(gatewayRef);
      const delivery = owingProvider.buildWebhookDelivery({
        gatewayEventId: nextEventId(),
        eventType: 'checkout.completed',
        gatewayRef,
      });
      expect(await postWebhook(owingApp, delivery)).toBe(200);
      const status = await paymentStatus(owingApp, customer, bookingId);
      expect(status.payment).toEqual({ status: 'compensationPending' });
    } finally {
      await owingApp.close();
    }
  });

  it('a dead hold with no payment projects `expired`, and a later initiate winds down typed', async () => {
    const { customer, quoteId, holdId } = await paidContext();
    const body = { holdId, quoteId, idempotencyKey: newId() };
    const started = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body);
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;
    await sql`UPDATE capacity_hold SET state = 'expired'
              WHERE id = ${holdId}`.execute(testDb.db);
    // Effective truth immediately (the S5-5 projection convention).
    const status = await paymentStatus(app, customer, bookingId);
    expect(status.payment).toEqual({ status: 'expired' });
    // Retrying the command winds the checkout down truthfully (W5-2
    // Option-A primitive) — typed, no resurrection, no new session.
    const retry = await inject(app, 'POST', '/customer/bookings/initiate', customer.bearer, body);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().code).toBe('holdExpired');
    const after = await paymentStatus(app, customer, bookingId);
    expect(after.payment).toEqual({ status: 'expired' });
  });
});
