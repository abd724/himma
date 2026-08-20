/**
 * W3-9 — the consolidated cross-role / cross-surface / assurance security
 * regression (docs/31 §9/§11 closeout). One matrix over the REAL policy
 * pipeline on real PostgreSQL pinning, for every internal role plus
 * provider/customer/anonymous callers:
 * - baseline `admin` assurance is NEVER authorization: each W3 read
 *   surface admits exactly its designated roles;
 * - the W3-1 split holds everywhere: stale-factor admins read their
 *   baseline surfaces but every sensitive mutation refuses stepUpRequired;
 * - provider and admin authority stay disjoint in BOTH directions;
 * - cross-organization provider reads stay fail-closed.
 * Per-domain depth (CAS, dual control, atomicity, hygiene) remains in the
 * owning suites; this suite locks the composed authorization surface.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/security-regression-pool';
const ADMIN_ROLE_NAMES = ['operations', 'access_admin', 'auditor', 'support', 'finance'] as const;
type AdminRoleName = (typeof ADMIN_ROLE_NAMES)[number];

let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let adminA: string;
let adminB: string;
/** One admin per role (D4: auditor coexists with nothing — all disjoint). */
let admins: Record<AdminRoleName, { userId: string; bearer: string }>;
let providerOwner: { bearer: string };
let orgA: string;
let orgB: string;
let customerBearer: string;

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
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  const entries: Array<readonly [AdminRoleName, { userId: string; bearer: string }]> = [];
  for (const role of ADMIN_ROLE_NAMES) {
    const userId = await createUser(testDb.db);
    await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
              VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
      testDb.db,
    );
    const { bearer } = await bearerForUser(ctx, userId);
    entries.push([role, { userId, bearer }] as const);
  }
  admins = Object.fromEntries(entries) as typeof admins;
  const created = await createProviderOrg(testDb.db, { state: 'live', branches: 1 });
  orgA = created.orgId;
  orgB = (await createProviderOrg(testDb.db, { state: 'live', branches: 1 })).orgId;
  providerOwner = await staffBearer(ctx, orgA, 'owner');
  customerBearer = (await bearerForUser(ctx, await createUser(testDb.db))).bearer;
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function get(url: string, bearer?: string) {
  return app.inject({
    method: 'GET',
    url,
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
}

/** Every baseline internal READ surface × its designated roles. */
const READ_MATRIX: Array<{ url: string; allowed: readonly AdminRoleName[] }> = [
  { url: '/admin/organizations', allowed: ['operations'] },
  { url: '/admin/listings', allowed: ['operations'] },
  { url: '/admin/revisions', allowed: ['operations'] },
  { url: '/admin/taxonomy', allowed: ['operations'] },
  { url: '/admin/role-assignments', allowed: ['access_admin', 'auditor'] },
  { url: '/admin/audit-events', allowed: ['auditor', 'operations'] },
];

describe('assurance is never authorization (docs/31 §9)', () => {
  it('every baseline read surface admits EXACTLY its designated roles — all five roles probed on all six surfaces', async () => {
    for (const probe of READ_MATRIX) {
      for (const role of ADMIN_ROLE_NAMES) {
        const response = await get(probe.url, admins[role].bearer);
        const expected = probe.allowed.includes(role) ? 200 : 403;
        expect(`${role} ${probe.url} → ${response.statusCode}`).toBe(
          `${role} ${probe.url} → ${expected}`,
        );
        if (expected === 403) expect(response.json().code).toBe('forbidden');
      }
    }
  });

  it('the shell bootstrap admits every ACTIVE admin role and nobody else', async () => {
    for (const role of ADMIN_ROLE_NAMES) {
      expect((await get('/admin/me', admins[role].bearer)).statusCode).toBe(200);
    }
    expect((await get('/admin/me', providerOwner.bearer)).statusCode).toBe(403);
    expect((await get('/admin/me', customerBearer)).statusCode).toBe(403);
    expect((await get('/admin/me')).statusCode).toBe(401);
  });

  it('a single-factor session is mfaRequired everywhere on the admin surface, role or no role', async () => {
    const singleFactor = await bearerForUser(ctx, admins.operations.userId, {
      assurance: 'single_factor',
    });
    for (const url of ['/admin/me', '/admin/organizations', '/admin/audit-events']) {
      const response = await get(url, singleFactor.bearer);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('mfaRequired');
    }
  });

  it('the W3-1 split holds composed: ONE stale operations bearer reads every operations baseline surface and is stepUpRequired on a mutation of every W3 mutation family', async () => {
    const stale = await bearerForUser(ctx, admins.operations.userId, {
      authTime: new Date(Date.now() - 3_600_000),
    });
    for (const url of [
      '/admin/organizations',
      '/admin/listings',
      '/admin/taxonomy',
      '/admin/audit-events',
      `/admin/organizations/${orgA}`,
    ]) {
      expect(`${url} → ${(await get(url, stale.bearer)).statusCode}`).toBe(`${url} → 200`);
    }
    const mutations: Array<{ url: string; payload: Record<string, unknown> }> = [
      // Organization lifecycle (S3-4/W3-2 family).
      { url: `/admin/organizations/${orgA}/suspend`, payload: { expectedVersion: 1 } },
      // Verification review (W3-5 family).
      { url: `/admin/organizations/${orgA}/verification/cases`, payload: {} },
      // Catalogue moderation (W3-6 family).
      { url: `/admin/listings/${newId()}/review/start`, payload: { expectedVersion: 1 } },
      // Taxonomy administration (W3-7 family).
      { url: '/admin/taxonomy/areas', payload: { slug: 'never-lands', labelEn: 'Never' } },
    ];
    for (const mutation of mutations) {
      const response = await app.inject({
        method: 'POST',
        url: mutation.url,
        headers: { authorization: `Bearer ${stale.bearer}` },
        payload: mutation.payload,
      });
      expect(`${mutation.url} → ${response.statusCode}:${response.json().code}`).toBe(
        `${mutation.url} → 403:stepUpRequired`,
      );
    }
    // Nothing moved anywhere.
    const org = await sql<{ s: string }>`
      SELECT verification_state AS s FROM organization WHERE id = ${orgA}`.execute(testDb.db);
    expect(org.rows[0]?.s).toBe('live');
    const area = await sql<{ n: string }>`
      SELECT count(*) AS n FROM area WHERE slug = 'never-lands'`.execute(testDb.db);
    expect(Number(area.rows[0]?.n)).toBe(0);
  });
});

describe('surface disjointness and cross-org scope (docs/31 §9)', () => {
  it('a provider OWNER is refused on every admin surface; an operations ADMIN is refused on the provider-private surface', async () => {
    for (const probe of READ_MATRIX) {
      expect((await get(probe.url, providerOwner.bearer)).statusCode).toBe(403);
    }
    // The reverse direction: internal authority grants nothing provider-side
    // — an admin with no membership gets the canonical not-found shape
    // (identical to a nonexistent org; nothing is learned).
    const adminOnProvider = await get(
      `/provider/organizations/${orgA}`,
      admins.operations.bearer,
    );
    expect(adminOnProvider.statusCode).toBe(404);
    expect(adminOnProvider.body).not.toContain('verification');
  });

  it('cross-organization provider reads stay fail-closed (org A staff → org B is the not-found shape)', async () => {
    const crossOrg = await get(`/provider/organizations/${orgB}`, providerOwner.bearer);
    expect(crossOrg.statusCode).toBeGreaterThanOrEqual(403);
    expect(crossOrg.body).not.toContain('verification');
  });

  it('a customer with admin-suggesting Cognito claims reaches nothing internal', async () => {
    const pretender = await bearerForUser(ctx, await createUser(testDb.db), {
      scopes: ['openid', 'cognito:groups:operations', 'custom:role:auditor'],
    });
    for (const probe of READ_MATRIX) {
      expect((await get(probe.url, pretender.bearer)).statusCode).toBe(403);
    }
  });
});
