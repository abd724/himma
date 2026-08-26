/**
 * W5 · W5-1 — payment persistence foundation (docs/33 §4–§5, §17 W5-1;
 * docs/24 §4.1/§5.8/§6; owner rulings D-W5-1/2/3, docs/33 §14.1). Real
 * PostgreSQL: proves the DATABASE-LAYER payment invariants directly — the
 * PaymentIntent commercial identity (one composite FK pinning
 * booking+account+quote+hold to ONE booking row; amount == quote total by
 * trigger; > 0 always; identity and TTL immutable; canonical §5.8
 * transitions with terminal freeze; exactly-one live and exactly-one
 * succeeded intent per booking; globally unique idempotency key), the
 * PaymentAttempt machine (sequence ownership, write-once opaque
 * gateway_ref with global uniqueness, post-terminal append-only), the
 * append-only PaymentTransaction ledger (no UPDATE/DELETE by trigger AND
 * by grant; globally unique gateway transaction id), the GatewayEvent
 * inbox ((provider, event id) dedup as a structural no-op; identity
 * immutable; processing lifecycle transitions only), the security sweep
 * (NO column exists for PAN/CVV/track data or gateway/webhook secrets —
 * credentials are runtime configuration, never business rows), and the
 * grant matrix. Deliberately NOT here: orchestration, routes, webhooks,
 * Stripe — W5-1 ships persistence + the provider port only; the frozen
 * Slice-5 seam (confirmPaidBooking) is neither called nor exposed.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { createProgram } from '../src/modules/catalogue/services/program-management';
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
let accountOther: string;

const FUTURE = new Date('2026-09-01T08:00:00.000Z');
const FUTURE_END = new Date('2026-09-01T09:00:00.000Z');

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

async function makeHold(sessionId: string, quoteId: string): Promise<string> {
  const id = newId();
  await testDb.db
    .insertInto('capacity_hold')
    .values({
      id,
      organization_id: orgA.orgId,
      session_id: sessionId,
      account_id: accountParent,
      participant_id: participantChild,
      quote_id: quoteId,
      expires_at: FUTURE,
    } as never)
    .execute();
  return id;
}

interface CheckoutFixture {
  sessionId: string;
  quoteId: string;
  holdId: string;
  bookingId: string;
}

/** A fresh pending_payment booking spine (own session — live uniques). */
async function makeCheckout(totalFils = 5000): Promise<CheckoutFixture> {
  const sessionId = await makeSession();
  const quoteId = await makeQuote(sessionId, totalFils);
  const holdId = await makeHold(sessionId, quoteId);
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
      session_id: sessionId,
      quote_id: quoteId,
      hold_id: holdId,
    } as never)
    .execute();
  return { sessionId, quoteId, holdId, bookingId };
}

async function insertIntent(
  fixture: CheckoutFixture,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string | undefined) ?? newId();
  await testDb.db
    .insertInto('payment_intent')
    .values({
      id,
      booking_id: fixture.bookingId,
      account_id: accountParent,
      quote_id: fixture.quoteId,
      hold_id: fixture.holdId,
      amount_fils: 5000,
      idempotency_key: `key-${id}`,
      expires_at: FUTURE,
      ...overrides,
    } as never)
    .execute();
  return id;
}

async function setIntentState(id: string, state: string): Promise<void> {
  await sql`UPDATE payment_intent SET state = ${state} WHERE id = ${id}`.execute(testDb.db);
}

async function insertAttempt(
  intentId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = (overrides.id as string | undefined) ?? newId();
  await testDb.db
    .insertInto('payment_attempt')
    .values({ id, intent_id: intentId, sequence_no: 1, ...overrides } as never)
    .execute();
  return id;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await createProviderOrg(testDb.db, { state: 'live', branches: 2 });
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id}, ${`w5-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'W5 Type')`.execute(
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
    titleEn: 'W5 Payment Schema Program',
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
  const otherUser = await createUser(testDb.db);
  accountOther = await createAccount(testDb.db, otherUser);
  await createSelfParticipant(testDb.db, accountOther);
});

afterAll(async () => {
  await testDb.drop();
});

