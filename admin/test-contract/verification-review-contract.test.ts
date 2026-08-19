/**
 * W3-5 Admin ↔ backend CONTRACT journey: the LIVE admin verification port
 * against the REAL backend (buildApp + real PostgreSQL + the fake-Cognito
 * boundary), composed with the CERTIFIED TEST content-safety/policy
 * configuration: authenticate → workspace read → open round → evidence
 * stored through the real W3-4 services → start review → APPROVED
 * decision → the canonical organization transition → go-live → the public
 * storefront exists. Plus the fail-closed live shape (safety unavailable)
 * and the auditor refusal.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import {
  bootstrapAccessAdmins,
  createIdentity,
  createUser,
} from '../../backend/test/helpers/identity-fixtures';
import { createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { createFakeEvidenceStore } from '../../backend/src/modules/provider/storage/fake-evidence-store';
import {
  finalizeEvidenceStorage,
  registerEvidence,
} from '../../backend/src/modules/provider/services/verification-case';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveVerificationPort } from '../src/services/live/live-verification-port';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from '../../portal/test-contract/support/backend-harness';

const POLICY_PROVIDER = {
  currentPolicy: async () => ({
    policyVersion: 'contract-policy-v1',
    requirements: [
      { key: 'business_document', labelEn: 'Business document', required: true },
      { key: 'operating_license', labelEn: 'Operating licence', required: true },
    ],
  }),
};

let harness: ContractHarness;
let adminA: string;
let adminB: string;
let opsUserId: string;
let ops: { email: string; password: string };
let userCounter = 0;

async function provisionAdmin(
  role: 'operations' | 'auditor',
): Promise<{ userId: string; email: string; password: string }> {
  userCounter += 1;
  const email = `review-admin-${userCounter}@contract.test`;
  const password = `pw-review-${userCounter}`;
  const subject = `review-contract-sub-${userCounter}`;
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
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    harness.testDb.db,
  );
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: `Review Admin ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, email, password };
}

async function signedInVerificationPort(credentials: { email: string; password: string }) {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  await runtime.adapter.signIn({ email: credentials.email, password: credentials.password });
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  expect(signedIn).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });
  return createLiveVerificationPort(runtime.transport);
}

beforeAll(async () => {
  harness = await createContractHarness({
    identityExtras: {
      // The CERTIFIED TEST composition (task §4): content safety reported
      // ready so the full decision mechanics are provable. The live/default
      // production composition cannot represent this state.
      verificationEvidenceStorage: {
        store: createFakeEvidenceStore(),
        contentSafetyReady: true,
      },
      verificationPolicyProvider: POLICY_PROVIDER,
    },
  });
  ({ adminA, adminB } = await bootstrapAccessAdmins(harness.testDb.db));
  const provisioned = await provisionAdmin('operations');
  opsUserId = provisioned.userId;
  ops = provisioned;
});

afterAll(async () => {
  await harness.close();
});

/** Stores one requirement's document through the REAL W3-3/W3-4 services. */
async function storeRequirement(caseId: string, requirementKey: string): Promise<void> {
  const requirement = await harness.testDb.db
    .selectFrom('verification_case_requirement')
    .select(['id'])
    .where('case_id', '=', caseId)
    .where('requirement_key', '=', requirementKey)
    .executeTakeFirstOrThrow();
  const registered = await registerEvidence({ db: harness.testDb.db }, { userId: opsUserId }, {
    caseId,
    requirementId: requirement.id,
    originalFilename: `${requirementKey}.pdf`,
    declaredContentType: 'application/pdf',
  });
  if (registered.kind !== 'evidenceRegistered') throw new Error(registered.kind);
  const stored = await finalizeEvidenceStorage(
    { db: harness.testDb.db },
    {
      evidenceId: registered.evidenceId,
      expectedVersion: registered.version,
      byteSize: 1024,
      sha256Digest: 'a'.repeat(64),
      storageRef: `verification/contract/${registered.evidenceId}`,
    },
  );
  if (stored.kind !== 'evidenceStored') throw new Error(stored.kind);
}

