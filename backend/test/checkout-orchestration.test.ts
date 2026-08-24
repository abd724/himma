/**
 * W5 · W5-2 — paid-checkout orchestration certification (docs/33 §17 W5-2;
 * docs/24 §7.4a/§8.2–8.3; owner rulings D-W5-1/2/3/5/6). Real PostgreSQL.
 *
 * Proves the orchestration boundary end-to-end over the deterministic
 * provider: the happy path establishes ACTIVE hold + Booking
 * `pending_payment` (via the frozen S5-3 `initiateBooking` — counters
 * untouched, hold still claimed) + ONE Himma PaymentIntent + ONE hosted
 * session; command replay rejoins everything without duplicate
 * audits/sessions; the DB↔gateway failure windows A–E recover through
 * durable intent state + stable provider idempotency keys (never a second
 * independent session); a genuine same-key concurrent storm converges on
 * one commercial checkout; unconfigured/production composition refuses
 * BEFORE any Booking or intent exists; a dead hold winds the checkout
 * down truthfully (intent expired, best-effort explicit session expiry —
 * the D-W5-5 Option-A primitive) and NOTHING here can claim financial
 * success: no route exists, `confirmPaidBooking` is never referenced, and
 * inspection alone never confirms anything (W5-3/W5-4 own trusted truth).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { initiateBooking } from '../src/modules/booking/services/booking-lifecycle';
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { resolvePaymentProvider } from '../src/modules/payment/provider-composition';
import { startPaidCheckout } from '../src/modules/payment/services/checkout-orchestration';
import type {
  CheckoutOrchestrationDeps,
  StartPaidCheckoutInput,
} from '../src/modules/payment/services/checkout-orchestration';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
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

async function makeSession(): Promise<string> {
  const id = newId();
  await testDb.db
    .insertInto('session')
    .values({
      id,
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
  return id;
}

async function makeQuote(sessionId: string, totalFils: number): Promise<string> {
  const id = newId();
  await testDb.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('price_quote')
      .values({
        id,
        organization_id: orgA.orgId,
        program_id: programA,
        account_id: accountParent,
        participant_id: participantChild,
        option_kind: 'dropIn',
        session_id: sessionId,
        total_fils: totalFils,
        price_kind: 'oneOff',
        expires_at: FUTURE,
      } as never)
      .execute();
    await trx
      .insertInto('price_quote_line')
      .values({
        id: newId(),
        quote_id: id,
        line_no: 1,
        kind: 'base',
        label_en: '1 session',
        amount_fils: totalFils,
      } as never)
      .execute();
  });
  return id;
}

/** A claimed spine: session (held_count 1) + quote + ACTIVE hold. */
async function makeSpine(totalFils = 5000): Promise<{
  sessionId: string;
  quoteId: string;
  holdId: string;
}> {
  const sessionId = await makeSession();
  const quoteId = await makeQuote(sessionId, totalFils);
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
      expires_at: HOLD_EXPIRY,
    } as never)
    .execute();
  return { sessionId, quoteId, holdId };
}

function makeProvider(
  options: Partial<ConstructorParameters<typeof DeterministicPaymentProvider>[0]> = {},
): DeterministicPaymentProvider {
  return new DeterministicPaymentProvider({ now: NOW, ...options });
}

function depsWith(provider: DeterministicPaymentProvider): CheckoutOrchestrationDeps {
  return { db: testDb.db, provider: { kind: 'configured', provider } };
}

function commandFor(
  spine: { holdId: string; quoteId: string },
  key: string,
): StartPaidCheckoutInput {
  return {
    holdId: spine.holdId,
    quoteId: spine.quoteId,
    idempotencyKey: key,
    returnUrl: 'https://himma.test/return',
    cancelUrl: 'https://himma.test/cancel',
  };
}

const actor = (): { accountId: string } => ({ accountId: accountParent });

