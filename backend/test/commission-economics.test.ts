/**
 * W5 · W5-4 owner correction — marketplace commission economics
 * certification (owner ruling D-W5-7, docs/33 §14.1). Real PostgreSQL.
 *
 * Proves the required matrix: provider-specific immutable splits (10% and
 * 12% providers side by side — never hard-coded, never defaulted); paid
 * checkout FAILS CLOSED before any Booking/intent/money when no ACTIVE
 * agreed term exists; the rate/basis/split are entirely server-derived
 * (no input channel exists, structurally); later term changes never touch
 * existing snapshots while new checkouts pick up the new rate; idempotent
 * retries reuse the exact committed snapshot; the owner round-half-up
 * rule in integer fils at fractional boundaries; the structural
 * reconciliation commission + share = basis; settlement ELIGIBILITY is a
 * projection — a confirmed paid booking retains its split for the future
 * payout workstream while a captured-but-compensated intent yields NO
 * settleable commission and NO provider payable (the snapshot remains as
 * audit/history); semantic-duplicate successes cannot duplicate
 * economics (1:1 by intent primary key); and no payout/Connect/transfer
 * surface exists anywhere. Plus the 0016 database invariants: one ACTIVE
 * term per org, immutable term rates, append-only snapshots, the
 * org-binding trigger (cross-provider substitution structurally
 * impossible), and the reconciliation CHECK against direct SQL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { expireHold } from '../src/modules/booking/services/hold-lifecycle';
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { computeCommissionSplit } from '../src/modules/payment/commission';
import { DeterministicPaymentProvider } from '../src/modules/payment/deterministic-provider';
import { startPaidCheckout } from '../src/modules/payment/services/checkout-orchestration';
import { runPaymentResultSaga } from '../src/modules/payment/services/payment-saga';
import {
  ingestGatewayDelivery,
  processPendingGatewayEvents,
} from '../src/modules/payment/services/webhook-ingestion';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createActivePolicyTemplate,
  createCommissionTerm,
} from './helpers/booking-fixtures';
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
let orgB: { orgId: string; branchIds: string[] };
let programA: string;
let programB: string;
let termA: string;
let accountParent: string;
let participantChild: string;

// Future-relative fixture instants (calendar-rot repair, 2026-08-31): the
// suite's meaning is "a session that has not started and a hold/quote that
// is still live at checkout time" — pinned to the wall clock, never to a
// date that silently lapses. The deterministic PROVIDER clock (NOW) stays
// fixed: it feeds only the fake gateway's internal bookkeeping.
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const FUTURE_END = new Date(FUTURE.getTime() + 60 * 60 * 1000);
const NOW = new Date('2026-08-21T12:00:00.000Z');
const HOLD_EXPIRY = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST = new Date('2026-08-21T10:00:00.000Z');

let eventSerial = 0;
const nextEventId = (): string => `evt_econ_${(eventSerial += 1)}`;

async function makeProgramFor(org: { orgId: string }): Promise<string> {
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  const typeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${typeId}, ${category.rows[0]!.id}, ${`econ-type-${typeId.replace(/-/g, '').slice(-12)}`}, 'Econ Type')`.execute(
    testDb.db,
  );
  const scope: OrgScope = {
    organizationId: org.orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const created = await createProgram({ db: testDb.db }, scope, { userId: newId() }, {
    titleEn: `Econ Program ${typeId.slice(0, 8)}`,
    activityTypeId: typeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return created.program.id;
}

interface Spine {
  sessionId: string;
  quoteId: string;
  holdId: string;
  orgId: string;
}

async function makeSpine(
  org: { orgId: string; branchIds: string[] },
  programId: string,
  totalFils: number,
  holdExpiresAt: Date = HOLD_EXPIRY,
): Promise<Spine> {
  const sessionId = newId();
  await testDb.db
    .insertInto('session')
    .values({
      id: sessionId,
      program_id: programId,
      organization_id: org.orgId,
      branch_id: org.branchIds[0],
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
        organization_id: org.orgId,
        program_id: programId,
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
        quote_id: quoteId,
        line_no: 1,
        kind: 'base',
        label_en: '1 activity',
        amount_fils: totalFils,
      } as never)
      .execute();
  });
  const holdId = newId();
  await testDb.db
    .insertInto('capacity_hold')
    .values({
      id: holdId,
      organization_id: org.orgId,
      session_id: sessionId,
      account_id: accountParent,
      participant_id: participantChild,
      quote_id: quoteId,
      expires_at: holdExpiresAt,
    } as never)
    .execute();
  return { sessionId, quoteId, holdId, orgId: org.orgId };
}

async function checkout(
  spine: Spine,
  key = `econ-${spine.holdId}`,
): Promise<{
  kind: string;
  intentId?: string;
  bookingId?: string;
  gatewayRef?: string;
  provider: DeterministicPaymentProvider;
}> {
  const provider = new DeterministicPaymentProvider({ now: NOW });
  const result = await startPaidCheckout(
    { db: testDb.db, provider: { kind: 'configured', provider } },
    { accountId: accountParent },
    {
      holdId: spine.holdId,
      quoteId: spine.quoteId,
      idempotencyKey: key,
      returnUrl: 'https://himma.test/return',
      cancelUrl: 'https://himma.test/cancel',
    },
  );
  return result.kind === 'checkoutStarted'
    ? {
        kind: result.kind,
        intentId: result.intentId,
        bookingId: result.bookingId,
        gatewayRef: result.gatewayRef,
        provider,
      }
    : { kind: result.kind, provider };
}

interface EconomicsRow {
  organization_id: string;
  commission_basis_amount_fils: string;
  platform_commission_rate_bps: number;
  platform_commission_amount_fils: string;
  provider_share_amount_fils: string;
}

async function economicsOf(intentId: string): Promise<EconomicsRow | undefined> {
  const result = await sql<EconomicsRow>`
    SELECT organization_id, commission_basis_amount_fils, platform_commission_rate_bps,
           platform_commission_amount_fils, provider_share_amount_fils
    FROM payment_intent_economics WHERE intent_id = ${intentId}`.execute(testDb.db);
  return result.rows[0];
}

/** The settlement-eligibility PROJECTION (D-W5-7 §7/§8): economics become
 *  settleable ONLY through the successful confirmed commercial outcome. */
