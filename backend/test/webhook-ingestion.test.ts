/**
 * W5 · W5-3 — trusted gateway-event ingestion certification (docs/33 §7,
 * §17 W5-3; docs/24 §4.1/§5.8/§7.8; D-W5-4/5). Real PostgreSQL over the
 * deterministic provider.
 *
 * Proves the trust boundary and the payment-domain processing matrix:
 * verified deliveries become durable §7.8 receipts (audit + outbox,
 * machine facts only) with (provider, event id) dedup as a structural
 * no-op; rejected signatures create NO row (the dedup space cannot be
 * poisoned by forgeries); success events LINK and REST at `verified` as
 * the W5-4 work item — no confirmation, no posting, no capacity effect,
 * even after the hold died (late success = compensation input);
 * `payment.failed` is non-definitive under hosted Checkout (recorded,
 * nothing moved); `checkout.expired` is the one definitive convergence
 * (attempt errored, CAS-guarded, stale expiry never regresses); unknown
 * types and unresolvable references quarantine; ordering is independent;
 * crash windows recover from the durable rows via the sweep; and NO
 * event of any kind touches Himma holds, bookings, or counters —
 * inventory authority stays with S5-2 (D-W5-5).
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { startPaidCheckout } from '../src/modules/payment/services/checkout-orchestration';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../src/modules/payment/services/webhook-ingestion';
import type { WebhookIngestionDeps } from '../src/modules/payment/services/webhook-ingestion';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { createCommissionTerm } from './helpers/booking-fixtures';
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

let eventSerial = 0;
const nextEventId = (): string => `evt_w53_${(eventSerial += 1)}`;

interface StartedCheckout {
  provider: DeterministicPaymentProvider;
  deps: WebhookIngestionDeps;
  holdId: string;
  sessionId: string;
  bookingId: string;
  intentId: string;
  attemptId: string;
  gatewayRef: string;
}

async function makeStartedCheckout(): Promise<StartedCheckout> {
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
      expires_at: HOLD_EXPIRY,
    } as never)
    .execute();
  const provider = new DeterministicPaymentProvider({ now: NOW });
  const started = await startPaidCheckout(
    { db: testDb.db, provider: { kind: 'configured', provider } },
    { accountId: accountParent },
    {
      holdId,
      quoteId,
      idempotencyKey: `w53-${holdId}`,
      returnUrl: 'https://himma.test/return',
      cancelUrl: 'https://himma.test/cancel',
    },
  );
  if (started.kind !== 'checkoutStarted') throw new Error(started.kind);
  return {
    provider,
    deps: { db: testDb.db, provider },
    holdId,
    sessionId,
    bookingId: started.bookingId,
    intentId: started.intentId,
    attemptId: started.attemptId,
    gatewayRef: started.gatewayRef,
  };
}

async function eventRow(rowId: string): Promise<{
  processing_state: string;
  attempt_id: string | null;
  event_type: string;
}> {
  const result = await sql<{
    processing_state: string;
    attempt_id: string | null;
    event_type: string;
  }>`SELECT processing_state, attempt_id, event_type FROM gateway_event
     WHERE id = ${rowId}`.execute(testDb.db);
  return result.rows[0]!;
}

async function attemptState(attemptId: string): Promise<{ state: string; failure_code: string | null }> {
  const result = await sql<{ state: string; failure_code: string | null }>`
    SELECT state, failure_code FROM payment_attempt WHERE id = ${attemptId}`.execute(testDb.db);
  return result.rows[0]!;
}

async function inventorySnapshot(c: StartedCheckout): Promise<Record<string, unknown>> {
  const result = await sql<Record<string, unknown>>`
    SELECT h.state AS hold_state, b.state AS booking_state,
           s.held_count, s.booked_count, i.state AS intent_state
    FROM capacity_hold h
    JOIN booking b ON b.hold_id = h.id
    JOIN session s ON s.id = h.session_id
    JOIN payment_intent i ON i.booking_id = b.id
    WHERE h.id = ${c.holdId}`.execute(testDb.db);
  return result.rows[0]!;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await createProviderOrg(testDb.db, { state: 'live', branches: 2 });
  await createCommissionTerm(testDb.db, orgA.orgId, 1000); // D-W5-7: 10%
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id}, ${`w53-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'W5-3 Type')`.execute(
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
    titleEn: 'W5-3 Webhook Program',
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

describe('durable trusted receipt (§7.8)', () => {
  it('a verified delivery becomes ONE durable receipt with machine-facts-only audit + outbox; exact duplicates are structural no-ops', async () => {
    const c = await makeStartedCheckout();
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const first = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (first.kind !== 'accepted') throw new Error(first.kind);
    expect(first.duplicate).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      const replay = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
      if (replay.kind !== 'accepted') throw new Error(replay.kind);
      expect(replay.duplicate).toBe(true);
      expect(replay.gatewayEventRowId).toBe(first.gatewayEventRowId);
    }
    const audits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'gateway.event.received' AND entity_id = ${first.gatewayEventRowId}`.execute(
      testDb.db,
    );
    expect(Number(audits.rows[0]!.n)).toBe(1);
    const outbox = await sql<{ payload: Record<string, unknown> }>`
      SELECT payload FROM outbox_event
      WHERE aggregate_id = ${first.gatewayEventRowId}
        AND event_type = 'gateway.event.received'`.execute(testDb.db);
    expect(outbox.rows).toHaveLength(1);
    // Machine facts only — never the payload bytes, a URL, or a secret.
    expect(Object.keys(outbox.rows[0]!.payload).sort()).toEqual([
      'eventType',
      'gatewayEventId',
      'provider',
    ]);
    const leak = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE payload::text LIKE '%dt_whsec%' OR payload::text LIKE '%deterministic.test%'`.execute(
      testDb.db,
    );
    expect(Number(leak.rows[0]!.n)).toBe(0);
  });

  it('a concurrent duplicate-delivery storm converges on ONE row', async () => {
    const c = await makeStartedCheckout();
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers),
      ),
    );
    const rowIds = new Set(
      results.map((r) => (r.kind === 'accepted' ? r.gatewayEventRowId : 'rejected')),
    );
    expect(rowIds.size).toBe(1);
    expect(results.filter((r) => r.kind === 'accepted' && !r.duplicate)).toHaveLength(1);
  });

  it('invalid signature, tampered bytes, stale timestamp, and malformed deliveries create NO row — the dedup space cannot be poisoned', async () => {
    const c = await makeStartedCheckout();
    const eventId = nextEventId();

    const forged = c.provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
      corruptSignature: true,
    });
    expect(await ingestGatewayDelivery(c.deps, forged.rawBody, forged.headers)).toEqual({
      kind: 'rejected',
      reason: 'invalidSignature',
    });

    const tampered = c.provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const flipped = Buffer.from(tampered.rawBody);
    flipped[flipped.length - 2] = flipped[flipped.length - 2]! ^ 0xff;
    expect((await ingestGatewayDelivery(c.deps, flipped, tampered.headers)).kind).toBe('rejected');

    const stale = c.provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      timestampSeconds: Math.floor(NOW.getTime() / 1000) - 3600,
    });
    expect(await ingestGatewayDelivery(c.deps, stale.rawBody, stale.headers)).toEqual({
      kind: 'rejected',
      reason: 'staleTimestamp',
    });

    expect(await ingestGatewayDelivery(c.deps, Buffer.from('{}'), {})).toEqual({
      kind: 'rejected',
      reason: 'malformed',
    });

    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM gateway_event WHERE gateway_event_id = ${eventId}`.execute(
      testDb.db,
    );
    expect(Number(rows.rows[0]!.n)).toBe(0);

    // The REAL event with the same id remains fully ingestible afterward.
    const genuine = c.provider.buildWebhookDelivery({
      gatewayEventId: eventId,
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const accepted = await ingestGatewayDelivery(c.deps, genuine.rawBody, genuine.headers);
    expect(accepted.kind).toBe('accepted');
  });
});

describe('processing — the payment-domain matrix', () => {
  it('success events LINK and REST at `verified` (the W5-4 work item): nothing confirms, nothing posts, inventory untouched; the sweep is idempotent', async () => {
    const c = await makeStartedCheckout();
    const before = await inventorySnapshot(c);
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const accepted = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    await processPendingGatewayEvents(c.deps);
    await processPendingGatewayEvents(c.deps); // idempotent re-run

    const row = await eventRow(accepted.gatewayEventRowId);
    expect(row).toEqual({
      processing_state: 'verified',
      attempt_id: c.attemptId,
      event_type: 'checkout.completed',
    });
    expect(await attemptState(c.attemptId)).toEqual({ state: 'started', failure_code: null });
    expect(await inventorySnapshot(c)).toEqual(before);
    const captures = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_transaction`.execute(testDb.db);
    expect(Number(captures.rows[0]!.n)).toBe(0);
  });

  it('a payment_intent-shaped success (no session ref, himma intent ref only) resolves through the server-authored reference', async () => {
    const c = await makeStartedCheckout();
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'payment.captured',
      himmaIntentRef: c.intentId,
      gatewayTransactionId: 'dt_txn_pi_shaped',
    });
    const accepted = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    await processPendingGatewayEvents(c.deps);
    const row = await eventRow(accepted.gatewayEventRowId);
    expect(row.processing_state).toBe('verified');
    expect(row.attempt_id).toBe(c.attemptId);
  });

  it('SEMANTIC duplicates (distinct event ids, one underlying payment) record truthfully as separate rows converging on ONE attempt — the W5-1 uniques own commercial exactly-once', async () => {
    const c = await makeStartedCheckout();
    const sessionShaped = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const intentShaped = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'payment.captured',
      himmaIntentRef: c.intentId,
    });
    const first = await ingestGatewayDelivery(c.deps, sessionShaped.rawBody, sessionShaped.headers);
    const second = await ingestGatewayDelivery(c.deps, intentShaped.rawBody, intentShaped.headers);
    if (first.kind !== 'accepted' || second.kind !== 'accepted') throw new Error('ingest');
    await processPendingGatewayEvents(c.deps);

    const rows = await sql<{ attempt_id: string; processing_state: string }>`
      SELECT attempt_id, processing_state FROM gateway_event
      WHERE id IN (${first.gatewayEventRowId}, ${second.gatewayEventRowId})`.execute(testDb.db);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.attempt_id).toBe(c.attemptId);
      expect(row.processing_state).toBe('verified');
    }
    // One attempt, one live intent, zero postings: the structural
    // exactly-once authorities W5-4 will consume are intact.
    const attempts = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_attempt WHERE intent_id = ${c.intentId}`.execute(
      testDb.db,
    );
    expect(Number(attempts.rows[0]!.n)).toBe(1);
  });

  it('payment.failed is NON-definitive under hosted Checkout: recorded + processed, attempt and intent unmoved', async () => {
    const c = await makeStartedCheckout();
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'payment.failed',
      gatewayRef: c.gatewayRef,
    });
    const accepted = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    await processPendingGatewayEvents(c.deps);
    expect((await eventRow(accepted.gatewayEventRowId)).processing_state).toBe('processed');
    expect(await attemptState(c.attemptId)).toEqual({ state: 'started', failure_code: null });
    const intent = await sql<{ state: string }>`
      SELECT state FROM payment_intent WHERE id = ${c.intentId}`.execute(testDb.db);
    expect(intent.rows[0]!.state).toBe('in_progress');
  });

  it('checkout.expired is the definitive convergence: attempt errored once; a SECOND stale expiry no-ops; Himma hold/counters never move (D-W5-5)', async () => {
    const c = await makeStartedCheckout();
    const first = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.expired',
      gatewayRef: c.gatewayRef,
    });
    const a1 = await ingestGatewayDelivery(c.deps, first.rawBody, first.headers);
    if (a1.kind !== 'accepted') throw new Error(a1.kind);
    await processPendingGatewayEvents(c.deps);
    expect(await attemptState(c.attemptId)).toEqual({
      state: 'errored',
      failure_code: 'checkoutExpired',
    });
    expect((await eventRow(a1.gatewayEventRowId)).processing_state).toBe('processed');

    // Stale second expiry (different event id): truthful no-op.
    const second = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.expired',
      gatewayRef: c.gatewayRef,
    });
    const a2 = await ingestGatewayDelivery(c.deps, second.rawBody, second.headers);
    if (a2.kind !== 'accepted') throw new Error(a2.kind);
    await processPendingGatewayEvents(c.deps);
    expect((await eventRow(a2.gatewayEventRowId)).processing_state).toBe('processed');
    const errorAudits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'payment.attempt.errored' AND entity_id = ${c.attemptId}`.execute(testDb.db);
    expect(Number(errorAudits.rows[0]!.n)).toBe(1);

    // The STRIPE expiry owned no Himma inventory: hold still active,
    // booking still pending, counters untouched.
    const snapshot = await inventorySnapshot(c);
    expect(snapshot.hold_state).toBe('active');
    expect(snapshot.booking_state).toBe('pending_payment');
    expect(snapshot.held_count).toBe(1);
    expect(snapshot.booked_count).toBe(0);
  });

  it('LATE SUCCESS after expiry (either order): the success event rests at `verified` for W5-4 compensation; the terminal attempt is never regressed', async () => {
    const c = await makeStartedCheckout();
    // Expiry first…
    const expiry = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.expired',
      gatewayRef: c.gatewayRef,
    });
    const e = await ingestGatewayDelivery(c.deps, expiry.rawBody, expiry.headers);
    if (e.kind !== 'accepted') throw new Error(e.kind);
    await processPendingGatewayEvents(c.deps);
    expect((await attemptState(c.attemptId)).state).toBe('errored');

    // …then the completion that slipped through the race.
    const late = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const l = await ingestGatewayDelivery(c.deps, late.rawBody, late.headers);
    if (l.kind !== 'accepted') throw new Error(l.kind);
    await processPendingGatewayEvents(c.deps);
    const row = await eventRow(l.gatewayEventRowId);
    expect(row.processing_state).toBe('verified'); // the compensation input
    expect(row.attempt_id).toBe(c.attemptId);
    expect((await attemptState(c.attemptId)).state).toBe('errored'); // never regressed

    // Nothing recreated the hold, incremented capacity, confirmed the
    // booking, or silently failed the payment.
    const snapshot = await inventorySnapshot(c);
    expect(snapshot.hold_state).toBe('active'); // untouched by events
    expect(snapshot.booking_state).toBe('pending_payment');
    expect(snapshot.intent_state).toBe('in_progress');
  });

  it('the REVERSE order (success then expiry) keeps the success work item at `verified` while the expiry converges the attempt', async () => {
    const c = await makeStartedCheckout();
    const success = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: c.gatewayRef,
    });
    const s = await ingestGatewayDelivery(c.deps, success.rawBody, success.headers);
    if (s.kind !== 'accepted') throw new Error(s.kind);
    await processPendingGatewayEvents(c.deps);

    const expiry = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.expired',
      gatewayRef: c.gatewayRef,
    });
    const e = await ingestGatewayDelivery(c.deps, expiry.rawBody, expiry.headers);
    if (e.kind !== 'accepted') throw new Error(e.kind);
    await processPendingGatewayEvents(c.deps);

    expect((await eventRow(s.gatewayEventRowId)).processing_state).toBe('verified');
    expect((await attemptState(c.attemptId)).state).toBe('errored');
    // W5-4 holds BOTH facts and reconciles provider truth before acting.
  });

  it('unknown-but-signed types and unresolvable references QUARANTINE with zero financial effect', async () => {
    const c = await makeStartedCheckout();
    const unknown = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'gateway.someday.new' as never,
      gatewayRef: c.gatewayRef,
    });
    const u = await ingestGatewayDelivery(c.deps, unknown.rawBody, unknown.headers);
    if (u.kind !== 'accepted') throw new Error(u.kind);

    const foreign = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.completed',
      gatewayRef: 'dt_cs_never_ours',
    });
    const f = await ingestGatewayDelivery(c.deps, foreign.rawBody, foreign.headers);
    if (f.kind !== 'accepted') throw new Error(f.kind);

    const before = await inventorySnapshot(c);
    await processPendingGatewayEvents(c.deps);
    expect((await eventRow(u.gatewayEventRowId)).processing_state).toBe('quarantined');
    expect((await eventRow(f.gatewayEventRowId)).processing_state).toBe('quarantined');
    expect(await inventorySnapshot(c)).toEqual(before);
    expect(await attemptState(c.attemptId)).toEqual({ state: 'started', failure_code: null });
  });
});

describe('crash recovery — the database is the only queue', () => {
  it('an event stranded at `received` (crash before processing) is recovered by the sweep; full redelivery after processing is a no-op', async () => {
    const c = await makeStartedCheckout();
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.expired',
      gatewayRef: c.gatewayRef,
    });
    // Ingest only — the "crash" happens before any processing ran.
    const accepted = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    expect((await eventRow(accepted.gatewayEventRowId)).processing_state).toBe('received');

    // Recovery: the sweep finds and completes it.
    await processPendingGatewayEvents(c.deps);
    expect((await eventRow(accepted.gatewayEventRowId)).processing_state).toBe('processed');
    expect((await attemptState(c.attemptId)).state).toBe('errored');

    // Stripe redelivers the SAME event after our state moved (crash-after-
    // transition-before-response): duplicate no-op, zero new effects.
    const redelivered = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (redelivered.kind !== 'accepted') throw new Error(redelivered.kind);
    expect(redelivered.duplicate).toBe(true);
    await processPendingGatewayEvents(c.deps);
    const errorAudits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'payment.attempt.errored' AND entity_id = ${c.attemptId}`.execute(testDb.db);
    expect(Number(errorAudits.rows[0]!.n)).toBe(1);
  });

  it('concurrent sweeps over the same pending events serialize per event: one transition, one audit trail', async () => {
    const c = await makeStartedCheckout();
    const delivery = c.provider.buildWebhookDelivery({
      gatewayEventId: nextEventId(),
      eventType: 'checkout.expired',
      gatewayRef: c.gatewayRef,
    });
    const accepted = await ingestGatewayDelivery(c.deps, delivery.rawBody, delivery.headers);
    if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
    await Promise.all([
      processPendingGatewayEvents(c.deps),
      processPendingGatewayEvents(c.deps),
      processPendingGatewayEvents(c.deps),
    ]);
    expect((await eventRow(accepted.gatewayEventRowId)).processing_state).toBe('processed');
    const audits = await sql<{ n: string }>`
      SELECT action, count(*) AS n FROM audit_event
      WHERE entity_id = ${accepted.gatewayEventRowId} GROUP BY action`.execute(testDb.db);
    for (const row of audits.rows as Array<{ action: string; n: string }>) {
      expect(Number(row.n)).toBe(1);
    }
  });
});
