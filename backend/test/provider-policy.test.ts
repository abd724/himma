/**
 * S3-3 — provider principal resolution and the `provider`/`providerStepUp`
 * route policies (docs/27 §7–§8; D-S3-5). Real PostgreSQL + Fastify
 * injection: PostgreSQL-only authority (Cognito claims inert), per-request
 * organization binding, immediate revocation/suspension effect, the MFA
 * baseline + recent-step-up composition, structural deny-by-default for
 * provider routes, admin/provider surface separation, and the production
 * fail-closed provider gate.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import {
  ACTIVE_PROVIDER_CAPABILITIES,
  PROVIDER_ROLE_CAPABILITIES,
  PROVIDER_ROLE_RESERVED_CAPABILITIES,
  RESERVED_PROVIDER_CAPABILITIES,
} from '../src/modules/provider/provider-capabilities';
import { PROVIDER_ROLES } from '../src/modules/provider/provider-roles';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  addMembership,
  bearerForUser,
  createProviderOrg,
  grantStepUp,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/provider-policy-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;

function identityOptions(verifier: FakeAccessTokenVerifier) {
  return {
    db: testDb.db,
    accessTokenVerifier: verifier,
    idTokenAdapter: new FakeAuthProviderAdapter(),
    mailSender: new CaptureMailSender(),
    rateLimiterStore: new InMemoryRateLimiterStore(),
    staffInvitationConfig: parseStaffInvitationConfig('test', {}),
  };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({ identity: identityOptions(verifier) });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function get(url: string, bearer: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
}
function post(url: string, bearer: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}` },
    payload: payload as Record<string, unknown>,
  });
}

describe('capability registry shape (docs/27 §6)', () => {
  it('active and reserved vocabularies are disjoint, and every role maps only to ACTIVE capabilities', () => {
    for (const reserved of RESERVED_PROVIDER_CAPABILITIES) {
      expect(ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).not.toContain(reserved);
    }
    for (const role of PROVIDER_ROLES) {
      for (const capability of PROVIDER_ROLE_CAPABILITIES[role]) {
        expect(ACTIVE_PROVIDER_CAPABILITIES).toContain(capability);
      }
      // The reserved map is vocabulary only — nothing it names is active.
      for (const capability of PROVIDER_ROLE_RESERVED_CAPABILITIES[role]) {
        expect(ACTIVE_PROVIDER_CAPABILITIES as readonly string[]).not.toContain(capability);
      }
    }
  });
});

describe('structural deny-by-default for provider routes', () => {
  it('every registered /provider route declares a provider policy or authenticatedCustomer (me/accept only)', () => {
    const providerRoutes = app.routePolicyInventory.filter((r) => r.url.startsWith('/provider'));
    expect(providerRoutes.length).toBeGreaterThanOrEqual(12);
    for (const route of providerRoutes) {
      if (route.url === '/provider/me' || route.url === '/provider/invitations/accept') {
        expect(route.policy).toBe('authenticatedCustomer');
      } else {
        expect(['provider', 'providerStepUp']).toContain(route.policy);
      }
    }
  });

  it('refuses provider routes without a capability, with a reserved capability, and capabilities on non-provider policies', async () => {
    const missing = buildApp();
    expect(() =>
      missing.get(
        '/rogue-provider',
        { config: { authPolicy: 'provider' } },
        async () => ({}),
      ),
    ).toThrow(/providerCapability/);
    await missing.close();

    const reserved = buildApp();
    expect(() =>
      reserved.get(
        '/rogue-reserved',
        {
          config: {
            authPolicy: 'providerStepUp',
            providerCapability: 'payouts.view' as never,
          },
        },
        async () => ({}),
      ),
    ).toThrow(/reserved capabilities cannot become executable/i);
    await reserved.close();

    const misplaced = buildApp();
    expect(() =>
      misplaced.get(
        '/rogue-misplaced',
        { config: { authPolicy: 'authenticatedCustomer', providerCapability: 'org.read' } },
        async () => ({}),
      ),
    ).toThrow(/non-provider policy/);
    await misplaced.close();
  });
});

describe('principal resolution (PostgreSQL-only provider authority)', () => {
  it('a customer without any membership gets not-found-shaped refusals, byte-identical to a nonexistent organization', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const customer = await createUser(testDb.db);
    const { bearer } = await bearerForUser(ctx, customer);
    const real = await get(`/provider/organizations/${orgId}`, bearer);
    const ghost = await get(`/provider/organizations/${newId()}`, bearer);
    expect(real.statusCode).toBe(404);
    expect(real.body).toBe(ghost.body);
  });

  it('Cognito scopes/claims-shaped token material grants zero provider authority', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const customer = await createUser(testDb.db);
    const { bearer } = await bearerForUser(ctx, customer, {
      scopes: ['openid', 'cognito:groups:provider-owner', `custom:organization:${orgId}`],
    });
    const response = await get(`/provider/organizations/${orgId}`, bearer);
    expect(response.statusCode).toBe(404);
  });

  it('an active membership resolves; revocation and organization suspension bite on the next request', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    // Keep a co-owner so revoking the first owner stays legal.
    await staffBearer(ctx, orgId, 'owner');
    expect((await get(`/provider/organizations/${orgId}`, owner.bearer)).statusCode).toBe(200);

    // Suspension: reads keep working, mutations refuse organizationSuspended.
    await sql`UPDATE organization SET verification_state = 'suspended', suspended_at = now()
              WHERE id = ${orgId}`.execute(testDb.db);
    expect((await get(`/provider/organizations/${orgId}`, owner.bearer)).statusCode).toBe(200);
    const mutation = await app.inject({
      method: 'PATCH',
      url: `/provider/organizations/${orgId}/profile`,
      headers: { authorization: `Bearer ${owner.bearer}` },
      payload: { expectedVersion: 1, displayName: 'New Name' },
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().code).toBe('organizationSuspended');
    await sql`UPDATE organization SET verification_state = 'live', suspended_at = NULL
              WHERE id = ${orgId}`.execute(testDb.db);

    // Revocation: the very next request is refused not-found-shaped.
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE id = ${owner.membershipId}`.execute(testDb.db);
    expect((await get(`/provider/organizations/${orgId}`, owner.bearer)).statusCode).toBe(404);
  });

  it('one user with memberships in two organizations resolves authority separately per addressed organization', async () => {
    const orgA = await createProviderOrg(testDb.db);
    const orgB = await createProviderOrg(testDb.db);
    const userId = await createUser(testDb.db);
    await addMembership(testDb.db, userId, orgA.orgId, 'owner');
    await addMembership(testDb.db, userId, orgB.orgId, 'coach');
    const { bearer } = await bearerForUser(ctx, userId);

    // Owner in A: staff surface reachable; coach in B: forbidden there —
    // same bearer, per-request binding to the addressed organization.
    expect((await get(`/provider/organizations/${orgA.orgId}/staff`, bearer)).statusCode).toBe(200);
    expect((await get(`/provider/organizations/${orgB.orgId}/staff`, bearer)).statusCode).toBe(403);
    const viewA = (await get(`/provider/organizations/${orgA.orgId}`, bearer)).json();
    const viewB = (await get(`/provider/organizations/${orgB.orgId}`, bearer)).json();
    expect(viewA.membership.role).toBe('owner');
    expect(viewB.membership.role).toBe('coach');
  });

  it('offboarded organizations are terminal: not-found-shaped for their own staff', async () => {
    const { orgId } = await createProviderOrg(testDb.db, { state: 'live' });
    const owner = await staffBearer(ctx, orgId, 'owner');
    await sql`UPDATE organization SET verification_state = 'offboarded', offboarded_at = now()
              WHERE id = ${orgId}`.execute(testDb.db);
    expect((await get(`/provider/organizations/${orgId}`, owner.bearer)).statusCode).toBe(404);
  });
});

describe('D-S3-5 MFA baseline and step-up composition', () => {
  it('walks the assurance ladder: no enrollment → mfaRequired; single-factor → mfaRequired; mfa session → baseline OK; stale → stepUpRequired on higher-risk; grant or fresh MFA login → full access', async () => {
    const { orgId, branchIds } = await createProviderOrg(testDb.db);
    const inviteBody = {
      email: 'ladder@example.com',
      role: 'front_desk' as const,
      branchScope: { kind: 'branches' as const, branchIds: [branchIds[0] as string] },
    };
    const inviteUrl = `/provider/organizations/${orgId}/staff/invitations`;

    // (1) Not MFA-enrolled: even an owner is mfaRequired on EVERY route.
    const unenrolled = await staffBearer(ctx, orgId, 'owner', { enrolled: false });
    const r1 = await get(`/provider/organizations/${orgId}`, unenrolled.bearer);
    expect(r1.statusCode).toBe(403);
    expect(r1.json().code).toBe('mfaRequired');

    // (2) Enrolled but single-factor session, no grant: still mfaRequired.
    const singleFactor = await staffBearer(ctx, orgId, 'owner', { assurance: 'single_factor' });
    const r2 = await get(`/provider/organizations/${orgId}`, singleFactor.bearer);
    expect(r2.statusCode).toBe(403);
    expect(r2.json().code).toBe('mfaRequired');

    // (3) MFA-verified login, stale (old authTime): baseline routes pass,
    // the higher-risk set demands a recent step-up.
    const stale = await staffBearer(ctx, orgId, 'owner', {
      authTime: new Date(Date.now() - 3_600_000),
    });
    expect((await get(`/provider/organizations/${orgId}`, stale.bearer)).statusCode).toBe(200);
    const r3 = await post(inviteUrl, stale.bearer, inviteBody);
    expect(r3.statusCode).toBe(403);
    expect(r3.json().code).toBe('stepUpRequired');

    // (4) A live session-bound recovery-code grant satisfies the step-up.
    await grantStepUp(testDb.db, stale.userId, stale.sessionId);
    expect((await post(inviteUrl, stale.bearer, inviteBody)).statusCode).toBe(200);

    // (5) A fresh MFA-verified login satisfies it directly.
    const fresh = await staffBearer(ctx, orgId, 'owner');
    expect(
      (
        await post(inviteUrl, fresh.bearer, {
          ...inviteBody,
          email: 'ladder2@example.com',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('a revoked session kills an existing step-up grant, and a revoked membership overrides assurance entirely', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner', {
      authTime: new Date(Date.now() - 3_600_000),
    });
    await staffBearer(ctx, orgId, 'owner'); // co-owner for the guard
    await grantStepUp(testDb.db, owner.userId, owner.sessionId);

    // Session revocation: grants are session-bound — everything is
    // sessionExpired-shaped regardless of the live grant row.
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'logout'
              WHERE id = ${owner.sessionId}`.execute(testDb.db);
    const afterSessionRevoke = await get(`/provider/organizations/${orgId}`, owner.bearer);
    expect(afterSessionRevoke.statusCode).toBe(401);

    // Fresh session, revoked membership: assurance cannot resurrect
    // authority — not-found-shaped immediately.
    const second = await staffBearer(ctx, orgId, 'front_desk');
    await grantStepUp(testDb.db, second.userId, second.sessionId);
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE id = ${second.membershipId}`.execute(testDb.db);
    expect((await get(`/provider/organizations/${orgId}`, second.bearer)).statusCode).toBe(404);
  });
});

describe('admin/provider surface separation', () => {
  it('provider staff never satisfy admin policies; admin roles never fabricate provider membership', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const adminList = await get('/admin/role-assignments', owner.bearer);
    expect(adminList.statusCode).toBe(403); // provider role ≠ admin role

    const { adminA } = await bootstrapAccessAdmins(testDb.db);
    const { bearer: adminBearer } = await bearerForUser(ctx, adminA);
    expect((await get('/admin/role-assignments', adminBearer)).statusCode).toBe(200);
    // The very same fully-assured admin has NO provider membership: the
    // provider surface is not-found-shaped for them.
    expect((await get(`/provider/organizations/${orgId}`, adminBearer)).statusCode).toBe(404);
    expect((await get(`/provider/organizations/${orgId}/staff`, adminBearer)).statusCode).toBe(404);
  });
});

describe('production fail-closed provider gate (D-S3-5; docs/26 §14.E′)', () => {
  it('an unready production build omits the provider surface entirely and refuses a forced activation', async () => {
    const verifier = new FakeAccessTokenVerifier();
    const production = buildApp({
      identity: {
        ...identityOptions(verifier),
        nodeEnv: 'production',
      },
    });
    await production.ready();
    const routes = production.routePolicyInventory.filter((r) => r.url.startsWith('/provider'));
    expect(routes).toEqual([]);
    const probe = await production.inject({ method: 'GET', url: '/provider/me' });
    expect(probe.statusCode).toBe(404);
    await production.close();

    expect(() =>
      buildApp({
        identity: {
          ...identityOptions(new FakeAccessTokenVerifier()),
          nodeEnv: 'production',
          enableProviderRoutes: true,
        },
      }),
    ).toThrow(/fail-closed/i);
  });
});