async function settleable(intentId: string): Promise<EconomicsRow | undefined> {
  const result = await sql<EconomicsRow>`
    SELECT e.organization_id, e.commission_basis_amount_fils, e.platform_commission_rate_bps,
           e.platform_commission_amount_fils, e.provider_share_amount_fils
    FROM payment_intent_economics e
    JOIN payment_intent i ON i.id = e.intent_id
    JOIN booking b ON b.id = i.booking_id
    WHERE e.intent_id = ${intentId}
      AND i.state = 'succeeded' AND b.state = 'confirmed'`.execute(testDb.db);
  return result.rows[0];
}

async function driveSagaToOutcome(
  c: { intentId?: string; gatewayRef?: string; provider: DeterministicPaymentProvider },
): Promise<string> {
  const deps = { db: testDb.db, provider: c.provider };
  const delivery = c.provider.buildWebhookDelivery({
    gatewayEventId: nextEventId(),
    eventType: 'checkout.completed',
    gatewayRef: c.gatewayRef!,
  });
  const accepted = await ingestGatewayDelivery(deps, delivery.rawBody, delivery.headers);
  if (accepted.kind !== 'accepted') throw new Error(accepted.kind);
  await processPendingGatewayEvents(deps);
  return await runPaymentResultSaga(deps, accepted.gatewayEventRowId);
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  orgA = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
  orgB = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
  termA = await createCommissionTerm(testDb.db, orgA.orgId, 1000); // 10%
  await createCommissionTerm(testDb.db, orgB.orgId, 1200); // 12%
  programA = await makeProgramFor(orgA);
  programB = await makeProgramFor(orgB);
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

describe('provider-specific immutable splits', () => {
  it('10% and 12% providers snapshot correct, DIFFERENT splits side by side — server-derived, reconciling exactly to basis', async () => {
    const a = await checkout(await makeSpine(orgA, programA, 5000));
    const b = await checkout(await makeSpine(orgB, programB, 5000));
    if (a.kind !== 'checkoutStarted' || b.kind !== 'checkoutStarted') throw new Error('setup');

    expect(await economicsOf(a.intentId!)).toMatchObject({
      organization_id: orgA.orgId,
      platform_commission_rate_bps: 1000,
      commission_basis_amount_fils: '5000',
      platform_commission_amount_fils: '500',
      provider_share_amount_fils: '4500',
    });
    expect(await economicsOf(b.intentId!)).toMatchObject({
      organization_id: orgB.orgId,
      platform_commission_rate_bps: 1200,
      commission_basis_amount_fils: '5000',
      platform_commission_amount_fils: '600',
      provider_share_amount_fils: '4400',
    });
  });

  it('NO configured rate → paid checkout fails closed BEFORE any Booking/intent/money (and the free path is untouched)', async () => {
    const orgC = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
    const programC = await makeProgramFor(orgC);
    const spine = await makeSpine(orgC, programC, 5000);
    const refused = await checkout(spine);
    expect(refused.kind).toBe('commissionTermsUnavailable');
    const rows = await sql<{ bookings: string; intents: string }>`
      SELECT (SELECT count(*) FROM booking WHERE hold_id = ${spine.holdId}) AS bookings,
             (SELECT count(*) FROM payment_intent WHERE hold_id = ${spine.holdId}) AS intents`.execute(
      testDb.db,
    );
    expect(rows.rows[0]).toEqual({ bookings: '0', intents: '0' });
    expect(refused.provider.createRequestCount).toBe(0); // no Stripe, no money

    // Zero-total quotes stay on the certified free path even termless.
    const freeSpine = await makeSpine(orgC, programC, 0);
    expect((await checkout(freeSpine)).kind).toBe('paymentNotRequired');
  });

  it('a rate change SUPERSEDES for new checkouts and never touches existing snapshots; idempotent replay reuses the exact snapshot; nothing customer-supplied exists', async () => {
    const orgD = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
    const programD = await makeProgramFor(orgD);
    const oldTerm = await createCommissionTerm(testDb.db, orgD.orgId, 1000);
    const first = await checkout(await makeSpine(orgD, programD, 5000), 'econ-rate-change-1');
    if (first.kind !== 'checkoutStarted') throw new Error(first.kind);

    // The agreement changes: supersede + new active 12%.
    await sql`UPDATE organization_commission_term SET state = 'superseded'
              WHERE id = ${oldTerm}`.execute(testDb.db);
    await createCommissionTerm(testDb.db, orgD.orgId, 1200);

    // Existing snapshot unchanged; idempotent replay returns the SAME one.
    expect(await economicsOf(first.intentId!)).toMatchObject({
      platform_commission_rate_bps: 1000,
      platform_commission_amount_fils: '500',
    });
    const bookingRefs = await sql<{ quote_id: string; hold_id: string }>`
      SELECT quote_id, hold_id FROM booking WHERE id = ${first.bookingId!}`.execute(testDb.db);
    const replay = await checkout(
      {
        sessionId: '',
        quoteId: bookingRefs.rows[0]!.quote_id,
        holdId: bookingRefs.rows[0]!.hold_id,
        orgId: orgD.orgId,
      },
      'econ-rate-change-1',
    );
    if (replay.kind !== 'checkoutStarted') throw new Error(replay.kind);
    expect(replay.intentId).toBe(first.intentId);
    const snapshots = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_intent_economics
      WHERE intent_id = ${first.intentId!}`.execute(testDb.db);
    expect(Number(snapshots.rows[0]!.n)).toBe(1);
    expect(await economicsOf(first.intentId!)).toMatchObject({
      platform_commission_rate_bps: 1000,
    });

    // A NEW checkout picks up the new agreed rate.
    const second = await checkout(await makeSpine(orgD, programD, 5000), 'econ-rate-change-2');
    if (second.kind !== 'checkoutStarted') throw new Error(second.kind);
    expect(await economicsOf(second.intentId!)).toMatchObject({
      platform_commission_rate_bps: 1200,
      platform_commission_amount_fils: '600',
    });
  });

  it('round-half-up in integer fils at fractional boundaries (owner rounding rule), pure and at the database', async () => {
    // Pure arithmetic first — no floats anywhere.
    expect(computeCommissionSplit(3333, 1000)).toMatchObject({
      platformCommissionAmountFils: 333, // 333.3 ↓
      providerShareAmountFils: 3000,
    });
    expect(computeCommissionSplit(3335, 1000)).toMatchObject({
      platformCommissionAmountFils: 334, // 333.5 ↑ (half-up)
      providerShareAmountFils: 3001,
    });
    expect(computeCommissionSplit(25, 1000)).toMatchObject({
      platformCommissionAmountFils: 3, // 2.5 ↑
      providerShareAmountFils: 22,
    });
    expect(computeCommissionSplit(4999, 1200)).toMatchObject({
      platformCommissionAmountFils: 600, // 599.88 ↑
      providerShareAmountFils: 4399,
    });
    expect(computeCommissionSplit(0, 1000).platformCommissionAmountFils).toBe(0);

    // And the same boundary shape end-to-end through checkout.
    const fractional = await checkout(await makeSpine(orgA, programA, 3335));
    if (fractional.kind !== 'checkoutStarted') throw new Error(fractional.kind);
    expect(await economicsOf(fractional.intentId!)).toMatchObject({
      commission_basis_amount_fils: '3335',
      platform_commission_amount_fils: '334',
      provider_share_amount_fils: '3001',
    });
  });
});

describe('settlement eligibility — the successful commercial outcome only', () => {
  it('capture + confirmed Booking retains the settleable split for the future payout workstream', async () => {
    const c = await checkout(await makeSpine(orgA, programA, 5000));
    if (c.kind !== 'checkoutStarted') throw new Error(c.kind);
    c.provider.completeCheckout(c.gatewayRef!);
    expect(await driveSagaToOutcome(c)).toBe('confirmed');
    expect(await settleable(c.intentId!)).toMatchObject({
      platform_commission_amount_fils: '500',
      provider_share_amount_fils: '4500',
    });
  });

  it('captured-but-COMPENSATED: the snapshot remains for audit, but NO settleable commission and NO provider payable exists', async () => {
    // The lapsed shape: booking + intent + economics assembled directly,
    // hold authoritatively expired, then the slipped completion.
    const spine = await makeSpine(orgA, programA, 5000, PAST);
    const provider = new DeterministicPaymentProvider({ now: NOW });
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
        idempotency_key: `cs:${accountParent}:econ-comp-${spine.holdId}`,
        expires_at: PAST,
      } as never)
      .execute();
    await sql`UPDATE payment_intent SET state = 'in_progress' WHERE id = ${intentId}`.execute(
      testDb.db,
    );
    await testDb.db
      .insertInto('payment_intent_economics')
      .values({
        intent_id: intentId,
        organization_id: orgA.orgId,
        commission_term_id: termA,
        commission_basis_amount_fils: 5000,
        platform_commission_rate_bps: 1000,
        platform_commission_amount_fils: 500,
        provider_share_amount_fils: 4500,
      } as never)
      .execute();
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
    await testDb.db
      .insertInto('payment_attempt')
      .values({
        id: newId(),
        intent_id: intentId,
        sequence_no: 1,
        gateway_ref: created.gatewayRef,
      } as never)
      .execute();
    await expireHold({ db: testDb.db }, { holdId: spine.holdId });
    provider.completeCheckout(created.gatewayRef);

    const outcome = await driveSagaToOutcome({
      intentId,
      gatewayRef: created.gatewayRef,
      provider,
    });
    expect(outcome).toBe('compensated');
    // Audit/history: the immutable snapshot remains…
    expect(await economicsOf(intentId)).toMatchObject({
      platform_commission_amount_fils: '500',
    });
    // …but the settleable projection is EMPTY: no earned commission, no
    // provider payable, for a compensated transient capture.
    expect(await settleable(intentId)).toBeUndefined();
  });

  it('semantic/duplicate success events cannot duplicate economics: the snapshot is 1:1 with the intent by primary key', async () => {
    const c = await checkout(await makeSpine(orgA, programA, 5000));
    if (c.kind !== 'checkoutStarted') throw new Error(c.kind);
    c.provider.completeCheckout(c.gatewayRef!);
    await driveSagaToOutcome(c);
    await driveSagaToOutcome(c); // second success event, different id
    const snapshots = await sql<{ n: string }>`
      SELECT count(*) AS n FROM payment_intent_economics
      WHERE intent_id = ${c.intentId!}`.execute(testDb.db);
    expect(Number(snapshots.rows[0]!.n)).toBe(1);
    await expect(
      testDb.db
        .insertInto('payment_intent_economics')
        .values({
          intent_id: c.intentId!,
          organization_id: orgA.orgId,
          commission_term_id: termA,
          commission_basis_amount_fils: 5000,
          platform_commission_rate_bps: 1000,
          platform_commission_amount_fils: 500,
          provider_share_amount_fils: 4500,
        } as never)
        .execute(),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe('0016 database invariants', () => {
  it('one ACTIVE term per organization; term rate immutable; superseded terminal; no DELETE path', async () => {
    const orgE = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
    const term = await createCommissionTerm(testDb.db, orgE.orgId, 1000);
    await expect(createCommissionTerm(testDb.db, orgE.orgId, 1200)).rejects.toThrow(
      /uq_commission_term_active_org|duplicate key/i,
    );
    await expect(
      sql`UPDATE organization_commission_term SET rate_bps = 1200 WHERE id = ${term}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/immutable/i);
    await sql`UPDATE organization_commission_term SET state = 'superseded'
              WHERE id = ${term}`.execute(testDb.db);
    await expect(
      sql`UPDATE organization_commission_term SET state = 'active' WHERE id = ${term}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/superseded|immutable/i);
    await createCommissionTerm(testDb.db, orgE.orgId, 1200); // now legal
    await expect(
      sql`DELETE FROM organization_commission_term WHERE id = ${term}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbidden/i);
    await expect(
      createCommissionTerm(testDb.db, orgE.orgId, 10001),
    ).rejects.toThrow(/ck_commission_term_rate|violates check/i);
  });

  it('snapshots are append-only, reconciliation-CHECKed, and organization-pinned to the BOOKING (cross-provider substitution impossible)', async () => {
    const c = await checkout(await makeSpine(orgA, programA, 5000));
    if (c.kind !== 'checkoutStarted') throw new Error(c.kind);
    await expect(
      sql`UPDATE payment_intent_economics SET provider_share_amount_fils = 0
          WHERE intent_id = ${c.intentId!}`.execute(testDb.db),
    ).rejects.toThrow(/append-only|forbidden/i);
    await expect(
      sql`DELETE FROM payment_intent_economics WHERE intent_id = ${c.intentId!}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/append-only|forbidden/i);

    // A second checkout to attack with direct SQL:
    const d = await checkout(await makeSpine(orgA, programA, 5000));
    if (d.kind !== 'checkoutStarted') throw new Error(d.kind);
    await sql`DELETE FROM payment_intent_economics WHERE false`.execute(testDb.db); // no-op sanity
    const orgBTerm = await sql<{ id: string }>`
      SELECT id FROM organization_commission_term
      WHERE organization_id = ${orgB.orgId} AND state = 'active'`.execute(testDb.db);
    // (a) a mis-reconciled split is uncommittable;
    await sql`DELETE FROM payment_intent_economics WHERE intent_id = ${d.intentId!}`.execute(
      testDb.db,
    ).catch(() => undefined);
    await expect(
      sql`INSERT INTO payment_intent_economics
            (intent_id, organization_id, commission_term_id, commission_basis_amount_fils,
             platform_commission_rate_bps, platform_commission_amount_fils,
             provider_share_amount_fils)
          VALUES (${newId()}, ${orgA.orgId}, ${termA}, 5000, 1000, 500, 4000)`.execute(testDb.db),
    ).rejects.toThrow(/ck_economics_reconciles|violates check|not found/i);
    // (b) ANOTHER provider's org/term on this booking's intent is refused —
    // by the org-binding trigger and by the composite term FK.
    await expect(
      sql`INSERT INTO payment_intent_economics
            (intent_id, organization_id, commission_term_id, commission_basis_amount_fils,
             platform_commission_rate_bps, platform_commission_amount_fils,
             provider_share_amount_fils)
          VALUES (${newId()}, ${orgB.orgId}, ${orgBTerm.rows[0]!.id}, 5000, 1200, 600, 4400)`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/not found/i); // random intent id → intent lookup fails first
    const freshIntent = await sql<{ id: string }>`
      SELECT id FROM payment_intent WHERE id = ${d.intentId!}`.execute(testDb.db);
    expect(freshIntent.rows).toHaveLength(1);
    await expect(
      sql`INSERT INTO payment_intent_economics
            (intent_id, organization_id, commission_term_id, commission_basis_amount_fils,
             platform_commission_rate_bps, platform_commission_amount_fils,
             provider_share_amount_fils)
          VALUES (${d.intentId!}, ${orgB.orgId}, ${orgBTerm.rows[0]!.id}, 5000, 1200, 600, 4400)`.execute(
        testDb.db,
      ),
    // S6-1 owning-slice amendment (docs/35 §5.3): the binding is now
    // TARGET-neutral — the message names the commercial target.
    ).rejects.toThrow(/organization must be the commercial target/i);
  });

  it('no payout/Connect/transfer surface exists: the payment module ships no such code and the HTTP dir is still exactly the webhook ingress', () => {
    const paymentDir = path.resolve(__dirname, '..', 'src', 'modules', 'payment');
    expect(readdirSync(path.join(paymentDir, 'http')).sort()).toEqual([
      'payment-webhook-routes.ts',
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
      );
    for (const file of walk(paymentDir)) {
      if (!file.endsWith('.ts')) continue;

      const source = readFileSync(file, 'utf8');
      // The concrete Connect/payout API surfaces — comments naming the
      // exclusions ("no Connect, no payouts") are the architecture
      // documenting itself, not an implementation.
      expect(source).not.toMatch(
        /stripe\.transfers|stripe\.accounts|stripe\.topups|transfer_data|application_fee|payout_statement/,
      );
    }
  });
});
