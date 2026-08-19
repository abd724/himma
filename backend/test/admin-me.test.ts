/**
 * W3-1 — GET /admin/me, the Admin Portal bootstrap (docs/31 §6/§7).
 *
 * The route answers exactly one question for the Admin frontend: is this
 * authenticated Himma identity an authorized internal administrator, and
 * what SAFE access projection should the portal use? Authority is the
 * existing `admin` policy (live session + Himma MFA assurance + ≥1 ACTIVE
 * PostgreSQL admin role) plus the centralized capability projection
 * (admin-capabilities.ts) — a projection of authority the services already
 * enforce, never a new authorization model. Cognito claims/scopes grant
 * nothing; provider memberships grant nothing; the DTO carries no session
 * internals, no assignment audit fields, and no provider/customer data.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { capabilitiesForAdminRoles } from '../src/modules/identity/services/admin-capabilities';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { firstLogin } from '../src/modules/identity/services/first-login';
import { establishSession } from '../src/modules/identity/services/sessions';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { bootstrapAccessAdmins } from './helpers/identity-fixtures';
import { addMembership, createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/admin-me-pool';
let testDb: TestDb;
let app: FastifyInstance;
let accessVerifier: FakeAccessTokenVerifier;
let adminA: string;
let adminB: string;
let counter = 0;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  accessVerifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: accessVerifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

async function makeCustomer(): Promise<string> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject: `admin-me-sub-${counter}`,
    email: `adminme${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return result.userId;
}

async function grantRole(userId: string, role: AdminRole): Promise<string> {
  const id = newId();
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${id}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(testDb.db);
  return id;
}

async function bearerFor(
  userId: string,
  assurance: 'single_factor' | 'mfa',
  options: { scopes?: string[]; authTime?: Date } = {},
): Promise<string> {
  counter += 1;
  const subject = `admin-me-bearer-${counter}`;
  await testDb.db
    .insertInto('auth_identity')
    .values({
      id: newId(),
      user_id: userId,
      provider: 'google',
      issuer: ISSUER,
      subject,
      email_verified: false,
      is_private_relay: false,
    })
    .execute();
  if (assurance === 'mfa') {
    const enrolled = await testDb.db
      .selectFrom('mfa_method')
      .select(['id'])
      .where('user_id', '=', userId)
      .where('state', '=', 'active')
      .executeTakeFirst();
    if (enrolled === undefined) {
      await testDb.db
        .insertInto('mfa_method')
        .values({ id: newId(), user_id: userId, kind: 'totp', state: 'active', confirmed_at: new Date() })
        .execute();
    }
  }
  const access: AccessTokenEvidence = {
    issuer: ISSUER,
    subject,
    originJti: `admin-me-origin-${counter}`,
    scopes: options.scopes ?? ['openid'],
    assurance,
    expiresAt: new Date(Date.now() + 3_600_000),
    authTime: options.authTime ?? new Date(),
  };
  const established = await establishSession({ db: testDb.db }, { evidence: access, client: {} });
  if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
  return accessVerifier.issueToken(access);
}

function me(bearer?: string) {
  return app.inject({
    method: 'GET',
    url: '/admin/me',
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
}

describe('bootstrap denial (task §8/§29)', () => {
  it('a customer-only identity is refused (forbidden), learning nothing more', async () => {
    const customer = await makeCustomer();
    const response = await me(await bearerFor(customer, 'mfa'));
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('a PROVIDER-only identity is refused — provider membership never implies admin access', async () => {
    const providerUser = await makeCustomer();
    const org = await createProviderOrg(testDb.db);
    await addMembership(testDb.db, providerUser, org.orgId, 'owner');
    const response = await me(await bearerFor(providerUser, 'mfa'));
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('Cognito scopes/claims suggesting admin grant NOTHING without a PostgreSQL role', async () => {
    const pretender = await makeCustomer();
    const response = await me(
      await bearerFor(pretender, 'mfa', {
        scopes: ['openid', 'aws.cognito.signin.user.admin', 'himma/admin'],
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('an admin without MFA assurance is refused with the typed mfaRequired outcome; no bearer is a plain 401', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'operations');
    const single = await me(await bearerFor(admin, 'single_factor'));
    expect(single.statusCode).toBe(403);
    expect(single.json().code).toBe('mfaRequired');
    expect((await me()).statusCode).toBe(401);
  });

  it('a revoked final admin role removes access on the next bootstrap', async () => {
    const admin = await makeCustomer();
    const assignmentId = await grantRole(admin, 'auditor');
    const bearer = await bearerFor(admin, 'mfa');
    expect((await me(bearer)).statusCode).toBe(200);
    await sql`UPDATE admin_role_assignment SET state = 'revoked', revoked_by = ${adminA}
              WHERE id = ${assignmentId}`.execute(testDb.db);
    const after = await me(bearer);
    expect(after.statusCode).toBe(403);
    expect(after.json().code).toBe('forbidden');
  });

  it('a revoked LoginSession removes access regardless of the bearer', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'operations');
    const bearer = await bearerFor(admin, 'mfa');
    expect((await me(bearer)).statusCode).toBe(200);
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'admin_test'
              WHERE provider_subject LIKE 'admin-me-bearer-%'
              AND id IN (
                SELECT ls.id FROM login_session ls
                JOIN auth_identity ai ON ai.subject = ls.provider_subject
                WHERE ai.user_id = ${admin}
              )`.execute(testDb.db);
    expect((await me(bearer)).statusCode).toBe(401);
  });
});

describe('the baseline/step-up separation (W3-1 final correction §5/§6/§12/§13)', () => {
  /** Well beyond the 300s step-up window — an MFA login whose factor aged. */
  const STALE_AUTH_TIME = () => new Date(Date.now() - 3_600_000);

  it('Case A/B: a fresh-factor admin AND the same admin with a STALE factor both bootstrap /admin/me — MFA assurance, not recency, is the baseline', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'access_admin');
    const fresh = await bearerFor(admin, 'mfa');
    expect((await me(fresh)).statusCode).toBe(200);
    // The key distinction: the recent-factor window has expired, MFA
    // assurance stands — ordinary shell access is NOT refused.
    const stale = await bearerFor(admin, 'mfa', { authTime: STALE_AUTH_TIME() });
    const bootstrap = await me(stale);
    expect(bootstrap.statusCode).toBe(200);
    expect((bootstrap.json() as { roles: string[] }).roles).toEqual(['access_admin']);
  });

  it('the split does NOT weaken sensitive admin routes: the SAME stale bearer that bootstraps /admin/me is refused stepUpRequired on role administration', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'access_admin');
    const stale = await bearerFor(admin, 'mfa', { authTime: STALE_AUTH_TIME() });
    const headers = { authorization: `Bearer ${stale}` };
    expect((await me(stale)).statusCode).toBe(200);
    // Read surface of the sensitive set (adminStepUp): retained strength.
    const read = await app.inject({ method: 'GET', url: '/admin/role-assignments', headers });
    expect(read.statusCode).toBe(403);
    expect(read.json().code).toBe('stepUpRequired');
    // Mutation surface: same retained strength (valid body — schema
    // validation runs before auth, so an invalid body would mask the probe).
    const target = await makeCustomer();
    const mutation = await app.inject({
      method: 'POST',
      url: '/admin/role-requests',
      headers,
      payload: { targetUserId: target, role: 'support' },
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().code).toBe('stepUpRequired');
    // A FRESH factor still satisfies the sensitive set — nothing tightened
    // by accident either.
    const fresh = await bearerFor(admin, 'mfa');
    const freshRead = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(freshRead.statusCode).toBe(200);
  });

  it('Case C/D still hold on the baseline: no MFA assurance and no active role are refused; a stale factor never rescues a revoked role or session', async () => {
    // No MFA assurance (single-factor login, no grant) → mfaRequired.
    const single = await makeCustomer();
    await grantRole(single, 'operations');
    const singleResponse = await me(await bearerFor(single, 'single_factor'));
    expect(singleResponse.statusCode).toBe(403);
    expect(singleResponse.json().code).toBe('mfaRequired');
    // No active role → forbidden, stale or not.
    const nobody = await makeCustomer();
    const nobodyResponse = await me(
      await bearerFor(nobody, 'mfa', { authTime: STALE_AUTH_TIME() }),
    );
    expect(nobodyResponse.statusCode).toBe(403);
    expect(nobodyResponse.json().code).toBe('forbidden');
    // Revoked final role with a stale (but MFA-assured) bearer → forbidden.
    const revoked = await makeCustomer();
    const assignmentId = await grantRole(revoked, 'operations');
    const staleBearer = await bearerFor(revoked, 'mfa', { authTime: STALE_AUTH_TIME() });
    expect((await me(staleBearer)).statusCode).toBe(200);
    await sql`UPDATE admin_role_assignment SET state = 'revoked', revoked_by = ${adminA}
              WHERE id = ${assignmentId}`.execute(testDb.db);
    const afterRevocation = await me(staleBearer);
    expect(afterRevocation.statusCode).toBe(403);
    expect(afterRevocation.json().code).toBe('forbidden');
  });
});