async function countRows(table: string, where: string, value: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM ${sql.id(table)} WHERE ${sql.id(where)} = ${value}`.execute(
    testDb.db,
  );
  return Number(result.rows[0]!.n);
}

async function auditCount(action: string, entityId: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM audit_event
    WHERE action = ${action} AND entity_id = ${entityId}`.execute(testDb.db);
  return Number(result.rows[0]!.n);
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await createProviderOrg(testDb.db, { state: 'live', branches: 2 });
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id}, ${`w52-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'W5-2 Type')`.execute(
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
    titleEn: 'W5-2 Orchestration Program',
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
});

afterAll(async () => {
  await testDb.drop();
});

describe('the happy path and command replay', () => {
  it('establishes booking pending_payment + intent + attempt + ONE hosted session; hold stays ACTIVE and counters untouched; replay rejoins everything', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    const first = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-happy'));
    if (first.kind !== 'checkoutStarted') throw new Error(first.kind);
    expect(first.redirectUrl).toContain('https://deterministic.test/checkout/');
    expect(first.holdExpiresAt.getTime()).toBe(HOLD_EXPIRY.getTime());
    // D-W5-5 made visible: the session outlives the 10-minute-hold model —
    // requested = hold expiry here, so they align; the clamp case is
    // port-certified. Both truths are reported separately.
    expect(first.gatewayExpiresAt.getTime()).toBeGreaterThanOrEqual(
      NOW.getTime() + 30 * 60 * 1000,
    );

    // Booking truth: pending_payment on the STILL-ACTIVE hold.
    const booking = await sql<{ state: string; hold_id: string }>`
      SELECT state, hold_id FROM booking WHERE id = ${first.bookingId}`.execute(testDb.db);
    expect(booking.rows[0]).toEqual({ state: 'pending_payment', hold_id: spine.holdId });
    const hold = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${spine.holdId}`.execute(testDb.db);
    expect(hold.rows[0]!.state).toBe('active');
    const unit = await sql<{ held_count: number; booked_count: number }>`
      SELECT held_count, booked_count FROM session WHERE id = ${spine.sessionId}`.execute(
      testDb.db,
    );
    expect(unit.rows[0]).toEqual({ held_count: 1, booked_count: 0 });

    // Payment truth: one intent (in_progress), one attempt bound to the ref.
    const intent = await sql<{ state: string; amount_fils: string }>`
      SELECT state, amount_fils FROM payment_intent WHERE id = ${first.intentId}`.execute(
      testDb.db,
    );
    expect(intent.rows[0]!.state).toBe('in_progress');
    expect(Number(intent.rows[0]!.amount_fils)).toBe(5000);
    expect(await countRows('payment_intent', 'booking_id', first.bookingId)).toBe(1);
    expect(await countRows('payment_attempt', 'intent_id', first.intentId)).toBe(1);
    expect(provider.sessionCount).toBe(1);

    // Replay: identical result, no new rows, no duplicate audit, no second
    // provider session.
    const replay = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-happy'));
    if (replay.kind !== 'checkoutStarted') throw new Error(replay.kind);
    expect(replay.bookingId).toBe(first.bookingId);
    expect(replay.intentId).toBe(first.intentId);
    expect(replay.attemptId).toBe(first.attemptId);
    expect(replay.gatewayRef).toBe(first.gatewayRef);
    expect(replay.redirectUrl).toBe(first.redirectUrl);
    expect(provider.sessionCount).toBe(1);
    expect(await auditCount('payment.intent.created', first.intentId)).toBe(1);
    expect(await auditCount('payment.attempt.started', first.attemptId)).toBe(1);
    expect(await auditCount('payment.checkout.created', first.attemptId)).toBe(1);

    // The redirect URL is NEVER persisted or audited (docs/33 §14).
    const urlLeaks = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE after_digest LIKE '%deterministic.test%'
         OR action LIKE '%url%'`.execute(testDb.db);
    expect(Number(urlLeaks.rows[0]!.n)).toBe(0);
  });

  it('same key + materially different payload → idempotencyConflict, nothing new created', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    const first = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-conflict'));
    if (first.kind !== 'checkoutStarted') throw new Error(first.kind);
    const otherQuote = await makeQuote(spine.sessionId, 5000);
    const conflicting = await startPaidCheckout(deps, actor(), {
      ...commandFor(spine, 'cmd-conflict'),
      quoteId: otherQuote,
    });
    expect(conflicting.kind).toBe('idempotencyConflict');
    expect(await countRows('payment_intent', 'booking_id', first.bookingId)).toBe(1);
    expect(provider.sessionCount).toBe(1);
  });

  it('a SECOND command (different key) against the already-booked hold refuses; no second intent or session appears', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    const first = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-owner'));
    if (first.kind !== 'checkoutStarted') throw new Error(first.kind);
    const rival = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-rival'));
    expect(rival.kind).toBe('alreadyBooked');
    expect(await countRows('payment_intent', 'booking_id', first.bookingId)).toBe(1);
    expect(provider.sessionCount).toBe(1);
  });
});

