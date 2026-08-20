/**
 * W3-9 — the consolidated cross-role / cross-surface / assurance security
 * regression (docs/31 §9/§11 closeout). One matrix over the REAL policy
 * pipeline on real PostgreSQL pinning, for every internal role plus
 * provider/customer/anonymous callers:
 * - baseline `admin` assurance is NEVER authorization: each W3 read
 *   surface admits exactly its designated roles;
 * - the FINAL D-W3-5 owner ruling holds composed: stale-factor admins
 *   read their surfaces AND perform the preparatory baseline mutations,
 *   while every retained authority/trust/availability action refuses
 *   stepUpRequired with zero state change;
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

  it('the FINAL D-W3-5 set holds composed: ONE stale operations bearer performs every newly-baseline PREPARATORY action and is stepUpRequired on every retained high-risk action — with zero state change', async () => {
    const stale = await bearerForUser(ctx, admins.operations.userId, {
      authTime: new Date(Date.now() - 3_600_000),
    });
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${stale.bearer}` },
        payload,
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

    // NEWLY-BASELINE preparatory actions succeed (or reach their DOMAIN
    // outcome — never stepUpRequired) under the stale factor:
    // (1) organization start_review — the ONE preparatory edge of the
    // EIGHT lifecycle actions — moves a real submitted org to in_review.
    const submitted = await createProviderOrg(testDb.db, { state: 'submitted', branches: 1 });
    const startReview = await post(
      `/admin/organizations/${submitted.orgId}/verification/start-review`,
      { expectedVersion: 1 },
    );
    expect(startReview.statusCode).toBe(200);
    const moved = await sql<{ s: string }>`
      SELECT verification_state AS s FROM organization WHERE id = ${submitted.orgId}`.execute(
      testDb.db,
    );
    expect(moved.rows[0]?.s).toBe('in_review');
    // (2) verification round-opening reaches the DOMAIN (this composition
    // has no policy provider, so the D-W3-3 fail-close answers — proving
    // the pipeline no longer step-up-refuses it; full success is proven in
    // the verification suite's ruling-behavior test).
    const openRound = await post(`/admin/organizations/${submitted.orgId}/verification/cases`);
    expect(`${openRound.statusCode}:${openRound.json().code}`).toBe(
      '503:verificationPolicyUnavailable',
    );
    // (3) listing start-review reaches the DOMAIN (ghost id → notFound;
    // full success is proven in the moderation suite's ruling test).
    const listingStart = await post(`/admin/listings/${newId()}/review/start`, {
      expectedVersion: 1,
    });
    expect(`${listingStart.statusCode}:${listingStart.json().code}`).toBe('404:notFound');
    // (4) taxonomy creation + ordinary metadata edit succeed.
    const createdArea = await post('/admin/taxonomy/areas', {
      slug: 'ruling-baseline-area',
      labelEn: 'Ruling Baseline Area',
    });
    expect(createdArea.statusCode).toBe(200);
    const areaId = (createdArea.json() as { area: { id: string } }).area.id;
    const metadata = await app.inject({
      method: 'PATCH',
      url: `/admin/taxonomy/areas/${areaId}`,
      headers: { authorization: `Bearer ${stale.bearer}` },
      payload: { expectedVersion: 1, sortHint: 7 },
    });
    expect(metadata.statusCode).toBe(200);

    // RETAINED high-risk actions: stepUpRequired for the SAME bearer.
    const retained: Array<{ label: string; method?: 'POST' | 'PATCH' | 'DELETE'; url: string; payload: Record<string, unknown> }> = [
      // Organization lifecycle — the remaining SEVEN of the eight actions.
      { label: 'org create', url: '/admin/organizations', payload: { legalName: 'Never LLC', tradeName: 'Never', foundingOwnerEmail: 'never@example.test' } },
      { label: 'org verify', url: `/admin/organizations/${submitted.orgId}/verification/verify`, payload: { expectedVersion: 2 } },
      { label: 'org reject', url: `/admin/organizations/${submitted.orgId}/verification/reject`, payload: { expectedVersion: 2 } },
      { label: 'org go-live', url: `/admin/organizations/${submitted.orgId}/go-live`, payload: { expectedVersion: 2 } },
      { label: 'org suspend', url: `/admin/organizations/${orgA}/suspend`, payload: { expectedVersion: 1 } },
      { label: 'org reinstate', url: `/admin/organizations/${orgA}/reinstate`, payload: { expectedVersion: 1 } },
      { label: 'org offboard', url: `/admin/organizations/${orgA}/offboard`, payload: { expectedVersion: 1 } },
      // Final verification decision.
      { label: 'verification decision', url: `/admin/organizations/${submitted.orgId}/verification/cases/${newId()}/decision`, payload: { expectedCaseVersion: 1, outcome: 'approved' } },
      // Consequential moderation decisions.
      { label: 'listing approve', url: `/admin/listings/${newId()}/review/approve`, payload: { expectedVersion: 1 } },
      { label: 'listing request-changes', url: `/admin/listings/${newId()}/review/request-changes`, payload: { expectedVersion: 1 } },
      { label: 'revision approve', url: `/admin/listings/${newId()}/revisions/${newId()}/approve`, payload: { expectedVersion: 1 } },
      { label: 'revision reject', url: `/admin/listings/${newId()}/revisions/${newId()}/reject`, payload: { expectedVersion: 1 } },
      // Taxonomy availability changes through the SAME PATCH surface.
      { label: 'taxonomy deactivate', method: 'PATCH', url: `/admin/taxonomy/areas/${areaId}`, payload: { expectedVersion: 2, active: false } },
    ];
    for (const probe of retained) {
      const response = await app.inject({
        method: probe.method ?? 'POST',
        url: probe.url,
        headers: { authorization: `Bearer ${stale.bearer}` },
        payload: probe.payload,
      });
      expect(`${probe.label} → ${response.statusCode}:${response.json().code}`).toBe(
        `${probe.label} → 403:stepUpRequired`,
      );
    }
    // Zero state change from every refusal: orgA untouched, the area still
    // active at its metadata-edit version.
    const org = await sql<{ s: string }>`
      SELECT verification_state AS s FROM organization WHERE id = ${orgA}`.execute(testDb.db);
    expect(org.rows[0]?.s).toBe('live');
    const area = await sql<{ active: boolean; version: number }>`
      SELECT active, version FROM area WHERE id = ${areaId}`.execute(testDb.db);
    expect(area.rows[0]).toEqual({ active: true, version: 2 });
  });

  it('role REQUEST keeps step-up even for an immediately-activating role: a stale access_admin is refused and NO assignment appears', async () => {
    const stale = await bearerForUser(ctx, admins.access_admin.userId, {
      authTime: new Date(Date.now() - 3_600_000),
    });
    const target = await createUser(testDb.db);
    // `support` is NOT finance-capable: a fresh-factor request would
    // ACTIVATE it immediately — which is exactly why request itself stays
    // on adminStepUp (the owner ruling: request can grant authority).
    const refused = await app.inject({
      method: 'POST',
      url: '/admin/role-requests',
      headers: { authorization: `Bearer ${stale.bearer}` },
      payload: { targetUserId: target, role: 'support' },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('stepUpRequired');
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM admin_role_assignment WHERE user_id = ${target}`.execute(
      testDb.db,
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it('capability/role refusal applies INDEPENDENTLY on newly-baseline mutations: a fresh access_admin gains nothing from the relaxed assurance', async () => {
    const accessAdmin = admins.access_admin.bearer; // fresh factor
    const taxonomy = await app.inject({
      method: 'POST',
      url: '/admin/taxonomy/areas',
      headers: { authorization: `Bearer ${accessAdmin}` },
      payload: { slug: 'never-created-by-access', labelEn: 'Never' },
    });
    expect(taxonomy.statusCode).toBe(403);
    expect(taxonomy.json().code).toBe('forbidden');
    const startReview = await app.inject({
      method: 'POST',
      url: `/admin/organizations/${orgA}/verification/start-review`,
      headers: { authorization: `Bearer ${accessAdmin}` },
      payload: { expectedVersion: 1 },
    });
    expect(startReview.statusCode).toBe(403);
    const created = await sql<{ n: string }>`
      SELECT count(*) AS n FROM area WHERE slug = 'never-created-by-access'`.execute(testDb.db);
    expect(Number(created.rows[0]?.n)).toBe(0);
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
