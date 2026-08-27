/**
 * W2-13 — provider fulfillment-configuration companion certification
 * (docs/35 §3; owner W2-13 items 2–6, 22–23, 26). Real PostgreSQL + real
 * Fastify transport.
 *
 * Authorization rides the certified PRODUCT capability (`listings.manage`
 * — never `attendance.manage`); edits are immutable supersede-and-insert
 * revisions; historical/sold terms are never rewritten; validation is
 * server truth (client validation is presentation only).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  createBookingFixture,
  createCustomer,
  createPriceOption,
  publishProgram,
  type BookingFixture,
} from './helpers/booking-fixtures';
import { createAccount, createSelfParticipant, createUser } from './helpers/identity-fixtures';
import { addMembership, bearerForUser, type ProviderTestContext } from './helpers/provider-fixtures';
import { createMigratedTestDb, type TestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/fulfillment-admin-pool';

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let f: BookingFixture;
let packOption: string;
let membershipOption: string;
let ownerBearer: string;

const BASE = () => `/provider/organizations/${f.org.orgId}`;

async function staffBearer(
  role: string,
  orgId = f.org.orgId,
  branchIds?: string[],
): Promise<string> {
  const userId = await createUser(testDb.db);
  await addMembership(testDb.db, userId, orgId, role as never, branchIds);
  const { bearer } = await bearerForUser(ctx, userId);
  return bearer;
}

function inject(
  method: 'GET' | 'PUT' | 'POST',
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

const FINITE_MEMBERSHIP_TERMS = {
  usageKind: 'finite',
  usesTotal: 8,
  validityKind: 'daysFromConfirmation',
  validityDays: 30,
  reservationRequired: true,
  walkInAllowed: true,
};

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  f = await createBookingFixture(testDb.db);
  await publishProgram(f);
  packOption = await createPriceOption(f, { kind: 'package', amountFils: 50000, sessionsCount: 5 });
  membershipOption = await createPriceOption(f, { kind: 'membership', amountFils: 30000 });
  ownerBearer = await staffBearer('owner');
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('fulfillment configuration editor (immutable revisions)', () => {
  it('owner configures a finite package; an EDIT supersedes and inserts revision 2; history stays intact and immutable', async () => {
    const url = `${BASE()}/programs/${f.programId}/price-options/${packOption}/fulfillment`;
    const first = await inject('PUT', url, ownerBearer, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 90,
      reservationRequired: false,
      walkInAllowed: true,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().revision).toMatchObject({
      revisionNo: 1,
      state: 'active',
      usageKind: 'finite',
      validityDays: 90,
    });
    const firstRevisionId = first.json().revision.revisionId as string;
    // The read route reports the ACTIVE terms.
    const read = await inject('GET', url, ownerBearer);
    expect(read.statusCode).toBe(200);
    expect(read.json().fulfillment.supported).toBe(true);
    expect(read.json().fulfillment.active.revisionId).toBe(firstRevisionId);
    // Edit = supersede + insert; the old revision survives, frozen.
    const second = await inject('PUT', url, ownerBearer, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 60,
      reservationRequired: true,
      walkInAllowed: true,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().revision.revisionNo).toBe(2);
    const states = await sql<{ id: string; state: string; validity_days: number }>`
      SELECT id, state, validity_days FROM price_option_fulfillment_revision
      WHERE price_option_id = ${packOption} ORDER BY revision_no`.execute(testDb.db);
    expect(states.rows.map((row) => row.state)).toEqual(['superseded', 'active']);
    expect(states.rows[0]!.validity_days).toBe(90); // history untouched
    await expect(
      sql`UPDATE price_option_fulfillment_revision SET validity_days = 1
          WHERE id = ${firstRevisionId}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`DELETE FROM price_option_fulfillment_revision WHERE id = ${firstRevisionId}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/append-only|forbid/i);
  });

  it('a sold Entitlement stays bound to its OLD immutable revision after the provider publishes new terms', async () => {
    const freePack = await createPriceOption(f, { kind: 'package', amountFils: 0, sessionsCount: 3 });
    const url = `${BASE()}/programs/${f.programId}/price-options/${freePack}/fulfillment`;
    const v1 = await inject('PUT', url, ownerBearer, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: false,
      walkInAllowed: true,
    });
    expect(v1.statusCode).toBe(200);
    const v1Id = v1.json().revision.revisionId as string;
    // A REAL customer acquisition under revision 1.
    const customer = await createCustomer(testDb.db);
    const quote = await requestEntitlementQuote({ db: testDb.db }, { accountId: customer.accountId }, {
      programId: f.programId,
      priceOptionId: freePack,
      participantId: customer.participantId,
    });
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const purchase = await confirmFreeEntitlementPurchase(
      { db: testDb.db },
      { accountId: customer.accountId },
      { quoteId: quote.quote.quoteId, idempotencyKey: newId() },
    );
    if (purchase.outcome.kind !== 'purchaseConfirmed') throw new Error(purchase.outcome.kind);
    const entitlementId = purchase.outcome.purchase.entitlement!.entitlementId;
    // The provider then changes FUTURE terms.
    const v2 = await inject('PUT', url, ownerBearer, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 7,
      reservationRequired: true,
      walkInAllowed: false,
    });
    expect(v2.statusCode).toBe(200);
    // The historical buyer keeps the OLD contract, byte-identical.
    const bound = await sql<{
      fulfillment_revision_id: string;
      walk_in_allowed: boolean;
      delta_days: number;
    }>`
      SELECT fulfillment_revision_id, walk_in_allowed,
             round(extract(epoch FROM (valid_until - valid_from)) / 86400)::int AS delta_days
      FROM entitlement WHERE id = ${entitlementId}`.execute(testDb.db);
    expect(bound.rows[0]).toEqual({
      fulfillment_revision_id: v1Id,
      walk_in_allowed: true,
      delta_days: 30,
    });
  });

  it('membership terms: finite/unlimited + schedule snapshot; server refuses every invalid canonical combination', async () => {
    const url = `${BASE()}/programs/${f.programId}/price-options/${membershipOption}/fulfillment`;
    const withSchedule = await inject('PUT', url, ownerBearer, {
      usageKind: 'unlimited',
      validityKind: 'fixedEndDate',
      validityEndDate: '2027-06-30',
      reservationRequired: false,
      walkInAllowed: true,
      scheduleTerms: [
        { weekday: 1, startTime: '19:00', endTime: '20:00' },
        { weekday: 3, startTime: '19:00', endTime: '20:00' },
      ],
    });
    expect(withSchedule.statusCode).toBe(200);
    expect(withSchedule.json().revision.scheduleTerms).toHaveLength(2);
    for (const [label, terms] of [
      // finite membership without a total
      ['finiteNoTotal', { ...FINITE_MEMBERSHIP_TERMS, usesTotal: undefined }],
      // unlimited with a fake finite count
      ['unlimitedWithTotal', { ...FINITE_MEMBERSHIP_TERMS, usageKind: 'unlimited' }],
      // unlimited with no expiry (not a V1 product)
      [
        'unlimitedNoExpiry',
        {
          usageKind: 'unlimited',
          validityKind: 'none',
          reservationRequired: false,
          walkInAllowed: true,
        },
      ],
      // no fulfillment path at all
      [
        'noMethod',
        { ...FINITE_MEMBERSHIP_TERMS, reservationRequired: false, walkInAllowed: false },
      ],
      // mismatched validity payload
      [
        'daysWithEndDate',
        { ...FINITE_MEMBERSHIP_TERMS, validityEndDate: '2027-01-01' },
      ],
    ] as const) {
      const refused = await inject('PUT', url, ownerBearer, terms);
      expect([422, 400]).toContain(refused.statusCode);
      void label;
    }
    // Package cannot carry a membership uses total or a schedule snapshot.
    const packUrl = `${BASE()}/programs/${f.programId}/price-options/${packOption}/fulfillment`;
    const packTotal = await inject('PUT', packUrl, ownerBearer, {
      ...FINITE_MEMBERSHIP_TERMS,
    });
    expect(packTotal.statusCode).toBe(422);
    const packSchedule = await inject('PUT', packUrl, ownerBearer, {
      usageKind: 'finite',
      validityKind: 'none',
      reservationRequired: false,
      walkInAllowed: true,
      scheduleTerms: [{ weekday: 1, startTime: '10:00', endTime: '11:00' }],
    });
    expect(packSchedule.statusCode).toBe(422);
    // Capacity kinds carry no fulfillment configuration at all.
    const dropIn = await createPriceOption(f, { kind: 'dropIn', amountFils: 5000 });
    const capacity = await inject(
      'PUT',
      `${BASE()}/programs/${f.programId}/price-options/${dropIn}/fulfillment`,
      ownerBearer,
      { usageKind: 'finite', validityKind: 'none', reservationRequired: false, walkInAllowed: true },
    );
    expect(capacity.statusCode).toBe(422);
    const capacityRead = await inject(
      'GET',
      `${BASE()}/programs/${f.programId}/price-options/${dropIn}/fulfillment`,
      ownerBearer,
    );
    expect(capacityRead.json().fulfillment.supported).toBe(false);
  });

  it('branch limitation accepts only OWNED active branches; foreign branch ids are refused', async () => {
    const url = `${BASE()}/programs/${f.programId}/price-options/${membershipOption}/fulfillment`;
    const owned = await inject('PUT', url, ownerBearer, {
      ...FINITE_MEMBERSHIP_TERMS,
      branchId: f.org.branchIds[0],
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.json().revision.branchId).toBe(f.org.branchIds[0]);
    const orgB = await createBookingFixture(testDb.db);
    const foreign = await inject('PUT', url, ownerBearer, {
      ...FINITE_MEMBERSHIP_TERMS,
      branchId: orgB.org.branchIds[0],
    });
    expect(foreign.statusCode).toBe(422);
  });

  it('membership price options are creatable on draft listings (incl. genuinely FREE ones); the review-gated path routes through the ORDINARY revision lifecycle', async () => {
    // Draft listing: direct edit — membership (and a zero-price package)
    // create through the certified editor path.
    const draft = await createBookingFixture(testDb.db); // stays draft
    const draftOwner = await staffBearer('owner', draft.org.orgId);
    const created = await inject(
      'POST',
      `/provider/organizations/${draft.org.orgId}/listings/${draft.programId}/price-options`,
      draftOwner,
      { kind: 'membership', amountFils: 45000 },
    );
    expect(created.statusCode).toBe(200);
    expect(created.json().option.kind).toBe('membership');
    const freeMembership = await inject(
      'POST',
      `/provider/organizations/${draft.org.orgId}/listings/${draft.programId}/price-options`,
      draftOwner,
      { kind: 'membership', amountFils: 0 },
    );
    expect(freeMembership.statusCode).toBe(200);
    expect(freeMembership.json().option.amountFils).toBe(0);
    // Published (review-gated) listing: since 0019 widened the 0008
    // program_revision kind CHECK, a membership option change is
    // REPRESENTED through the ordinary certified revision path — the
    // W2-13 temporary typed refusal is gone.
    const gated = await inject(
      'POST',
      `${BASE()}/listings/${f.programId}/price-options`,
      ownerBearer,
      { kind: 'membership', amountFils: 45000 },
    );
    expect(gated.statusCode).toBe(200);
    expect(gated.json().status).toBe('revisionSubmitted');
    const revision = await sql<{ option_kind: string | null; state: string }>`
      SELECT option_kind, state FROM program_revision
      WHERE program_id = ${f.programId} AND option_kind = 'membership'`.execute(testDb.db);
    expect(revision.rows[0]).toEqual({ option_kind: 'membership', state: 'submitted' });
  });
});

describe('authorization — product capability, never attendance authority', () => {
  const terms = FINITE_MEMBERSHIP_TERMS;

  it('org A cannot read or configure org B options (not-found-shaped)', async () => {
    const orgB = await createBookingFixture(testDb.db);
    await publishProgram(orgB);
    const optionB = await createPriceOption(orgB, {
      kind: 'membership',
      amountFils: 20000,
    });
    const url = `${BASE()}/programs/${orgB.programId}/price-options/${optionB}/fulfillment`;
    expect((await inject('GET', url, ownerBearer)).statusCode).toBe(404);
    expect((await inject('PUT', url, ownerBearer, terms)).statusCode).toBe(404);
  });

  it('front desk and coach hold attendance authority but CANNOT edit product fulfillment (403 at the capability gate)', async () => {
    const url = `${BASE()}/programs/${f.programId}/price-options/${membershipOption}/fulfillment`;
    for (const role of ['front_desk', 'coach'] as const) {
      const bearer = await staffBearer(role, f.org.orgId, role === 'front_desk' ? [f.org.branchIds[0]!] : undefined);
      expect((await inject('PUT', url, bearer, terms)).statusCode).toBe(403);
    }
    // listings_editor holds the certified product capability and may edit.
    const editor = await staffBearer('listings_editor');
    expect((await inject('PUT', url, editor, terms)).statusCode).toBe(200);
  });

  it('customer and unauthenticated bearers cannot use the provider mutation', async () => {
    const url = `${BASE()}/programs/${f.programId}/price-options/${membershipOption}/fulfillment`;
    const userId = await createUser(testDb.db);
    await createSelfParticipant(testDb.db, await createAccount(testDb.db, userId));
    const { bearer: customerBearer } = await bearerForUser(ctx, userId);
    expect([403, 404]).toContain((await inject('PUT', url, customerBearer, terms)).statusCode);
    expect((await inject('PUT', url, null, terms)).statusCode).toBe(401);
  });
});