describe('fail-closed composition — refusal BEFORE any state exists', () => {
  it('unconfigured (and production, with or without Stripe config) creates NO pending Booking and NO intent', async () => {
    const spine = await makeSpine();
    for (const resolution of [
      resolvePaymentProvider('test'),
      resolvePaymentProvider('production'),
      resolvePaymentProvider('production', { stripe: { secretKey: 'sk_test_x' } }),
      resolvePaymentProvider('production', { stripe: { secretKey: 'sk_live_x' } }),
      resolvePaymentProvider('production', { deterministic: makeProvider() }),
    ]) {
      const refused = await startPaidCheckout(
        { db: testDb.db, provider: resolution },
        actor(),
        commandFor(spine, 'cmd-unconfigured'),
      );
      expect(refused.kind).toBe('paymentUnavailable');
    }
    expect(await countRows('booking', 'hold_id', spine.holdId)).toBe(0);
    expect(await countRows('payment_intent', 'hold_id', spine.holdId)).toBe(0);
  });

  it('zero-total quotes stay on the free path: paymentNotRequired from the certified S5-3 gate, no Booking, no intent', async () => {
    const spine = await makeSpine(0);
    const refused = await startPaidCheckout(
      depsWith(makeProvider()),
      actor(),
      commandFor(spine, 'cmd-free'),
    );
    expect(refused.kind).toBe('paymentNotRequired');
    expect(await countRows('booking', 'hold_id', spine.holdId)).toBe(0);
    expect(await countRows('payment_intent', 'hold_id', spine.holdId)).toBe(0);
  });
});

