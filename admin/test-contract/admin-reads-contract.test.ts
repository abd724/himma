/**
 * W3-2 Admin ↔ backend CONTRACT tests (task §37): the LIVE admin auth
 * runtime and provider-read port against the REAL backend (buildApp over
 * freshly migrated real PostgreSQL), reusing the portal's deterministic
 * fake-Cognito harness — the ONE simulated boundary. The full internal
 * read journey executes the real routes, policies, session rows, and
 * outcome codes: admin authenticate → /admin/me → provider directory →
 * authoritative search/filter → organization detail. An admin role
 * WITHOUT provider-operations authority is proven unable to perform the
 * same journey.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import { bootstrapAccessAdmins, createIdentity, createUser } from '../../backend/test/helpers/identity-fixtures';
import { createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveProvidersReadPort } from '../src/services/live/live-providers-port';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from '../../portal/test-contract/support/backend-harness';

let harness: ContractHarness;
let adminA: string;
let adminB: string;

beforeAll(async () => {
  harness = await createContractHarness();
  ({ adminA, adminB } = await bootstrapAccessAdmins(harness.testDb.db));
});

afterAll(async () => {
  await harness.close();
});

function liveRuntime() {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  return { ...runtime, providersPort: createLiveProvidersReadPort(runtime.transport) };
}

let userCounter = 0;

/** A Himma admin (PostgreSQL role + Himma MFA enrollment) who also exists
 *  in the fake Cognito pool with TOTP configured. */
async function provisionAdmin(
  role: 'operations' | 'auditor',
): Promise<{ email: string; password: string }> {
  userCounter += 1;
  const email = `admin-${userCounter}@contract.test`;
  const password = `pw-admin-${userCounter}`;
  const subject = `admin-contract-sub-${userCounter}`;
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
    displayName: `Admin ${userCounter}`,
    mfaConfigured: true,
  });
  return { email, password };
}

async function signIn(runtime: ReturnType<typeof liveRuntime>, email: string, password: string) {
  await expect(runtime.adapter.signIn({ email, password })).resolves.toEqual({
    kind: 'mfaChallenge',
  });
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  expect(signedIn).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });
}

describe('the full internal read journey on the real backend', () => {
  test('operations admin: sign-in → /admin/me → directory → authoritative search + queue filter → detail', async () => {
    // Real organizations across the canonical states.
    const submitted = await createProviderOrg(harness.testDb.db, {
      state: 'submitted',
      displayName: 'Contract Wave Swimming',
      branches: 2,
    });
    const live = await createProviderOrg(harness.testDb.db, {
      state: 'live',
      displayName: 'Contract Summit Climbing',
      branches: 1,
    });
    await sql`UPDATE organization_public_profile SET published = true
              WHERE organization_id = ${live.orgId}`.execute(harness.testDb.db);

    const ops = await provisionAdmin('operations');
    const runtime = liveRuntime();
    await signIn(runtime, ops.email, ops.password);

    // The REAL /admin/me bootstrap resolves the operations projection.
    const access = await runtime.accessPort.resolveAccess();
    if (access.kind !== 'resolved') throw new Error(access.kind);
    expect(access.access.roles).toEqual(['operations']);
    expect(access.access.capabilities).toContain('providers.operate');

    // Directory over the complete authorized set.
    const all = await runtime.providersPort.listOrganizations({ limit: 100 });
    if (all.kind !== 'loaded') throw new Error(all.kind);
    const ids = all.page.organizations.map((row) => row.organizationId);
    expect(ids).toEqual(expect.arrayContaining([submitted.orgId, live.orgId]));

    // Authoritative server-side search (case-insensitive).
    const searched = await runtime.providersPort.listOrganizations({
      limit: 100,
      q: 'contract WAVE',
    });
    if (searched.kind !== 'loaded') throw new Error(searched.kind);
    expect(searched.page.organizations.map((row) => row.displayName)).toEqual([
      'Contract Wave Swimming',
    ]);

    // The review-queue predicate over real states.
    const queue = await runtime.providersPort.listOrganizations({
      limit: 100,
      needsReview: true,
    });
    if (queue.kind !== 'loaded') throw new Error(queue.kind);
    const queueIds = queue.page.organizations.map((row) => row.organizationId);
    expect(queueIds).toContain(submitted.orgId);
    expect(queueIds).not.toContain(live.orgId);
    const submittedRow = queue.page.organizations.find(
      (row) => row.organizationId === submitted.orgId,
    )!;
    expect(submittedRow.reviewState).toBe('awaiting_review');
    expect(submittedRow.activeBranchCount).toBe(2);
    expect(submittedRow.storefront).toEqual({ published: false, publiclyVisible: false });

    // The real internal detail.
    const detail = await runtime.providersPort.getOrganization(live.orgId);
    if (detail.kind !== 'loaded') throw new Error(detail.kind);
    expect(detail.detail.organization.verificationState).toBe('live');
    expect(detail.detail.profile.publiclyVisible).toBe(true);
    expect(detail.detail.branches).toHaveLength(1);
    expect(detail.detail.catalogue.total).toBe(0);

    // A nonexistent organization is a clean notFound for the SAME admin.
    await expect(runtime.providersPort.getOrganization(newId())).resolves.toEqual({
      kind: 'notFound',
    });
  });

  test('an auditor admin authenticates and bootstraps, but CANNOT perform the provider-read journey', async () => {
    const auditor = await provisionAdmin('auditor');
    const runtime = liveRuntime();
    await signIn(runtime, auditor.email, auditor.password);

    // /admin/me resolves truthfully (auditor is a valid administrator)…
    const access = await runtime.accessPort.resolveAccess();
    if (access.kind !== 'resolved') throw new Error(access.kind);
    expect(access.access.roles).toEqual(['auditor']);
    expect(access.access.capabilities).not.toContain('providers.operate');

    // …but every provider read refuses — directory, queue, and detail,
    // existing and nonexistent ids alike (no enumeration oracle).
    await expect(runtime.providersPort.listOrganizations({ limit: 10 })).resolves.toEqual({
      kind: 'forbidden',
    });
    await expect(
      runtime.providersPort.listOrganizations({ limit: 10, needsReview: true }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(runtime.providersPort.getOrganization(newId())).resolves.toEqual({
      kind: 'forbidden',
    });
  });
});
