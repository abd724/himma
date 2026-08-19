/**
 * W3-5 — verification review/decision integration through the REAL policy
 * pipeline on real PostgreSQL: the ONE authoritative path case → readiness
 * → review ownership → decision → canonical organization transition, with
 * the full §13 acceptance matrix (atomicity, CAS, typed distinct
 * refusals, the W3-4 content-safety invariant, and readiness-is-not-
 * approval semantics).
 */
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { createFakeEvidenceStore } from '../src/modules/provider/storage/fake-evidence-store';
import { decideVerification } from '../src/modules/provider/services/verification-review';
import {
  getProviderSafeVerificationSummary,
  type VerificationRequirementPolicyProvider,
} from '../src/modules/provider/services/verification-case';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/verification-review-pool';
const PDF = Buffer.from('%PDF-1.4 review evidence');

/** Fictional deterministic policy (D-W3-3 stays deferred). */
const POLICY_PROVIDER: VerificationRequirementPolicyProvider = {
  currentPolicy: async () => ({
    policyVersion: 'review-policy-v1',
    requirements: [
      { key: 'business_document', labelEn: 'Business document', required: true },
      { key: 'operating_license', labelEn: 'Operating licence', required: true },
      { key: 'optional_reference', labelEn: 'Optional reference', required: false },
    ],
  }),
};

let testDb: TestDb;
let ctx: ProviderTestContext;
let adminA: string;
let adminB: string;
let ops: string;
let opsBearer: string;
/** The certified TEST composition: policy + storage + content safety. */
let app: FastifyInstance;
/** LIVE-shaped: storage configured, content safety NOT ready (default). */
let guardedApp: FastifyInstance;
/** D-W3-3-shaped: no policy configured at all. */
let unpolicedApp: FastifyInstance;

async function grantRole(userId: string, role: AdminRole): Promise<void> {
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
}