describe('DB ↔ gateway failure windows (docs/33 §17 W5-2 §6)', () => {
  it('A: intent committed before any gateway attempt → the retry REJOINS the same commercial intent', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    // Simulate the crash window: T1+T2 committed, no attempt, no network.
    const initiation = await initiateBooking({ db: testDb.db }, actor(), {
      holdId: spine.holdId,
      quoteId: spine.quoteId,
      idempotencyKey: 'cmd-window-a',
    });
    if (initiation.outcome.kind !== 'bookingPending') throw new Error(initiation.outcome.kind);
    const intentId = newId();
    await testDb.db
      .insertInto('payment_intent')
      .values({
        id: intentId,
        booking_id: initiation.outcome.booking.bookingId,
        account_id: accountParent,
        quote_id: spine.quoteId,
        hold_id: spine.holdId,
        amount_fils: 5000,
        idempotency_key: `cs:${accountParent}:cmd-window-a`,
        expires_at: HOLD_EXPIRY,
      } as never)
      .execute();

    const recovered = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-a'));
    if (recovered.kind !== 'checkoutStarted') throw new Error(recovered.kind);
    expect(recovered.intentId).toBe(intentId);
    expect(await countRows('payment_intent', 'booking_id', recovered.bookingId)).toBe(1);
    expect(provider.sessionCount).toBe(1);
  });

  it('B/E: session created but the response was lost → the SAME stable provider key recovers the SAME session; never a second one', async () => {
    const spine = await makeSpine();
    const provider = makeProvider({ defaultScenario: 'timeoutOnce' });
    const deps = depsWith(provider);

    const lost = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-b'));
    if (lost.kind !== 'checkoutPending') throw new Error(lost.kind);
    // The session EXISTS provider-side; Himma holds no ref yet.
    expect(provider.sessionCount).toBe(1);
    const beforeRef = await sql<{ gateway_ref: string | null }>`
      SELECT gateway_ref FROM payment_attempt WHERE id = ${lost.attemptId}`.execute(testDb.db);
    expect(beforeRef.rows[0]!.gateway_ref).toBeNull();

    const recovered = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-b'));
    if (recovered.kind !== 'checkoutStarted') throw new Error(recovered.kind);
    expect(recovered.intentId).toBe(lost.intentId);
    expect(recovered.attemptId).toBe(lost.attemptId);
    expect(provider.sessionCount).toBe(1);
    expect(provider.createRequestCount).toBe(2);
    expect(await auditCount('payment.checkout.created', recovered.attemptId)).toBe(1);
  });

  it('C: definitive create failure → attempt errored truthfully; the retry opens the NEXT attempt with a NEW provider key; nothing stranded', async () => {
    const spine = await makeSpine();
    const provider = makeProvider({ defaultScenario: 'refuse' });
    const deps = depsWith(provider);

    const failed = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-c'));
    expect(failed.kind).toBe('checkoutCreateFailed');
    const attempts1 = await sql<{ state: string; failure_code: string | null; sequence_no: number }>`
      SELECT a.state, a.failure_code, a.sequence_no FROM payment_attempt a
      JOIN payment_intent i ON i.id = a.intent_id
      WHERE i.idempotency_key = ${`cs:${accountParent}:cmd-window-c`}
      ORDER BY a.sequence_no`.execute(testDb.db);
    expect(attempts1.rows).toEqual([
      { state: 'errored', failure_code: 'providerUnavailable', sequence_no: 1 },
    ]);

    // The booking still rests on its ACTIVE hold — hold TTL is the backstop.
    const hold = await sql<{ state: string }>`
      SELECT state FROM capacity_hold WHERE id = ${spine.holdId}`.execute(testDb.db);
    expect(hold.rows[0]!.state).toBe('active');

    const retried = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-c'));
    expect(retried.kind).toBe('checkoutCreateFailed'); // scenario still refuses…
    const attempts2 = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_attempt a
      JOIN payment_intent i ON i.id = a.intent_id
      WHERE i.idempotency_key = ${`cs:${accountParent}:cmd-window-c`}`.execute(testDb.db);
    // …but it did so on attempt 2 with its OWN provider key: the recorded
    // failure was never silently replayed as the commercial outcome.
    expect(Number(attempts2.rows[0]!.n)).toBe(2);
    expect(provider.sessionCount).toBe(0);
  });

  it('D: persistent unknown/timeout is NEVER labeled failed and NEVER authorizes a second independent session', async () => {
    const spine = await makeSpine();
    const provider = makeProvider({ defaultScenario: 'timeout' });
    const deps = depsWith(provider);

    const first = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-d'));
    if (first.kind !== 'checkoutPending') throw new Error(first.kind);
    for (let i = 0; i < 3; i += 1) {
      const retry = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-window-d'));
      expect(retry.kind).toBe('checkoutPending');
    }
    // One session provider-side, one attempt, still started, no ref, and
    // the intent is NOT failed.
    expect(provider.sessionCount).toBe(1);
    const attempt = await sql<{ state: string; gateway_ref: string | null }>`
      SELECT state, gateway_ref FROM payment_attempt WHERE id = ${first.attemptId}`.execute(
      testDb.db,
    );
    expect(attempt.rows[0]).toEqual({ state: 'started', gateway_ref: null });
    const intent = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${first.intentId}`.execute(testDb.db);
    expect(intent.rows[0]!.state).toBe('in_progress');
  });
});

describe('genuine concurrency (real PostgreSQL, shared pool)', () => {
  it('a same-key storm of 8 converges on ONE booking, ONE intent, ONE attempt, ONE session, one audit trail', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-storm')),
      ),
    );
    const started = results.filter((r) => r.kind === 'checkoutStarted');
    // Every contender converges on the same commercial checkout (a loser
    // mid-race may surface the transient pending shape, never a fork).
    expect(started.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(started.map((r) => (r.kind === 'checkoutStarted' ? r.intentId : '')));
    expect(ids.size).toBe(1);
    const [intentId] = [...ids];
    expect(await countRows('payment_attempt', 'intent_id', intentId!)).toBe(1);
    expect(provider.sessionCount).toBe(1);
    const bookings = await sql<{ n: string }>`
      SELECT count(*) AS n FROM booking WHERE hold_id = ${spine.holdId}`.execute(testDb.db);
    expect(Number(bookings.rows[0]!.n)).toBe(1);
    expect(await auditCount('payment.intent.created', intentId!)).toBe(1);
  });
});

