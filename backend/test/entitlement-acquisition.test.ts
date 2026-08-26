/**
 * S6-1 — entitlement acquisition certification (docs/35 §5, §13, §17
 * proofs 7–9, 13, 19–20; owner items 17–25, 29, 33–34). Real PostgreSQL +
 * real Fastify transport over the deterministic provider.
 *
 * FREE acquisition: one idempotent transaction creates Purchase (AS
 * `confirmed`) + Entitlement with ZERO payment artifacts — no intent, no
 * transaction, no economics, no provider request, no observable
 * zero-price pending_payment. Same-key storms replay one result set.
 *
 * PAID acquisition: the SAME W5 stack — generalized orchestration, one
 * live intent + one economics snapshot per purchase, stable provider
 * session, trusted webhook → saga → `confirmPaidEntitlementPurchase`
 * (HTTP-unreachable) → exactly one Entitlement; repeated deliveries
 * converge. Late success on a still-pending purchase CONFIRMS; a swept
 * (terminal) purchase COMPENSATES — no entitlement, no settleable
 * economics; a captured intent is never swept.
 *
 * Cross-path exclusion: one acquisition quote can never confirm once free
 * and once paid, under any key/race combination.
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
import {
  startPaidEntitlementCheckout,
  sweepLapsedPaidCheckouts,
} from '../src/modules/payment/services/checkout-orchestration';
import {
  customerEntitlementPurchasePaymentStatus,
} from '../src/modules/payment/services/customer-payment-read';
import { processTrustedPaymentResults } from '../src/modules/payment/services/payment-saga';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../src/modules/payment/services/webhook-ingestion';
import {
  confirmFreeEntitlementPurchase,
} from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  createBookingFixture,
  createCommissionTerm,
  createCustomer,
  createFulfillmentRevision,
  createPriceOption,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/entitlement-acquisition-pool';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const SUCCESS_URL = 'https://app.himma.test/checkout/return';
const CANCEL_URL = 'https://app.himma.test/checkout/cancel';

let testDb: TestDb;
let verifier: FakeAccessTokenVerifier;
let ctx: ProviderTestContext;
let provider: DeterministicPaymentProvider;
let app: FastifyInstance;
let f: BookingFixture;
let packOption: string; // 10 sessions, AED 800 (80000 fils), 90 days
let freePackOption: string; // 3 sessions, genuinely free
let membershipOption: string; // finite 8 uses / 30 days
let unlimitedOption: string; // unlimited, fixed end date

let eventSerial = 0;
const nextEventId = (): string => `evt_s61_${(eventSerial += 1)}`;

interface HttpCustomer extends Customer {
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

const serviceDeps = () => ({ db: testDb.db });
const orchestration = () => ({
  db: testDb.db,
  provider: { kind: 'configured' as const, provider },
});

async function acquisitionQuote(
  customer: Customer,
  optionId: string,
): Promise<{ quoteId: string; totalFils: number }> {
  const result = await requestEntitlementQuote(serviceDeps(), { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    participantId: customer.participantId,
  });
  if (result.kind !== 'quoteIssued') throw new Error(result.kind);
  return { quoteId: result.quote.quoteId, totalFils: result.quote.totalFils };
}

async function paidCheckout(
  customer: Customer,
  optionId: string,
  options: { idempotencyKey?: string; windowSeconds?: number } = {},
): Promise<{ quoteId: string; purchaseId: string; intentId: string; gatewayRef: string; key: string }> {
  const { quoteId } = await acquisitionQuote(customer, optionId);
  const key = options.idempotencyKey ?? newId();
  const started = await startPaidEntitlementCheckout(
    {
      ...orchestration(),
      ...(options.windowSeconds !== undefined
        ? { purchaseWindowSeconds: options.windowSeconds }
        : {}),
    },
    { accountId: customer.accountId },
    { quoteId, idempotencyKey: key, returnUrl: SUCCESS_URL, cancelUrl: CANCEL_URL },
  );
  if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
  return {
    quoteId,
    purchaseId: started.purchaseId,
    intentId: started.intentId,
    gatewayRef: started.gatewayRef,
    key,
  };
}

/** Deliver a signed success event through the certified trusted ingress and
 *  run the W5-3 lifecycle to `verified`. */
