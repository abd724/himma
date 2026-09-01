/**
 * S6 — migration backward-compatibility + fail-closed rollback
 * certification (`0017` + `0018`; S6-1 owner item 30, S6-2 owner item 34;
 * docs/35 §21). Real PostgreSQL, staged migration:
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
import { addPriceOption } from '../src/modules/catalogue/services/price-option-management';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { issueRedemptionCredential } from '../src/modules/entitlement/services/redemption-credential';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import {
  confirmEntitlementReservation,
  requestEntitlementReservationQuote,
} from '../src/modules/entitlement/services/entitlement-reservation';
import { redeemCredential } from '../src/modules/entitlement/services/attendance-redemption';
import { dubaiDateOf } from '../src/modules/entitlement/services/occurrence-authority';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { addMembership } from './helpers/provider-fixtures';
import { createUser } from './helpers/identity-fixtures';
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

  // ---- 2. Apply 0017 + 0018 on the LIVE data. Any violating row aborts.
  const applied = await runMigrationsUp(config, { quiet: true });
  expect(applied.applied).toEqual([
    '0017_commercial_target_and_entitlement_foundation',
    '0018_redemption_attendance_reservation',
    '0019_membership_program_revision_kind',
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
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

  // ---- 5. DOWN (all four S6/W2-13/0020 migrations — no S6-native data,
  // no membership revisions, no membership bookings, and no
  // occurrence-stamped rows exist, so every preflight passes) restores the
  // exact legacy schema; rows survive.
  await runMigrationsDown(config, { count: 5, quiet: true });
  const legacyTables = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('package_entitlement', 'entitlement_purchase', 'entitlement',
                         'price_option_fulfillment_revision', 'redemption_credential',
                         'attendance_record', 'entitlement_reservation')`.execute(db);
  expect(legacyTables.rows.map((row) => row.table_name)).toEqual(['package_entitlement']);
  const survivors = await sql<{ n: string; state: string }>`
    SELECT count(*) AS n, min(state) AS state FROM booking
    WHERE id = ${confirmedBookingId} GROUP BY state`.execute(db);
  expect(survivors.rows[0]).toEqual({ n: '1', state: 'confirmed' });
  const legacyNotNull = await sql<{ is_nullable: string }>`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'payment_intent' AND column_name = 'booking_id'`.execute(db);
  expect(legacyNotNull.rows[0]!.is_nullable).toBe('NO');

  // ---- 6. UP re-applies both cleanly.
  const reapplied = await runMigrationsUp(config, { quiet: true });
  expect(reapplied.applied).toEqual([
    '0017_commercial_target_and_entitlement_foundation',
    '0018_redemption_attendance_reservation',
    '0019_membership_program_revision_kind',
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
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

  // ---- The downgrade is REFUSED by the explicit 0017 preflight — the
  // FIRST statement of that down migration, not an accidental later FK
  // failure. (0020 with no membership bookings/occurrence rows, 0019 with
  // no membership revisions, and 0018 with no S6-2-native data legally
  // revert first; their structure is restored below.)
  await expect(runMigrationsDown(config, { count: 5, quiet: true })).rejects.toThrow(
    /Downgrade of 0017 refused: S6-1-native data exists/,
  );

  // ---- NOTHING commercial was destroyed or partially modified: the
  // schema rests at 0017 (only the empty 0018/0019 structure reverted;
  // verify reports exactly those pending migrations and zero problems)…
  const verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([
    '0018_redemption_attendance_reservation',
    '0019_membership_program_revision_kind',
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
  expect(verified.problems).toEqual([]);
  // Restore head for the suite's remaining proofs.
  await runMigrationsUp(config, { quiet: true });
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

it('S6-2-native downgrade REFUSAL: once credential/attendance state exists, 0018 down fails closed with NOTHING destroyed', async () => {
  // Genuine S6-2 state through the REAL domain path: confirmed free
  // entitlement → live walk-in redemption credential.
  const f = await createBookingFixture(db);
  await publishProgram(f);
  const freePack = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 4 });
  await createFulfillmentRevision(f, freePack, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
  });
  const customer = await createCustomer(db);
  const quote = await requestEntitlementQuote({ db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: freePack,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const confirmed = await confirmFreeEntitlementPurchase({ db }, { accountId: customer.accountId }, {
    quoteId: quote.quote.quoteId,
    idempotencyKey: `compat-s62-${quote.quote.quoteId}`,
  });
  if (confirmed.outcome.kind !== 'purchaseConfirmed') throw new Error(confirmed.outcome.kind);
  const entitlementId = confirmed.outcome.purchase.entitlement!.entitlementId;
  const issued = await issueRedemptionCredential({ db }, { accountId: customer.accountId }, {
    target: { kind: 'entitlement', entitlementId },
    idempotencyKey: `compat-s62-cred-${entitlementId}`,
  });
  if (issued.outcome.kind !== 'credentialIssued') throw new Error(issued.outcome.kind);
  const credentialId = issued.outcome.credential.credentialId;

  // The 0018 preflight refuses as the FIRST down statement (0020 and
  // 0019, with no native state of their own, legally revert first and are
  // restored below).
  await expect(runMigrationsDown(config, { count: 4, quiet: true })).rejects.toThrow(
    /Downgrade of 0018 refused: S6-2-native data exists/,
  );
  // Nothing partially destroyed: only the 0019/0020 constraint widenings
  // reverted; the credential and its entitlement remain queryable and
  // unchanged. Restore head for the remaining proofs.
  const verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([
    '0019_membership_program_revision_kind',
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
  expect(verified.problems).toEqual([]);
  await runMigrationsUp(config, { quiet: true });
  const survivor = await sql<{ state: string; entitlement_id: string }>`
    SELECT state, entitlement_id FROM redemption_credential
    WHERE id = ${credentialId}`.execute(db);
  expect(survivor.rows[0]).toEqual({ state: 'live', entitlement_id: entitlementId });
});

it('0019 SAFE downgrade with no membership revision state; REFUSAL once a genuine membership ProgramRevision exists', async () => {
  // ---- Safe downgrade: no program_revision row carries `membership`, so
  // the 0019 down restores the exact pre-correction constraint cleanly
  // (0020, with no membership bookings/occurrence rows, reverts first).
  await runMigrationsDown(config, { count: 3, quiet: true });
  let verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([
    '0019_membership_program_revision_kind',
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
  expect(verified.problems).toEqual([]);
  // The restored legacy CHECK genuinely refuses membership again.
  const f = await createBookingFixture(db);
  await publishProgram(f);
  await expect(
    sql`INSERT INTO program_revision (id, program_id, organization_id, option_kind, option_amount_fils, submitted_by)
        VALUES (gen_random_uuid(), ${f.programId}, ${f.org.orgId}, 'membership', 45000, gen_random_uuid())`.execute(
      db,
    ),
  ).rejects.toThrow(/ck_program_revision_option_kind/);
  await runMigrationsUp(config, { quiet: true });

  // ---- Genuine membership ProgramRevision through the REAL provider
  // path: a review-gated (published) listing takes a membership option
  // ADD as an ordinary revision — the W2-13 typed refusal is gone.
  const scope = {
    organizationId: f.org.orgId,
    membershipId: '00000000-0000-7000-8000-000000000019',
    role: 'owner' as const,
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all' as const,
    organizationState: 'live' as const,
  };
  const added = await addPriceOption({ db }, scope, { userId: '00000000-0000-7000-8000-000000000020' }, {
    programId: f.programId,
    option: { kind: 'membership', amountFils: 45000 },
  });
  if (added.kind !== 'revisionSubmitted') throw new Error(added.kind);

  // ---- The 0019 preflight refuses as the FIRST down statement — the
  // membership review history is never deleted, rewritten, or discarded
  // (0020, still free of native state, legally reverts first and is
  // restored below).
  await expect(runMigrationsDown(config, { count: 3, quiet: true })).rejects.toThrow(
    /Downgrade of 0019 refused: .*membership/,
  );
  verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
  expect(verified.problems).toEqual([]);
  await runMigrationsUp(config, { quiet: true });
  verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([]);
  expect(verified.problems).toEqual([]);
  const survivor = await sql<{ option_kind: string | null; state: string }>`
    SELECT option_kind, state FROM program_revision WHERE id = ${added.revisionId}`.execute(db);
  expect(survivor.rows[0]).toEqual({ option_kind: 'membership', state: 'submitted' });
});

it('0020 SAFE downgrade with no native state; REFUSAL once a membership Booking or occurrence-stamped credential/attendance exists — nothing destroyed either way', async () => {
  // ---- Safe downgrade: no membership Booking and no occurrence-stamped
  // rows exist, so the 0020 down restores the exact pre-correction
  // objects cleanly.
  await runMigrationsDown(config, { count: 2, quiet: true });
  let verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([
    '0020_membership_booking_and_multi_occurrence_attendance',
    '0021_rate_limit_window',
  ]);
  expect(verified.problems).toEqual([]);
  const legacyBookingCheck = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname = 'ck_booking_option_kind'`.execute(db);
  expect(legacyBookingCheck.rows[0]!.def).not.toContain('membership');
  const occurrenceColumns = await sql<{ n: string }>`
    SELECT count(*) AS n FROM information_schema.columns
    WHERE table_name IN ('redemption_credential', 'attendance_record')
      AND column_name IN ('occurrence_date', 'occurrence_start_time')`.execute(db);
  expect(occurrenceColumns.rows[0]!.n).toBe('0');
  await runMigrationsUp(config, { quiet: true });

  // ---- Genuine MEMBERSHIP-KIND reservation Booking through the REAL
  // path: acquisition → reservation quote → certified hold → confirm.
  const f = await createBookingFixture(db);
  await publishProgram(f);
  const membershipOption = await createPriceOption(f, { kind: 'membership', amountFils: 0 });
  await createFulfillmentRevision(f, membershipOption, {
    usageKind: 'finite',
    usesTotal: 4,
    validityKind: 'daysFromConfirmation',
    validityDays: 30,
    reservationRequired: true,
    walkInAllowed: false,
  });
  const customer = await createCustomer(db);
  const acquisition = await requestEntitlementQuote({ db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: membershipOption,
    participantId: customer.participantId,
  });
  if (acquisition.kind !== 'quoteIssued') throw new Error(acquisition.kind);
  const confirmed = await confirmFreeEntitlementPurchase({ db }, {
    accountId: customer.accountId,
  }, {
    quoteId: acquisition.quote.quoteId,
    idempotencyKey: `compat-0020-${acquisition.quote.quoteId}`,
  });
  if (confirmed.outcome.kind !== 'purchaseConfirmed') throw new Error(confirmed.outcome.kind);
  const entitlementId = confirmed.outcome.purchase.entitlement!.entitlementId;
  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const sessionId = await createSession(f, {
    start_at: startAt,
    end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
    registration_cutoff_at: startAt,
  });
  const reservationQuote = await requestEntitlementReservationQuote({ db }, {
    accountId: customer.accountId,
  }, { entitlementId, sessionId });
  if (reservationQuote.kind !== 'quoteIssued') throw new Error(reservationQuote.kind);
  const hold = await claimHold({ db }, { accountId: customer.accountId }, {
    unit: { kind: 'session', id: sessionId },
    participantId: customer.participantId,
    quoteId: reservationQuote.quote.quoteId,
    idempotencyKey: `compat-0020-hold-${sessionId}`,
  });
  if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
  const reserved = await confirmEntitlementReservation({ db }, {
    accountId: customer.accountId,
  }, { holdId: hold.outcome.hold.holdId, idempotencyKey: `compat-0020-res-${sessionId}` });
  if (reserved.outcome.kind !== 'reservationConfirmed') throw new Error(reserved.outcome.kind);
  const membershipBookingId = reserved.outcome.reservation.bookingId;

  // The 0020 preflight refuses (0021, native-state-free, legally reverts
  // first and is restored below — the established safe-top pattern).
  await expect(runMigrationsDown(config, { count: 2, quiet: true })).rejects.toThrow(
    /Downgrade of 0020 refused: 0020-native data exists .*membership bookings=1/,
  );
  verified = await verifyMigrations(config);
  expect(verified.pending).toEqual(['0021_rate_limit_window']);
  await runMigrationsUp(config, { quiet: true });
  verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([]);
  expect(verified.problems).toEqual([]);

  // ---- Genuine OCCURRENCE-STAMPED credential + attendance through the
  // REAL camp path (span day+1..day+3; issuance window widened via server
  // config; redemption by real org staff).
  const campOption = await createPriceOption(f, { kind: 'free' });
  const dayMs = 24 * 60 * 60 * 1000;
  const campStart = dubaiDateOf(new Date(Date.now() + 1 * dayMs));
  const campEnd = dubaiDateOf(new Date(Date.now() + 3 * dayMs));
  const campId = '00000000-0000-7000-8000-000000000200';
  await sql`
    INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date, end_date,
                           daily_start_time, daily_end_time, capacity, registration_cutoff_at)
    VALUES (${campId}, ${f.programId}, ${f.org.orgId}, ${f.org.branchIds[0]},
            ${campStart}, ${campEnd}, '09:00', '13:00', 5,
            now() + interval '10 days')`.execute(db);
  const campQuote = await requestQuote({ db }, { accountId: customer.accountId }, {
    programId: f.programId,
    priceOptionId: campOption,
    unit: { kind: 'campWeek', id: campId },
    participantId: customer.participantId,
  });
  if (campQuote.kind !== 'quoteIssued') throw new Error(campQuote.kind);
  const campHold = await claimHold({ db }, { accountId: customer.accountId }, {
    unit: { kind: 'campWeek', id: campId },
    participantId: customer.participantId,
    quoteId: campQuote.quote.quoteId,
    idempotencyKey: `compat-0020-camp-${campId}`,
  });
  if (campHold.outcome.kind !== 'holdClaimed') throw new Error(campHold.outcome.kind);
  const campBooking = await confirmFreeBooking({ db }, { accountId: customer.accountId }, {
    holdId: campHold.outcome.hold.holdId,
    idempotencyKey: `compat-0020-campconfirm-${campId}`,
  });
  if (campBooking.outcome.kind !== 'bookingConfirmed') throw new Error(campBooking.outcome.kind);
  const issued = await issueRedemptionCredential({
    db,
    checkInWindowBeforeMinutes: 60 * 24 * 30,
    checkInWindowAfterMinutes: 60 * 24 * 30,
  }, { accountId: customer.accountId }, {
    target: { kind: 'booking', bookingId: campBooking.outcome.booking.bookingId },
    occurrence: { date: campStart, startTime: '09:00' },
    idempotencyKey: `compat-0020-cred-${campId}`,
  });
  if (issued.outcome.kind !== 'credentialIssued') throw new Error(issued.outcome.kind);
  const staffUser = await createUser(db);
  const membershipId = await addMembership(db, staffUser, f.org.orgId, 'front_desk');
  const scope: OrgScope = {
    organizationId: f.org.orgId,
    membershipId,
    role: 'front_desk',
    capabilities: capabilitiesForRole('front_desk'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const redeemed = await redeemCredential({ db }, scope, { userId: staffUser }, {
    code: issued.outcome.credential.displayCode!,
    credentialId: issued.outcome.credential.credentialId,
    idempotencyKey: `compat-0020-redeem-${campId}`,
  });
  if (redeemed.outcome.kind !== 'attendanceRecorded') throw new Error(redeemed.outcome.kind);

  const snapshotBefore = await sql<Record<string, string>>`
    SELECT (SELECT count(*) FROM booking WHERE option_kind = 'membership') AS membership_bookings,
           (SELECT count(*) FROM redemption_credential
             WHERE occurrence_date IS NOT NULL) AS occurrence_credentials,
           (SELECT count(*) FROM attendance_record
             WHERE occurrence_date IS NOT NULL) AS occurrence_attendance,
           (SELECT count(*) FROM entitlement_reservation) AS commitments,
           (SELECT count(*) FROM booking) AS bookings`.execute(db);
  expect(snapshotBefore.rows[0]!.membership_bookings).toBe('1');
  expect(snapshotBefore.rows[0]!.occurrence_credentials).toBe('1');
  expect(snapshotBefore.rows[0]!.occurrence_attendance).toBe('1');

  // The preflight refuses with ALL 0020-native facts counted; NOTHING is
  // destroyed or transformed; the domain schema rests at head (0021, the
  // native-state-free top, legally reverts first and is restored).
  await expect(runMigrationsDown(config, { count: 2, quiet: true })).rejects.toThrow(
    /membership bookings=1, occurrence-stamped credentials=1, occurrence-stamped attendance=1/,
  );
  verified = await verifyMigrations(config);
  expect(verified.pending).toEqual(['0021_rate_limit_window']);
  await runMigrationsUp(config, { quiet: true });
  verified = await verifyMigrations(config);
  expect(verified.pending).toEqual([]);
  expect(verified.problems).toEqual([]);
  const snapshotAfter = await sql<Record<string, string>>`
    SELECT (SELECT count(*) FROM booking WHERE option_kind = 'membership') AS membership_bookings,
           (SELECT count(*) FROM redemption_credential
             WHERE occurrence_date IS NOT NULL) AS occurrence_credentials,
           (SELECT count(*) FROM attendance_record
             WHERE occurrence_date IS NOT NULL) AS occurrence_attendance,
           (SELECT count(*) FROM entitlement_reservation) AS commitments,
           (SELECT count(*) FROM booking) AS bookings`.execute(db);
  expect(snapshotAfter.rows[0]).toEqual(snapshotBefore.rows[0]);
  const membershipSurvivor = await sql<{ option_kind: string; state: string }>`
    SELECT option_kind, state FROM booking WHERE id = ${membershipBookingId}`.execute(db);
  expect(membershipSurvivor.rows[0]).toEqual({ option_kind: 'membership', state: 'confirmed' });
});
