/**
 * W2-12A portal ↔ backend CONTRACT tests: the LIVE portal auth adapter and
 * provider-access port against the REAL backend (buildApp over freshly
 * migrated real PostgreSQL). Only the external Cognito HTTP boundary is
 * simulated (see support/backend-harness.ts) — token presentation,
 * first-login, Himma session establishment, liveness, provider-access
 * resolution, revocation, logout, and step-up all execute the real
 * routes, services, policies, and outcome codes.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import { createIdentity, createUser } from '../../backend/test/helpers/identity-fixtures';
import {
  addMembership,
  createProviderOrg,
} from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { SessionInterrupt } from '../src/auth/adapter';
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

function liveRuntime() {
  return createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
}

let userCounter = 0;

/** A provider staff user that exists in Himma (identity + optional
 *  memberships) AND in the fake Cognito pool. */
async function provisionStaffUser(options: {
  mfaConfigured?: boolean;
  displayName?: string;
}): Promise<{ userId: string; subject: string; email: string; password: string }> {
  userCounter += 1;
  const email = `staff-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `contract-sub-${userCounter}`;
  const userId = await createUser(harness.testDb.db);
  await createIdentity(harness.testDb.db, userId, {
    provider: 'email',
    issuer: CONTRACT_ISSUER,
    subject,
    email,
    emailVerified: true,
  });
  // Mirror an active TOTP enrollment (the provider MFA baseline source).
  await harness.testDb.db
    .insertInto('mfa_method')
    .values({
      id: newId(),
      user_id: userId,
      kind: 'totp',
      state: 'active',
      confirmed_at: new Date(),
    })
    .execute();
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: options.displayName ?? `Staff ${userCounter}`,
    mfaConfigured: options.mfaConfigured ?? true,
  });
  return { userId, subject, email, password };
}

describe('sign-in → MFA → Himma session → provider access (the full real leg)', () => {
  test('a multi-org staff user completes TOTP sign-in and resolves EXACTLY the real /provider/me membership DTOs', async () => {
    const staff = await provisionStaffUser({ displayName: 'Rana Contract' });
    const orgA = await createProviderOrg(harness.testDb.db, { displayName: 'Alpha Aquatics' });
    const orgB = await createProviderOrg(harness.testDb.db, { displayName: 'Beta Fitness' });
    await addMembership(harness.testDb.db, staff.userId, orgA.orgId, 'owner');
    await addMembership(harness.testDb.db, staff.userId, orgB.orgId, 'branch_manager', [
      orgB.branchIds[0] as string,
    ]);

    const { adapter, accessPort } = liveRuntime();
    await expect(
      adapter.signIn({ email: staff.email, password: staff.password }),
    ).resolves.toEqual({ kind: 'mfaChallenge' });

    const signedIn = await adapter.completeMfaChallenge(VALID_TOTP);
    expect(signedIn).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });

    // The REAL Himma session-of-record exists for this identity.
    const sessions = await harness.testDb.db
      .selectFrom('login_session')
      .select(['id', 'revoked_at'])
      .where('provider_subject', '=', staff.subject)
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revoked_at).toBeNull();

    const access = await accessPort.resolveAccess();
    expect(access).toEqual({
      kind: 'resolved',
      memberships: [
        {
          organizationId: orgA.orgId,
          displayName: 'Alpha Aquatics',
          role: 'owner',
          branchScope: 'all',
          organizationState: 'live',
        },
        {
          organizationId: orgB.orgId,
          displayName: 'Beta Fitness',
          role: 'branch_manager',
          branchScope: [orgB.branchIds[0]],
          organizationState: 'live',
        },
      ],
    });
  });

  test('a wrong TOTP is a safe invalidCode; a consumed/lapsed challenge maps to challengeExpired and restarts from credentials', async () => {
    const staff = await provisionStaffUser({});
    const { adapter } = liveRuntime();
    await adapter.signIn({ email: staff.email, password: staff.password });
    await expect(adapter.completeMfaChallenge('000000')).resolves.toEqual({
      kind: 'invalidCode',
    });
    // Complete correctly (the fake Session is single-use, like Cognito's).
    await expect(adapter.completeMfaChallenge(VALID_TOTP)).resolves.toMatchObject({
      kind: 'signedIn',
    });
    // The consumed challenge cannot be answered again.
    await expect(adapter.completeMfaChallenge(VALID_TOTP)).resolves.toEqual({
      kind: 'challengeExpired',
    });
  });

  test('an identity WITHOUT MFA configured signs in single_factor — the portal guard layer (not this adapter) forces enrollment before provider-private screens', async () => {
    const staff = await provisionStaffUser({ mfaConfigured: false });
    const { adapter } = liveRuntime();
    await expect(
      adapter.signIn({ email: staff.email, password: staff.password }),
    ).resolves.toMatchObject({ kind: 'signedIn', assurance: 'single_factor' });
  });

  test('wrong credentials refuse with the one safe class', async () => {
    const staff = await provisionStaffUser({});
    const { adapter } = liveRuntime();
    await expect(
      adapter.signIn({ email: staff.email, password: 'wrong-password' }),
    ).resolves.toEqual({ kind: 'invalidCredentials' });
  });
});

describe('claims grant NOTHING — Himma PostgreSQL is the only authority (§19.1–3)', () => {
  test('a valid Cognito bearer with authority-suggesting scopes but NO staff membership resolves ZERO memberships', async () => {
    const customer = await provisionStaffUser({}); // identity exists, NO membership rows
    const bearer = harness.mintAccessToken({
      subject: customer.subject,
      assurance: 'mfa',
      scopes: ['provider-admin', 'org-owner'],
    });
    // Establish the real Himma session with that bearer directly.
    const session = await fetch(`${harness.apiBaseUrl}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: bearer }),
    });
    expect(session.status).toBe(200);

    const me = await fetch(`${harness.apiBaseUrl}/provider/me`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({ memberships: [] });
  });

  test('an unauthorized organization id entered by URL is the safe not-found shape — nothing about the foreign organization leaks', async () => {
    const staff = await provisionStaffUser({});
    const own = await createProviderOrg(harness.testDb.db, { displayName: 'Own Org' });
    const foreign = await createProviderOrg(harness.testDb.db, {
      displayName: 'Foreign Secret Org',
    });
    await addMembership(harness.testDb.db, staff.userId, own.orgId, 'owner');

    const bearer = harness.mintAccessToken({ subject: staff.subject });
    await fetch(`${harness.apiBaseUrl}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: bearer }),
    });

    const foreignView = await fetch(
      `${harness.apiBaseUrl}/provider/organizations/${foreign.orgId}`,
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    expect(foreignView.status).toBe(404);
    const body = (await foreignView.json()) as { code: string };
    expect(body.code).toBe('notFound');
    expect(JSON.stringify(body)).not.toContain('Foreign Secret Org');

    // A ghost id is byte-identically the same shape (no enumeration oracle).
    const ghost = await fetch(
      `${harness.apiBaseUrl}/provider/organizations/${newId()}`,
      { headers: { authorization: `Bearer ${bearer}` } },
    );
    expect(ghost.status).toBe(404);
    await expect(ghost.json()).resolves.toEqual(body);
  });
});

describe('session and membership revocation bite through the real liveness/access checks (§19.11–12)', () => {
  test('a force-revoked Himma LoginSession makes the portal drop tokens and push the ONE canonical interrupt', async () => {
    const staff = await provisionStaffUser({});
    const org = await createProviderOrg(harness.testDb.db, {});
    await addMembership(harness.testDb.db, staff.userId, org.orgId, 'owner');

    const { adapter, accessPort } = liveRuntime();
    const interrupts: SessionInterrupt[] = [];
    adapter.subscribe((interrupt) => interrupts.push(interrupt));
    await adapter.signIn({ email: staff.email, password: staff.password });
    await adapter.completeMfaChallenge(VALID_TOTP);
    await expect(accessPort.resolveAccess()).resolves.toMatchObject({ kind: 'resolved' });

    // Forced server-side revocation (admin/security action) — the REAL row.
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'forced'
              WHERE provider_subject = ${staff.subject}`.execute(harness.testDb.db);

    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    expect(interrupts).toEqual([{ kind: 'sessionExpired' }]);
  });

  test('membership revocation removes access at the next authoritative resolution', async () => {
    const staff = await provisionStaffUser({});
    const org = await createProviderOrg(harness.testDb.db, {});
    // A standing owner keeps the organization valid (the schema itself
    // enforces last-owner protection); the revoked seat is a non-owner.
    const standingOwner = await createUser(harness.testDb.db);
    await addMembership(harness.testDb.db, standingOwner, org.orgId, 'owner');
    const membershipId = await addMembership(
      harness.testDb.db,
      staff.userId,
      org.orgId,
      'listings_editor',
    );

    const { adapter, accessPort } = liveRuntime();
    await adapter.signIn({ email: staff.email, password: staff.password });
    await adapter.completeMfaChallenge(VALID_TOTP);
    await expect(accessPort.resolveAccess()).resolves.toMatchObject({
      kind: 'resolved',
      memberships: [expect.objectContaining({ organizationId: org.orgId })],
    });

    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE id = ${membershipId}`.execute(harness.testDb.db);

    // The session is still LIVE (revoking membership ≠ revoking session):
    // access truth changes, memberships become empty → noMembership UX.
    await expect(accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      memberships: [],
    });
  });

  test('logout revokes the real Himma session-of-record and the bearer stops working immediately', async () => {
    const staff = await provisionStaffUser({});
    const org = await createProviderOrg(harness.testDb.db, {});
    await addMembership(harness.testDb.db, staff.userId, org.orgId, 'owner');

    const { adapter, accessPort } = liveRuntime();
    await adapter.signIn({ email: staff.email, password: staff.password });
    await adapter.completeMfaChallenge(VALID_TOTP);
    await adapter.signOut();

    const sessions = await harness.testDb.db
      .selectFrom('login_session')
      .select(['revoked_at'])
      .where('provider_subject', '=', staff.subject)
      .execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revoked_at).not.toBeNull();
    await expect(accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('step-up over the real Himma routes', () => {
  test('the two-legged TOTP step-up completes against /auth/step-up/totp/begin + /complete', async () => {
    const staff = await provisionStaffUser({});
    const { adapter } = liveRuntime();
    await adapter.signIn({ email: staff.email, password: staff.password });
    await adapter.completeMfaChallenge(VALID_TOTP);

    // The backend's fake MFA provider accepts its deterministic OTP for the
    // provider user ref (= the token subject).
    const outcome = await adapter.completeStepUpTotp(
      harness.mfaProvider.validCodeFor(staff.subject),
    );
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(Date.parse(outcome.expiresAt)).toBeGreaterThan(Date.now());
    }
  });

  test('a wrong step-up code surfaces the sanitized retryable refusal', async () => {
    const staff = await provisionStaffUser({});
    const { adapter } = liveRuntime();
    await adapter.signIn({ email: staff.email, password: staff.password });
    await adapter.completeMfaChallenge(VALID_TOTP);
    await expect(adapter.completeStepUpTotp('999999')).resolves.toEqual({
      kind: 'invalidCode',
    });
  });
});