async function deliverSuccess(gatewayRef: string): Promise<void> {
  const delivery = provider.buildWebhookDelivery({
    gatewayEventId: nextEventId(),
    eventType: 'payment.captured',
    gatewayRef,
  });
  const deps = { db: testDb.db, provider };
  const accepted = await ingestGatewayDelivery(deps, delivery.rawBody, delivery.headers);
  if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
  await processPendingGatewayEvents(deps);
}

async function purchaseTruths(purchaseId: string): Promise<{
  state: string;
  entitlements: number;
  intents: number;
  economics: number;
  captures: number;
  reversals: number;
}> {
  const row = await sql<{
    state: string;
    entitlements: string;
    intents: string;
    economics: string;
    captures: string;
    reversals: string;
  }>`
    SELECT p.state,
      (SELECT count(*) FROM entitlement e WHERE e.purchase_id = p.id) AS entitlements,
      (SELECT count(*) FROM payment_intent i WHERE i.purchase_id = p.id) AS intents,
      (SELECT count(*) FROM payment_intent_economics x
        JOIN payment_intent i ON i.id = x.intent_id WHERE i.purchase_id = p.id) AS economics,
      (SELECT count(*) FROM payment_transaction t
        JOIN payment_attempt a ON a.id = t.attempt_id
        JOIN payment_intent i ON i.id = a.intent_id
        WHERE i.purchase_id = p.id AND t.kind = 'capture') AS captures,
      (SELECT count(*) FROM payment_transaction t
        JOIN payment_attempt a ON a.id = t.attempt_id
        JOIN payment_intent i ON i.id = a.intent_id
        WHERE i.purchase_id = p.id AND t.kind = 'reversal') AS reversals
    FROM entitlement_purchase p WHERE p.id = ${purchaseId}`.execute(testDb.db);
  const r = row.rows[0]!;
  return {
    state: r.state,
    entitlements: Number(r.entitlements),
    intents: Number(r.intents),
    economics: Number(r.economics),
    captures: Number(r.captures),
    reversals: Number(r.reversals),
  };
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
  await createCommissionTerm(testDb.db, f.org.orgId, 1200); // the recorded launch rate — stated, never defaulted
  packOption = await createPriceOption(f, { kind: 'package', amountFils: 100000, sessionsCount: 10 });
  await createFulfillmentRevision(f, packOption, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 90,
  });
  freePackOption = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 3 });
  await createFulfillmentRevision(f, freePackOption, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
  });
  membershipOption = await createPriceOption(f, { kind: 'membership', amountFils: 48000 });
  await createFulfillmentRevision(f, membershipOption, {
    usageKind: 'finite',
    usesTotal: 8,
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
    reservationRequired: true,
    walkInAllowed: true,
  });
  unlimitedOption = await createPriceOption(f, { kind: 'membership', amountFils: 60000 });
  await createFulfillmentRevision(f, unlimitedOption, {
    usageKind: 'unlimited',
    validityKind: 'fixedEndDate',
    validityEndDate: '2026-12-31',
  });
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Acquisition quote — the unit-less certified branch
// ---------------------------------------------------------------------------

describe('entitlement-acquisition quote', () => {
  it('issues the server-authored quote with the immutable terms; capacity options are refused', async () => {
    const customer = await createCustomer(testDb.db);
    const result = await requestEntitlementQuote(serviceDeps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: membershipOption,
      participantId: customer.participantId,
    });
    expect(result.kind).toBe('quoteIssued');
    if (result.kind !== 'quoteIssued') return;
    expect(result.quote.totalFils).toBe(48000);
    expect(result.quote.fulfillment).toEqual({
      usageKind: 'finite',
      usesTotal: 8,
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: true,
      walkInAllowed: true,
    });
    // The stored quote is unit-less and revision-bound.
    const stored = await sql<{ commercial_shape: string; n: string }>`
      SELECT commercial_shape,
             num_nonnulls(session_id, camp_week_id, cohort_id) AS n
      FROM price_quote WHERE id = ${result.quote.quoteId}`.execute(testDb.db);
    expect(stored.rows[0]).toEqual({ commercial_shape: 'entitlementAcquisition', n: 0 });

    const dropIn = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
    const refused = await requestEntitlementQuote(serviceDeps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: dropIn,
      participantId: customer.participantId,
    });
    expect(refused.kind).toBe('optionNotEntitlement');
  });

  it('fails CLOSED without an active fulfillment revision, and for foreign participants', async () => {
    const customer = await createCustomer(testDb.db);
    const bare = await createPriceOption(f, { kind: 'package', amountFils: 30000, sessionsCount: 5 });
    const noRevision = await requestEntitlementQuote(serviceDeps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: bare,
      participantId: customer.participantId,
    });
    expect(noRevision.kind).toBe('fulfillmentUnavailable');

    const stranger = await createCustomer(testDb.db);
    const foreign = await requestEntitlementQuote(serviceDeps(), { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: membershipOption,
      participantId: stranger.participantId,
    });
    expect(foreign.kind).toBe('participantNotFound');
  });
});

