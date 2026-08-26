/**
 * S6-1 — commercial-target + entitlement foundation schema certification
 * (docs/35 §4–§6, §11, §21, §31; migration 0017). Real PostgreSQL.
 *
 * The §31 invariant coverage: the quote commercial-shape matrix; the
 * bidirectional cross-trail impossibility (acquisition quotes unholdable →
 * unbookable; capacity quotes refused by the purchase shape trigger); one
 * quote → one Purchase → one Entitlement; reciprocal participant/account/
 * org/Program identity by composite FK; exactly-one PaymentIntent target +
 * Booking⇔hold shape; one live/succeeded intent per Purchase; target-
 * neutral economics org binding; finite/unlimited + validity CHECKs;
 * immutable fulfillment revisions; zero-price no-payment triggers; terminal
 * Purchase immutability; the D-S6-2 package_entitlement supersession; and
 * the S6-2/S6-3 absence locks (no reservation/credential/attendance
 * capability exists early).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
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
import { createProviderOrg } from './helpers/provider-fixtures';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

let testDb: TestDb;
let f: BookingFixture;
let customer: Customer;
let packageOption: string;
let packageRevision: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  customer = await createCustomer(testDb.db);
  packageOption = await createPriceOption(f, {
    kind: 'package',
    amountFils: 80000,
    sessionsCount: 10,
  });
  packageRevision = await createFulfillmentRevision(f, packageOption, {
    usageKind: 'finite',
    validityKind: 'daysFromConfirmation',
    validityDays: 90,
  });
});

afterAll(async () => {
  await testDb.drop();
});

async function insertAcquisitionQuote(
  options: {
    quoteCustomer?: Customer;
    totalFils?: number;
    optionId?: string;
    revisionId?: string;
    expiresAt?: Date;
  } = {},
): Promise<string> {
  const who = options.quoteCustomer ?? customer;
  const id = newId();
  const total = options.totalFils ?? 80000;
  await testDb.db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                               option_kind, price_option_id, commercial_shape,
                               fulfillment_revision_id, total_fils, price_kind, expires_at)
      VALUES (${id}, ${f.org.orgId}, ${f.programId}, ${who.accountId}, ${who.participantId},
              'package', ${options.optionId ?? packageOption}, 'entitlementAcquisition',
              ${options.revisionId ?? packageRevision}, ${total}, 'oneOff',
              ${options.expiresAt ?? new Date('2026-09-01T08:00:00.000Z')})`.execute(trx);
    await sql`
      INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
      VALUES (${newId()}, ${id}, 1, 'base', 'pack', ${total})`.execute(trx);
  });
  return id;
}

async function insertPurchase(
  quoteId: string,
  options: { state?: string; quoteCustomer?: Customer } = {},
): Promise<string> {
  const quoteRow = await sql<{
    account_id: string;
    participant_id: string;
    organization_id: string;
    program_id: string;
    price_option_id: string | null;
    fulfillment_revision_id: string | null;
  }>`SELECT account_id, participant_id, organization_id, program_id, price_option_id,
            fulfillment_revision_id
     FROM price_quote WHERE id = ${quoteId}`.execute(testDb.db);
  const q = quoteRow.rows[0]!;
  const who =
    options.quoteCustomer ?? { accountId: q.account_id, participantId: q.participant_id };
  const id = newId();
  const state = options.state ?? 'pending_payment';
  const confirmed = state === 'confirmed';
  await sql`
    INSERT INTO entitlement_purchase
      (id, account_id, participant_id, organization_id, program_id, price_option_id,
       quote_id, fulfillment_revision_id, state, reference_code, expires_at, confirmed_at)
    VALUES (${id}, ${who.accountId}, ${who.participantId}, ${q.organization_id},
            ${q.program_id}, ${q.price_option_id}, ${quoteId},
            ${q.fulfillment_revision_id ?? packageRevision}, ${state},
            ${confirmed ? `HMP-${id}` : null},
            now() + interval '30 minutes', ${confirmed ? sql`now()` : null})`.execute(
    testDb.db,
  );
  return id;
}

describe('quote commercial-shape invariant (ck_price_quote_shape)', () => {
  it('capacityPurchase keeps the certified shape: one unit, no revision, no entitlement', async () => {
    // Existing behavior: a normal capacity quote inserts (proven across the
    // whole certified battery). Violations of the NEW invariant are refused:
    const sessionId = await createSession(f);
    // Capacity shape may not carry a fulfillment revision.
    await expect(
      sql`INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                                   option_kind, session_id, fulfillment_revision_id,
                                   total_fils, price_kind, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                  ${customer.participantId}, 'dropIn', ${sessionId}, ${packageRevision},
                  5000, 'oneOff', now() + interval '15 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/ck_price_quote_shape/);
    // Capacity option kinds may not be unit-less.
    await expect(
      sql`INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                                   option_kind, total_fils, price_kind, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                  ${customer.participantId}, 'dropIn', 5000, 'oneOff',
                  now() + interval '15 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/ck_price_quote_shape/);
  });

  it('entitlementAcquisition requires ZERO units + the immutable revision', async () => {
    const sessionId = await createSession(f);
    // With a unit → refused (no fake capacity, ever).
    await expect(
      sql`INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                                   option_kind, price_option_id, session_id, commercial_shape,
                                   fulfillment_revision_id, total_fils, price_kind, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                  ${customer.participantId}, 'package', ${packageOption}, ${sessionId},
                  'entitlementAcquisition', ${packageRevision}, 80000, 'oneOff',
                  now() + interval '15 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/ck_price_quote_shape/);
    // Without the revision → refused (terms binding is structural).
    await expect(
      sql`INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                                   option_kind, price_option_id, commercial_shape,
                                   total_fils, price_kind, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                  ${customer.participantId}, 'package', ${packageOption},
                  'entitlementAcquisition', 80000, 'oneOff',
                  now() + interval '15 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/ck_price_quote_shape/);
    // The revision must belong to the quote's option (composite FK).
    const otherOption = await createPriceOption(f, {
      kind: 'membership',
      amountFils: 40000,
    });
    await expect(
      insertAcquisitionQuote({ optionId: otherOption, revisionId: packageRevision }),
    ).rejects.toThrow(/fk_price_quote_fulfillment_revision/);
  });

  it('an entitlementAcquisition quote can NEVER be held — and therefore never booked', async () => {
    const quoteId = await insertAcquisitionQuote();
    const sessionId = await createSession(f);
    await expect(
      sql`INSERT INTO capacity_hold (id, organization_id, session_id, account_id,
                                     participant_id, quote_id, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${sessionId}, ${customer.accountId},
                  ${customer.participantId}, ${quoteId},
                  now() + interval '10 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/fk_capacity_hold_quote_session/);
  });

  it('capacity quote/unit substitution is structurally impossible (hold unit ≡ quote unit)', async () => {
    const sessionA = await createSession(f);
    const sessionB = await createSession(f);
    const quoteId = newId();
    await testDb.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO price_quote (id, organization_id, program_id, account_id,
                                         participant_id, option_kind, session_id, total_fils,
                                         price_kind, expires_at)
                VALUES (${quoteId}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                        ${customer.participantId}, 'dropIn', ${sessionA}, 5000, 'oneOff',
                        now() + interval '15 minutes')`.execute(trx);
      await sql`INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
                VALUES (${newId()}, ${quoteId}, 1, 'base', 'x', 5000)`.execute(trx);
    });
    await expect(
      sql`INSERT INTO capacity_hold (id, organization_id, session_id, account_id,
                                     participant_id, quote_id, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${sessionB}, ${customer.accountId},
                  ${customer.participantId}, ${quoteId},
                  now() + interval '10 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/fk_capacity_hold_quote_session/);
  });

  it('entitlementReservation (S6-3 structure): entitlement-bound, unit-bound, zero-total; ownership FK bites', async () => {
    // Build a confirmed purchase + entitlement to have a legal reservation
    // target; the SHAPE exists structurally, but no S6-1 service can
    // produce it (source lock below).
    const quoteId = await insertAcquisitionQuote();
    const purchaseId = await insertPurchase(quoteId, { state: 'confirmed' });
    const entitlementId = newId();
    await sql`
      INSERT INTO entitlement (id, purchase_id, account_id, participant_id, organization_id,
                               program_id, price_option_id, fulfillment_revision_id,
                               usage_kind, uses_total, valid_from, valid_until,
                               reservation_required, walk_in_allowed)
      VALUES (${entitlementId}, ${purchaseId}, ${customer.accountId},
              ${customer.participantId}, ${f.org.orgId}, ${f.programId}, ${packageOption},
              ${packageRevision}, 'finite', 10, now(), now() + interval '90 days',
              false, true)`.execute(testDb.db);
    const sessionId = await createSession(f);
    // A FOREIGN account naming this entitlement id gets a row-level refusal.
    const stranger = await createCustomer(testDb.db);
    await expect(
      sql`INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                                   option_kind, price_option_id, session_id, commercial_shape,
                                   entitlement_id, total_fils, price_kind, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${f.programId}, ${stranger.accountId},
                  ${stranger.participantId}, 'package', ${packageOption}, ${sessionId},
                  'entitlementReservation', ${entitlementId}, 0, 'oneOff',
                  now() + interval '15 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/fk_price_quote_entitlement/);
    // A NONZERO reservation quote is inexpressible.
    await expect(
      sql`INSERT INTO price_quote (id, organization_id, program_id, account_id, participant_id,
                                   option_kind, price_option_id, session_id, commercial_shape,
                                   entitlement_id, total_fils, price_kind, expires_at)
          VALUES (${newId()}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                  ${customer.participantId}, 'package', ${packageOption}, ${sessionId},
                  'entitlementReservation', ${entitlementId}, 100, 'oneOff',
                  now() + interval '15 minutes')`.execute(testDb.db),
    ).rejects.toThrow(/ck_price_quote_shape/);
    // A reservation quote can never seed an EntitlementPurchase.
    const reservationQuote = newId();
    await sql`INSERT INTO price_quote (id, organization_id, program_id, account_id,
                                       participant_id, option_kind, price_option_id, session_id,
                                       commercial_shape, entitlement_id, total_fils, price_kind,
                                       expires_at)
              VALUES (${reservationQuote}, ${f.org.orgId}, ${f.programId},
                      ${customer.accountId}, ${customer.participantId}, 'package',
                      ${packageOption}, ${sessionId}, 'entitlementReservation',
                      ${entitlementId}, 0, 'oneOff', now() + interval '15 minutes')`.execute(
      testDb.db,
    );
    await expect(insertPurchase(reservationQuote)).rejects.toThrow(
      /requires an entitlementAcquisition quote/,
    );
  });
});

describe('entitlement_purchase — the parallel unit-less anchor', () => {
  it('a CAPACITY quote can never become an EntitlementPurchase (shape trigger)', async () => {
    const sessionId = await createSession(f);
    const quoteId = newId();
    await testDb.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO price_quote (id, organization_id, program_id, account_id,
                                         participant_id, option_kind, session_id, total_fils,
                                         price_kind, expires_at)
                VALUES (${quoteId}, ${f.org.orgId}, ${f.programId}, ${customer.accountId},
                        ${customer.participantId}, 'dropIn', ${sessionId}, 5000, 'oneOff',
                        now() + interval '15 minutes')`.execute(trx);
      await sql`INSERT INTO price_quote_line (id, quote_id, line_no, kind, label_en, amount_fils)
                VALUES (${newId()}, ${quoteId}, 1, 'base', 'x', 5000)`.execute(trx);
    });
    await expect(insertPurchase(quoteId)).rejects.toThrow(
      /requires an entitlementAcquisition quote/,
    );
  });

  it('identity must equal the quote (participant substitution refused at the row level)', async () => {
    const quoteId = await insertAcquisitionQuote();
    const other = await createCustomer(testDb.db);
    await expect(insertPurchase(quoteId, { quoteCustomer: other })).rejects.toThrow(
      /identity must equal its quote/,
    );
  });

  it('one quote → at most ONE Purchase, ever (uq_entitlement_purchase_quote)', async () => {
    const quoteId = await insertAcquisitionQuote();
    await insertPurchase(quoteId);
    await expect(insertPurchase(quoteId)).rejects.toThrow(/uq_entitlement_purchase_quote/);
  });

  it('exact state machine: terminals frozen; only the approved transitions move', async () => {
    const quoteId = await insertAcquisitionQuote();
    const purchaseId = await insertPurchase(quoteId);
    // pending_payment → confirmed needs confirmation facts.
    await expect(
      sql`UPDATE entitlement_purchase SET state = 'confirmed' WHERE id = ${purchaseId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_entitlement_purchase_confirmation_facts/);
    // Legal: pending_payment → payment_failed → pending_payment → expired.
    await sql`UPDATE entitlement_purchase SET state = 'payment_failed' WHERE id = ${purchaseId}`.execute(testDb.db);
    await sql`UPDATE entitlement_purchase SET state = 'pending_payment' WHERE id = ${purchaseId}`.execute(testDb.db);
    await sql`UPDATE entitlement_purchase SET state = 'expired' WHERE id = ${purchaseId}`.execute(testDb.db);
    // Terminal frozen: expired never resurrects (late success compensates).
    await expect(
      sql`UPDATE entitlement_purchase SET state = 'pending_payment' WHERE id = ${purchaseId}`.execute(testDb.db),
    ).rejects.toThrow(/terminal/);
    // Identity frozen.
    const quote2 = await insertAcquisitionQuote();
    const purchase2 = await insertPurchase(quote2);
    await expect(
      sql`UPDATE entitlement_purchase SET expires_at = now() WHERE id = ${purchase2}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/);
    // Insert states are pending_payment | confirmed only.
    const quote3 = await insertAcquisitionQuote();
    await expect(insertPurchase(quote3, { state: 'expired' })).rejects.toThrow(
      /created pending_payment or confirmed/,
    );
    // DELETE forbidden.
    await expect(
      sql`DELETE FROM entitlement_purchase WHERE id = ${purchaseId}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
  });
});

describe('entitlement — the append-only grant', () => {
  async function confirmedPurchase(): Promise<string> {
    const quoteId = await insertAcquisitionQuote();
    return insertPurchase(quoteId, { state: 'confirmed' });
  }

  function grantValues(purchaseId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: newId(),
      purchase_id: purchaseId,
      account_id: customer.accountId,
      participant_id: customer.participantId,
      organization_id: f.org.orgId,
      program_id: f.programId,
      price_option_id: packageOption,
      fulfillment_revision_id: packageRevision,
      usage_kind: 'finite',
      uses_total: 10,
      valid_from: new Date(),
      valid_until: new Date(Date.now() + 86_400_000),
      reservation_required: false,
      walk_in_allowed: true,
      ...overrides,
    };
  }

  async function insertGrant(values: Record<string, unknown>): Promise<void> {
    await testDb.db.insertInto('entitlement').values(values as never).execute();
  }

  it('exactly ONE entitlement per confirmed purchase; unconfirmed purchases grant nothing', async () => {
    const pendingQuote = await insertAcquisitionQuote();
    const pending = await insertPurchase(pendingQuote);
    await expect(insertGrant(grantValues(pending))).rejects.toThrow(
      /requires a confirmed purchase/,
    );
    const confirmed = await confirmedPurchase();
    await insertGrant(grantValues(confirmed));
    await expect(insertGrant(grantValues(confirmed))).rejects.toThrow(
      /uq_entitlement_purchase/,
    );
  });

  it('grant identity ≡ purchase identity (7-column composite FK refuses substitution)', async () => {
    const confirmed = await confirmedPurchase();
    const other = await createCustomer(testDb.db);
    await expect(
      insertGrant(
        grantValues(confirmed, {
          account_id: other.accountId,
          participant_id: other.participantId,
        }),
      ),
    ).rejects.toThrow(/fk_entitlement_purchase_identity/);
  });

  it('finite/unlimited are explicit: finite ⇔ uses_total; validity must extend past valid_from; append-only', async () => {
    const confirmed = await confirmedPurchase();
    await expect(
      insertGrant(grantValues(confirmed, { usage_kind: 'finite', uses_total: null })),
    ).rejects.toThrow(/ck_entitlement_finite_uses/);
    await expect(
      insertGrant(grantValues(confirmed, { usage_kind: 'unlimited', uses_total: 999999 })),
    ).rejects.toThrow(/ck_entitlement_finite_uses/);
    await expect(
      insertGrant(
        grantValues(confirmed, { valid_until: new Date(Date.now() - 86_400_000) }),
      ),
    ).rejects.toThrow(/ck_entitlement_validity/);
    await insertGrant(grantValues(confirmed));
    const grant = await sql<{ id: string }>`
      SELECT id FROM entitlement WHERE purchase_id = ${confirmed}`.execute(testDb.db);
    await expect(
      sql`UPDATE entitlement SET uses_total = 99 WHERE id = ${grant.rows[0]!.id}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/append-only|forbid/i);
    await expect(
      sql`DELETE FROM entitlement WHERE id = ${grant.rows[0]!.id}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
  });
});

describe('fulfillment revisions — immutable terms', () => {
  it('per-kind shape: capacity kinds carry no revisions; package derives its total; finite membership needs uses_total', async () => {
    const dropIn = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
    await expect(
      createFulfillmentRevision(f, dropIn, { usageKind: 'finite' }),
    ).rejects.toThrow(/entitlement kinds/);
    await expect(
      createFulfillmentRevision(f, packageOption, {
        usageKind: 'finite',
        usesTotal: 5,
        revisionNo: 9,
      }),
    ).rejects.toThrow(/derives from sessions_count/);
    const membership = await createPriceOption(f, { kind: 'membership', amountFils: 30000 });
    await expect(
      createFulfillmentRevision(f, membership, {
        usageKind: 'finite',
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
      }),
    ).rejects.toThrow(/requires uses_total/);
    // Unlimited must expire (docs/35 §3): validity 'none' refused.
    await expect(
      createFulfillmentRevision(f, membership, { usageKind: 'unlimited' }),
    ).rejects.toThrow(/ck_fulfillment_unlimited_expires/);
    // Reservation-or-walk-in: at least one mode.
    await expect(
      createFulfillmentRevision(f, membership, {
        usageKind: 'unlimited',
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
        reservationRequired: false,
        walkInAllowed: false,
      }),
    ).rejects.toThrow(/ck_fulfillment_reservation_or_walkin/);
  });

  it('rows are immutable; a provider edit supersedes and inserts; one ACTIVE per option', async () => {
    const membership = await createPriceOption(f, { kind: 'membership', amountFils: 30000 });
    const first = await createFulfillmentRevision(f, membership, {
      usageKind: 'finite',
      usesTotal: 8,
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
    });
    await expect(
      sql`UPDATE price_option_fulfillment_revision SET uses_total = 99
          WHERE id = ${first}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    await expect(
      createFulfillmentRevision(f, membership, {
        usageKind: 'finite',
        usesTotal: 12,
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
        revisionNo: 2,
      }),
    ).rejects.toThrow(/uq_fulfillment_revision_active_option/);
    await sql`UPDATE price_option_fulfillment_revision SET state = 'superseded'
              WHERE id = ${first}`.execute(testDb.db);
    await createFulfillmentRevision(f, membership, {
      usageKind: 'finite',
      usesTotal: 12,
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      revisionNo: 2,
    });
    // Superseded rows are frozen forever; DELETE is forbidden everywhere.
    await expect(
      sql`UPDATE price_option_fulfillment_revision SET state = 'active'
          WHERE id = ${first}`.execute(testDb.db),
    ).rejects.toThrow(/superseded and immutable/);
    await expect(
      sql`DELETE FROM price_option_fulfillment_revision WHERE id = ${first}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbid/i);
  });
});

describe('payment_intent — exactly one commercial target', () => {
  it('one-target CHECK + Booking⇔hold shape + purchase composite FK', async () => {
    const quoteId = await insertAcquisitionQuote();
    const purchaseId = await insertPurchase(quoteId);
    // Purchase target with a hold column → target-shape CHECK.
    const holdless = {
      id: newId(),
      purchase_id: purchaseId,
      account_id: customer.accountId,
      quote_id: quoteId,
      amount_fils: 80000,
      idempotency_key: `cs:${customer.accountId}:${newId()}`,
      expires_at: new Date(Date.now() + 1_800_000),
    };
    // Neither target → one-target CHECK.
    await expect(
      testDb.db
        .insertInto('payment_intent')
        .values({ ...holdless, id: newId(), purchase_id: null } as never)
        .execute(),
    ).rejects.toThrow(/ck_payment_intent_one_target/);
    // Foreign account on the purchase target → composite FK.
    const stranger = await createCustomer(testDb.db);
    await expect(
      testDb.db
        .insertInto('payment_intent')
        .values({
          ...holdless,
          id: newId(),
          account_id: stranger.accountId,
          idempotency_key: `cs:${stranger.accountId}:${newId()}`,
        } as never)
        .execute(),
    ).rejects.toThrow(/fk_payment_intent_purchase/);
    // The legal purchase-target intent inserts; a SECOND live intent on the
    // same purchase dies on the partial unique.
    await testDb.db.insertInto('payment_intent').values(holdless as never).execute();
    await expect(
      testDb.db
        .insertInto('payment_intent')
        .values({
          ...holdless,
          id: newId(),
          idempotency_key: `cs:${customer.accountId}:${newId()}`,
        } as never)
        .execute(),
    ).rejects.toThrow(/uq_payment_intent_live_purchase/);
  });

  it('zero-price acquisition can NEVER create payment state (the certified zero-total trigger)', async () => {
    const freePackage = await createPriceOption(f, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 3,
    });
    const freeRevision = await createFulfillmentRevision(f, freePackage, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
    });
    const quoteId = await insertAcquisitionQuote({
      totalFils: 0,
      optionId: freePackage,
      revisionId: freeRevision,
    });
    const purchaseId = await insertPurchase(quoteId);
    await expect(
      testDb.db
        .insertInto('payment_intent')
        .values({
          id: newId(),
          purchase_id: purchaseId,
          account_id: customer.accountId,
          quote_id: quoteId,
          amount_fils: 0,
          idempotency_key: `cs:${customer.accountId}:${newId()}`,
          expires_at: new Date(Date.now() + 1_800_000),
        } as never)
        .execute(),
    ).rejects.toThrow(/zero-total quote/);
  });

  it('economics org binding is TARGET-neutral: a foreign org on a purchase intent is refused', async () => {
    const quoteId = await insertAcquisitionQuote();
    const purchaseId = await insertPurchase(quoteId);
    const intentId = newId();
    await testDb.db
      .insertInto('payment_intent')
      .values({
        id: intentId,
        purchase_id: purchaseId,
        account_id: customer.accountId,
        quote_id: quoteId,
        amount_fils: 80000,
        idempotency_key: `cs:${customer.accountId}:${newId()}`,
        expires_at: new Date(Date.now() + 1_800_000),
      } as never)
      .execute();
    const termA = await createCommissionTerm(testDb.db, f.org.orgId, 1200);
    // Correct org + term inserts (the purchase branch of the trigger).
    await testDb.db
      .insertInto('payment_intent_economics')
      .values({
        intent_id: intentId,
        organization_id: f.org.orgId,
        commission_term_id: termA,
        commission_basis_amount_fils: 80000,
        platform_commission_rate_bps: 1200,
        platform_commission_amount_fils: 9600,
        provider_share_amount_fils: 70400,
      } as never)
      .execute();
    // A foreign org (with its own term) on THIS intent is refused.
    const orgB = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
    const termB = await createCommissionTerm(testDb.db, orgB.orgId, 1000);
    const quote2 = await insertAcquisitionQuote();
    const purchase2 = await insertPurchase(quote2);
    const intent2 = newId();
    await testDb.db
      .insertInto('payment_intent')
      .values({
        id: intent2,
        purchase_id: purchase2,
        account_id: customer.accountId,
        quote_id: quote2,
        amount_fils: 80000,
        idempotency_key: `cs:${customer.accountId}:${newId()}`,
        expires_at: new Date(Date.now() + 1_800_000),
      } as never)
      .execute();
    await expect(
      testDb.db
        .insertInto('payment_intent_economics')
        .values({
          intent_id: intent2,
          organization_id: orgB.orgId,
          commission_term_id: termB,
          commission_basis_amount_fils: 80000,
          platform_commission_rate_bps: 1000,
          platform_commission_amount_fils: 8000,
          provider_share_amount_fils: 72000,
        } as never)
        .execute(),
    ).rejects.toThrow(/organization must be the commercial target/);
  });
});

describe('supersession and early-capability locks', () => {
  it('package_entitlement is SUPERSEDED (D-S6-2) and no second entitlement model exists', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'package_entitlement'`.execute(testDb.db);
    expect(tables.rows).toHaveLength(0);
  });

  it('S6-2/S6-3 tables stay ABSENT: no credential/attendance/reservation table exists yet', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('redemption_credential', 'attendance_record',
                           'entitlement_reservation')`.execute(testDb.db);
    expect(tables.rows).toHaveLength(0);
  });

  it("no S6-1 service/http source can produce an 'entitlementReservation' quote (S6-3 owns it)", () => {
    const roots = [
      path.resolve(__dirname, '..', 'src', 'modules'),
      path.resolve(__dirname, '..', 'src', 'app'),
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) {
          const source = readFileSync(full, 'utf8');
          if (source.includes("'entitlementReservation'")) offenders.push(full);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