describe('the dead-hold wind-down (D-W5-5 Option-A primitive)', () => {
  it('a hold that dies under an open checkout expires the intent, errors the attempt, and best-effort-expires the hosted session; a later retry reports intentNotLive', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    const started = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-dying'));
    if (started.kind !== 'checkoutStarted') throw new Error(started.kind);

    // The hold dies (authoritative S5-2-style settlement transition).
    await sql`UPDATE capacity_hold SET state = 'expired' WHERE id = ${spine.holdId}`.execute(
      testDb.db,
    );

    const wound = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-dying'));
    expect(wound.kind).toBe('holdExpired');
    const intent = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${started.intentId}`.execute(testDb.db);
    expect(intent.rows[0]!.state).toBe('expired');
    const attempt = await sql<{ state: string; failure_code: string | null }>`
      SELECT state, failure_code FROM payment_attempt WHERE id = ${started.attemptId}`.execute(
      testDb.db,
    );
    expect(attempt.rows[0]).toEqual({ state: 'errored', failure_code: 'holdExpired' });
    // The hosted session was explicitly expired provider-side.
    const inspection = await provider.inspectPayment(started.gatewayRef);
    if (inspection.kind !== 'payment') throw new Error(inspection.kind);
    expect(inspection.status).toBe('expired');

    const after = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-dying'));
    expect(after).toEqual({ kind: 'intentNotLive', state: 'expired' });
  });

  it('explicit expire racing a completed session tolerates alreadyFinalized: the wind-down still lands, money truth stays with W5-3/W5-4', async () => {
    const spine = await makeSpine();
    const provider = makeProvider();
    const deps = depsWith(provider);
    const started = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-raced'));
    if (started.kind !== 'checkoutStarted') throw new Error(started.kind);

    // The customer completes on the hosted page JUST before the hold dies.
    provider.completeCheckout(started.gatewayRef);
    await sql`UPDATE capacity_hold SET state = 'expired' WHERE id = ${spine.holdId}`.execute(
      testDb.db,
    );

    const wound = await startPaidCheckout(deps, actor(), commandFor(spine, 'cmd-raced'));
    expect(wound.kind).toBe('holdExpired');
    const intent = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${started.intentId}`.execute(testDb.db);
    expect(intent.rows[0]!.state).toBe('expired');
    // The captured money is UNTOUCHED here — no reversal ran, no booking
    // was confirmed: that is exactly the W5-4 §8.6 compensation case.
    const inspection = await provider.inspectPayment(started.gatewayRef);
    if (inspection.kind !== 'payment') throw new Error(inspection.kind);
    expect(inspection.status).toBe('captured');
    const booking = await sql<{ state: string }>`
      SELECT state FROM booking WHERE id = ${started.bookingId}`.execute(testDb.db);
    expect(booking.rows[0]!.state).toBe('pending_payment');
  });
});

describe('no trusted-success path exists (docs/33 §17 W5-2 §10/§17)', () => {
  it('the orchestration module never references confirmPaidBooking and the payment module exposes NO HTTP surface', () => {
    const orchestrationSource = readFileSync(
      path.resolve(
        __dirname,
        '..',
        'src',
        'modules',
        'payment',
        'services',
        'checkout-orchestration.ts',
      ),
      'utf8',
    );
    expect(orchestrationSource.includes('confirmPaidBooking(')).toBe(false);
    expect(orchestrationSource).not.toMatch(/from ['"].*booking-lifecycle['"].*confirmPaid/);

    // No payment HTTP module exists at all (W5-5 owns customer exposure).
    expect(
      existsSync(path.resolve(__dirname, '..', 'src', 'modules', 'payment', 'http')),
    ).toBe(false);
  });
});
