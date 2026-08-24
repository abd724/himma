/**
 * W5 · W5-4 — payment-success → booking-confirmation / compensation saga
 * certification (docs/24 §7.4b/§8.5–§8.6; docs/33 §17 W5-4; D-W5-4/5).
 * Real PostgreSQL over the deterministic provider.
 *
 * The acceptance matrix: exactly-one capture + confirmation for a valid
 * success on a live hold, THROUGH the frozen `confirmPaidBooking` with the
 * W5-4 settlement seam joined in the SAME transaction (atomicity proven by
 * failure injection: a settlement crash rolls back the booking too);
 * duplicate/semantic-duplicate/worker storms converge on one commercial
 * effect; success races hold expiry/release to exactly one truthful
 * outcome (confirmed XOR compensated — never a booking on a dead hold,
 * never oversell, never ignored money); late success, released holds, and
 * the D-8 policy fail-close after capture all enter the D-W5-4
 * compensation branch (capture preserved once, same-amount reversal
 * posted once via the stable provider key, intent settled, booking left
 * unconfirmed, holds/counters untouched); compensation timeouts leave a
 * durable retryable obligation and lost responses replay the SAME
 * provider reversal; crash windows at every named point recover from the
 * database alone; and no customer/provider/admin surface can assert
 * payment success (source + route pins).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { expireHold, sweepExpiredHolds } from '../src/modules/booking/services/hold-lifecycle';
import { releaseHold } from '../src/modules/booking/services/hold-lifecycle';
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { startPaidCheckout } from '../src/modules/payment/services/checkout-orchestration';
import {
  processTrustedPaymentResults,
  runPaymentResultSaga,
} from '../src/modules/payment/services/payment-saga';
import type { PaymentSagaDeps, SagaFailpoint } from '../src/modules/payment/services/payment-saga';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../src/modules/payment/services/webhook-ingestion';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { createActivePolicyTemplate } from './helpers/booking-fixtures';
import {
  createAccount,
  createSelfParticipant,
  createUser,
} from './helpers/identity-fixtures';
import { createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let orgA: { orgId: string; branchIds: string[] };
let programA: string;
let accountParent: string;
let participantChild: string;

const FUTURE = new Date('2026-09-01T08:00:00.000Z');
const FUTURE_END = new Date('2026-09-01T09:00:00.000Z');
const NOW = new Date('2026-08-21T12:00:00.000Z');
const HOLD_EXPIRY = new Date('2026-08-30T12:00:00.000Z');
const PAST = new Date('2026-08-21T10:00:00.000Z');

let eventSerial = 0;
const nextEventId = (): string => `evt_saga_${(eventSerial += 1)}`;

interface Checkout {
  provider: DeterministicPaymentProvider;
  saga: PaymentSagaDeps;
  sessionId: string;
  quoteId: string;
  holdId: string;
  bookingId: string;
  intentId: string;
  attemptId: string;
  gatewayRef: string;
}

async function makeSpineRows(holdExpiresAt: Date): Promise<{
  sessionId: string;
  quoteId: string;
  holdId: string;
}> {
  const sessionId = newId();
  await testDb.db
    .insertInto('session')
    .values({
      id: sessionId,
      program_id: programA,
      organization_id: orgA.orgId,
      branch_id: orgA.branchIds[0],
      start_at: FUTURE,
      end_at: FUTURE_END,
      capacity: 5,
      held_count: 1,
      registration_cutoff_at: FUTURE,
    } as never)
    .execute();
  const quoteId = newId();
  await testDb.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('price_quote')
      .values({
        id: quoteId,
        organization_id: orgA.orgId,
        program_id: programA,
        account_id: accountParent,
        participant_id: participantChild,
        option_kind: 'dropIn',
        session_id: sessionId,
        total_fils: 5000,
        price_kind: 'oneOff',
        expires_at: FUTURE,
      } as never)
      .execute();
    await trx
      .insertInto('price_quote_line')
      .values({
        id: newId(),
        quote_id: quoteId,
        line_no: 1,
        kind: 'base',
        label_en: '1 session',
        amount_fils: 5000,
      } as never)
      .execute();
  });
  const holdId = newId();
  await testDb.db
    .insertInto('capacity_hold')
    .values({
      id: holdId,
      organization_id: orgA.orgId,
      session_id: sessionId,
      account_id: accountParent,
      participant_id: participantChild,
      quote_id: quoteId,
      expires_at: holdExpiresAt,
    } as never)
    .execute();
  return { sessionId, quoteId, holdId };
}

/** A live checkout built through the CERTIFIED W5-2 orchestration. */
async function makeCheckout(
  options: { holdExpiresAt?: Date; failpoint?: (p: SagaFailpoint) => void } = {},
): Promise<Checkout> {
  const spine = await makeSpineRows(options.holdExpiresAt ?? HOLD_EXPIRY);
  const provider = new DeterministicPaymentProvider({ now: NOW });
  const started = await startPaidCheckout(
    { db: testDb.db, provider: { kind: 'configured', provider } },
    { accountId: accountParent },
    {
      holdId: spine.holdId,
      quoteId: spine.quoteId,
      idempotencyKey: `saga-fixture-${spine.holdId}`,
      returnUrl: 'https://himma.test/return',
      cancelUrl: 'https://himma.test/cancel',
    },
  );
  if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
  const saga: PaymentSagaDeps = {
    db: testDb.db,
    provider,
    ...(options.failpoint !== undefined ? { failpoint: options.failpoint } : {}),
  };
  return {
    provider,
    saga,
    ...spine,
    bookingId: started.bookingId,
    intentId: started.intentId,
    attemptId: started.attemptId,
    gatewayRef: started.gatewayRef,
  };
}