// ---------------------------------------------------------------------------
// FREE acquisition — zero payment state, ever (owner §19; proof 19)
// ---------------------------------------------------------------------------

describe('zero-price acquisition', () => {
  it('atomically creates ONE confirmed Purchase + ONE Entitlement with ZERO payment artifacts; storms replay', async () => {
    const customer = await createCustomer(testDb.db);
    const { quoteId, totalFils } = await acquisitionQuote(customer, freePackOption);
    expect(totalFils).toBe(0);
    const before = {
      requests: provider.createRequestCount,
      sessions: provider.sessionCount,
    };
    const key = newId();
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(
        await confirmFreeEntitlementPurchase(serviceDeps(), { accountId: customer.accountId }, {
          quoteId,
          idempotencyKey: key,
        }),
      );
    }
    for (const run of results) {
      expect(run.outcome.kind).toBe('purchaseConfirmed');
    }
    const first = results[0]!.outcome;
    if (first.kind !== 'purchaseConfirmed') return;
    const purchaseId = first.purchase.purchaseId;
    expect(first.purchase.state).toBe('confirmed');
    expect(first.purchase.referenceCode).toMatch(/^HMP-/);
    expect(first.purchase.entitlement?.usageKind).toBe('finite');
    expect(first.purchase.entitlement?.usesTotal).toBe(3); // sessions_count IS the total
    // Every replay returned the SAME purchase.
    for (const run of results.slice(1)) {
      expect(run.replayed).toBe(true);
      if (run.outcome.kind === 'purchaseConfirmed') {
        expect(run.outcome.purchase.purchaseId).toBe(purchaseId);
      }
    }
    // ZERO payment machinery: no intent, no economics, no provider request.
    const truths = await purchaseTruths(purchaseId);
    expect(truths).toEqual({
      state: 'confirmed',
      entitlements: 1,
      intents: 0,
      economics: 0,
      captures: 0,
      reversals: 0,
    });
    expect(provider.createRequestCount).toBe(before.requests);
    expect(provider.sessionCount).toBe(before.sessions);
    // No observable zero-price pending_payment ever existed, and the audit/
    // outbox effect set is exactly one.
    const audits = await sql<{ action: string; n: string }>`
      SELECT action, count(*) AS n FROM audit_event
      WHERE entity_type = 'entitlement_purchase' AND entity_id = ${purchaseId}
      GROUP BY action ORDER BY action`.execute(testDb.db);
    expect(audits.rows).toEqual([
      { action: 'entitlement.purchase.confirmed', n: '1' },
      { action: 'entitlement.purchase.created', n: '1' },
    ]);
    const outbox = await sql<{ event_type: string; n: string }>`
      SELECT event_type, count(*) AS n FROM outbox_event
      WHERE aggregate_type = 'entitlement_purchase' AND aggregate_id = ${purchaseId}
      GROUP BY event_type`.execute(testDb.db);
    expect(outbox.rows).toEqual([{ event_type: 'entitlement.purchase.confirmed', n: '1' }]);
  });

  it('refuses a NONZERO quote (`notFreeQuote`); paid initiation refuses a ZERO quote (`paymentNotRequired`)', async () => {
    const customer = await createCustomer(testDb.db);
    const paid = await acquisitionQuote(customer, packOption);
    const run = await confirmFreeEntitlementPurchase(serviceDeps(), { accountId: customer.accountId }, {
      quoteId: paid.quoteId,
      idempotencyKey: newId(),
    });
    expect(run.outcome.kind).toBe('notFreeQuote');
    const free = await acquisitionQuote(customer, freePackOption);
    const initiated = await startPaidEntitlementCheckout(orchestration(), { accountId: customer.accountId }, {
      quoteId: free.quoteId,
      idempotencyKey: newId(),
      returnUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    });
    expect(initiated.kind).toBe('paymentNotRequired');
  });

  it('failure injection: a crash after the Purchase insert leaves NOTHING behind and the key replays cleanly', async () => {
    const customer = await createCustomer(testDb.db);
    const { quoteId } = await acquisitionQuote(customer, freePackOption);
    const key = newId();
    const boom = new Error('injected: after purchase insert');
    await expect(
      confirmFreeEntitlementPurchase(
        {
          db: testDb.db,
          onAcquirePhase: (phase) => {
            if (phase === 'purchaseInserted') throw boom;
          },
        },
        { accountId: customer.accountId },
        { quoteId, idempotencyKey: key },
      ),
    ).rejects.toThrow('injected: after purchase insert');
    const nothing = await sql<{ n: string }>`
      SELECT count(*) AS n FROM entitlement_purchase WHERE quote_id = ${quoteId}`.execute(
      testDb.db,
    );
    expect(Number(nothing.rows[0]!.n)).toBe(0);
    // Same for a crash between the Purchase and its Entitlement.
    await expect(
      confirmFreeEntitlementPurchase(
        {
          db: testDb.db,
          onAcquirePhase: (phase) => {
            if (phase === 'entitlementInserted') throw boom;
          },
        },
        { accountId: customer.accountId },
        { quoteId, idempotencyKey: key },
      ),
    ).rejects.toThrow();
    const stillNothing = await sql<{ p: string; e: string }>`
      SELECT (SELECT count(*) FROM entitlement_purchase WHERE quote_id = ${quoteId}) AS p,
             (SELECT count(*) FROM entitlement e
               JOIN entitlement_purchase ep ON ep.id = e.purchase_id
               WHERE ep.quote_id = ${quoteId}) AS e`.execute(testDb.db);
    expect(stillNothing.rows[0]).toEqual({ p: '0', e: '0' });
    // The unpoisoned key completes on retry.
    const retry = await confirmFreeEntitlementPurchase(serviceDeps(), { accountId: customer.accountId }, {
      quoteId,
      idempotencyKey: key,
    });
    expect(retry.outcome.kind).toBe('purchaseConfirmed');
  });
});