describe('payment_intent — commercial identity and binding (docs/24 §4.1)', () => {
  it('binds to exactly its booking row: a valid intent inserts; foreign account, foreign quote, and foreign hold are composite-FK-refused', async () => {
    const fixture = await makeCheckout();
    await insertIntent(fixture);

    // Wrong purchaser for the booking — an intent can never migrate across
    // accounts even when every id individually exists.
    const f2 = await makeCheckout();
    await expect(insertIntent(f2, { account_id: accountOther })).rejects.toThrow(/foreign key/i);

    // A real quote that is NOT the booking's quote.
    const strayQuote = await makeQuote(f2.sessionId, 5000);
    await expect(insertIntent(f2, { quote_id: strayQuote })).rejects.toThrow(/foreign key/i);

    // A real hold that is NOT the booking's hold (fresh spine's hold).
    const f3 = await makeCheckout();
    await expect(insertIntent(f2, { hold_id: f3.holdId })).rejects.toThrow(/foreign key/i);
  });

  it('amount is the bound quote total, structurally: mismatch refused, zero-total quote refused, non-positive amount refused, AED only', async () => {
    const fixture = await makeCheckout();
    await expect(insertIntent(fixture, { amount_fils: 4999 })).rejects.toThrow(
      /must equal quote total/i,
    );

    // A zero-total quote is the FREE path (§7.3) — it has no payment to
    // intend, even when a pending_payment row was forged by direct SQL.
    const freeFixture = await makeCheckout(0);
    await expect(insertIntent(freeFixture, { amount_fils: 0 })).rejects.toThrow(
      /zero-total quote|has no payment/i,
    );

    await expect(insertIntent(fixture, { currency: 'USD', amount_fils: 5000 })).rejects.toThrow(
      /ck_payment_intent_currency|violates check/i,
    );
  });

  it('identity/commercial columns and the TTL are immutable after creation', async () => {
    const fixture = await makeCheckout();
    const other = await makeCheckout();
    const intentId = await insertIntent(fixture);
    for (const mutation of [
      sql`UPDATE payment_intent SET booking_id = ${other.bookingId} WHERE id = ${intentId}`,
      sql`UPDATE payment_intent SET amount_fils = 1 WHERE id = ${intentId}`,
      sql`UPDATE payment_intent SET idempotency_key = 'rewritten' WHERE id = ${intentId}`,
      sql`UPDATE payment_intent SET expires_at = now() WHERE id = ${intentId}`,
    ]) {
      await expect(mutation.execute(testDb.db)).rejects.toThrow(/immutable|foreign key/i);
    }
  });

  it('canonical §5.8 transitions only: the legal chain commits, shortcuts are refused, terminals freeze', async () => {
    const fixture = await makeCheckout();
    const intentId = await insertIntent(fixture);

    // created → succeeded / failed shortcuts are invalid (success requires
    // an in-progress attempt series).
    await expect(setIntentState(intentId, 'succeeded')).rejects.toThrow(/invalid.*transition/i);
    await expect(setIntentState(intentId, 'failed')).rejects.toThrow(/invalid.*transition/i);

    await setIntentState(intentId, 'in_progress');
    await setIntentState(intentId, 'succeeded');

    // Terminal freeze — no further transition, no field wiggle.
    await expect(setIntentState(intentId, 'failed')).rejects.toThrow(/terminal/i);
    await expect(setIntentState(intentId, 'created')).rejects.toThrow(/terminal/i);

    // created → expired|cancelled terminate a never-attempted intent
    // (surfaced reconciliation — gateway-create failure/abandonment).
    const f2 = await makeCheckout();
    const i2 = await insertIntent(f2);
    await setIntentState(i2, 'expired');
    await expect(setIntentState(i2, 'in_progress')).rejects.toThrow(/terminal/i);
  });

  it('exactly-one commercial intent: unique idempotency key, one LIVE intent per booking, one SUCCEEDED intent per booking', async () => {
    const fixture = await makeCheckout();
    const first = await insertIntent(fixture);
    await expect(
      insertIntent(fixture, { idempotency_key: `key-${first}` }),
    ).rejects.toThrow(/uq_payment_intent_idempotency_key|duplicate key/i);

    // A second LIVE intent for the same booking is structurally impossible.
    await expect(insertIntent(fixture)).rejects.toThrow(
      /uq_payment_intent_live_booking|duplicate key/i,
    );

    // After a terminal state a NEW checkout attempt may open a new intent…
    await setIntentState(first, 'cancelled');
    const second = await insertIntent(fixture);
    await setIntentState(second, 'in_progress');
    await setIntentState(second, 'succeeded');

    // …but a second commercial SUCCESS for one booking can never commit.
    const third = await insertIntent(fixture);
    await setIntentState(third, 'in_progress');
    await expect(setIntentState(third, 'succeeded')).rejects.toThrow(
      /uq_payment_intent_succeeded_booking|duplicate key/i,
    );
  });
});

