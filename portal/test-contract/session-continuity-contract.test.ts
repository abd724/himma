/**
 * §18 session-continuity sequence — the most important automated proof of
 * the W2-12A correction. REAL backend (`buildApp` on real PostgreSQL) +
 * REAL portal live adapter; only the external Cognito boundary is the
 * deterministic fake. The simulated browser keeps a cookie jar exactly the
 * way a browser would (Set-Cookie absorbed, sent back on credentialed
 * auth-path requests) while portal code never reads it.
 */
import { sql } from 'kysely';

import { createIdentity, createUser } from '../../backend/test/helpers/identity-fixtures';
import {
  addMembership,
  createProviderOrg,
} from '../../backend/test/helpers/provider-fixtures';
import { newId } from '../../backend/src/db/ids';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from './support/backend-harness';

let harness: ContractHarness;

beforeAll(async () => {
  harness = await createContractHarness();
});

afterAll(async () => {
  await harness.close();
});

/** A fresh runtime = a fresh browser JS context (memory wiped); the shared
 *  harness fetchImpl carries the SAME cookie jar (the browser survives). */
function freshJsContext() {
  return createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
}

let userCounter = 100;

async function provisionStaffOwner(): Promise<{
  userId: string;
  subject: string;
  email: string;
  password: string;
  orgId: string;
  orgName: string;
}> {
  userCounter += 1;
  const email = `continuity-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `continuity-sub-${userCounter}`;
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
  const orgName = `Continuity Org ${userCounter}`;
  const org = await createProviderOrg(harness.testDb.db, { displayName: orgName });
  await addMembership(harness.testDb.db, userId, org.orgId, 'owner');
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: `Owner ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, subject, email, password, orgId: org.orgId, orgName };
}

describe('the §18 sequence: sign-in → continuity → simulated reload → refresh → access → revocation → refused', () => {
  test('the full sequence holds end-to-end against the real backend', async () => {
    const staff = await provisionStaffOwner();

    // 1. Sign in + MFA in browser context A; the cookie channel engages.
    const contextA = freshJsContext();
    await contextA.adapter.signIn({ email: staff.email, password: staff.password });
    const signedIn = await contextA.adapter.completeMfaChallenge(VALID_TOTP);
    expect(signedIn).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });
    expect(harness.cookieJar.has('himma_refresh')).toBe(true);
    expect(harness.cookieJar.has('himma_csrf')).toBe(true);

    // 2. Simulate a hard reload: browser JS memory is GONE (a brand-new
    // runtime), the cookie jar survives — exactly what a browser does.
    const contextB = freshJsContext();
    const bootstrap = await contextB.adapter.bootstrap();
    expect(bootstrap).toMatchObject({ kind: 'session', assurance: 'mfa' });

    // 3. The refreshed session resolves REAL provider access.
    await expect(contextB.accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      memberships: [
        {
          organizationId: staff.orgId,
          displayName: staff.orgName,
          role: 'owner',
          branchScope: 'all',
          organizationState: 'live',
        },
      ],
    });

    // 4. Force-revoke the Himma LoginSession (the session-of-record).
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'forced'
              WHERE provider_subject = ${staff.subject}`.execute(harness.testDb.db);

    // 5. The next reload bootstrap is REFUSED — a still-valid provider
    // refresh token cannot bypass Himma revocation — and the dead channel
    // is cleared so nothing loops.
    const contextC = freshJsContext();
    await expect(contextC.adapter.bootstrap()).resolves.toEqual({ kind: 'noSession' });
    expect(harness.cookieJar.has('himma_refresh')).toBe(false);

    // 6. And with no channel left, the following bootstrap is signed out
    // at the first probe.
    const contextD = freshJsContext();
    await expect(contextD.adapter.bootstrap()).resolves.toEqual({ kind: 'noSession' });
  });

  test('membership revocation is respected across reload-refresh: the refreshed identity gets no provider access back', async () => {
    const staff = await provisionStaffOwner();
    const contextA = freshJsContext();
    await contextA.adapter.signIn({ email: staff.email, password: staff.password });
    await contextA.adapter.completeMfaChallenge(VALID_TOTP);

    // A standing owner keeps the org valid; then the seat is revoked.
    const standing = await createUser(harness.testDb.db);
    await addMembership(harness.testDb.db, standing, staff.orgId, 'owner');
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE user_id = ${staff.userId}`.execute(harness.testDb.db);

    // The reload bootstrap still authenticates (the SESSION is live) but
    // PostgreSQL membership truth yields zero provider access.
    const contextB = freshJsContext();
    await expect(contextB.adapter.bootstrap()).resolves.toMatchObject({ kind: 'session' });
    await expect(contextB.accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      memberships: [],
    });
  });

  test('logout ends continuity for the browser: reload after logout stays signed out and Back cannot silently re-authenticate', async () => {
    const staff = await provisionStaffOwner();
    const contextA = freshJsContext();
    await contextA.adapter.signIn({ email: staff.email, password: staff.password });
    await contextA.adapter.completeMfaChallenge(VALID_TOTP);
    expect(harness.cookieJar.has('himma_refresh')).toBe(true);

    await contextA.adapter.signOut();
    // The server cleared the auth cookies (the jar absorbed Max-Age=0) and
    // revoked the session-of-record.
    expect(harness.cookieJar.has('himma_refresh')).toBe(false);
    const rows = await harness.testDb.db
      .selectFrom('login_session')
      .select(['revoked_at'])
      .where('provider_subject', '=', staff.subject)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();

    // A reload (fresh JS context) finds nothing to continue.
    const contextB = freshJsContext();
    await expect(contextB.adapter.bootstrap()).resolves.toEqual({ kind: 'noSession' });
  });

  test('an inaccessible organization stays blocked after a reload-refresh (the backend re-authorizes every request)', async () => {
    const staff = await provisionStaffOwner();
    const foreign = await createProviderOrg(harness.testDb.db, {
      displayName: 'Foreign After Reload',
    });
    const contextA = freshJsContext();
    await contextA.adapter.signIn({ email: staff.email, password: staff.password });
    await contextA.adapter.completeMfaChallenge(VALID_TOTP);

    const contextB = freshJsContext();
    await contextB.adapter.bootstrap();
    // Reach for the foreign org with the refreshed bearer directly — the
    // real backend answers with the safe not-found shape.
    const csrf = await harness.fetchImpl(`${harness.apiBaseUrl}/auth/csrf`, {
      method: 'GET',
      credentials: 'include',
    });
    expect(csrf.status).toBe(200); // channel alive
    const refreshed = await harness.fetchImpl(`${harness.apiBaseUrl}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-csrf-token': ((await csrf.json()) as { csrfToken: string }).csrfToken,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const bearer = ((await refreshed.json()) as { accessToken: string }).accessToken;
    const foreignView = await fetch(
      `${harness.apiBaseUrl}/provider/organizations/${foreign.orgId}`,
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    expect(foreignView.status).toBe(404);
  });
});
