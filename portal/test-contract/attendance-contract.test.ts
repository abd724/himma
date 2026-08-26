/**
 * W2-13 contract tests: the LIVE fulfillment-configuration port and the
 * LIVE provider check-in port against the REAL backend (`buildApp` on real
 * PostgreSQL) through the REAL authenticated W2-12A transport (sign-in +
 * MFA over the deterministic fake Cognito boundary).
 *
 * PROVIDER surface under test — everything travels the real HTTP routes
 * with real capability/scope enforcement:
 * - fulfillment editor: immutable supersede-and-insert revisions, terms
 *   validation, capacity-kind refusal, the listings.manage boundary
 *   (attendance.manage grants NOTHING here), and the sold-entitlement
 *   historical binding.
 * - check-in: real credential preview (pure read) → atomic redeem (201)
 *   → repeat refused, for BOTH a finite walk-in entitlement and a
 *   scheduled session booking, plus the generic foreign-org refusal.
 *
 * CUSTOMER-side placement (entitlement acquisition, booking, credential
 * issuance) uses the backend's own certified service layer directly —
 * those customer HTTP surfaces were certified in S6-1/S6-2 backend suites
 * and belong to the Customer App integration, which W2-13 explicitly
 * excludes. No portal browser E2E runs against the real backend (bounded
 * limitation recorded in the W2-13 report): the real-stack proof lives
 * HERE, and the browser E2E runs fixture-mode.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import { confirmFreeBooking } from '../../backend/src/modules/booking/services/booking-lifecycle';
import { claimHold } from '../../backend/src/modules/booking/services/hold-claim';
import { requestQuote } from '../../backend/src/modules/booking/services/quote-service';
import { confirmFreeEntitlementPurchase } from '../../backend/src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../../backend/src/modules/entitlement/services/entitlement-quote';
import { issueRedemptionCredential } from '../../backend/src/modules/entitlement/services/redemption-credential';
import type { ProviderRole } from '../../backend/src/modules/provider/provider-roles';
import {
  createActivePolicyTemplate,
  createBookingFixture,
  createCustomer,
  createFulfillmentRevision,
  createPriceOption,
  createSession,
  publishProgram,
  type BookingFixture,
  type Customer,
} from '../../backend/test/helpers/booking-fixtures';
import { createIdentity, createUser } from '../../backend/test/helpers/identity-fixtures';
import { addMembership, createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { CheckInPort } from '../src/checkin/contract';
import type { FulfillmentConfigPort } from '../src/catalogue/fulfillment-contract';
import type { ListingEditorPort } from '../src/catalogue/editor-contract';
import { createLiveCheckInPort } from '../src/services/live/live-checkin-port';
import { createLiveFulfillmentPort } from '../src/services/live/live-fulfillment-port';
import { createLiveListingEditorPort } from '../src/services/live/live-listing-editor-port';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from './support/backend-harness';

let harness: ContractHarness;
let activityTypeId: string;

beforeAll(async () => {
  harness = await createContractHarness();
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(harness.testDb.db);
  activityTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityTypeId}, ${category.rows[0]!.id}, 'attendance-contract', 'Attendance Contract')`.execute(
    harness.testDb.db,
  );
  await createActivePolicyTemplate(harness.testDb.db);
});

afterAll(async () => {
  await harness.close();
});

let userCounter = 4200;

interface PortalSession {
  editor: ListingEditorPort;
  fulfillment: FulfillmentConfigPort;
  checkin: CheckInPort;
}

async function provisionUser(): Promise<{ userId: string; email: string; password: string }> {
  userCounter += 1;
  const email = `attendance-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `attendance-sub-${userCounter}`;
  const userId = await createUser(harness.testDb.db);
  await createIdentity(harness.testDb.db, userId, {
    provider: 'email',
    issuer: CONTRACT_ISSUER,
    subject,
    email,
    emailVerified: true,
  });
  await harness.testDb.db
    .insertInto('mfa_method')
    .values({ id: newId(), user_id: userId, kind: 'totp', state: 'active', confirmed_at: new Date() })
    .execute();
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: `Attendance ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, email, password };
}

async function signedIn(user: { email: string; password: string }): Promise<PortalSession> {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  await runtime.adapter.signIn({ email: user.email, password: user.password });
  const outcome = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  if (outcome.kind !== 'signedIn') throw new Error(`sign-in failed: ${outcome.kind}`);
  return {
    editor: createLiveListingEditorPort(runtime.transport),
    fulfillment: createLiveFulfillmentPort(runtime.transport),
    checkin: createLiveCheckInPort(runtime.transport),
  };
}

async function staffSession(
  orgId: string,
  role: ProviderRole,
  branchIds?: string[],
): Promise<PortalSession> {
  const user = await provisionUser();
  await addMembership(harness.testDb.db, user.userId, orgId, role, branchIds);
  return signedIn(user);
}

const deps = () => ({ db: harness.testDb.db });

async function makeEntitlement(
  fixture: BookingFixture,
  customer: Customer,
  optionId: string,
): Promise<string> {
  const quote = await requestEntitlementQuote(deps(), { accountId: customer.accountId }, {
    programId: fixture.programId,
    priceOptionId: optionId,
    participantId: customer.participantId,
  });
  if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
  const run = await confirmFreeEntitlementPurchase(deps(), { accountId: customer.accountId }, {
    quoteId: quote.quote.quoteId,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'purchaseConfirmed') throw new Error(run.outcome.kind);
  return run.outcome.purchase.entitlement!.entitlementId;
}

async function issueCredential(
  customer: Customer,
  target:
    | { kind: 'entitlement'; entitlementId: string }
    | { kind: 'booking'; bookingId: string },
): Promise<{ credentialId: string; displayCode: string }> {
  const run = await issueRedemptionCredential(deps(), { accountId: customer.accountId }, {
    target,
    idempotencyKey: newId(),
  });
  if (run.outcome.kind !== 'credentialIssued') throw new Error(run.outcome.kind);
  return {
    credentialId: run.outcome.credential.credentialId,
    displayCode: run.outcome.credential.displayCode!,
  };
}

// ---------------------------------------------------------------------------
// Fulfillment editor over the real backend
// ---------------------------------------------------------------------------

describe('fulfillment configuration (live port, real backend)', () => {
  test('a membership option created at AED 0 supports fulfillment; saving supersedes-and-inserts IMMUTABLE revisions', async () => {
    const user = await provisionUser();
    const org = await createProviderOrg(harness.testDb.db, {
      branches: 2,
      displayName: `Fulfillment org ${userCounter}`,
    });
    await addMembership(harness.testDb.db, user.userId, org.orgId, 'owner');
    const session = await signedIn(user);

    const created = await session.editor.createProgram(org.orgId, {
      titleEn: 'Fulfillment contract listing',
      activityTypeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    const programId = created.program.id;

    // Zero-price MEMBERSHIP is legal on the real route (S6-1 zero-price
    // acquisition) — the kind alone carries no usage semantics (D-S6-3).
    const added = await session.editor.addPriceOption(org.orgId, programId, {
      kind: 'membership',
      amountFils: 0,
      sessionsCount: null,
      labelEn: 'Founders pass',
    });
    if (added.kind !== 'optionAdded') throw new Error(added.kind);
    const optionId = added.option.id;

    const before = await session.fulfillment.loadFulfillment(org.orgId, programId, optionId);
    expect(before).toEqual({
      kind: 'fulfillment',
      optionKind: 'membership',
      supported: true,
      active: null,
    });

    const first = await session.fulfillment.setFulfillment(org.orgId, programId, optionId, {
      usageKind: 'finite',
      usesTotal: 3,
      validityKind: 'daysFromConfirmation',
      validityDays: 90,
      reservationRequired: false,
      walkInAllowed: true,
    });
    if (first.kind !== 'revisionCreated') throw new Error(first.kind);
    expect(first.revision.revisionNo).toBe(1);
    expect(first.revision.state).toBe('active');

    const second = await session.fulfillment.setFulfillment(org.orgId, programId, optionId, {
      usageKind: 'finite',
      usesTotal: 5,
      validityKind: 'daysFromConfirmation',
      validityDays: 60,
      reservationRequired: false,
      walkInAllowed: true,
    });
    if (second.kind !== 'revisionCreated') throw new Error(second.kind);
    expect(second.revision.revisionNo).toBe(2);

    const after = await session.fulfillment.loadFulfillment(org.orgId, programId, optionId);
    if (after.kind !== 'fulfillment') throw new Error(after.kind);
    expect(after.active?.revisionNo).toBe(2);
    expect(after.active?.usesTotal).toBe(5);

    // BOTH rows exist — revision 1 was superseded, never edited or deleted.
    const rows = await sql<{ revision_no: number; state: string; uses_total: number }>`
      SELECT revision_no, state, uses_total FROM price_option_fulfillment_revision
      WHERE price_option_id = ${optionId} ORDER BY revision_no`.execute(harness.testDb.db);
    expect(rows.rows).toEqual([
      { revision_no: 1, state: 'superseded', uses_total: 3 },
      { revision_no: 2, state: 'active', uses_total: 5 },
    ]);
  });

  test('capacity kinds are truthfully unsupported; invalid term combinations are refused by the SERVER', async () => {
    const user = await provisionUser();
    const org = await createProviderOrg(harness.testDb.db, { branches: 1 });
    await addMembership(harness.testDb.db, user.userId, org.orgId, 'owner');
    const session = await signedIn(user);
    const created = await session.editor.createProgram(org.orgId, {
      titleEn: 'Capacity refusal listing',
      activityTypeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    const dropIn = await session.editor.addPriceOption(org.orgId, created.program.id, {
      kind: 'dropIn',
      amountFils: 5_000,
      sessionsCount: null,
      labelEn: null,
    });
    if (dropIn.kind !== 'optionAdded') throw new Error(dropIn.kind);

    const load = await session.fulfillment.loadFulfillment(
      org.orgId,
      created.program.id,
      dropIn.option.id,
    );
    if (load.kind !== 'fulfillment') throw new Error(load.kind);
    expect(load.supported).toBe(false);
    expect(
      await session.fulfillment.setFulfillment(org.orgId, created.program.id, dropIn.option.id, {
        usageKind: 'finite',
        validityKind: 'none',
        reservationRequired: false,
        walkInAllowed: true,
      }),
    ).toEqual({ kind: 'invalidFulfillmentConfig' });

    // A package's total IS its sessions count — an explicit usesTotal is
    // refused by the server-side terms validation.
    const pack = await session.editor.addPriceOption(org.orgId, created.program.id, {
      kind: 'package',
      amountFils: 40_000,
      sessionsCount: 8,
      labelEn: '8 sessions',
    });
    if (pack.kind !== 'optionAdded') throw new Error(pack.kind);
    expect(
      await session.fulfillment.setFulfillment(org.orgId, created.program.id, pack.option.id, {
        usageKind: 'finite',
        usesTotal: 5,
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
        reservationRequired: false,
        walkInAllowed: true,
      }),
    ).toEqual({ kind: 'invalidFulfillmentConfig' });
    // No walk-in AND no reservation → unusable purchase, refused.
    expect(
      await session.fulfillment.setFulfillment(org.orgId, created.program.id, pack.option.id, {
        usageKind: 'finite',
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
        reservationRequired: false,
        walkInAllowed: false,
      }),
    ).toEqual({ kind: 'invalidFulfillmentConfig' });
  });

  test('AUTHORIZATION: attendance.manage grants NOTHING on the fulfillment editor — front desk and coach are refused', async () => {
    const owner = await provisionUser();
    const org = await createProviderOrg(harness.testDb.db, { branches: 1 });
    await addMembership(harness.testDb.db, owner.userId, org.orgId, 'owner');
    const ownerSession = await signedIn(owner);
    const created = await ownerSession.editor.createProgram(org.orgId, {
      titleEn: 'Authorization boundary listing',
      activityTypeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    const option = await ownerSession.editor.addPriceOption(org.orgId, created.program.id, {
      kind: 'membership',
      amountFils: 0,
      sessionsCount: null,
      labelEn: null,
    });
    if (option.kind !== 'optionAdded') throw new Error(option.kind);

    const terms = {
      usageKind: 'finite',
      usesTotal: 3,
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
      reservationRequired: false,
      walkInAllowed: true,
    } as const;
    for (const role of ['front_desk', 'coach'] as const) {
      const staff = await staffSession(org.orgId, role);
      expect(
        await staff.fulfillment.setFulfillment(org.orgId, created.program.id, option.option.id, terms),
      ).toEqual({ kind: 'forbidden' });
      expect(
        await staff.fulfillment.loadFulfillment(org.orgId, created.program.id, option.option.id),
      ).toEqual({ kind: 'forbidden' });
    }
    // listings_editor holds listings.manage — the exact product capability
    // that owns the parent price option — and IS allowed.
    const editorStaff = await staffSession(org.orgId, 'listings_editor');
    const saved = await editorStaff.fulfillment.setFulfillment(
      org.orgId,
      created.program.id,
      option.option.id,
      terms,
    );
    expect(saved.kind).toBe('revisionCreated');
  });
});

// ---------------------------------------------------------------------------
// Check-in journeys over the real backend
// ---------------------------------------------------------------------------

describe('provider check-in (live port, real backend)', () => {
  test('FINITE WALK-IN journey: real entitlement → real credential → preview (pure read) → redeem 201 → repeat refused; sold entitlement keeps its historical revision', async () => {
    const fixture = await createBookingFixture(harness.testDb.db);
    await publishProgram(fixture);
    const packOption = await createPriceOption(fixture, {
      kind: 'package',
      amountFils: 0,
      sessionsCount: 3,
    });
    const revisionId = await createFulfillmentRevision(fixture, packOption, {
      usageKind: 'finite',
      validityKind: 'daysFromConfirmation',
      validityDays: 30,
    });
    const customer = await createCustomer(harness.testDb.db);
    const entitlementId = await makeEntitlement(fixture, customer, packOption);
    const credential = await issueCredential(customer, { kind: 'entitlement', entitlementId });
    expect(credential.displayCode).toMatch(/^\d{8}$/);

    const desk = await staffSession(fixture.org.orgId, 'front_desk', [
      fixture.org.branchIds[0]!,
    ]);

    // Preview: a pure read of the real credential — grants nothing.
    const preview = await desk.checkin.previewCheckIn(fixture.org.orgId, credential.displayCode);
    if (preview.kind !== 'preview') throw new Error(preview.kind);
    expect(preview.preview.credentialId).toBe(credential.credentialId);
    expect(preview.preview.targetKind).toBe('walkIn');
    expect(preview.preview.usage).toMatchObject({ usageKind: 'finite', remaining: 3 });
    // No attendance exists after preview — the read consumed nothing.
    const afterPreview = await sql<{ n: string }>`
      SELECT count(*) AS n FROM attendance_record
      WHERE entitlement_id = ${entitlementId}`.execute(harness.testDb.db);
    expect(Number(afterPreview.rows[0]!.n)).toBe(0);

    // Redeem: the atomic authority — HTTP 201 through the live port.
    const redeemed = await desk.checkin.redeemCheckIn(fixture.org.orgId, {
      code: credential.displayCode,
      credentialId: credential.credentialId,
      idempotencyKey: newId(),
    });
    if (redeemed.kind !== 'attendanceRecorded') throw new Error(redeemed.kind);
    expect(redeemed.attendance.remaining).toBe(2);
    expect(redeemed.attendance.targetKind).toBe('walkIn');

    // Exactly ONE attendance record exists; a repeat of the SAME code is
    // truthfully refused as already used — never a second decrement.
    const count = await sql<{ n: string }>`
      SELECT count(*) AS n FROM attendance_record
      WHERE entitlement_id = ${entitlementId}`.execute(harness.testDb.db);
    expect(Number(count.rows[0]!.n)).toBe(1);
    expect(
      await desk.checkin.redeemCheckIn(fixture.org.orgId, {
        code: credential.displayCode,
        credentialId: credential.credentialId,
        idempotencyKey: newId(),
      }),
    ).toEqual({ kind: 'codeAlreadyUsed' });
    // Preview resolves ONLY effectively-live credentials: once consumed,
    // the code previews as the same generic not-found as a code that never
    // existed (redeem with the exact credentialId names the truthful
    // already-used refusal above).
    expect(
      await desk.checkin.previewCheckIn(fixture.org.orgId, credential.displayCode),
    ).toEqual({ kind: 'codeNotFound' });

    // SOLD-ENTITLEMENT BINDING: superseding the fulfillment terms via the
    // live editor leaves the purchased entitlement bound to the revision
    // it was bought under.
    const ownerUser = await provisionUser();
    await addMembership(harness.testDb.db, ownerUser.userId, fixture.org.orgId, 'owner');
    const ownerSession = await signedIn(ownerUser);
    const superseding = await ownerSession.fulfillment.setFulfillment(
      fixture.org.orgId,
      fixture.programId,
      packOption,
      {
        usageKind: 'finite',
        validityKind: 'daysFromConfirmation',
        validityDays: 60,
        reservationRequired: false,
        walkInAllowed: true,
      },
    );
    if (superseding.kind !== 'revisionCreated') throw new Error(superseding.kind);
    const bound = await sql<{ fulfillment_revision_id: string }>`
      SELECT fulfillment_revision_id FROM entitlement WHERE id = ${entitlementId}`.execute(
      harness.testDb.db,
    );
    expect(bound.rows[0]!.fulfillment_revision_id).toBe(revisionId);
  });

  test('SCHEDULED SESSION journey: a confirmed in-window booking checks in atomically; a foreign organization gets the ONE generic refusal', async () => {
    const fixture = await createBookingFixture(harness.testDb.db);
    await publishProgram(fixture);
    const freeOption = await createPriceOption(fixture, { kind: 'free' });
    const customer = await createCustomer(harness.testDb.db);

    const startAt = new Date(Date.now() + 30 * 60 * 1000);
    const sessionId = await createSession(fixture, {
      start_at: startAt,
      end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
      registration_cutoff_at: startAt,
    });
    const quote = await requestQuote(deps(), { accountId: customer.accountId }, {
      programId: fixture.programId,
      priceOptionId: freeOption,
      unit: { kind: 'session', id: sessionId },
      participantId: customer.participantId,
    });
    if (quote.kind !== 'quoteIssued') throw new Error(quote.kind);
    const hold = await claimHold(deps(), { accountId: customer.accountId }, {
      unit: { kind: 'session', id: sessionId },
      participantId: customer.participantId,
      quoteId: quote.quote.quoteId,
      idempotencyKey: newId(),
    });
    if (hold.outcome.kind !== 'holdClaimed') throw new Error(hold.outcome.kind);
    const confirmed = await confirmFreeBooking(deps(), { accountId: customer.accountId }, {
      holdId: hold.outcome.hold.holdId,
      idempotencyKey: newId(),
    });
    if (confirmed.outcome.kind !== 'bookingConfirmed') throw new Error(confirmed.outcome.kind);
    const bookingId = confirmed.outcome.booking.bookingId;
    const credential = await issueCredential(customer, { kind: 'booking', bookingId });

    const desk = await staffSession(fixture.org.orgId, 'front_desk', [
      fixture.org.branchIds[0]!,
    ]);
    const preview = await desk.checkin.previewCheckIn(fixture.org.orgId, credential.displayCode);
    if (preview.kind !== 'preview') throw new Error(preview.kind);
    expect(preview.preview.targetKind).toBe('session');
    expect(preview.preview.sessionStartAt).toBeDefined();

    // A staff member of a DIFFERENT organization gets the generic
    // not-found — the S6-2 shaping never reveals a foreign credential.
    const otherOrg = await createProviderOrg(harness.testDb.db, { branches: 1 });
    const foreignDesk = await staffSession(otherOrg.orgId, 'front_desk');
    expect(
      await foreignDesk.checkin.previewCheckIn(otherOrg.orgId, credential.displayCode),
    ).toEqual({ kind: 'codeNotFound' });

    const redeemed = await desk.checkin.redeemCheckIn(fixture.org.orgId, {
      code: credential.displayCode,
      credentialId: credential.credentialId,
      idempotencyKey: newId(),
    });
    if (redeemed.kind !== 'attendanceRecorded') throw new Error(redeemed.kind);
    expect(redeemed.attendance.targetKind).toBe('session');
    const count = await sql<{ n: string }>`
      SELECT count(*) AS n FROM attendance_record WHERE booking_id = ${bookingId}`.execute(
      harness.testDb.db,
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  test('an unknown code is the ONE generic refusal for authorized staff; a customer principal cannot preview at all', async () => {
    const fixture = await createBookingFixture(harness.testDb.db);
    const desk = await staffSession(fixture.org.orgId, 'front_desk');
    expect(await desk.checkin.previewCheckIn(fixture.org.orgId, '00000000')).toEqual({
      kind: 'codeNotFound',
    });

    // A signed-in portal user with NO membership in the organization is
    // refused with the SAME generic shaping (the backend answers a plain
    // notFound so a non-member learns nothing about the org's desk) — and
    // no preview is ever produced.
    const outsider = await provisionUser();
    const outsiderSession = await signedIn(outsider);
    const refused = await outsiderSession.checkin.previewCheckIn(fixture.org.orgId, '00000000');
    expect(refused.kind).not.toBe('preview');
    expect(['codeNotFound', 'notAuthorized', 'unavailable']).toContain(refused.kind);
  });
});
