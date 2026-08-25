/**
 * W5 · W5-6 — Payment Core Closeout / Security & Operational Readiness
 * Audit (docs/33 §17 W5-6; the W2-12D/W3-9/S5-6 closeout pattern). Real
 * PostgreSQL + real transport over the deterministic provider.
 *
 * The consolidated final locks: the full paid journey (confirmation AND
 * compensation) with the global Booking↔payment consistency sweep; the
 * final payment route inventory + authority pins (only the trusted
 * Stripe-result → saga path can cause paid confirmation; customer/
 * provider/Admin can assert nothing financial); the customer
 * commercial-data privacy sweep; the audit/outbox payload privacy sweep;
 * the source-level authority matrix (Stripe SDK behind the driver only;
 * ledger inserts in the saga only; commission computed once at snapshot
 * time only; no commission-term HTTP surface; no gateway-fee arithmetic;
 * no Stripe Tax); and the docs/33-assigned W5-6 skeleton — the bounded
 * pure-read reconciliation job, the stuck-state alerting hooks, and the
 * computed payment capability report (B2-6C pattern; production charging
 * structurally impossible).
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
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import {
  paymentCapabilityReport,
  resolvePaymentProvider,
} from '../src/modules/payment/provider-composition';
import {
  findStuckPaymentStates,
  reconcileLedgerAgainstProvider,
} from '../src/modules/payment/services/payment-reconciliation';
import { ingestGatewayDelivery } from '../src/modules/payment/services/webhook-ingestion';
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

const ISSUER = 'https://cognito.test/payment-closeout-pool';
const NOW = new Date('2026-08-21T12:00:00.000Z');
const SUCCESS_URL = 'https://app.himma.test/checkout/return';
const CANCEL_URL = 'https://app.himma.test/checkout/cancel';
const WEBHOOK_URL = '/payments/webhook/deterministicTest';
const SRC = path.join(__dirname, '..', 'src');

let testDb: TestDb;
let verifier: FakeAccessTokenVerifier;
let ctx: ProviderTestContext;
let provider: DeterministicPaymentProvider;
let app: FastifyInstance;
let f: BookingFixture;
let dropInOption: string;
let freeOption: string;

let eventSerial = 0;
const nextEventId = (): string => `evt_w56_${(eventSerial += 1)}`;

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

function inject(
  method: 'GET' | 'POST',
  url: string,
  bearer: string | null,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Every customer-facing body this suite produces, for the privacy sweep. */
const customerBodies: string[] = [];

async function customerCall(
  method: 'GET' | 'POST',
  url: string,
  bearer: string,
  payload?: unknown,
): Promise<{ statusCode: number; json: () => Record<string, unknown>; body: string }> {
  const response = await inject(method, url, bearer, payload);
  customerBodies.push(response.body);
  return response;
}

async function paidContext(): Promise<{
  customer: HttpCustomer;
  sessionId: string;
  quoteId: string;
  holdId: string;
}> {
  const customer = await httpCustomer();
  const sessionId = await createSession(f);
  const quote = await customerCall('POST', '/customer/quotes', customer.bearer, {
    programId: f.programId,
    priceOptionId: dropInOption,
    unitKind: 'session',
    unitId: sessionId,
    participantId: customer.participantId,
  });
  expect(quote.statusCode).toBe(201);
  const quoteId = (quote.json().quote as Record<string, unknown>)['quoteId'] as string;
  const hold = await customerCall('POST', '/customer/holds', customer.bearer, {
    unitKind: 'session',
    unitId: sessionId,
    participantId: customer.participantId,
    quoteId,
    idempotencyKey: newId(),
  });
  expect(hold.statusCode).toBe(201);
  const holdId = (hold.json().hold as Record<string, unknown>)['holdId'] as string;
  return { customer, sessionId, quoteId, holdId };
}

async function attemptRefFor(bookingId: string): Promise<string> {
  const row = await sql<{ gateway_ref: string }>`
    SELECT a.gateway_ref FROM payment_attempt a
    JOIN payment_intent i ON i.id = a.intent_id
    WHERE i.booking_id = ${bookingId}
    ORDER BY a.sequence_no DESC LIMIT 1`.execute(testDb.db);
  return row.rows[0]!.gateway_ref;
}

