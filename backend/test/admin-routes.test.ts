/**
 * B2-5 — administrative HTTP routes (docs/26 §10) behind the B2-4 policy
 * registry: a new explicit `admin` policy requiring a live session, MFA
 * assurance, and active Himma database roles. Production registration is
 * FAIL-CLOSED until B2-6 (admin MFA enforcement) — proven below.
 */
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { firstLogin } from '../src/modules/identity/services/first-login';
import { establishSession } from '../src/modules/identity/services/sessions';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { bootstrapAccessAdmins } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/admin-routes-pool';
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
    subject: `admin-route-sub-${counter}`,
    email: `adminroute${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return result.userId;
}

/** Session-of-record for a user id — links a deterministic identity when
 *  needed and establishes a session with the requested assurance. */
async function bearerFor(
  userId: string,
  assurance: 'single_factor' | 'mfa',
): Promise<string> {
  counter += 1;
  const subject = `admin-bearer-sub-${counter}`;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject,
    emailVerified: false,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
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
  void evidence;
  // B2-6C admin enforcement: an MFA-asserting session is honored only for
  // an ENROLLED user — mint the enrollment mirror alongside mfa bearers.
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
        .values({
          id: newId(),
          user_id: userId,
          kind: 'totp',
          state: 'active',
          confirmed_at: new Date(),
        })
        .execute();
    }
  }
  const access: AccessTokenEvidence = {
    issuer: ISSUER,
    subject,
    originJti: `admin-origin-${counter}`,
    scopes: ['openid'],
    assurance,
    expiresAt: new Date(Date.now() + 3_600_000),
    authTime: new Date(),
  };
  const established = await establishSession({ db: testDb.db }, { evidence: access, client: {} });
  if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
  return accessVerifier.issueToken(access);
}

describe('admin policy category', () => {
  it('declares every admin route with an explicit admin-category policy — the /admin/me bootstrap on the baseline, every sensitive operation on adminStepUp', () => {
    const adminRoutes = app.routePolicyInventory.filter((r) => r.url.startsWith('/admin'));
    expect(adminRoutes.length).toBeGreaterThanOrEqual(5);
    // W3-1 final split (+ the W3-2 reads): ordinary internal READ surfaces
    // sit on the baseline; the pre-existing sensitive set keeps its
    // recent-factor strength — the split must never weaken it. NB the
    // /admin/organizations URL carries BOTH: GET (read, baseline) and POST
    // (creation, step-up) — the assertion is per method.
    const BASELINE = new Set([
      '/admin/me',
      '/admin/organizations',
      '/admin/organizations/:organizationId',
      '/admin/organizations/:organizationId/verification', // W3-5 workspace read
      '/admin/listings', // W3-6 moderation queue read
      '/admin/listings/:programId', // W3-6 moderation detail read
      '/admin/revisions', // W3-6 revision queue read
      '/admin/taxonomy', // W3-7 taxonomy administration read
    ]);
    for (const route of adminRoutes) {
      const isRead = (route.method === 'GET' || route.method === 'HEAD') && BASELINE.has(route.url);
      expect(`${route.method} ${route.url} → ${route.policy}`).toBe(
        `${route.method} ${route.url} → ${isRead ? 'admin' : 'adminStepUp'}`,
      );
    }
  });

  it('a normal customer session cannot reach any admin route (403 forbidden)', async () => {
    const customer = await makeCustomer();
    const bearer = await bearerFor(customer, 'mfa');
    const response = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('an admin without MFA assurance is refused with the typed mfaRequired outcome', async () => {
    const bearer = await bearerFor(adminA, 'single_factor');
    const response = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('mfaRequired');
  });

  it('no bearer at all is a plain 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/role-assignments' });
    expect(response.statusCode).toBe(401);
  });
});

describe('role-management routes', () => {
  it('supports the full lifecycle: request, self-approval refusal, approval, inspection, revocation', async () => {
    const bearerA = await bearerFor(adminA, 'mfa');
    const bearerB = await bearerFor(adminB, 'mfa');
    const target = await makeCustomer();

    const requested = await app.inject({
      method: 'POST',
      url: '/admin/role-requests',
      headers: { authorization: `Bearer ${bearerA}` },
      payload: { targetUserId: target, role: 'finance' },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().status).toBe('roleRequested');
    const assignmentId = requested.json().assignmentId as string;

    const selfApproval = await app.inject({
      method: 'POST',
      url: `/admin/role-requests/${assignmentId}/approve`,
      headers: { authorization: `Bearer ${bearerA}` },
      payload: { expectedVersion: 1 },
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(selfApproval.json().code).toBe('dualControlViolation');

    const approved = await app.inject({
      method: 'POST',
      url: `/admin/role-requests/${assignmentId}/approve`,
      headers: { authorization: `Bearer ${bearerB}` },
      payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('roleActivated');

    const inspected = await app.inject({
      method: 'GET',
      url: `/admin/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${bearerA}` },
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().assignment).toMatchObject({
      id: assignmentId,
      role: 'finance',
      state: 'active',
    });
    expect(inspected.body).not.toContain('@');

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/admin/role-assignments/${assignmentId}`,
      headers: { authorization: `Bearer ${bearerA}` },
      payload: { expectedVersion: 2 },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('roleRevoked');
  });

  it('types conflicts, stale versions, unknown assignments, and denial', async () => {
    const bearerA = await bearerFor(adminA, 'mfa');
    const bearerB = await bearerFor(adminB, 'mfa');

    // finance for an access_admin → roleConflict.
    const conflict = await app.inject({
      method: 'POST',
      url: '/admin/role-requests',
      headers: { authorization: `Bearer ${bearerA}` },
      payload: { targetUserId: adminB, role: 'finance' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('roleConflict');

    const target = await makeCustomer();
    const requested = await app.inject({
      method: 'POST',
      url: '/admin/role-requests',
      headers: { authorization: `Bearer ${bearerA}` },
      payload: { targetUserId: target, role: 'finance' },
    });
    const assignmentId = requested.json().assignmentId as string;

    const stale = await app.inject({
      method: 'POST',
      url: `/admin/role-requests/${assignmentId}/approve`,
      headers: { authorization: `Bearer ${bearerB}` },
      payload: { expectedVersion: 42 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    const denied = await app.inject({
      method: 'POST',
      url: `/admin/role-requests/${assignmentId}/deny`,
      headers: { authorization: `Bearer ${bearerB}` },
      payload: { expectedVersion: 1 },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().status).toBe('roleDenied');

    const unknown = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments/01890000-0000-7000-8000-0000000000ff',
      headers: { authorization: `Bearer ${bearerA}` },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('production fail-closed boundary (B2-6C capability gate)', () => {
  it('does not register admin routes for an unready production build, and explicit enablement throws', async () => {
    const production = buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: accessVerifier,
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
        nodeEnv: 'production',
      },
    });
    await production.ready();
    expect(
      production.routePolicyInventory.filter((r) => r.url.startsWith('/admin')),
    ).toEqual([]);
    const response = await production.inject({ method: 'GET', url: '/admin/role-assignments' });
    expect(response.statusCode).toBe(404);
    await production.close();

    expect(() =>
      buildApp({
        identity: {
          db: testDb.db,
          accessTokenVerifier: accessVerifier,
          idTokenAdapter: new FakeAuthProviderAdapter(),
          mailSender: new CaptureMailSender(),
          rateLimiterStore: new InMemoryRateLimiterStore(),
          nodeEnv: 'production',
          enableAdminRoutes: true,
        },
      }),
    ).toThrow(/fail-closed/);
  });
});
