/**
 * S6-1 — migration `0017` backward-compatibility certification (owner item
 * 30; docs/35 §21). Real PostgreSQL, staged migration:
 *
 *   1. migrate a fresh database to the PRE-S6-1 head (`0016`);
 *   2. seed representative CERTIFIED commercial rows through the real
 *      services (capacity quote → hold → free confirmation; a paid
 *      checkout with its live intent + economics snapshot);
 *   3. apply `0017` — every existing row must satisfy the new invariants
 *      with ZERO rewrites (the ALTERs themselves validate: a single
 *      violating row would abort the migration);
 *   4. exercise the certified Booking paths ON the migrated schema (new
 *      free confirmation; the pre-existing live paid intent still
 *      readable/consistent);
 *   5. migrate DOWN one step — the legacy schema (incl. the empty
 *      package_entitlement) is restored and the certified rows survive;
 *   6. migrate UP again cleanly.
 *
 * Existing commercial data is never rewritten into EntitlementPurchase.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { Client } from 'pg';

import type { BackendConfig } from '../src/config/env';
import type { DB } from '../src/db/kysely';
import { createDb } from '../src/db/kysely';
import {
  defaultMigrationsDir,
  runMigrationsDown,
  runMigrationsUp,
  verifyMigrations,
} from '../src/db/migrations';
import { createPool } from '../src/db/pool';
import { assertSafeTestDatabase, TEST_DATABASE_PREFIX } from '../src/db/safety';
import { confirmFreeBooking } from '../src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../src/modules/booking/services/hold-claim';
import { requestQuote } from '../src/modules/booking/services/quote-service';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import {
  startPaidCheckout,
  startPaidEntitlementCheckout,
} from '../src/modules/payment/services/checkout-orchestration';
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

const HOST = process.env.PGHOST ?? 'localhost';
const PORT = Number(process.env.PGPORT ?? 5432);
const USER = process.env.PGUSER ?? os.userInfo().username;
const NOW = new Date('2026-08-26T12:00:00.000Z');

let config: BackendConfig;
let db: Kysely<DB>;
let dbName: string;
let legacyDir: string;

async function admin(run: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ host: HOST, port: PORT, user: USER, database: 'postgres' });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  dbName = `${TEST_DATABASE_PREFIX}_${randomBytes(6).toString('hex')}`;
  config = {
    nodeEnv: 'test',
    database: { host: HOST, port: PORT, database: dbName, user: USER },
  };
  assertSafeTestDatabase(config.database);
  await admin(async (client) => {
    await client.query(`CREATE DATABASE ${dbName}`);
  });
  // The PRE-S6-1 world: exactly migrations 0001–0016.
  legacyDir = mkdtempSync(path.join(os.tmpdir(), 'himma-0016-'));
  for (const file of readdirSync(defaultMigrationsDir()).sort()) {
    if (file.endsWith('.sql') && file < '0017') {
      copyFileSync(path.join(defaultMigrationsDir(), file), path.join(legacyDir, file));
    }
  }
  await runMigrationsUp(config, { dir: legacyDir, quiet: true });
  db = createDb(createPool(config));
});

afterAll(async () => {
  await db?.destroy();
  rmSync(legacyDir, { recursive: true, force: true });
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  });
});

async function capacityJourney(
  f: BookingFixture,
  customer: Customer,
  optionId: string,
): Promise<{ quoteId: string; holdId: string; sessionId: string }> {
  const sessionId = await createSession(f);
  const quote = await requestQuote({ db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: optionId,
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const hold = await claimHold({ db }, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: quote.quote.quoteId,
    idempotencyKey: `compat-${sessionId}`,
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  return { quoteId: quote.quote.quoteId, holdId: hold.outcome.hold.holdId, sessionId };
}

it('0017 preserves every certified Booking/payment row; down restores the legacy schema; up re-applies', async () => {
  // ---- 1. Seed the PRE-S6-1 certified spine through the real services.
  const f = await createBookingFixture(db);
  await publishProgram(f);
  await createActivePolicyTemplate(db);
  await createCommissionTerm(db, f.org.orgId, 1000);
  const freeOption = await createPriceOption(f, { kind: 'free' });
  const dropInOption = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });

  // A CONFIRMED free booking.
  const freeCustomer = await createCustomer(db);
  const freeSpine = await capacityJourney(f, freeCustomer, freeOption);
  const confirmed = await confirmFreeBooking({ db }, { accountId: freeCustomer.accountId }, {
    holdId: freeSpine.holdId,
    idempotencyKey: `compat-free-${freeSpine.holdId}`,
  });
  if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
  const confirmedBookingId = confirmed.outcome.booking.bookingId;

  // A LIVE paid checkout: pending Booking + created/in_progress intent +
  // its immutable economics snapshot + a provider session.
  const provider = new DeterministicPaymentProvider({ now: NOW });
  const paidCustomer = await createCustomer(db);
  const paidSpine = await capacityJourney(f, paidCustomer, dropInOption);
  const started = await startPaidCheckout(
    { db, provider: { kind: 'configured', provider } },
    { accountId: paidCustomer.accountId },
    {
      holdId: paidSpine.holdId,
      quoteId: paidSpine.quoteId,
      idempotencyKey: `compat-paid-${paidSpine.holdId}`,
      returnUrl: 'https://himma.test/return',
      cancelUrl: 'https://himma.test/cancel',
    },
  );
  if (started.kind !== 'checkoutStarted') throw new Error(started.kind);

  const preCounts = await sql<{ bookings: string; intents: string; economics: string }>`
    SELECT (SELECT count(*) FROM booking) AS bookings,
           (SELECT count(*) FROM payment_intent) AS intents,
           (SELECT count(*) FROM payment_intent_economics) AS economics`.execute(db);

  // ---- 2. Apply 0017 on the LIVE data. Any violating row would abort it.
  const applied = await runMigrationsUp(config, { quiet: true });
  expect(applied.applied).toEqual(['0017_commercial_target_and_entitlement_foundation']);
  const verified = await verifyMigrations(config);
  expect(verified.problems).toEqual([]);
  expect(verified.pending).toEqual([]);

  // ---- 3. Existing rows: untouched, valid, and NOT rewritten.
  const postCounts = await sql<{ bookings: string; intents: string; economics: string; purchases: string }>`
    SELECT (SELECT count(*) FROM booking) AS bookings,
           (SELECT count(*) FROM payment_intent) AS intents,
           (SELECT count(*) FROM payment_intent_economics) AS economics,
           (SELECT count(*) FROM entitlement_purchase) AS purchases`.execute(db);
  expect(postCounts.rows[0]!.bookings).toBe(preCounts.rows[0]!.bookings);
  expect(postCounts.rows[0]!.intents).toBe(preCounts.rows[0]!.intents);
  expect(postCounts.rows[0]!.economics).toBe(preCounts.rows[0]!.economics);
  expect(Number(postCounts.rows[0]!.purchases)).toBe(0); // never rewritten
  const shapes = await sql<{ commercial_shape: string; n: string }>`
    SELECT commercial_shape, count(*) AS n FROM price_quote GROUP BY commercial_shape`.execute(db);
  expect(shapes.rows).toEqual([{ commercial_shape: 'capacityPurchase', n: '2' }]);
  const intactIntent = await sql<{ state: string; booking_id: string | null; purchase_id: string | null }>`
    SELECT state, booking_id, purchase_id FROM payment_intent
    WHERE id = ${started.intentId}`.execute(db);
  expect(intactIntent.rows[0]!.booking_id).not.toBeNull();
  expect(intactIntent.rows[0]!.purchase_id).toBeNull();

  // ---- 4. The certified Booking paths still run ON the migrated schema.
  const postCustomer = await createCustomer(db);
  const postSpine = await capacityJourney(f, postCustomer, freeOption);
  const postConfirm = await confirmFreeBooking({ db }, { accountId: postCustomer.accountId }, {
    holdId: postSpine.holdId,
    idempotencyKey: `compat-post-${postSpine.holdId}`,
  });
  expect(postConfirm.outcome.kind).toBe('bookingConfirmed');

  // ---- 5. DOWN restores the exact legacy schema; certified rows survive.
  await runMigrationsDown(config, { count: 1, quiet: true });
  const legacyTables = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('package_entitlement', 'entitlement_purchase', 'entitlement',
                         'price_option_fulfillment_revision')`.execute(db);
  expect(legacyTables.rows.map((row) => row.table_name)).toEqual(['package_entitlement']);
  const survivors = await sql<{ n: string; state: string }>`
    SELECT count(*) AS n, min(state) AS state FROM booking
    WHERE id = ${confirmedBookingId} GROUP BY state`.execute(db);
  expect(survivors.rows[0]).toEqual({ n: '1', state: 'confirmed' });
  const legacyNotNull = await sql<{ is_nullable: string }>`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'payment_intent' AND column_name = 'booking_id'`.execute(db);
  expect(legacyNotNull.rows[0]!.is_nullable).toBe('NO');

  // ---- 6. UP re-applies cleanly.
  const reapplied = await runMigrationsUp(config, { quiet: true });
  expect(reapplied.applied).toEqual(['0017_commercial_target_and_entitlement_foundation']);
  expect((await verifyMigrations(config)).problems).toEqual([]);
});

it('S6-native downgrade REFUSAL: once genuine S6-1 data exists, down fails closed with NOTHING destroyed', async () => {
  // Genuine S6-native durable state through the REAL domain path: an
  // active fulfillment revision → acquisition quote → confirmed free
  // Purchase + Entitlement; plus a purchase-target PaymentIntent from a
  // real paid initiation.
  const f = await createBookingFixture(db);
  await publishProgram(f);
  const freePack = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 3 });
  await createFulfillmentRevision(f, freePack, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
  });
  const paidPack = await createPriceOption(f, { kind: 'package', amountFils: 50000, sessionsCount: 5 });
  await createFulfillmentRevision(f, paidPack, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 60,
  });
  await createCommissionTerm(db, f.org.orgId, 1200);

  const customer = await createCustomer(db);
  const freeQuote = await requestEntitlementQuote({ db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freePack,
    participantId: customer.participantId,
  });
  if (freeQuote.kind !== 'quoteIssued') throw new Error(freeQuote.kind);
  const confirmed = await confirmFreeEntitlementPurchase({ db }, { accountId: customer.accountId }, {
    quoteId: freeQuote.quote.quoteId,
    idempotencyKey: `compat-refusal-free-${freeQuote.quote.quoteId}`,
  });
  if (confirmed.outcome.kind !== 'purchaseConfirmed') throw new Error(confirmed.outcome.kind);
  const purchaseId = confirmed.outcome.purchase.purchaseId;
  const entitlementId = confirmed.outcome.purchase.entitlement!.entitlementId;

  const paidQuote = await requestEntitlementQuote({ db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: paidPack,
    participantId: customer.participantId,
  });
  if (paidQuote.kind !== 'quoteIssued') throw new Error(paidQuote.kind);
  const provider = new DeterministicPaymentProvider({ now: NOW });
  const initiated = await startPaidEntitlementCheckout(
    { db, provider: { kind: 'configured', provider } },
    { accountId: customer.accountId },
    {
      quoteId: paidQuote.quote.quoteId,
      idempotencyKey: `compat-refusal-paid-${paidQuote.quote.quoteId}`,
      returnUrl: 'https://himma.test/return',
      cancelUrl: 'https://himma.test/cancel',
    },
  );
  if (initiated.kind !== 'checkoutStarted') throw new Error(initiated.kind);

  const snapshotBefore = await sql<Record<string, string>>`
    SELECT (SELECT count(*) FROM entitlement_purchase) AS purchases,
           (SELECT count(*) FROM entitlement) AS grants,
           (SELECT count(*) FROM payment_intent WHERE purchase_id IS NOT NULL) AS purchase_intents,
           (SELECT count(*) FROM price_quote WHERE commercial_shape <> 'capacityPurchase') AS shaped_quotes,
           (SELECT count(*) FROM price_option_fulfillment_revision) AS revisions,
           (SELECT count(*) FROM booking) AS bookings,
           (SELECT count(*) FROM payment_intent) AS intents`.execute(db);

  // ---- The downgrade is REFUSED by the explicit preflight — the FIRST
  // statement of the down migration, not an accidental later FK failure.
  await expect(runMigrationsDown(config, { count: 1, quiet: true })).rejects.toThrow(
    /Downgrade of 0017 refused: S6-1-native data exists/,
  );

  // ---- NOTHING was destroyed or partially modified: the schema remains
  // at 0017 (verify reports zero pending, zero problems)…
  const verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([]);
  expect(verified.problems).toEqual([]);
  // …every S6-1 table/column is intact…
  const snapshotAfter = await sql<Record<string, string>>`
    SELECT (SELECT count(*) FROM entitlement_purchase) AS purchases,
           (SELECT count(*) FROM entitlement) AS grants,
           (SELECT count(*) FROM payment_intent WHERE purchase_id IS NOT NULL) AS purchase_intents,
           (SELECT count(*) FROM price_quote WHERE commercial_shape <> 'capacityPurchase') AS shaped_quotes,
           (SELECT count(*) FROM price_option_fulfillment_revision) AS revisions,
           (SELECT count(*) FROM booking) AS bookings,
           (SELECT count(*) FROM payment_intent) AS intents`.execute(db);
  expect(snapshotAfter.rows[0]).toEqual(snapshotBefore.rows[0]);
  // …and the Purchase + Entitlement remain queryable and unchanged, beside
  // the surviving certified Booking/W5 rows.
  const survivors = await sql<{ p_state: string; e_uses: number; intent_state: string }>`
    SELECT p.state AS p_state, e.uses_total AS e_uses,
           (SELECT state FROM payment_intent WHERE id = ${initiated.intentId}) AS intent_state
    FROM entitlement_purchase p
    JOIN entitlement e ON e.purchase_id = p.id
    WHERE p.id = ${purchaseId} AND e.id = ${entitlementId}`.execute(db);
  expect(survivors.rows[0]).toEqual({ p_state: 'confirmed', e_uses: 3, intent_state: 'in_progress' });
});