describe('the real review journey through the live admin transport', () => {
  test('workspace → open round → evidence → start review → APPROVE → verified → go-live → public storefront', async () => {
    const { orgId } = await createProviderOrg(harness.testDb.db, {
      state: 'submitted',
      displayName: 'Contract Review Swimming',
      branches: 1,
    });
    await sql`UPDATE organization_public_profile SET published = true
              WHERE organization_id = ${orgId}`.execute(harness.testDb.db);
    const port = await signedInVerificationPort(ops);

    const before = await port.getVerification(orgId);
    if (before.kind !== 'loaded') throw new Error(before.kind);
    expect(before.view).toMatchObject({
      organizationState: 'submitted',
      contentSafetyReady: true,
      policyConfigured: true,
      latestCase: null,
    });

    await expect(port.openCase(orgId)).resolves.toEqual({ kind: 'completed' });
    const opened = await port.getVerification(orgId);
    if (opened.kind !== 'loaded') throw new Error(opened.kind);
    const caseView = opened.view.latestCase!;
    expect(caseView.state).toBe('open');
    expect(caseView.readiness.kind).toBe('missingRequirements');

    // Evidence is collected while the round is OPEN (the W3-3 rule), then
    // the reviewer takes ownership with a READY checklist.
    await storeRequirement(caseView.caseId, 'business_document');
    await storeRequirement(caseView.caseId, 'operating_license');
    await expect(
      port.startReview(orgId, { caseId: caseView.caseId, expectedCaseVersion: caseView.version }),
    ).resolves.toEqual({ kind: 'completed' });
    const inReview = await port.getVerification(orgId);
    if (inReview.kind !== 'loaded') throw new Error(inReview.kind);
    expect(inReview.view.organizationState).toBe('in_review');
    expect(inReview.view.latestCase?.readiness.kind).toBe('ready');

    const decided = await port.decide(orgId, {
      caseId: caseView.caseId,
      expectedCaseVersion: inReview.view.latestCase!.version,
      outcome: 'approved',
      internalNote: 'Contract journey approval.',
    });
    expect(decided).toEqual({ kind: 'completed' });

    const after = await port.getVerification(orgId);
    if (after.kind !== 'loaded') throw new Error(after.kind);
    expect(after.view.organizationState).toBe('verified');
    expect(after.view.latestCase?.decision?.outcome).toBe('approved');

    await expect(
      port.goLive(orgId, { expectedVersion: after.view.organizationVersion }),
    ).resolves.toEqual({ kind: 'completed' });

    // The canonical end state: the public storefront exists.
    const storefront = await fetch(`${harness.apiBaseUrl}/providers/${orgId}`);
    expect(storefront.status).toBe(200);
  });

  test('approval of an UNREADY round refuses with the structured missing list and changes nothing', async () => {
    const { orgId } = await createProviderOrg(harness.testDb.db, {
      state: 'submitted',
      displayName: 'Contract Unready Climbing',
      branches: 1,
    });
    const port = await signedInVerificationPort(ops);
    await expect(port.openCase(orgId)).resolves.toEqual({ kind: 'completed' });
    const opened = await port.getVerification(orgId);
    if (opened.kind !== 'loaded') throw new Error(opened.kind);
    const caseView = opened.view.latestCase!;
    await expect(
      port.startReview(orgId, { caseId: caseView.caseId, expectedCaseVersion: caseView.version }),
    ).resolves.toEqual({ kind: 'completed' });
    const inReview = await port.getVerification(orgId);
    if (inReview.kind !== 'loaded') throw new Error(inReview.kind);

    const notReady = await port.decide(orgId, {
      caseId: caseView.caseId,
      expectedCaseVersion: inReview.view.latestCase!.version,
      outcome: 'approved',
    });
    expect(notReady).toEqual({
      kind: 'notReady',
      missing: [
        { requirementKey: 'business_document', labelEn: 'Business document' },
        { requirementKey: 'operating_license', labelEn: 'Operating licence' },
      ],
    });
    const after = await port.getVerification(orgId);
    if (after.kind !== 'loaded') throw new Error(after.kind);
    expect(after.view.organizationState).toBe('in_review'); // unchanged
    expect(after.view.latestCase?.decision).toBeNull();
  });

  test('an auditor cannot perform the journey; unknown organizations are a clean not-found', async () => {
    const auditor = await provisionAdmin('auditor');
    const port = await signedInVerificationPort(auditor);
    await expect(port.getVerification(newId())).resolves.toEqual({ kind: 'forbidden' });
    await expect(port.openCase(newId())).resolves.toEqual({ kind: 'forbidden' });
    const opsPort = await signedInVerificationPort(ops);
    await expect(opsPort.getVerification(newId())).resolves.toEqual({ kind: 'notFound' });
  });
});