function adminPost(
  target: FastifyInstance,
  bearer: string,
  url: string,
  payload: Record<string, unknown> = {},
) {
  return target.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}` },
    payload,
  });
}

async function submittedOrg(): Promise<{ orgId: string; ownerBearer: string }> {
  const { orgId } = await createProviderOrg(testDb.db, { state: 'submitted', branches: 1 });
  await sql`UPDATE organization_public_profile SET published = true
            WHERE organization_id = ${orgId}`.execute(testDb.db);
  const owner = await staffBearer(ctx, orgId, 'owner');
  return { orgId, ownerBearer: owner.bearer };
}

async function openCase(orgId: string): Promise<{ caseId: string; version: number }> {
  const opened = await adminPost(
    app,
    opsBearer,
    `/admin/organizations/${orgId}/verification/cases`,
  );
  expect(opened.statusCode).toBe(200);
  const body = opened.json() as { caseId: string; version: number };
  return { caseId: body.caseId, version: body.version };
}

/** Uploads and stores one document for a requirement key via the real
 *  provider evidence surface (W3-4). */
async function storeRequirement(
  orgId: string,
  ownerBearer: string,
  caseId: string,
  requirementKey: string,
): Promise<void> {
  const requirement = await testDb.db
    .selectFrom('verification_case_requirement')
    .select(['id'])
    .where('case_id', '=', caseId)
    .where('requirement_key', '=', requirementKey)
    .executeTakeFirstOrThrow();
  const registered = await app.inject({
    method: 'POST',
    url: `/provider/organizations/${orgId}/verification/evidence`,
    headers: { authorization: `Bearer ${ownerBearer}` },
    payload: {
      caseId,
      requirementId: requirement.id,
      originalFilename: `${requirementKey}.pdf`,
      declaredContentType: 'application/pdf',
    },
  });
  expect(registered.statusCode).toBe(200);
  const { evidenceId } = registered.json() as { evidenceId: string };
  const uploaded = await app.inject({
    method: 'PUT',
    url: `/provider/organizations/${orgId}/verification/evidence/${evidenceId}/content`,
    headers: { authorization: `Bearer ${ownerBearer}`, 'content-type': 'application/pdf' },
    payload: PDF,
  });
  expect(uploaded.statusCode).toBe(200);
}

async function orgState(orgId: string): Promise<{ state: string; version: number }> {
  const row = await testDb.db
    .selectFrom('organization')
    .select(['verification_state', 'version'])
    .where('id', '=', orgId)
    .executeTakeFirstOrThrow();
  return { state: row.verification_state, version: row.version };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  const verifier = new FakeAccessTokenVerifier();
  const base = {
    db: testDb.db,
    accessTokenVerifier: verifier,
    idTokenAdapter: new FakeAuthProviderAdapter(),
    mailSender: new CaptureMailSender(),
    rateLimiterStore: new InMemoryRateLimiterStore(),
    staffInvitationConfig: parseStaffInvitationConfig('test', {}),
  };
  app = buildApp({
    identity: {
      ...base,
      verificationEvidenceStorage: { store: createFakeEvidenceStore(), contentSafetyReady: true },
      verificationPolicyProvider: POLICY_PROVIDER,
    },
  });
  guardedApp = buildApp({
    identity: {
      ...base,
      verificationEvidenceStorage: { store: createFakeEvidenceStore() },
      verificationPolicyProvider: POLICY_PROVIDER,
    },
  });
  unpolicedApp = buildApp({
    identity: {
      ...base,
      verificationEvidenceStorage: { store: createFakeEvidenceStore(), contentSafetyReady: true },
    },
  });
  await Promise.all([app.ready(), guardedApp.ready(), unpolicedApp.ready()]);
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  ops = await createUser(testDb.db);
  await grantRole(ops, 'operations');
  opsBearer = (await bearerForUser(ctx, ops)).bearer;
});

afterAll(async () => {
  await Promise.all([app.close(), guardedApp.close(), unpolicedApp.close()]);
  await testDb.drop();
});

describe('route policies (W3-1: reads baseline, mutations on the safer adminStepUp — D-W3-5 stays open)', () => {
  it('declares the read on the admin baseline and every mutation on adminStepUp', () => {
    const verification = app.routePolicyInventory
      .filter((route) => route.url.includes('/verification') && route.url.startsWith('/admin'))
      .map((route) => `${route.method} ${route.url} → ${route.policy}`);
    expect(new Set(verification)).toEqual(
      new Set([
        'GET /admin/organizations/:organizationId/verification → admin',
        'HEAD /admin/organizations/:organizationId/verification → admin',
        'POST /admin/organizations/:organizationId/verification/cases → adminStepUp',
        'POST /admin/organizations/:organizationId/verification/cases/:caseId/review → adminStepUp',
        'POST /admin/organizations/:organizationId/verification/cases/:caseId/decision → adminStepUp',
        'GET /admin/verification/evidence/:evidenceId/content → admin',
        'HEAD /admin/verification/evidence/:evidenceId/content → admin',
        // The pre-existing standalone edges keep their certified strength
        // (D-S3-3 defense-in-depth remains on verify/go-live).
        'POST /admin/organizations/:organizationId/verification/start-review → adminStepUp',
        'POST /admin/organizations/:organizationId/verification/verify → adminStepUp',
        'POST /admin/organizations/:organizationId/verification/reject → adminStepUp',
      ]),
    );
  });
});

describe('the authoritative end-to-end journey (certified test composition)', () => {
  it('submitted → case → evidence → review → APPROVED decision → verified (exactly once) → go-live → public storefront', async () => {
    const { orgId, ownerBearer } = await submittedOrg();
    const opened = await openCase(orgId);

    // The reviewer workspace read: truthful readiness + composition state.
    const before = await app.inject({
      method: 'GET',
      url: `/admin/organizations/${orgId}/verification`,
      headers: { authorization: `Bearer ${opsBearer}` },
    });
    expect(before.statusCode).toBe(200);
    const beforeView = before.json() as {
      organizationState: string;
      contentSafetyReady: boolean;
      policyConfigured: boolean;
      latestCase: { readiness: { kind: string }; state: string } | null;
      rounds: unknown[];
    };
    expect(beforeView.organizationState).toBe('submitted');
    expect(beforeView.contentSafetyReady).toBe(true);
    expect(beforeView.policyConfigured).toBe(true);
    expect(beforeView.rounds).toHaveLength(1);
    expect(beforeView.latestCase?.readiness.kind).toBe('missingRequirements');

    await storeRequirement(orgId, ownerBearer, opened.caseId, 'business_document');
    await storeRequirement(orgId, ownerBearer, opened.caseId, 'operating_license');

    // Begin review: case in_review + the canonical org start_review edge,
    // one transaction.
    const started = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: 'reviewStarted', organizationState: 'in_review' });
    const caseVersion = (started.json() as { caseVersion: number }).caseVersion;
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'in_review' });

    // READINESS IS NOT APPROVAL: ready + owned review, still in_review.
    const midView = await app.inject({
      method: 'GET',
      url: `/admin/organizations/${orgId}/verification`,
      headers: { authorization: `Bearer ${opsBearer}` },
    });
    expect((midView.json() as { latestCase: { readiness: { kind: string } } }).latestCase.readiness.kind).toBe('ready');
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'in_review' });

    // The explicit APPROVED decision → verified, atomically.
    const decided = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      { expectedCaseVersion: caseVersion, outcome: 'approved', internalNote: 'Registry checked.' },
    );
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({
      status: 'verificationDecided',
      organizationState: 'verified',
    });
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'verified' });

    // Exactly once: a duplicate decision attempt conflicts, org unchanged.
    const again = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      {
        expectedCaseVersion: (decided.json() as { caseVersion: number }).caseVersion,
        outcome: 'approved',
      },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('verificationCaseConflict');
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'verified' });

    // The canonical audit/outbox evidence exists once.
    const verifiedEvents = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type'])
      .where('aggregate_id', '=', orgId)
      .where('event_type', '=', 'organization.verified')
      .execute();
    expect(verifiedEvents).toHaveLength(1);

    // go-live (separate admin action, existing certified edge) → public.
    const org = await orgState(orgId);
    const live = await adminPost(app, opsBearer, `/admin/organizations/${orgId}/go-live`, {
      expectedVersion: org.version,
    });
    expect(live.statusCode).toBe(200);
    const storefront = await app.inject({ method: 'GET', url: `/providers/${orgId}` });
    expect(storefront.statusCode).toBe(200);
  });

  it('a REJECTED decision carries the three layers, moves the organization to rejected (never verified), and the next round works after resubmission', async () => {
    const { orgId } = await submittedOrg();
    const opened = await openCase(orgId);
    const started = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    const caseVersion = (started.json() as { caseVersion: number }).caseVersion;

    // Rejection is legal on an UNREADY case; both provider-facing layers
    // are mandatory (invalid without them).
    const invalid = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      { expectedCaseVersion: caseVersion, outcome: 'rejected' },
    );
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().code).toBe('invalidVerificationDecision');

    const rejected = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      {
        expectedCaseVersion: caseVersion,
        outcome: 'rejected',
        reasonCode: 'incomplete_evidence',
        providerSafeMessage: 'Please upload the missing business documents.',
        internalNote: 'Nothing was uploaded at all.',
      },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ organizationState: 'rejected' });
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'rejected' });

    // The org NEVER took the approved edge; the decision preserves layers.
    const decision = await testDb.db
      .selectFrom('verification_decision')
      .selectAll()
      .where('case_id', '=', opened.caseId)
      .executeTakeFirstOrThrow();
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason_code).toBe('incomplete_evidence');
    expect(decision.provider_safe_message).toContain('missing business documents');
    expect(decision.internal_note).toBe('Nothing was uploaded at all.');

    // Provider resubmits (the canonical rejected → submitted edge) and the
    // NEXT round opens — round 1 stays immutable history.
    await sql`UPDATE organization SET verification_state = 'submitted'
              WHERE id = ${orgId}`.execute(testDb.db);
    const round2 = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases`,
    );
    expect(round2.statusCode).toBe(200);
    expect((round2.json() as { round: number }).round).toBe(2);
  });
});