describe('the safe access projection (task §7/§25/§31)', () => {
  it('an active operations admin bootstraps with the exact roles + centralized capability projection and NOTHING else', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'operations');
    const response = await me(await bearerFor(admin, 'mfa'));
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['capabilities', 'roles', 'user']);
    expect(Object.keys(body.user as object).sort()).toEqual(['displayName', 'id']);
    expect(body.roles).toEqual(['operations']);
    expect(body.capabilities).toEqual([
      'providers.operate',
      'catalogue.moderate',
      'taxonomy.manage',
    ]);
    const account = await testDb.db
      .selectFrom('customer_account')
      .select(['display_name'])
      .where('user_id', '=', admin)
      .executeTakeFirstOrThrow();
    expect((body.user as { displayName: string }).displayName).toBe(account.display_name);
    // No secret/internal auth material of any kind.
    const serialized = JSON.stringify(body);
    for (const leak of ['session', 'token', 'jti', 'issuer', 'subject', 'requested_by', 'approvedBy']) {
      expect(serialized.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('a multi-role admin receives the deduplicated capability union in canonical order (operations + access_admin — a D4-legal pair)', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'operations');
    await grantRole(admin, 'access_admin');
    const response = await me(await bearerFor(admin, 'mfa'));
    expect(response.statusCode).toBe(200);
    const body = response.json() as { roles: string[]; capabilities: string[] };
    expect([...body.roles].sort()).toEqual(['access_admin', 'operations']);
    expect(body.capabilities).toEqual([
      'providers.operate',
      'catalogue.moderate',
      'taxonomy.manage',
      'roles.administer',
      'roles.view',
    ]);
    // D4 exclusivity (0002 trigger): auditor cannot coexist with any other
    // active role — the database refuses the combination outright.
    await expect(grantRole(admin, 'auditor')).rejects.toThrow(/exclusivity/);
  });

  it('support and finance are valid admins with truthfully EMPTY W3-phase capabilities (their domains do not exist yet)', async () => {
    const admin = await makeCustomer();
    await grantRole(admin, 'support');
    const response = await me(await bearerFor(admin, 'mfa'));
    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities).toEqual([]);
  });

  it('the projection module mirrors real service authority (access_admin ≠ operations; auditor read-only)', () => {
    expect(capabilitiesForAdminRoles(['access_admin'])).toEqual(['roles.administer', 'roles.view']);
    expect(capabilitiesForAdminRoles(['auditor'])).toEqual(['roles.view', 'audit.read']);
    expect(capabilitiesForAdminRoles(['access_admin'])).not.toContain('providers.operate');
    expect(capabilitiesForAdminRoles(['auditor'])).not.toContain('roles.administer');
    expect(capabilitiesForAdminRoles([])).toEqual([]);
  });
});