/** A checkout whose hold ALREADY lapsed — the crash-recovered/late shape
 *  (direct assembly mirroring the certified rows; the W5-2 path refuses
 *  lapsed holds up front, which is exactly why this shape needs building). */
async function makeLapsedCheckout(
  options: { defaultScenario?: 'compensationFailure' | 'compensationTimeoutOnce' } = {},
): Promise<Checkout> {
  const spine = await makeSpineRows(PAST);
  const provider = new DeterministicPaymentProvider({
    now: NOW,
    ...(options.defaultScenario !== undefined
      ? { defaultScenario: options.defaultScenario }
      : {}),
  });
  const bookingId = newId();
  await testDb.db
    .insertInto('booking')
    .values({
      id: bookingId,
      account_id: accountParent,
      participant_id: participantChild,
      program_id: programA,
      organization_id: orgA.orgId,
      branch_id: orgA.branchIds[0],
      option_kind: 'dropIn',
      session_id: spine.sessionId,
      quote_id: spine.quoteId,
      hold_id: spine.holdId,
    } as never)
    .execute();
  const intentId = newId();
  await testDb.db
    .insertInto('payment_intent')
    .values({
      id: intentId,
      booking_id: bookingId,
      account_id: accountParent,
      quote_id: spine.quoteId,
      hold_id: spine.holdId,
      amount_fils: 5000,
      state: 'created',
      idempotency_key: `cs:${accountParent}:saga-lapsed-${spine.holdId}`,
      expires_at: PAST,
    } as never)
    .execute();
  await sql`UPDATE payment_intent SET state = 'in_progress' WHERE id = ${intentId}`.execute(
    testDb.db,
  );
  const created = await provider.createHostedCheckout({
    intentId,
    idempotencyKey: `himma:checkout:${intentId}:1`,
    amountFils: 5000,
    currency: 'AED',
    description: 'Himma booking',
    returnUrl: 'https://himma.test/return',
    cancelUrl: 'https://himma.test/cancel',
    requestedExpiresAt: PAST,
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  const attemptId = newId();
  await testDb.db
    .insertInto('payment_attempt')
    .values({
      id: attemptId,
      intent_id: intentId,
      sequence_no: 1,
      gateway_ref: created.gatewayRef,
    } as never)
    .execute();
  return {
    provider,
    saga: { db: testDb.db, provider },
    ...spine,
    bookingId,
    intentId,
    attemptId,
    gatewayRef: created.gatewayRef,
  };
}

/** Ingest a signed success event and run the W5-3 lifecycle to `verified`. */
async function deliverSuccess(c: Checkout, eventId = nextEventId()): Promise<string> {
  const delivery = c.provider.buildWebhookDelivery({
    gatewayEventId: eventId,
    eventType: 'checkout.completed',
    gatewayRef: c.gatewayRef,
  });
  const deps = { db: testDb.db, provider: c.provider };
  const accepted = await ingestGatewayDelivery(deps, delivery.rawBody, delivery.headers);
  if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
  await processPendingGatewayEvents(deps);
  return accepted.gatewayEventRowId;
}

interface Truths {
  bookingState: string;
  holdState: string;
  heldCount: number;
  bookedCount: number;
  intentState: string;
  attemptState: string;
  captures: number;
  reversals: number;
}

async function truths(c: Checkout): Promise<Truths> {
  const row = await sql<{
    booking_state: string;
    hold_state: string;
    held_count: number;
    booked_count: number;
    intent_state: string;
    attempt_state: string;
  }>`SELECT b.state AS booking_state, h.state AS hold_state, s.held_count, s.booked_count,
            i.state AS intent_state, a.state AS attempt_state
     FROM booking b
     JOIN capacity_hold h ON h.id = b.hold_id
     JOIN session s ON s.id = b.session_id
     JOIN payment_intent i ON i.id = ${c.intentId}
     JOIN payment_attempt a ON a.id = ${c.attemptId}
     WHERE b.id = ${c.bookingId}`.execute(testDb.db);
  const postings = await sql<{ kind: string; n: string }>`
    SELECT kind, count(*) AS n FROM payment_transaction
    WHERE attempt_id = ${c.attemptId} GROUP BY kind`.execute(testDb.db);
  const byKind = new Map(postings.rows.map((p) => [p.kind, Number(p.n)]));
  const r = row.rows[0]!;
  return {
    bookingState: r.booking_state,
    holdState: r.hold_state,
    heldCount: r.held_count,
    bookedCount: r.booked_count,
    intentState: r.intent_state,
    attemptState: r.attempt_state,
    captures: byKind.get('capture') ?? 0,
    reversals: byKind.get('reversal') ?? 0,
  };
}

async function eventState(rowId: string): Promise<string> {
  const row = await sql<{ processing_state: string }>`
    SELECT processing_state FROM gateway_event WHERE id = ${rowId}`.execute(testDb.db);
  return row.rows[0]!.processing_state;
}

const CONFIRMED: Partial<Truths> = {
  bookingState: 'confirmed',
  holdState: 'consumed',
  heldCount: 0,
  bookedCount: 1,
  intentState: 'succeeded',
  attemptState: 'captured',
  captures: 1,
  reversals: 0,
};

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await createProviderOrg(testDb.db, { state: 'live', branches: 2 });
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id}, ${`w54-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'W5-4 Type')`.execute(
    testDb.db,
  );
  const scope: OrgScope = {
    organizationId: orgA.orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const created = await createProgram({ db: testDb.db }, scope, { userId: newId() }, {
    titleEn: 'W5-4 Saga Program',
    activityTypeId: typeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  programA = created.program.id;
  const parentUser = await createUser(testDb.db);
  accountParent = await createAccount(testDb.db, parentUser);
  await createSelfParticipant(testDb.db, accountParent);
  participantChild = newId();
  await testDb.db
    .insertInto('participant')
    .values({
      id: participantChild,
      account_id: accountParent,
      kind: 'child',
      first_name: 'Child',
      date_of_birth: new Date('2018-03-01'),
    } as never)
    .execute();
  await createActivePolicyTemplate(testDb.db);
});

afterAll(async () => {
  await testDb.drop();
});

describe('success path — the §7.4b single transaction through the frozen seam', () => {
  it('valid success + valid active hold → EXACTLY one capture + one confirmation, counters moved once, intent succeeded, item processed, single audit/outbox set', async () => {
    const c = await makeCheckout();
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    const summary = await processTrustedPaymentResults(c.saga);
    expect(summary.confirmed).toBe(1);

    expect(await truths(c)).toMatchObject(CONFIRMED);
    expect(await eventState(eventRow)).toBe('processed');

    const audits = await sql<{ action: string; n: string }>`
      SELECT action, count(*) AS n FROM audit_event
      WHERE (action = 'payment.captured' AND entity_type = 'payment_transaction'
             AND entity_id IN (SELECT id::text FROM payment_transaction WHERE attempt_id = ${c.attemptId}))
         OR (action = 'booking.confirmed' AND entity_id = ${c.bookingId})
      GROUP BY action`.execute(testDb.db);
    for (const row of audits.rows) expect(Number(row.n)).toBe(1);
    const outbox = await sql<{ event_type: string; n: string }>`
      SELECT event_type, count(*) AS n FROM outbox_event
      WHERE (event_type = 'payment.captured' AND aggregate_id = ${c.intentId})
         OR (event_type = 'booking.confirmed' AND aggregate_id = ${c.bookingId})
      GROUP BY event_type`.execute(testDb.db);
    expect(outbox.rows).toHaveLength(2);
    for (const row of outbox.rows) expect(Number(row.n)).toBe(1);
  });

  it('duplicate storm + semantic duplicates + repeated sweeps → ONE commercial effect, every item converges to processed', async () => {
    const c = await makeCheckout();
    c.provider.completeCheckout(c.gatewayRef);
    const sessionShaped = await deliverSuccess(c);
    // Semantic duplicate: intent-shaped event, different id.
    const intentShaped = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'payment.captured',
      himmaIntentRef: c.intentId,
    });
    const deps = { db: testDb.db, provider: c.provider };
    const second = await ingestGatewayDelivery(deps, intentShaped.rawBody, intentShaped.headers);
    if (second.kind !== 'accepted') throw new Error(second.kind);
    await processPendingGatewayEvents(deps);

    await processTrustedPaymentResults(c.saga);
    await processTrustedPaymentResults(c.saga);
    await processTrustedPaymentResults(c.saga);

    expect(await truths(c)).toMatchObject(CONFIRMED);
    expect(await eventState(sessionShaped)).toBe('processed');
    expect(await eventState(second.gatewayEventRowId)).toBe('processed');
  });

  it('two saga workers racing ONE event converge on a single effect set', async () => {
    const c = await makeCheckout();
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await Promise.all([
      runPaymentResultSaga(c.saga, eventRow),
      runPaymentResultSaga(c.saga, eventRow),
    ]);
    expect(await truths(c)).toMatchObject(CONFIRMED);
    const confirmAudits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'booking.confirmed' AND entity_id = ${c.bookingId}`.execute(testDb.db);
    expect(Number(confirmAudits.rows[0]!.n)).toBe(1);
  });

  it('ATOMICITY: a settlement crash inside the §7.4b transaction rolls back the BOOKING too; the retry then confirms cleanly', async () => {
    let boom = true;
    const c = await makeCheckout({
      failpoint: (p) => {
        if (p === 'inSettlement' && boom) throw new Error('injected settlement crash');
      },
    });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await expect(runPaymentResultSaga(c.saga, eventRow)).rejects.toThrow(/injected/);

    // NOTHING committed: no confirmation, no consumption, no capture, no
    // intent settlement — and the idempotency key is unpoisoned.
    expect(await truths(c)).toMatchObject({
      bookingState: 'pending_payment',
      holdState: 'active',
      heldCount: 1,
      bookedCount: 0,
      intentState: 'in_progress',
      captures: 0,
    });
    boom = false;
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('confirmed');
    expect(await truths(c)).toMatchObject(CONFIRMED);
  });

  it('crash AFTER the atomic commit but before item completion recovers by convergence — no second confirmation, no second capture', async () => {
    let boom = true;
    const c = await makeCheckout({
      failpoint: (p) => {
        if (p === 'beforeCompletion' && boom) throw new Error('injected completion crash');
      },
    });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await expect(runPaymentResultSaga(c.saga, eventRow)).rejects.toThrow(/injected/);
    // Commercial effect committed; the work item is the only leftover.
    expect(await truths(c)).toMatchObject(CONFIRMED);
    expect(await eventState(eventRow)).toBe('verified');
    boom = false;
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('converged');
    expect(await truths(c)).toMatchObject(CONFIRMED);
    expect(await eventState(eventRow)).toBe('processed');
  });

  it('a premature success event (provider not captured yet) defers without effect, then confirms once the provider truth is captured', async () => {
    const c = await makeCheckout();
    const eventRow = await deliverSuccess(c); // NOT completed provider-side
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('deferred');
    expect(await truths(c)).toMatchObject({ bookingState: 'pending_payment', captures: 0 });
    c.provider.completeCheckout(c.gatewayRef);
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('confirmed');
  });

  it('a contradicted success event (provider says expired, nothing captured) completes with ZERO financial effect', async () => {
    const c = await makeCheckout();
    await c.provider.expireCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('converged');
    expect(await truths(c)).toMatchObject({
      bookingState: 'pending_payment',
      captures: 0,
      reversals: 0,
      intentState: 'in_progress',
    });
    expect(await eventState(eventRow)).toBe('processed');
  });

  it('a provider amount mismatch is QUARANTINED, never acted on', async () => {
    const c = await makeCheckout();
    c.provider.completeCheckout(c.gatewayRef);
    c.provider.setReportedAmount(c.gatewayRef, 4999);
    const eventRow = await deliverSuccess(c);
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('quarantined');
    expect(await eventState(eventRow)).toBe('quarantined');
    expect(await truths(c)).toMatchObject({ captures: 0, bookingState: 'pending_payment' });
  });
});

describe('compensation — D-W5-4: money real, inventory not confirmable', () => {
  it('LATE SUCCESS on an authoritatively expired hold → capture preserved once, same-amount reversal once, intent failed, booking stays unconfirmed, nothing resurrected', async () => {
    const c = await makeLapsedCheckout();
    const settled = await expireHold({ db: testDb.db }, { holdId: c.holdId });
    expect(settled.kind).toBe('holdExpired');
    c.provider.completeCheckout(c.gatewayRef); // the slipped completion
    const eventRow = await deliverSuccess(c);

    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('compensated');
    expect(await truths(c)).toMatchObject({
      bookingState: 'expired', // the S5-2 unwind — never this saga
      holdState: 'expired',
      heldCount: 0,
      bookedCount: 0,
      intentState: 'failed',
      attemptState: 'captured',
      captures: 1,
      reversals: 1,
    });
    expect(await eventState(eventRow)).toBe('processed');
    // Reversal is same-amount, append-only, audited + outboxed once.
    const reversal = await sql<{ amount_fils: string }>`
      SELECT amount_fils FROM payment_transaction
      WHERE attempt_id = ${c.attemptId} AND kind = 'reversal'`.execute(testDb.db);
    expect(Number(reversal.rows[0]!.amount_fils)).toBe(5000);
    const reversedOutbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'payment.reversed' AND aggregate_id = ${c.intentId}`.execute(testDb.db);
    expect(Number(reversedOutbox.rows[0]!.n)).toBe(1);
  });

  it('a RELEASED hold (customer walked away, then payment landed) → compensated, seat already freed for others', async () => {
    const c = await makeCheckout();
    const released = await releaseHold(
      { db: testDb.db },
      { accountId: accountParent },
      { holdId: c.holdId, idempotencyKey: newId() },
    );
    expect(released.outcome.kind).toBe('holdReleased');
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('compensated');
    expect(await truths(c)).toMatchObject({
      holdState: 'released',
      heldCount: 0,
      bookedCount: 0,
      intentState: 'failed',
      captures: 1,
      reversals: 1,
    });
  });

  it('D-8 POLICY FAIL-CLOSE AFTER CAPTURE: no active cancellation-policy template → compensation, never a policy bypass for money', async () => {
    await sql`UPDATE cancellation_policy_template SET state = 'retired'
              WHERE state = 'active'`.execute(testDb.db);
    try {
      const c = await makeCheckout();
      c.provider.completeCheckout(c.gatewayRef);
      const eventRow = await deliverSuccess(c);
      expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('compensated');
      expect(await truths(c)).toMatchObject({
        bookingState: 'pending_payment', // hold TTL is the backstop, untouched here
        holdState: 'active',
        heldCount: 1,
        bookedCount: 0,
        intentState: 'failed',
        captures: 1,
        reversals: 1,
      });
    } finally {
      await createActivePolicyTemplate(testDb.db);
    }
  });

  it('compensation TIMEOUT is a durable retryable obligation: capture stands, no reversal, item stays verified; retries never duplicate', async () => {
    const c = await makeLapsedCheckout({ defaultScenario: 'compensationFailure' });
    await expireHold({ db: testDb.db }, { holdId: c.holdId });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    for (let i = 0; i < 3; i += 1) {
      expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('deferred');
    }
    expect(await truths(c)).toMatchObject({ captures: 1, reversals: 0, intentState: 'failed' });
    expect(await eventState(eventRow)).toBe('verified'); // the durable obligation
  });

  it('compensation LOST RESPONSE: provider accepted, response lost → the retry replays the SAME reversal; exactly one posting', async () => {
    const c = await makeLapsedCheckout({ defaultScenario: 'compensationTimeoutOnce' });
    await expireHold({ db: testDb.db }, { holdId: c.holdId });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('deferred');
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('compensated');
    expect(await truths(c)).toMatchObject({ captures: 1, reversals: 1 });
  });

  it('crash AFTER the compensation capture but before the reversal call resumes exactly where it durably stopped', async () => {
    let boom = true;
    const c = await makeLapsedCheckout();
    c.saga.failpoint = (p): void => {
      if (p === 'afterCompensationCapture' && boom) throw new Error('injected comp crash');
    };
    await expireHold({ db: testDb.db }, { holdId: c.holdId });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await expect(runPaymentResultSaga(c.saga, eventRow)).rejects.toThrow(/injected/);
    expect(await truths(c)).toMatchObject({ captures: 1, reversals: 0, intentState: 'failed' });
    boom = false;
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('compensated');
    expect(await truths(c)).toMatchObject({ captures: 1, reversals: 1 });
  });

  it('crash AFTER the provider reversal but before its posting: the stable key replays the same reversal id — one posting, then completion', async () => {
    let boom = true;
    const c = await makeLapsedCheckout();
    c.saga.failpoint = (p): void => {
      if (p === 'beforeReversalPosting' && boom) throw new Error('injected posting crash');
    };
    await expireHold({ db: testDb.db }, { holdId: c.holdId });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await expect(runPaymentResultSaga(c.saga, eventRow)).rejects.toThrow(/injected/);
    expect(await truths(c)).toMatchObject({ captures: 1, reversals: 0 });
    boom = false;
    expect(await runPaymentResultSaga(c.saga, eventRow)).toBe('compensated');
    const reversals = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_transaction
      WHERE attempt_id = ${c.attemptId} AND kind = 'reversal'`.execute(testDb.db);
    expect(Number(reversals.rows[0]!.n)).toBe(1);
    expect(await eventState(eventRow)).toBe('processed');
  });
});

describe('hold races — real PostgreSQL concurrency', () => {
  it('saga vs authoritative expiry on a LAPSED hold: compensated exactly once, hold settled exactly once, zero oversell', async () => {
    const c = await makeLapsedCheckout();
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await Promise.all([
      runPaymentResultSaga(c.saga, eventRow),
      expireHold({ db: testDb.db }, { holdId: c.holdId }),
      runPaymentResultSaga(c.saga, eventRow),
    ]);
    // Whatever the interleaving: never confirmed on a dead hold, the seat
    // settled exactly once, and the money is fully accounted.
    let state = await truths(c);
    if (state.reversals === 0) {
      // A racing pass may have deferred behind the in-flight settlement;
      // one more pass must converge it (the durable obligation drains).
      await runPaymentResultSaga(c.saga, eventRow);
      state = await truths(c);
    }
    expect(state).toMatchObject({
      bookingState: 'expired',
      holdState: 'expired',
      heldCount: 0,
      bookedCount: 0,
      captures: 1,
      reversals: 1,
    });
  });

  it('saga vs sweep on a LIVE hold: confirmation wins, expiry no-ops, capture retained, no reversal', async () => {
    const c = await makeCheckout();
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    const [outcome, sweep] = await Promise.all([
      runPaymentResultSaga(c.saga, eventRow),
      sweepExpiredHolds({ db: testDb.db }, { limit: 10 }),
    ]);
    expect(outcome).toBe('confirmed');
    expect(sweep).toBeDefined();
    expect(await truths(c)).toMatchObject(CONFIRMED);
  });

  it('the boundary race (hold dying NOW): exactly one truthful outcome — confirmed XOR compensated, counters coherent, money accounted', async () => {
    const c = await makeCheckout({ holdExpiresAt: new Date(Date.now() + 250) });
    c.provider.completeCheckout(c.gatewayRef);
    const eventRow = await deliverSuccess(c);
    await Promise.all([
      runPaymentResultSaga(c.saga, eventRow),
      (async (): Promise<void> => {
        for (let i = 0; i < 20; i += 1) {
          await sweepExpiredHolds({ db: testDb.db }, { limit: 10 });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })(),
    ]);
    // Drain any deferred obligation left by the race.
    await runPaymentResultSaga(c.saga, eventRow);
    await runPaymentResultSaga(c.saga, eventRow);
    const state = await truths(c);
    const confirmed = state.bookingState === 'confirmed';
    if (confirmed) {
      expect(state).toMatchObject(CONFIRMED);
    } else {
      expect(state).toMatchObject({
        holdState: 'expired',
        heldCount: 0,
        bookedCount: 0,
        captures: 1,
        reversals: 1,
      });
    }
    // NEVER both, NEVER neither, NEVER a seat double-counted.
    expect(state.bookedCount + state.heldCount).toBeLessThanOrEqual(1);
  });
});

describe('no customer/provider/admin success authority (docs/33 §17 W5-4 §15)', () => {
  it('confirmPaidBooking is referenced ONLY by its defining module and the saga; the payment HTTP surface is still exactly the webhook ingress', () => {
    const srcRoot = path.resolve(__dirname, '..', 'src');
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'generated') continue;
          scan(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        // Call/definition sites only — doc comments naming the seam are the
        // architecture explaining itself, not an invocation path.
        if (/confirmPaidBooking\(/.test(source)) offenders.push(path.relative(srcRoot, full));
      }
    };
    scan(srcRoot);
    expect(offenders.sort()).toEqual([
      'modules/booking/services/booking-lifecycle.ts',
      'modules/payment/services/payment-saga.ts',
    ]);
    const httpDir = path.join(srcRoot, 'modules', 'payment', 'http');
    expect(readdirSync(httpDir).sort()).toEqual(['payment-webhook-routes.ts']);
  });
});