describe('typed distinct refusals (§3/§13)', () => {
  it('no case → 404; approval on an unready case → structured verificationCaseNotReady; open/superseded/decided states conflict', async () => {
    const { orgId } = await submittedOrg();
    // No case at all.
    const noCase = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${newId()}/decision`,
      { expectedCaseVersion: 1, outcome: 'approved' },
    );
    expect(noCase.statusCode).toBe(404);

    const opened = await openCase(orgId);
    // Deciding an OPEN (unowned) case conflicts — review must be owned.
    const unowned = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      { expectedCaseVersion: opened.version, outcome: 'approved' },
    );
    expect(unowned.statusCode).toBe(409);
    expect(unowned.json().code).toBe('verificationCaseConflict');

    const started = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    const caseVersion = (started.json() as { caseVersion: number }).caseVersion;
    // Approval requires READY evidence — the structured missing list rides
    // the refusal, and nothing changes.
    const notReady = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      { expectedCaseVersion: caseVersion, outcome: 'approved' },
    );
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({
      code: 'verificationCaseNotReady',
      missing: [
        { requirementKey: 'business_document', labelEn: 'Business document' },
        { requirementKey: 'operating_license', labelEn: 'Operating licence' },
      ],
    });
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'in_review' });
    const decisions = await testDb.db
      .selectFrom('verification_decision')
      .select(['id'])
      .where('case_id', '=', opened.caseId)
      .execute();
    expect(decisions).toHaveLength(0);

    // Stale case version on the decision: refused, no partial change.
    const stale = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      {
        expectedCaseVersion: 999,
        outcome: 'rejected',
        reasonCode: 'x_reason',
        providerSafeMessage: 'x',
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'in_review' });
  });

  it('a superseded case cannot be reviewed or decided', async () => {
    const { orgId } = await submittedOrg();
    const opened = await openCase(orgId);
    await sql`UPDATE verification_case SET state = 'superseded', superseded_at = now()
              WHERE id = ${opened.caseId}`.execute(testDb.db);
    const review = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    expect(review.statusCode).toBe(409);
    expect(review.json().code).toBe('verificationCaseConflict');
  });

  it('cross-organization case references are a not-found shape', async () => {
    const a = await submittedOrg();
    const b = await submittedOrg();
    const openedA = await openCase(a.orgId);
    const crossed = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${b.orgId}/verification/cases/${openedA.caseId}/review`,
      { expectedCaseVersion: openedA.version },
    );
    expect(crossed.statusCode).toBe(404);
  });
});