describe('payment_attempt — interaction records under the intent (docs/24 §5.8)', () => {
  it('attempts belong to their intent with unique sequence numbers; a retry is a NEW attempt', async () => {
    const fixture = await makeCheckout();
    const intentId = await insertIntent(fixture);
    await insertAttempt(intentId);
    await expect(insertAttempt(intentId)).rejects.toThrow(
      /uq_payment_attempt_sequence|duplicate key/i,
    );
    await insertAttempt(intentId, { sequence_no: 2 });
    await expect(insertAttempt(newId())).rejects.toThrow(/foreign key/i);
    await expect(insertAttempt(intentId, { sequence_no: 0 })).rejects.toThrow(
      /ck_payment_attempt_sequence|violates check/i,
    );
  });

  it('state machine: 3-DS loop and auto-capture legal, shortcuts refused, terminals append-only (UPDATE and DELETE)', async () => {
    const fixture = await makeCheckout();
    const intentId = await insertIntent(fixture);
    const set = (id: string, state: string) =>
      sql`UPDATE payment_attempt SET state = ${state} WHERE id = ${id}`.execute(testDb.db);

    const a1 = await insertAttempt(intentId);
    await set(a1, 'requires_action');
    await set(a1, 'started');
    await set(a1, 'authorized');
    await expect(set(a1, 'requires_action')).rejects.toThrow(/invalid.*transition/i);
    await set(a1, 'captured');
    await expect(set(a1, 'declined')).rejects.toThrow(/terminal/i);
    await expect(
      sql`DELETE FROM payment_attempt WHERE id = ${a1}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbidden/i);

    // D-W5-2 hosted Checkout auto-capture: started → captured directly.
    const a2 = await insertAttempt(intentId, { sequence_no: 2 });
    await set(a2, 'captured');
    await expect(set(a2, 'started')).rejects.toThrow(/terminal/i);
  });

  it('gateway_ref is opaque, write-once, and globally unique; method and failure_code are vocabulary-bounded', async () => {
    const fixture = await makeCheckout();
    const intentId = await insertIntent(fixture);
    const a1 = await insertAttempt(intentId, { gateway_ref: 'dt_cs_once' });
    await expect(
      sql`UPDATE payment_attempt SET gateway_ref = 'dt_cs_other' WHERE id = ${a1}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/write-once/i);
    await expect(
      insertAttempt(intentId, { sequence_no: 2, gateway_ref: 'dt_cs_once' }),
    ).rejects.toThrow(/uq_payment_attempt_gateway_ref|duplicate key/i);

    await expect(insertAttempt(intentId, { sequence_no: 3, method: 'cheque' })).rejects.toThrow(
      /ck_payment_attempt_method|violates check/i,
    );
    // failure facts only on failed terminals.
    await expect(
      insertAttempt(intentId, { sequence_no: 3, failure_code: 'cardDeclined' }),
    ).rejects.toThrow(/ck_payment_attempt_failure_code|violates check/i);
    await insertAttempt(intentId, {
      sequence_no: 3,
      state: 'declined',
      failure_code: 'cardDeclined',
      method: 'card',
    });
  });
});

