/**
 * W6-2 — the worker's payment pass drives the CERTIFIED W5 async seams to
 * convergence on real PostgreSQL over the deterministic provider (test
 * environment only — the deterministic provider cannot compose in
 * production): the Booking path and the EntitlementPurchase path each
 * confirm exactly once through `runPaymentPass`; duplicate and repeated
 * deliveries converge with no second capture/commission/entitlement;
 * a late success on a dead hold compensates (capture kept once, same-
 * amount reversal once, no booking); and worker storms over the same work
 * items converge. Nothing here reimplements settlement — the worker only
 * calls `processPendingGatewayEvents` and `processTrustedPaymentResults`.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { releaseHold } from '../src/modules/booking/services/hold-lifecycle';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import { startPaidCheckout, startPaidEntitlementCheckout } from '../src/modules/payment/services/checkout-orchestration';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';

import { ingestGatewayDelivery } from '../src/modules/payment/services/webhook-ingestion';
import { runPaymentPass } from '../src/worker/payment-processing';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCommissionTerm,
  createCustomer,
  createFulfillmentRevision,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
  type Customer,
} from './helpers/booking-fixtures';
import { createRacePool } from './helpers/race-harness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

const NOW = new Date('2026-08-26T12:00:00.000Z');
const RETURN = 'https://app.himma.test/checkout/return';
const CANCEL = 'https://app.himma.test/checkout/cancel';

let testDb: TestDb;
let f: BookingFixture;
let provider: DeterministicPaymentProvider;
let dropInOption: string;
let packOption: string;
let eventSerial = 0;
const nextEventId = () => `evt_w62_${(eventSerial += 1)}`;

const deps = () => ({ db: testDb.db, provider });

async function deliver(gatewayRef: string, eventType: 'checkout.completed' | 'payment.captured'): Promise<void> {
  const delivery = provider.buildWebhookDelivery({ gatewayEventId: nextEventId(), eventType, gatewayRef });
  const accepted = await ingestGatewayDelivery(deps(), delivery.rawBody, delivery.headers);
  if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
}

async function startBookingCheckout(customer: Customer): Promise<{ bookingId: string; intentId: string; gatewayRef: string; holdId: string }> {
  const sessionId = await createSession(f);
  const quote = await requestQuote({ db: testDb.db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: dropInOption,
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold({ db: testDb.db }, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const started = await startPaidCheckout(
    { db: testDb.db, provider: { kind: 'configured', provider } },
    { accountId: customer.accountId },
    {
      holdId: hold.outcome.hold.holdId,
      quoteId: quote.quote.quoteId,
      idempotencyKey: newId(),
      returnUrl: RETURN,
      cancelUrl: CANCEL,
    },
  );
  if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
  return {
    bookingId: started.bookingId,
    intentId: started.intentId,
    gatewayRef: started.gatewayRef,
    holdId: hold.outcome.hold.holdId,
  };
}

async function bookingTruths(bookingId: string, intentId: string): Promise<Record<string, string>> {
  const rows = await sql<Record<string, string>>`
    SELECT (SELECT state FROM booking WHERE id = ${bookingId}) AS booking_state,
           (SELECT state FROM payment_intent WHERE id = ${intentId}) AS intent_state,
           (SELECT count(*) FROM payment_transaction t JOIN payment_attempt a ON a.id = t.attempt_id
             WHERE a.intent_id = ${intentId} AND t.kind = 'capture') AS captures,
           (SELECT count(*) FROM payment_transaction t JOIN payment_attempt a ON a.id = t.attempt_id
             WHERE a.intent_id = ${intentId} AND t.kind = 'reversal') AS reversals,
           (SELECT count(*) FROM payment_intent_economics WHERE intent_id = ${intentId}) AS economics
  `.execute(testDb.db);
  return rows.rows[0]!;
}

async function purchaseTruths(purchaseId: string, intentId: string): Promise<Record<string, string>> {
  const rows = await sql<Record<string, string>>`
    SELECT (SELECT state FROM entitlement_purchase WHERE id = ${purchaseId}) AS purchase_state,
           (SELECT count(*) FROM entitlement WHERE purchase_id = ${purchaseId}) AS entitlements,
           (SELECT state FROM payment_intent WHERE id = ${intentId}) AS intent_state,
           (SELECT count(*) FROM payment_transaction t JOIN payment_attempt a ON a.id = t.attempt_id
             WHERE a.intent_id = ${intentId} AND t.kind = 'capture') AS captures,
           (SELECT count(*) FROM payment_intent_economics WHERE intent_id = ${intentId}) AS economics
  `.execute(testDb.db);
  return rows.rows[0]!;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  await createCommissionTerm(testDb.db, f.org.orgId, 1200); // launch 12 % (D-W5-7)
  await createActivePolicyTemplate(testDb.db);
  dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
  packOption = await createPriceOption(f, { kind: 'package', amountFils: 80_000, sessionsCount: 10 });
  await createFulfillmentRevision(f, packOption, {
    usageKind: 'finite',
    // package uses_total derives from sessions_count (trigger-enforced)
    validityKind: 'daysFromConfirmation',
    validityDays: 90,
    reservationRequired: false,
    walkInAllowed: true,
  });
  await publishProgram(f);
  provider = new DeterministicPaymentProvider({ now: NOW });
});

afterAll(async () => {
  await testDb.drop();
});

describe('Booking payment path through the worker pass', () => {
  it('a trusted success confirms the booking exactly once; duplicate and repeated deliveries converge with one capture and one commission snapshot', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await startBookingCheckout(customer);
    provider.completeCheckout(checkout.gatewayRef);
    await deliver(checkout.gatewayRef, 'checkout.completed');
    const first = await runPaymentPass(deps());
    expect(first.confirmed).toBe(1);
    expect(await bookingTruths(checkout.bookingId, checkout.intentId)).toMatchObject({
      booking_state: 'confirmed',
      intent_state: 'succeeded',
      captures: '1',
      reversals: '0',
      economics: '1',
    });
    // Semantic duplicate (a second event id describing the same payment) + replay of the pass.
    await deliver(checkout.gatewayRef, 'payment.captured');
    const second = await runPaymentPass(deps());
    expect(second.confirmed).toBe(0);
    await runPaymentPass(deps());
    expect(await bookingTruths(checkout.bookingId, checkout.intentId)).toMatchObject({
      booking_state: 'confirmed',
      captures: '1',
      reversals: '0',
      economics: '1',
    });
  });

  it('a late success on a RELEASED hold compensates through the certified branch: capture once, reversal once, no booking', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await startBookingCheckout(customer);
    // The hold is RELEASED (customer walked away) BEFORE the success arrives —
    // the certified D-W5-4 compensation trigger (hold identity is immutable, so
    // lapse is exercised through the release path exactly as the saga suite does).
    const released = await releaseHold(
      { db: testDb.db },
      { accountId: customer.accountId },
      { holdId: checkout.holdId, idempotencyKey: newId() },
    );
    expect(released.outcome.kind).toBe('holdReleased');
    provider.completeCheckout(checkout.gatewayRef);
    await deliver(checkout.gatewayRef, 'checkout.completed');
    const pass = await runPaymentPass(deps());
    expect(pass.compensated).toBe(1);
    const truths = await bookingTruths(checkout.bookingId, checkout.intentId);
    expect(truths.booking_state).not.toBe('confirmed');
    expect(truths).toMatchObject({ captures: '1', reversals: '1' });
    // Replay changes nothing.
    await runPaymentPass(deps());
    expect(await bookingTruths(checkout.bookingId, checkout.intentId)).toMatchObject({ captures: '1', reversals: '1' });
  });

  it('a worker storm over one trusted work item converges to one confirmation', async () => {
    const customer = await createCustomer(testDb.db);
    const checkout = await startBookingCheckout(customer);
    provider.completeCheckout(checkout.gatewayRef);
    await deliver(checkout.gatewayRef, 'checkout.completed');
    const pools = await Promise.all([1, 2, 3].map(() => createRacePool(testDb.config, 2)));
    try {
      // Racing passes may each REPORT the idempotent confirmation outcome; the
      // commercial truth below is what must be singular.
      const results = await Promise.all(pools.map((p) => runPaymentPass({ db: p.db, provider })));
      expect(results.reduce((sum, r) => sum + r.confirmed + r.converged, 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.all(pools.map((p) => p.destroy()));
    }
    expect(await bookingTruths(checkout.bookingId, checkout.intentId)).toMatchObject({
      booking_state: 'confirmed',
      captures: '1',
      economics: '1',
    });
  });
});

describe('EntitlementPurchase payment path through the worker pass', () => {
  it('a trusted capture confirms the purchase exactly once (one entitlement, one capture, one commission snapshot); duplicates converge', async () => {
    const customer = await createCustomer(testDb.db);
    const quote = await requestEntitlementQuote({ db: testDb.db }, { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: packOption,
      participantId: customer.participantId,
    });
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const started = await startPaidEntitlementCheckout(
      { db: testDb.db, provider: { kind: 'configured', provider } },
      { accountId: customer.accountId },
      { quoteId: quote.quote.quoteId, idempotencyKey: newId(), returnUrl: RETURN, cancelUrl: CANCEL },
    );
    if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
    provider.completeCheckout(started.gatewayRef);
    await deliver(started.gatewayRef, 'payment.captured');
    const first = await runPaymentPass(deps());
    expect(first.confirmed).toBe(1);
    expect(await purchaseTruths(started.purchaseId, started.intentId)).toMatchObject({
      purchase_state: 'confirmed',
      entitlements: '1',
      intent_state: 'succeeded',
      captures: '1',
      economics: '1',
    });
    await deliver(started.gatewayRef, 'checkout.completed');
    await runPaymentPass(deps());
    await runPaymentPass(deps());
    expect(await purchaseTruths(started.purchaseId, started.intentId)).toMatchObject({
      purchase_state: 'confirmed',
      entitlements: '1',
      captures: '1',
      economics: '1',
    });
  });
});