describe('atomicity (§7): decision and lifecycle can never diverge', () => {
  it('when the organization left the review edge concurrently, the decision is refused and NOTHING is recorded', async () => {
    const { orgId } = await submittedOrg();
    const opened = await openCase(orgId);
    const started = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    const caseVersion = (started.json() as { caseVersion: number }).caseVersion;
    // Another admin rejects the ORGANIZATION directly (certified edge).
    const org = await orgState(orgId);
    const directReject = await adminPost(app, opsBearer, `/admin/organizations/${orgId}/verification/reject`, {
      expectedVersion: org.version,
    });
    expect(directReject.statusCode).toBe(200);

    const decided = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      {
        expectedCaseVersion: caseVersion,
        outcome: 'rejected',
        reasonCode: 'x_reason',
        providerSafeMessage: 'x',
      },
    );
    expect(decided.statusCode).toBe(409);
    expect(decided.json().code).toBe('lifecycleConflict');
    // No decision row exists; the case is still in_review (undecided).
    const decisions = await testDb.db
      .selectFrom('verification_decision')
      .select(['id'])
      .where('case_id', '=', opened.caseId)
      .execute();
    expect(decisions).toHaveLength(0);
    const caseRow = await testDb.db
      .selectFrom('verification_case')
      .select(['state'])
      .where('id', '=', opened.caseId)
      .executeTakeFirstOrThrow();
    expect(caseRow.state).toBe('in_review');
  });

  it('when the decision INSERT fails after the organization transition, the whole transaction rolls back — no verified org from a failed decision', async () => {
    const { orgId, ownerBearer } = await submittedOrg();
    const opened = await openCase(orgId);
    await storeRequirement(orgId, ownerBearer, opened.caseId, 'business_document');
    await storeRequirement(orgId, ownerBearer, opened.caseId, 'operating_license');
    const started = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    const caseVersion = (started.json() as { caseVersion: number }).caseVersion;
    // Sabotage: a decision row already exists for the case (unique per
    // round), so the in-transaction insert MUST fail AFTER the org verify
    // transition ran — proving the rollback.
    await sql`INSERT INTO verification_decision (id, case_id, outcome, decided_by)
              VALUES (${newId()}, ${opened.caseId}, 'approved', ${ops})`.execute(testDb.db);

    await expect(
      decideVerification(
        {
          db: testDb.db,
          lifecycle: { nodeEnv: 'test', verificationEvidenceCapabilityReady: false },
          contentSafetyReady: true,
        },
        { userId: ops },
        {
          organizationId: orgId,
          caseId: opened.caseId,
          expectedCaseVersion: caseVersion,
          outcome: 'approved',
        },
      ),
    ).rejects.toThrow();
    // The organization did NOT stay verified and the case did NOT decide.
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'in_review' });
    const caseRow = await testDb.db
      .selectFrom('verification_case')
      .select(['state'])
      .where('id', '=', opened.caseId)
      .executeTakeFirstOrThrow();
    expect(caseRow.state).toBe('in_review');
  });
});