describe('payment_transaction — the append-only financial ledger (docs/24 §4.1/§6.8)', () => {
  it('postings insert once and can never be updated or deleted; gateway transaction ids are globally unique; vocabulary and money constrained', async () => {
    const fixture = await makeCheckout();
    const intentId = await insertIntent(fixture);
    const attemptId = await insertAttempt(intentId);
    const postingId = newId();
    await testDb.db
      .insertInto('payment_transaction')
      .values({
        id: postingId,
        attempt_id: attemptId,
        kind: 'capture',
        amount_fils: 5000,
        gateway_transaction_id: 'dt_txn_ledger_1',
      } as never)
      .execute();

    await expect(
      sql`UPDATE payment_transaction SET amount_fils = 1 WHERE id = ${postingId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/append-only|forbidden/i);
    await expect(
      sql`DELETE FROM payment_transaction WHERE id = ${postingId}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbidden/i);

    // One gateway transaction posts exactly once, ever.
    await expect(
      testDb.db
        .insertInto('payment_transaction')
        .values({
          id: newId(),
          attempt_id: attemptId,
          kind: 'capture',
          amount_fils: 5000,
          gateway_transaction_id: 'dt_txn_ledger_1',
        } as never)
        .execute(),
    ).rejects.toThrow(/uq_payment_transaction_gateway_id|duplicate key/i);

    for (const bad of [
      { kind: 'chargeback', amount_fils: 5000, gateway_transaction_id: 'dt_txn_k' },
      { kind: 'capture', amount_fils: 0, gateway_transaction_id: 'dt_txn_z' },
      { kind: 'capture', amount_fils: -5, gateway_transaction_id: 'dt_txn_n' },
      { kind: 'capture', amount_fils: 5000, currency: 'USD', gateway_transaction_id: 'dt_txn_c' },
    ]) {
      await expect(
        testDb.db
          .insertInto('payment_transaction')
          .values({ id: newId(), attempt_id: attemptId, ...bad } as never)
          .execute(),
      ).rejects.toThrow(/violates check/i);
    }
  });
});

describe('gateway_event — the replay-safe webhook inbox (docs/24 §4.1/§7.8)', () => {
  const insertEvent = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const id = (overrides.id as string | undefined) ?? newId();
    await testDb.db
      .insertInto('gateway_event')
      .values({
        id,
        provider: 'deterministicTest',
        gateway_event_id: `evt_${id}`,
        event_type: 'payment.captured',
        payload_digest: 'digest',
        signature_verified: true,
        ...overrides,
      } as never)
      .execute();
    return id;
  };

  it('duplicate delivery is a structural no-op: (provider, gateway_event_id) is unique and ON CONFLICT DO NOTHING inserts zero rows', async () => {
    await insertEvent({ gateway_event_id: 'evt_dup_1' });
    await expect(insertEvent({ gateway_event_id: 'evt_dup_1' })).rejects.toThrow(
      /uq_gateway_event_provider_event|duplicate key/i,
    );
    const conflict = await sql`
      INSERT INTO gateway_event (id, provider, gateway_event_id, event_type, payload_digest, signature_verified)
      VALUES (${newId()}, 'deterministicTest', 'evt_dup_1', 'payment.captured', 'digest', true)
      ON CONFLICT (provider, gateway_event_id) DO NOTHING`.execute(testDb.db);
    expect(Number(conflict.numAffectedRows ?? 0)).toBe(0);
    // A different provider namespace is a different event.
    await insertEvent({ provider: 'stripe', gateway_event_id: 'evt_dup_1' });
    await expect(insertEvent({ provider: 'square', gateway_event_id: 'x' })).rejects.toThrow(
      /ck_gateway_event_provider|violates check/i,
    );
  });

  it('identity/receipt facts are immutable; only the §5.8 processing lifecycle moves; terminals freeze; links are write-once', async () => {
    const id = await insertEvent();
    const set = (state: string) =>
      sql`UPDATE gateway_event SET processing_state = ${state} WHERE id = ${id}`.execute(
        testDb.db,
      );
    await expect(
      sql`UPDATE gateway_event SET payload_digest = 'rewritten' WHERE id = ${id}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      sql`UPDATE gateway_event SET signature_verified = false WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/i);

    await expect(set('processed')).rejects.toThrow(/invalid.*transition/i);
    await set('verified');
    await set('processed');
    await expect(set('quarantined')).rejects.toThrow(/terminal/i);
    await expect(
      sql`DELETE FROM gateway_event WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbidden/i);

    const q = await insertEvent();
    await sql`UPDATE gateway_event SET processing_state = 'quarantined' WHERE id = ${q}`.execute(
      testDb.db,
    );
    await expect(
      sql`UPDATE gateway_event SET processing_state = 'verified' WHERE id = ${q}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/terminal/i);
  });
});