// ---------------------------------------------------------------------------
// PAID acquisition — the same W5 stack (owner §18; proofs 7, 9)
// ---------------------------------------------------------------------------

describe('paid acquisition', () => {
  it('same-key storm ×20: ONE purchase, ONE live intent, ONE economics snapshot, ONE provider session', async () => {
    const customer = await createCustomer(testDb.db);
    const { quoteId } = await acquisitionQuote(customer, packOption);
    const key = newId();
    const sessionsBefore = provider.sessionCount;
    const outcomes = [];
    for (let i = 0; i < 20; i += 1) {
      outcomes.push(
        await startPaidEntitlementCheckout(orchestration(), { accountId: customer.accountId }, {
          quoteId,
          idempotencyKey: key,
          returnUrl: SUCCESS_URL,
          cancelUrl: CANCEL_URL,
        }),
      );
    }
    const first = outcomes[0]!;
    if (first.kind !== 'checkoutStarted') throw new Error(first.kind);
    for (const outcome of outcomes) {
      if (outcome.kind !== 'checkoutStarted') throw new Error(outcome.kind);
      expect(outcome.purchaseId).toBe(first.purchaseId);
      expect(outcome.intentId).toBe(first.intentId);
      expect(outcome.gatewayRef).toBe(first.gatewayRef);
      expect(outcome.redirectUrl).toBe(first.redirectUrl);
    }
    expect(provider.sessionCount).toBe(sessionsBefore + 1);
    const truths = await purchaseTruths(first.purchaseId);
    expect(truths.state).toBe('pending_payment');
    expect(truths.intents).toBe(1);
    expect(truths.economics).toBe(1);
    expect(truths.entitlements).toBe(0);
    // D-W5-7 at 1200 bps on AED 1,000: 120.00 / 880.00 (in fils).
    const economics = await sql<{
      commission_basis_amount_fils: string;
      platform_commission_rate_bps: number;
      platform_commission_amount_fils: string;
      provider_share_amount_fils: string;
    }>`
      SELECT x.commission_basis_amount_fils, x.platform_commission_rate_bps,
             x.platform_commission_amount_fils, x.provider_share_amount_fils
      FROM payment_intent_economics x WHERE x.intent_id = ${first.intentId}`.execute(testDb.db);
    expect(economics.rows[0]).toEqual({
      commission_basis_amount_fils: '100000',
      platform_commission_rate_bps: 1200,
      platform_commission_amount_fils: '12000',
      provider_share_amount_fils: '88000',
    });
  });

  it('trusted success → saga → confirmPaidEntitlementPurchase: ONE entitlement; repeated delivery converges', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await paidCheckout(customer, membershipOption);
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    const summary = await processTrustedPaymentResults({ db: testDb.db, provider });
    expect(summary.confirmed).toBe(1);
    const truths = await purchaseTruths(checkout.purchaseId);
    expect(truths).toMatchObject({
      state: 'confirmed',
      entitlements: 1,
      captures: 1,
      reversals: 0,
    });
    const intent = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${checkout.intentId}`.execute(testDb.db);
    expect(intent.rows[0]!.state).toBe('succeeded');
    // Validity per D-S6-4: 30 days from acquisition CONFIRMATION.
    const grant = await sql<{ delta_days: number; uses_total: number }>`
      SELECT round(extract(epoch FROM (e.valid_until - e.valid_from)) / 86400)::int
               AS delta_days,
             e.uses_total
      FROM entitlement e WHERE e.purchase_id = ${checkout.purchaseId}`.execute(testDb.db);
    expect(grant.rows[0]).toEqual({ delta_days: 30, uses_total: 8 });
    // Repeated webhook/saga delivery (proof 9): converges, no second effect.
    await deliverSuccess(checkout.gatewayRef);
    const replay = await processTrustedPaymentResults({ db: testDb.db, provider });
    expect(replay.converged).toBe(1);
    expect(replay.confirmed).toBe(0);
    const after = await purchaseTruths(checkout.purchaseId);
    expect(after.entitlements).toBe(1);
    expect(after.captures).toBe(1);
  });

  it('unlimited pass: NO fake counter — uses_total NULL, validity from the fixed end date', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await paidCheckout(customer, unlimitedOption);
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    await processTrustedPaymentResults({ db: testDb.db, provider });
    const grant = await sql<{ usage_kind: string; uses_total: number | null; valid_until: Date }>`
      SELECT usage_kind, uses_total, valid_until FROM entitlement e
      WHERE e.purchase_id = ${checkout.purchaseId}`.execute(testDb.db);
    expect(grant.rows[0]!.usage_kind).toBe('unlimited');
    expect(grant.rows[0]!.uses_total).toBeNull();
    // End of 2026-12-31 in Asia/Dubai (UTC+4) = 2026-12-31T20:00:00Z.
    expect(grant.rows[0]!.valid_until.toISOString()).toBe('2026-12-31T20:00:00.000Z');
  });

  it('LATE success on a still-pending purchase past its window CONFIRMS (abandonment metadata, no inventory)', async () => {
    const customer = await createCustomer(testDb.db);
    // A zero-second window: expires_at passes immediately, but nothing
    // terminalizes the purchase before the capture arrives.
    const checkout = await paidCheckout(customer, packOption, { windowSeconds: 0 });
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    const summary = await processTrustedPaymentResults({ db: testDb.db, provider });
    expect(summary.confirmed).toBe(1);
    expect((await purchaseTruths(checkout.purchaseId)).state).toBe('confirmed');
  });

  it('SWEPT purchase then late capture → COMPENSATION: no entitlement, reversal posted, no settleable economics (proofs 8, 13)', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await paidCheckout(customer, packOption, { windowSeconds: 0 });
    // The customer completes the hosted session BEFORE the sweep's
    // best-effort expiry can stop it — the exact slipped-through-completion
    // case: provider-side money exists, Himma's ledger knows nothing yet.
    provider.completeCheckout(checkout.gatewayRef);
    // The wind-down sweep terminalizes the (ledger-)capture-less lapsed
    // checkout truthfully.
    const swept = await sweepLapsedPaidCheckouts({ db: testDb.db, provider });
    expect(swept.woundDown).toBeGreaterThanOrEqual(1);
    expect((await purchaseTruths(checkout.purchaseId)).state).toBe('expired');
    const intent = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${checkout.intentId}`.execute(testDb.db);
    expect(intent.rows[0]!.state).toBe('expired');
    // The captured money now surfaces via the trusted webhook — the saga
    // must COMPENSATE, never resurrect the terminal purchase.
    await deliverSuccess(checkout.gatewayRef);
    const summary = await processTrustedPaymentResults({ db: testDb.db, provider });
    expect(summary.compensated).toBe(1);
    const truths = await purchaseTruths(checkout.purchaseId);
    expect(truths).toMatchObject({
      state: 'expired', // terminal states never resurrect
      entitlements: 0,
      captures: 1,
      reversals: 1,
    });
    // No settleable commission: the intent never reached `succeeded`.
    const settled = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${checkout.intentId}`.execute(testDb.db);
    expect(settled.rows[0]!.state).toBe('expired');
  });

  it('a CAPTURED intent is never swept (proof 13 guard)', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await paidCheckout(customer, packOption, { windowSeconds: 0 });
    // Capture evidence lands BEFORE any sweep runs.
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    await processTrustedPaymentResults({ db: testDb.db, provider });
    expect((await purchaseTruths(checkout.purchaseId)).state).toBe('confirmed');
    // The sweep finds nothing to wind down for this purchase.
    await sweepLapsedPaidCheckouts({ db: testDb.db, provider });
    expect((await purchaseTruths(checkout.purchaseId)).state).toBe('confirmed');
  });

  it('participant archived between initiation and capture → compensation (§5.4 refusal set)', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await paidCheckout(customer, packOption);
    await sql`UPDATE participant SET status = 'archived'
              WHERE id = ${customer.participantId}`.execute(testDb.db);
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    const summary = await processTrustedPaymentResults({ db: testDb.db, provider });
    expect(summary.compensated).toBe(1);
    const truths = await purchaseTruths(checkout.purchaseId);
    expect(truths).toMatchObject({
      state: 'compensated',
      entitlements: 0,
      captures: 1,
      reversals: 1,
    });
  });

  it('cross-path exclusion (proof 20): one quote can never confirm free AND paid', async () => {
    const customer = await createCustomer(testDb.db);
    // Paid purchase pending → the free command refuses the used quote.
    const checkout = await paidCheckout(customer, packOption);
    const freeAttempt = await confirmFreeEntitlementPurchase(serviceDeps(), { accountId: customer.accountId }, {
      quoteId: checkout.quoteId,
      idempotencyKey: newId(),
    });
    // The nonzero guard fires first — and even a hypothetical zero-total
    // path would die on uq_entitlement_purchase_quote.
    expect(freeAttempt.outcome.kind).toBe('notFreeQuote');
    // Confirmed FREE purchase → paid initiation refuses (`alreadyAcquired`
    // after the zero-guard: use a free quote confirmed first).
    const free = await acquisitionQuote(customer, freePackOption);
    const confirmed = await confirmFreeEntitlementPurchase(serviceDeps(), { accountId: customer.accountId }, {
      quoteId: free.quoteId,
      idempotencyKey: newId(),
    });
    expect(confirmed.outcome.kind).toBe('purchaseConfirmed');
    const secondFree = await confirmFreeEntitlementPurchase(serviceDeps(), { accountId: customer.accountId }, {
      quoteId: free.quoteId,
      idempotencyKey: newId(),
    });
    expect(secondFree.outcome.kind).toBe('quoteAlreadyUsed');
    // A DIFFERENT command key on the pending paid quote is arbitrated by
    // the one-live-intent structure: checkoutAlreadyActive, no second
    // purchase/intent.
    const differentKey = await startPaidEntitlementCheckout(orchestration(), { accountId: customer.accountId }, {
      quoteId: checkout.quoteId,
      idempotencyKey: newId(),
      returnUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    });
    expect(differentKey.kind).toBe('checkoutAlreadyActive');
    expect((await purchaseTruths(checkout.purchaseId)).intents).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Customer-safe status projection + HTTP surface (owner §24–§25, §33)
// ---------------------------------------------------------------------------

describe('purchase payment status + HTTP surface', () => {
  it('projects awaitingPayment → processing → confirmed over the wire vocabulary', async () => {
    const customer = await httpCustomer();
    const checkout = await paidCheckout(customer, packOption);
    const awaiting = await customerEntitlementPurchasePaymentStatus(
      serviceDeps(),
      { accountId: customer.accountId },
      { purchaseId: checkout.purchaseId },
    );
    expect(awaiting.kind).toBe('paymentStatus');
    if (awaiting.kind === 'paymentStatus') {
      expect(awaiting.payment.status).toBe('awaitingPayment');
      expect(awaiting.payment.purchaseExpiresAt).toBeDefined();
    }
    // Trusted evidence received but unresolved → processing (never a
    // browser-return claim).
    await deliverSuccess(checkout.gatewayRef); // provider not yet captured → saga defers
    await processTrustedPaymentResults({ db: testDb.db, provider });
    const processing = await customerEntitlementPurchasePaymentStatus(
      serviceDeps(),
      { accountId: customer.accountId },
      { purchaseId: checkout.purchaseId },
    );
    if (processing.kind === 'paymentStatus') {
      expect(processing.payment.status).toBe('processing');
    }
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    await processTrustedPaymentResults({ db: testDb.db, provider });
    const response = await inject(
      'GET',
      `/customer/entitlement-purchases/${checkout.purchaseId}/payment`,
      customer.bearer,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().payment.status).toBe('confirmed');
    expect(response.json().payment.referenceCode).toMatch(/^HMP-/);
  });

  it('compensation never projects success', async () => {
    const customer = await httpCustomer();
    const checkout = await paidCheckout(customer, packOption);
    await sql`UPDATE participant SET status = 'archived'
              WHERE id = ${customer.participantId}`.execute(testDb.db);
    provider.completeCheckout(checkout.gatewayRef);
    await deliverSuccess(checkout.gatewayRef);
    await processTrustedPaymentResults({ db: testDb.db, provider });
    const response = await inject(
      'GET',
      `/customer/entitlement-purchases/${checkout.purchaseId}/payment`,
      customer.bearer,
    );
    expect(response.json().payment.status).toBe('compensated');
  });

  it('the full acquisition journey works over HTTP; smuggled money/terms fields are inexpressible', async () => {
    const customer = await httpCustomer();
    const quoted = await inject('POST', '/customer/entitlement-purchases/quote', customer.bearer, {
      programId: f.programId,
      priceOptionId: freePackOption,
      participantId: customer.participantId,
      // Smuggled fields: stripped by the app-wide Ajv — money and terms
      // remain SERVER-authored.
      totalFils: 1,
      usesTotal: 999,
      validityDays: 9999,
    });
    expect(quoted.statusCode).toBe(201);
    expect(quoted.json().quote.totalFils).toBe(0);
    expect(quoted.json().quote.fulfillment.usesTotal).toBe(3);
    const confirmed = await inject(
      'POST',
      '/customer/entitlement-purchases/confirm-free',
      customer.bearer,
      { quoteId: quoted.json().quote.quoteId, idempotencyKey: newId() },
    );
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().purchase.state).toBe('confirmed');
    expect(confirmed.json().purchase.entitlement.usesTotal).toBe(3);
    const read = await inject(
      'GET',
      `/customer/entitlement-purchases/${confirmed.json().purchase.purchaseId}`,
      customer.bearer,
    );
    expect(read.statusCode).toBe(200);
    expect(read.json().purchase.entitlement.usageKind).toBe('finite');
    // Paid initiation over HTTP returns only customer-safe identity.
    const paidQuote = await inject('POST', '/customer/entitlement-purchases/quote', customer.bearer, {
      programId: f.programId,
      priceOptionId: packOption,
      participantId: customer.participantId,
    });
    const initiated = await inject(
      'POST',
      '/customer/entitlement-purchases/initiate',
      customer.bearer,
      { quoteId: paidQuote.json().quote.quoteId, idempotencyKey: newId() },
    );
    expect(initiated.statusCode).toBe(201);
    const checkout = initiated.json().checkout;
    expect(Object.keys(checkout).sort()).toEqual(['expiresAt', 'purchaseId', 'redirectUrl']);
  });

  it('cross-account authority is not-found-shaped everywhere; unauthenticated is refused', async () => {
    const owner = await httpCustomer();
    const stranger = await httpCustomer();
    const checkout = await paidCheckout(owner, packOption);
    for (const url of [
      `/customer/entitlement-purchases/${checkout.purchaseId}`,
      `/customer/entitlement-purchases/${checkout.purchaseId}/payment`,
    ]) {
      expect((await inject('GET', url, stranger.bearer)).statusCode).toBe(404);
      expect((await inject('GET', url, null)).statusCode).toBe(401);
    }
    // A stranger cannot act on the owner's quote either.
    const strangerConfirm = await inject(
      'POST',
      '/customer/entitlement-purchases/initiate',
      stranger.bearer,
      { quoteId: checkout.quoteId, idempotencyKey: newId() },
    );
    expect(strangerConfirm.statusCode).toBe(404);
  });
});