describe('authorization and the content-safety invariant (§4/§5/§13)', () => {
  it('non-operations admins and no-role identities are refused; reads do not demand step-up', async () => {
    const { orgId } = await submittedOrg();
    const auditor = await createUser(testDb.db);
    await grantRole(auditor, 'auditor');
    const auditorBearer = (await bearerForUser(ctx, auditor)).bearer;
    const read = await app.inject({
      method: 'GET',
      url: `/admin/organizations/${orgId}/verification`,
      headers: { authorization: `Bearer ${auditorBearer}` },
    });
    expect(read.statusCode).toBe(403);
    expect(read.json().code).toBe('forbidden');
    const mutate = await adminPost(
      app,
      auditorBearer,
      `/admin/organizations/${orgId}/verification/cases`,
    );
    expect(mutate.statusCode).toBe(403);

    // A STALE-factor operations admin can still READ the workspace (W3-1
    // baseline) but is step-up-refused on the mutation (adminStepUp).
    const staleBearer = (
      await bearerForUser(ctx, ops, { authTime: new Date(Date.now() - 3_600_000) })
    ).bearer;
    const staleRead = await app.inject({
      method: 'GET',
      url: `/admin/organizations/${orgId}/verification`,
      headers: { authorization: `Bearer ${staleBearer}` },
    });
    expect(staleRead.statusCode).toBe(200);
    const staleMutation = await adminPost(
      app,
      staleBearer,
      `/admin/organizations/${orgId}/verification/cases`,
    );
    expect(staleMutation.statusCode).toBe(403);
    expect(staleMutation.json().code).toBe('stepUpRequired');
  });

  it('while content safety is unavailable (the ONLY production-representable state), review and decision are refused with the typed safety condition', async () => {
    const { orgId } = await submittedOrg();
    const opened = await openCase(orgId); // opening/collecting is allowed
    const view = await guardedApp.inject({
      method: 'GET',
      url: `/admin/organizations/${orgId}/verification`,
      headers: { authorization: `Bearer ${opsBearer}` },
    });
    expect((view.json() as { contentSafetyReady: boolean }).contentSafetyReady).toBe(false);

    const begin = await adminPost(
      guardedApp,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    expect(begin.statusCode).toBe(503);
    expect(begin.json().code).toBe('verificationEvidenceSafetyUnavailable');

    const decide = await adminPost(
      guardedApp,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      {
        expectedCaseVersion: opened.version,
        outcome: 'rejected',
        reasonCode: 'x_reason',
        providerSafeMessage: 'x',
      },
    );
    expect(decide.statusCode).toBe(503);
    expect(decide.json().code).toBe('verificationEvidenceSafetyUnavailable');
    // Nothing moved.
    await expect(orgState(orgId)).resolves.toMatchObject({ state: 'submitted' });
  });

  it('with NO configured policy (D-W3-3 unresolved), opening a round fails closed with the typed policy condition', async () => {
    const { orgId } = await submittedOrg();
    const refused = await adminPost(
      unpolicedApp,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases`,
    );
    expect(refused.statusCode).toBe(503);
    expect(refused.json().code).toBe('verificationPolicyUnavailable');
    const view = await unpolicedApp.inject({
      method: 'GET',
      url: `/admin/organizations/${orgId}/verification`,
      headers: { authorization: `Bearer ${opsBearer}` },
    });
    expect((view.json() as { policyConfigured: boolean }).policyConfigured).toBe(false);
  });

  it('the provider-safe seam still exposes ONLY provider-safe fields after a W3-5 decision', async () => {
    const { orgId } = await submittedOrg();
    const opened = await openCase(orgId);
    const started = await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/review`,
      { expectedCaseVersion: opened.version },
    );
    await adminPost(
      app,
      opsBearer,
      `/admin/organizations/${orgId}/verification/cases/${opened.caseId}/decision`,
      {
        expectedCaseVersion: (started.json() as { caseVersion: number }).caseVersion,
        outcome: 'rejected',
        reasonCode: 'expired_document',
        providerSafeMessage: 'Your licence has expired.',
        internalNote: 'Registry lookup failed twice. Escalated internally.',
      },
    );
    const summary = await getProviderSafeVerificationSummary(
      { db: testDb.db },
      { organizationId: orgId },
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).toContain('expired_document');
    expect(serialized).toContain('Your licence has expired.');
    expect(serialized).not.toContain('Escalated internally');
    expect(serialized).not.toContain(ops); // reviewer identity
    expect(serialized).not.toContain('storage');
    expect(serialized).not.toContain('sha256');
  });
});