describe('schema objects, grants, and the security sweep', () => {
  it('the four W5-1 tables, key uniques, and the booking binding target exist', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN
        ('payment_intent', 'payment_attempt', 'payment_transaction', 'gateway_event')`.execute(
      testDb.db,
    );
    expect(tables.rows).toHaveLength(4);
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
        ('uq_payment_intent_live_booking', 'uq_payment_intent_succeeded_booking',
         'uq_payment_attempt_gateway_ref', 'ix_gateway_event_unprocessed',
         'uq_booking_id_account_quote_hold')`.execute(testDb.db);
    expect(indexes.rows).toHaveLength(5);
  });

  it('himma_app holds NO DELETE on any payment table and NO UPDATE on the financial ledger', async () => {
    const grants = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app' AND table_name IN
        ('payment_intent', 'payment_attempt', 'payment_transaction', 'gateway_event')`.execute(
      testDb.db,
    );
    expect(grants.rows.some((row) => row.privilege_type === 'DELETE')).toBe(false);
    expect(
      grants.rows.some(
        (row) => row.table_name === 'payment_transaction' && row.privilege_type === 'UPDATE',
      ),
    ).toBe(false);
  });

  it('NO payment column exists for PAN/CVV/track data or gateway/webhook secrets, and the column sets are exactly the certified ones', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('payment_intent', 'payment_attempt', 'payment_transaction',
                           'gateway_event')
      ORDER BY table_name, ordinal_position`.execute(testDb.db);

    // Structural PCI pin (docs/33 §13; D-W5-2): credentials and card data
    // are runtime/gateway concerns — no column may even be SHAPED for them.
    const forbidden =
      /(pan|cvv|cvc|card_num|card_no|cardholder|magnetic|track|exp_month|exp_year|secret|api_key|apikey|private_key|password|credential|webhook_key)/i;
    expect(columns.rows.filter((row) => forbidden.test(row.column_name))).toEqual([]);

    const byTable = new Map<string, string[]>();
    for (const row of columns.rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
    }
    expect(byTable.get('payment_intent')).toEqual([
      'id', 'booking_id', 'account_id', 'quote_id', 'hold_id', 'amount_fils', 'currency',
      'state', 'idempotency_key', 'expires_at', 'created_at', 'updated_at', 'version',
      // S6-1 owning-slice amendment (docs/35 §5.2): the exactly-one
      // commercial-target column — Booking columns retained verbatim.
      'purchase_id',
    ]);
    expect(byTable.get('payment_attempt')).toEqual([
      'id', 'intent_id', 'sequence_no', 'method', 'gateway_ref', 'state', 'failure_code',
      'threeds_ref', 'created_at', 'updated_at', 'version',
    ]);
    expect(byTable.get('payment_transaction')).toEqual([
      'id', 'attempt_id', 'kind', 'amount_fils', 'currency', 'gateway_transaction_id',
      'posted_at', 'created_at',
    ]);
    expect(byTable.get('gateway_event')).toEqual([
      'id', 'provider', 'gateway_event_id', 'event_type', 'payload_digest',
      'signature_verified', 'processing_state', 'attempt_id', 'transaction_id',
      'received_at', 'created_at', 'updated_at', 'version',
    ]);
  });

  it('no payment table stores raw gateway payloads: gateway_event carries a digest, never a JSON blob column', async () => {
    const jsonColumns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('payment_intent', 'payment_attempt', 'payment_transaction',
                           'gateway_event')
        AND data_type IN ('json', 'jsonb')`.execute(testDb.db);
    expect(jsonColumns.rows).toEqual([]);
  });
});