async function postWebhook(delivery: {
  rawBody: Buffer;
  headers: Record<string, string>;
}): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    payload: delivery.rawBody,
    headers: { 'content-type': 'application/json', ...delivery.headers },
  });
  return response.statusCode;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  verifier = new FakeAccessTokenVerifier();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  provider = new DeterministicPaymentProvider({ now: NOW });
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
    payment: {
      provider,
      checkoutUrls: { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
    },
  });
  await app.ready();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  await createActivePolicyTemplate(testDb.db);
  await createCommissionTerm(testDb.db, f.org.orgId, 1200); // D-W5-7: 12% — stated, never defaulted
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  freeOption = await createPriceOption(f, { kind: 'free' });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// §1/§13/§4/§16 — full-journey reconciliation, global consistency, privacy
// ---------------------------------------------------------------------------

describe('W5-6 closeout — full journey + global consistency + privacy sweeps', () => {
  it('traces the confirmation journey and the compensation journey end-to-end, then proves the global Booking↔payment consistency matrix and sweeps every customer/audit/outbox surface for private material', async () => {
    // ---- Journey 1: quote → hold → initiate → hosted completion → signed
    //      webhook → saga → CONFIRMED (each step through its ONE authority).
    const confirmCtx = await paidContext();
    const started = await customerCall(
      'POST',
      '/customer/bookings/initiate',
      confirmCtx.customer.bearer,
      { holdId: confirmCtx.holdId, quoteId: confirmCtx.quoteId, idempotencyKey: newId() },
    );
    expect(started.statusCode).toBe(201);
    const confirmedBookingId = (started.json().checkout as Record<string, unknown>)[
      'bookingId'
    ] as string;
    const confirmRef = await attemptRefFor(confirmedBookingId);
    provider.completeCheckout(confirmRef);
    expect(
      await postWebhook(
        provider.buildWebhookDelivery({
          gatewayEventId: nextEventId(),
          eventType: 'checkout.completed',
          gatewayRef: confirmRef,
        }),
      ),
    ).toBe(200);
    const confirmedStatus = await customerCall(
      'GET',
      `/customer/bookings/${confirmedBookingId}/payment`,
      confirmCtx.customer.bearer,
    );
    expect((confirmedStatus.json().payment as Record<string, unknown>)['status']).toBe(
      'confirmed',
    );
    const confirmedTruth = await sql<{
      booking_state: string;
      hold_state: string;
      intent_state: string;
      captures: string;
      economics: string;
      rate: number;
      commission: string;
      share: string;
      basis: string;
    }>`SELECT b.state AS booking_state, h.state AS hold_state, i.state AS intent_state,
              (SELECT count(*) FROM payment_transaction t
                JOIN payment_attempt a ON a.id = t.attempt_id
                WHERE a.intent_id = i.id AND t.kind = 'capture') AS captures,
              (SELECT count(*) FROM payment_intent_economics e WHERE e.intent_id = i.id) AS economics,
              e.platform_commission_rate_bps AS rate,
              e.platform_commission_amount_fils AS commission,
              e.provider_share_amount_fils AS share,
              e.commission_basis_amount_fils AS basis
       FROM booking b
       JOIN capacity_hold h ON h.id = b.hold_id
       JOIN payment_intent i ON i.booking_id = b.id
       JOIN payment_intent_economics e ON e.intent_id = i.id
       WHERE b.id = ${confirmedBookingId}`.execute(testDb.db);
    expect(confirmedTruth.rows[0]).toMatchObject({
      booking_state: 'confirmed',
      hold_state: 'consumed',
      intent_state: 'succeeded',
    });
    expect(Number(confirmedTruth.rows[0]!.captures)).toBe(1);
    expect(Number(confirmedTruth.rows[0]!.economics)).toBe(1);
    // D-W5-7 economics: 12% of 5000 = 600 (half-up), share 4400, sum = basis.
    expect(confirmedTruth.rows[0]!.rate).toBe(1200);
    expect(Number(confirmedTruth.rows[0]!.commission)).toBe(600);
    expect(Number(confirmedTruth.rows[0]!.share)).toBe(4400);
    expect(
      Number(confirmedTruth.rows[0]!.commission) + Number(confirmedTruth.rows[0]!.share),
    ).toBe(Number(confirmedTruth.rows[0]!.basis));

    // ---- Journey 2: trusted capture on a dead hold → compensation →
    //      unconfirmed Booking, NO settlement-eligible commission.
    const compCtx = await paidContext();
    const compStarted = await customerCall(
      'POST',
      '/customer/bookings/initiate',
      compCtx.customer.bearer,
      { holdId: compCtx.holdId, quoteId: compCtx.quoteId, idempotencyKey: newId() },
    );
    expect(compStarted.statusCode).toBe(201);
    const compBookingId = (compStarted.json().checkout as Record<string, unknown>)[
      'bookingId'
    ] as string;
    const compRef = await attemptRefFor(compBookingId);
    await sql`UPDATE capacity_hold SET state = 'expired' WHERE id = ${compCtx.holdId}`.execute(
      testDb.db,
    );
    provider.completeCheckout(compRef);
    expect(
      await postWebhook(
        provider.buildWebhookDelivery({
          gatewayEventId: nextEventId(),
          eventType: 'checkout.completed',
          gatewayRef: compRef,
        }),
      ),
    ).toBe(200);
    const compStatus = await customerCall(
      'GET',
      `/customer/bookings/${compBookingId}/payment`,
      compCtx.customer.bearer,
    );
    expect((compStatus.json().payment as Record<string, unknown>)['status']).toBe('compensated');

    // ---- Free journey: zero-total confirms atomically outside payments.
    const freeCustomer = await httpCustomer();
    const freeSession = await createSession(f);
    const freeQuote = await customerCall('POST', '/customer/quotes', freeCustomer.bearer, {
      programId: f.programId,
      priceOptionId: freeOption,
      unitKind: 'session',
      unitId: freeSession,
      participantId: freeCustomer.participantId,
    });
    const freeQuoteId = (freeQuote.json().quote as Record<string, unknown>)['quoteId'] as string;
    const freeHold = await customerCall('POST', '/customer/holds', freeCustomer.bearer, {
      unitKind: 'session',
      unitId: freeSession,
      participantId: freeCustomer.participantId,
      quoteId: freeQuoteId,
      idempotencyKey: newId(),
    });
    const freeHoldId = (freeHold.json().hold as Record<string, unknown>)['holdId'] as string;
    const freeConfirm = await customerCall(
      'POST',
      '/customer/bookings/confirm-free',
      freeCustomer.bearer,
      { holdId: freeHoldId, idempotencyKey: newId() },
    );
    expect(freeConfirm.statusCode).toBe(201);

    // ---- Global consistency matrix (owner item 13) over the WHOLE database.
    const matrix = await sql<{ label: string; n: string }>`
      SELECT 'paidConfirmedWithoutSuccess' AS label, count(*) AS n
        FROM booking b JOIN price_quote q ON q.id = b.quote_id
        WHERE b.state = 'confirmed' AND q.total_fils > 0
          AND NOT EXISTS (SELECT 1 FROM payment_intent i
                          WHERE i.booking_id = b.id AND i.state = 'succeeded')
      UNION ALL
      SELECT 'succeededWithoutExactlyOneCapture', count(*)
        FROM payment_intent i WHERE i.state = 'succeeded'
          AND (SELECT count(*) FROM payment_transaction t
                JOIN payment_attempt a ON a.id = t.attempt_id
                WHERE a.intent_id = i.id AND t.kind = 'capture') <> 1
      UNION ALL
      SELECT 'succeededWithoutConfirmedBooking', count(*)
        FROM payment_intent i JOIN booking b ON b.id = i.booking_id
        WHERE i.state = 'succeeded' AND b.state <> 'confirmed'
      UNION ALL
      SELECT 'compensatedButConfirmed', count(*)
        FROM booking b WHERE b.state = 'confirmed'
          AND EXISTS (SELECT 1 FROM payment_transaction t
                      JOIN payment_attempt a ON a.id = t.attempt_id
                      JOIN payment_intent i ON i.id = a.intent_id
                      WHERE i.booking_id = b.id AND t.kind = 'reversal')
      UNION ALL
      SELECT 'unresolvedCaptureObligation', count(*)
        FROM payment_transaction t
        JOIN payment_attempt a ON a.id = t.attempt_id
        JOIN payment_intent i ON i.id = a.intent_id
        JOIN booking b ON b.id = i.booking_id
        WHERE t.kind = 'capture' AND b.state <> 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM payment_transaction r
                          WHERE r.attempt_id = t.attempt_id AND r.kind = 'reversal')
      UNION ALL
      SELECT 'freeBookingWithPaymentRow', count(*)
        FROM booking b JOIN price_quote q ON q.id = b.quote_id
        WHERE q.total_fils = 0
          AND EXISTS (SELECT 1 FROM payment_intent i WHERE i.booking_id = b.id)
      UNION ALL
      SELECT 'zeroPricePendingPayment', count(*)
        FROM booking b JOIN price_quote q ON q.id = b.quote_id
        WHERE q.total_fils = 0 AND b.state = 'pending_payment'
      UNION ALL
      SELECT 'intentWithoutEconomics', count(*)
        FROM payment_intent i
        WHERE NOT EXISTS (SELECT 1 FROM payment_intent_economics e WHERE e.intent_id = i.id)
      UNION ALL
      SELECT 'economicsSplitBroken', count(*)
        FROM payment_intent_economics e
        WHERE e.platform_commission_amount_fils + e.provider_share_amount_fils
              <> e.commission_basis_amount_fils
      UNION ALL
      SELECT 'oversoldSession', count(*)
        FROM session s WHERE s.booked_count + s.held_count > s.capacity`.execute(testDb.db);
    for (const row of matrix.rows) {
      expect(`${row.label}=${row.n}`).toBe(`${row.label}=0`);
    }
    // NOTE (owner item 13): "capture without confirmed Booking and without
    // reversal" IS a legal TRANSIENT state inside the W5-4 saga (between
    // T-COMP-A and T-COMP-B, or while a reversal outcome is unknown) — it
    // is the durable, sweep-recoverable compensation obligation. At REST
    // (all work items drained, as here) it must be zero, which is exactly
    // what `unresolvedCaptureObligation` proves.

    // ---- Customer commercial-data privacy sweep (owner item 4): NO body
    //      this suite produced carries economics/secret/internal material.
    expect(customerBodies.length).toBeGreaterThan(8);
    for (const body of customerBodies) {
      expect(body).not.toMatch(
        /commission|rate_bps|rateBps|providerShare|provider_share|basis_amount|sk_test|sk_live|whsec|gatewayExpiresAt|payment_transaction|gateway_event|client_secret/i,
      );
    }

    // ---- Audit/outbox payload privacy sweep (owner item 16).
    const audit = await sql<{ blob: string }>`
      SELECT concat_ws(' ', action, entity_type, actor_id, principal_context,
                       before_digest, after_digest) AS blob
      FROM audit_event`.execute(testDb.db);
    for (const row of audit.rows) {
      expect(row.blob).not.toMatch(
        /https?:\/\/|sk_test|sk_live|whsec|cvv|pan_|card_number|commission|rate_bps/i,
      );
    }
    const outbox = await sql<{ blob: string }>`
      SELECT payload::text AS blob FROM outbox_event`.execute(testDb.db);
    for (const row of outbox.rows) {
      expect(row.blob).not.toMatch(
        /https?:\/\/|sk_test|sk_live|whsec|cvv|card|commission|rateBps|providerShare/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §2/§3 — final route inventory + payment authority matrix
// ---------------------------------------------------------------------------

describe('W5-6 closeout — final route inventory and authority pins', () => {
  it('the externally reachable payment surface is EXACTLY the three docs/33-assigned boundaries; every forbidden payment-authority URL family is absent; the webhook is never behind Himma auth; provider/Admin have no payment surface at all', () => {
    const inventory = app.routePolicyInventory.filter((route) => route.method !== 'HEAD');
    const paymentSurface = inventory
      .filter(
        (route) =>
          route.url.startsWith('/payments') ||
          route.url === '/customer/bookings/initiate' ||
          route.url === '/customer/bookings/:bookingId/payment',
      )
      .map((route) => `${route.method} ${route.url} → ${route.policy}`)
      .sort();
    expect(paymentSurface).toEqual([
      'GET /customer/bookings/:bookingId/payment → authenticatedCustomer',
      'POST /customer/bookings/initiate → authenticatedCustomer',
      'POST /payments/webhook/deterministicTest → public',
    ]);
    for (const route of inventory) {
      // Forbidden authority families (owner item 3).
      expect(route.url).not.toMatch(
        /payment-success|payment-succeeded|mark-paid|confirm-paid|confirm-payment|capture|refund|reversal|commission|payout|transfer|settlement/i,
      );
      // The webhook is Stripe-authenticated only — never under customer/
      // provider/Admin auth, and no auth surface hosts a webhook.
      if (route.url.startsWith('/payments')) expect(route.policy).toBe('public');
      if (/webhook/i.test(route.url)) expect(route.url.startsWith('/payments')).toBe(true);
      // Provider/Admin surfaces carry NO payment route of any kind.
      if (route.url.startsWith('/admin') || route.url.startsWith('/provider')) {
        expect(route.url).not.toMatch(/payment|stripe|webhook|intent|ledger/i);
      }
    }
  });

  it('source-level authority matrix: paid confirmation only via the saga; ledger writes only in the saga; commission computed only at snapshot time; Stripe SDK only behind the driver; no commission-term HTTP surface; no gateway-fee arithmetic; no Stripe Tax', () => {
    const files = sourceFiles(SRC);
    const byPattern = (pattern: RegExp): string[] =>
      files
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => path.relative(SRC, file))
        .sort();

    // Only the frozen S5-3 boundary defines and the W5-4 saga invokes the
    // trusted paid confirmation (comment mentions excluded by the call
    // pattern) — no HTTP module, no other worker, nothing customer/provider/
    // Admin reachable.
    expect(byPattern(/confirmPaidBooking\(/)).toEqual([
      'modules/booking/services/booking-lifecycle.ts',
      'modules/payment/services/payment-saga.ts',
    ]);
    // The append-only financial ledger is written by the saga ALONE.
    expect(byPattern(/insertInto\('payment_transaction'\)/)).toEqual([
      'modules/payment/services/payment-saga.ts',
    ]);
    // Commission is computed EXACTLY at snapshot creation (plus its pure
    // module) — nothing recomputes historical commission from current rates.
    expect(byPattern(/computeCommissionSplit\(/)).toEqual([
      'modules/payment/commission.ts',
      'modules/payment/services/checkout-orchestration.ts',
    ]);
    // The Stripe SDK exists ONLY behind the driver boundary.
    expect(byPattern(/from 'stripe'/)).toEqual(['modules/payment/stripe-driver.ts']);
    // No HTTP module touches the commission-term mechanism at all — the
    // production administration capability is a recorded launch
    // prerequisite, deliberately NOT built (D-W3-5 classification required).
    const httpDirs = files.filter((file) => file.includes(`${path.sep}http${path.sep}`));
    for (const file of httpDirs) {
      expect(readFileSync(file, 'utf8')).not.toContain('organization_commission_term');
    }
    // No gateway-fee arithmetic anywhere (owner item 7: allocation is an
    // unresolved commercial decision) and no Stripe Tax logic (D-W5-3).
    expect(byPattern(/application_fee|processing_fee|automatic_tax|stripe\.tax/i)).toEqual([]);
    // Production composition can never substitute the deterministic fake and
    // can never produce a provider at all in W5 (re-pinned at closeout).
    const deterministic = new DeterministicPaymentProvider({ now: NOW });
    expect(resolvePaymentProvider('production', { deterministic }).kind).toBe('unconfigured');
    expect(
      resolvePaymentProvider('production', {
        stripe: { secretKey: 'sk_test_fictional', webhookSecret: 'whsec_fictional' },
      }).kind,
    ).toBe('unconfigured');
  });
});

// ---------------------------------------------------------------------------
// §17-skeleton — reconciliation job, stuck-state hooks, capability report
// ---------------------------------------------------------------------------

describe('W5-6 closeout — reconciliation skeleton, stuck-state hooks, capability report', () => {
  it('the bounded pure-read reconciliation classifies ledger-vs-provider truth without converging anything', async () => {
    // An OPEN checkout is consistent; a provider-side capture the ledger has
    // not posted yet is the §8.9 convergence signal; a corrupted reported
    // amount is a mismatch; a fresh provider that knows no refs reports
    // providerMissing; a ledger capture the provider does not corroborate is
    // flagged. Nothing is written by any of it.
    const openCtx = await paidContext();
    const started = await inject('POST', '/customer/bookings/initiate', openCtx.customer.bearer, {
      holdId: openCtx.holdId,
      quoteId: openCtx.quoteId,
      idempotencyKey: newId(),
    });
    expect(started.statusCode).toBe(201);
    const bookingId = started.json().checkout.bookingId as string;
    const ref = await attemptRefFor(bookingId);

    const open = await reconcileLedgerAgainstProvider({ db: testDb.db, provider }, { limit: 1 });
    expect(open).toMatchObject({ examined: 1, consistent: 1, findings: [] });

    provider.completeCheckout(ref); // money exists provider-side, no webhook yet
    const unposted = await reconcileLedgerAgainstProvider(
      { db: testDb.db, provider },
      { limit: 1 },
    );
    expect(unposted.findings).toEqual([
      expect.objectContaining({ kind: 'captureUnposted', gatewayRef: ref }),
    ]);

    provider.setReportedAmount(ref, 4999); // adversarial provider truth
    const mismatch = await reconcileLedgerAgainstProvider(
      { db: testDb.db, provider },
      { limit: 1 },
    );
    expect(mismatch.findings).toEqual([
      expect.objectContaining({ kind: 'amountMismatch', gatewayRef: ref }),
    ]);
    provider.setReportedAmount(ref, 5000);

    const blindProvider = new DeterministicPaymentProvider({ now: NOW });
    const missing = await reconcileLedgerAgainstProvider(
      { db: testDb.db, provider: blindProvider },
      { limit: 1 },
    );
    expect(missing.findings).toEqual([
      expect.objectContaining({ kind: 'providerMissing', gatewayRef: ref }),
    ]);

    // Reconciliation wrote NOTHING: intent still live, no postings, no audit
    // from reads (it is a diagnostic, never an authority).
    const truth = await sql<{ state: string; postings: string }>`
      SELECT i.state, (SELECT count(*) FROM payment_transaction t
        JOIN payment_attempt a ON a.id = t.attempt_id
        WHERE a.intent_id = i.id) AS postings
      FROM payment_intent i WHERE i.booking_id = ${bookingId}`.execute(testDb.db);
    expect(truth.rows[0]!.state).toBe('in_progress');
    expect(Number(truth.rows[0]!.postings)).toBe(0);

    // captureUncorroborated: a ledger capture the provider does not confirm
    // (adversarial direct insert — the DB permits INSERT; the provider says
    // the session is still open).
    const stray = await paidContext();
    const strayStart = await inject('POST', '/customer/bookings/initiate', stray.customer.bearer, {
      holdId: stray.holdId,
      quoteId: stray.quoteId,
      idempotencyKey: newId(),
    });
    const strayBooking = strayStart.json().checkout.bookingId as string;
    await sql`INSERT INTO payment_transaction (id, attempt_id, kind, amount_fils, gateway_transaction_id)
              SELECT ${newId()}, a.id, 'capture', 5000, ${`dt_txn_stray_${newId()}`}
              FROM payment_attempt a JOIN payment_intent i ON i.id = a.intent_id
              WHERE i.booking_id = ${strayBooking}`.execute(testDb.db);
    const uncorroborated = await reconcileLedgerAgainstProvider(
      { db: testDb.db, provider },
      { limit: 1 },
    );
    expect(uncorroborated.findings).toEqual([
      expect.objectContaining({ kind: 'captureUncorroborated' }),
    ]);
  });

  it('the stuck-state hooks surface exactly the states that should not persist — and the age threshold filters fresh states out', async () => {
    // A durable unprocessed event (receipt without any processing pass).
    const evCtx = await paidContext();
    const evStart = await inject('POST', '/customer/bookings/initiate', evCtx.customer.bearer, {
      holdId: evCtx.holdId,
      quoteId: evCtx.quoteId,
      idempotencyKey: newId(),
    });
    const evBooking = evStart.json().checkout.bookingId as string;
    const evRef = await attemptRefFor(evBooking);
    provider.completeCheckout(evRef);
    const delivery = provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: evRef,
    });
    const ingested = await ingestGatewayDelivery(
      { db: testDb.db, provider },
      delivery.rawBody,
      delivery.headers,
    );
    expect(ingested.kind).toBe('accepted');

    // A live intent on a dead hold (wind-down runner missing/behind).
    const deadCtx = await paidContext();
    const deadStart = await inject('POST', '/customer/bookings/initiate', deadCtx.customer.bearer, {
      holdId: deadCtx.holdId,
      quoteId: deadCtx.quoteId,
      idempotencyKey: newId(),
    });
    expect(deadStart.statusCode).toBe(201);
    await sql`UPDATE capacity_hold SET state = 'expired' WHERE id = ${deadCtx.holdId}`.execute(
      testDb.db,
    );

    const stuck = await findStuckPaymentStates({ db: testDb.db }, { olderThanSeconds: 0 });
    expect(
      stuck.unprocessedGatewayEvents.some((event) => event.processingState === 'received'),
    ).toBe(true);
    expect(
      stuck.liveIntentsOnDeadHolds.some((item) => item.holdId === deadCtx.holdId),
    ).toBe(true);
    // The adversarial stray capture from the reconciliation test is the
    // outstanding-compensation ledger shape (capture, unsucceeded intent,
    // no reversal).
    expect(stuck.outstandingCompensations.length).toBeGreaterThanOrEqual(1);

    // With the default (15-minute) threshold, none of these FRESH states
    // alert — the hooks measure persistence, not existence.
    const calm = await findStuckPaymentStates({ db: testDb.db });
    expect(calm.unprocessedGatewayEvents).toEqual([]);
    expect(calm.liveIntentsOnDeadHolds).toEqual([]);
    expect(calm.outstandingCompensations).toEqual([]);
    expect(calm.refAwaitingAttempts).toEqual([]);
  });

  it('the computed capability report follows the B2-6C pattern: readiness is derived, production charging is structurally impossible, and no input can force anything', () => {
    const deterministic = new DeterministicPaymentProvider({ now: NOW });

    const none = paymentCapabilityReport('test');
    expect(none).toMatchObject({
      provider: 'none',
      providerConfigured: false,
      customerCheckoutAvailable: false,
      webhookIngressAvailable: false,
      productionChargingPossible: false,
    });
    expect(none.reasons.length).toBeGreaterThan(0);

    const noUrls = paymentCapabilityReport('test', { deterministic });
    expect(noUrls).toMatchObject({
      provider: 'deterministicTest',
      providerConfigured: true,
      checkoutUrlsConfigured: false,
      customerCheckoutAvailable: false,
      webhookIngressAvailable: true,
    });

    const full = paymentCapabilityReport(
      'test',
      { deterministic },
      { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
    );
    expect(full).toMatchObject({
      customerCheckoutAvailable: true,
      productionChargingPossible: false,
    });

    const stripeSandbox = paymentCapabilityReport(
      'development',
      { stripe: { secretKey: 'sk_test_fictional', webhookSecret: 'whsec_fictional' } },
      { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
    );
    expect(stripeSandbox).toMatchObject({
      provider: 'stripe',
      providerConfigured: true,
      webhookSecretConfigured: true,
      customerCheckoutAvailable: true,
      productionChargingPossible: false,
    });

    // A live key is refused; production composes NOTHING — the report can
    // only say so (there is no field an operator could set to change it).
    const liveKey = paymentCapabilityReport('development', {
      stripe: { secretKey: 'sk_live_fictional' },
    });
    expect(liveKey.providerConfigured).toBe(false);
    const production = paymentCapabilityReport(
      'production',
      { deterministic },
      { successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
    );
    expect(production).toMatchObject({
      provider: 'none',
      providerConfigured: false,
      customerCheckoutAvailable: false,
      webhookIngressAvailable: false,
      productionChargingPossible: false,
    });
  });
});
