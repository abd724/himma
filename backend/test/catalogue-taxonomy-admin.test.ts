/**
 * Slice 4 — internal taxonomy administration (docs/28 §9 "0007.5", §15,
 * §16.3; docs/24 §2.1/§10.2; D-S4-3). Real PostgreSQL + Fastify injection:
 * operations-only authority on the existing admin policy, create/edit for
 * area/category/activity_type/collection with slug immutability and
 * deactivate-only retirement, reference safety for in-use taxonomy, CAS,
 * provider isolation (providers consume, never administer), deterministic
 * seed preservation, and taxonomy.* audit/outbox atomicity + hygiene.
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
import { createProgram } from '../src/modules/catalogue/services/program-management';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/taxonomy-admin-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let ops: { userId: string; bearer: string };

async function makeAdmin(role: string): Promise<{ userId: string; bearer: string }> {
  const seeded = Number(
    (await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(testDb.db)).rows[0]
      ?.n,
  );
  let approverA: string;
  let approverB: string;
  if (seeded > 0) {
    const admins = await sql<{ user_id: string }>`
      SELECT user_id FROM admin_role_assignment
      WHERE role = 'access_admin' AND state = 'active' LIMIT 2`.execute(testDb.db);
    approverA = admins.rows[0]!.user_id;
    approverB = admins.rows[1]!.user_id;
  } else {
    ({ adminA: approverA, adminB: approverB } = await bootstrapAccessAdmins(testDb.db));
  }
  const userId = await createUser(testDb.db);
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${approverA}, ${approverB})`.execute(
    testDb.db,
  );
  const { bearer } = await bearerForUser(ctx, userId);
  return { userId, bearer };
}

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
  ops = await makeAdmin('operations');
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, bearer?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function createCategory(slug: string, labelEn = 'Test Category'): Promise<{ id: string; version: number }> {
  const response = await inject('POST', '/admin/taxonomy/categories', ops.bearer, {
    slug,
    labelEn,
    sortHint: 500,
  });
  if (response.statusCode !== 200) throw new Error(response.body);
  return response.json().category;
}

describe('authorization (docs/24 §10.2: taxonomy is operations-only)', () => {
  it('grants exactly the operations role; every other admin role is refused', async () => {
    for (const role of ['support', 'finance', 'auditor'] as const) {
      const admin = await makeAdmin(role);
      const read = await inject('GET', '/admin/taxonomy', admin.bearer);
      expect(`${role}:read:${read.statusCode}`).toBe(`${role}:read:403`);
      const write = await inject('POST', '/admin/taxonomy/areas', admin.bearer, {
        slug: `denied-${role}`,
        labelEn: 'Denied',
      });
      expect(`${role}:write:${write.statusCode}`).toBe(`${role}:write:403`);
    }
    const seededAccessAdmin = await sql<{ user_id: string }>`
      SELECT user_id FROM admin_role_assignment
      WHERE role = 'access_admin' AND state = 'active' LIMIT 1`.execute(testDb.db);
    const accessAdmin = await bearerForUser(ctx, seededAccessAdmin.rows[0]!.user_id);
    expect((await inject('GET', '/admin/taxonomy', accessAdmin.bearer)).statusCode).toBe(403);
    expect((await inject('GET', '/admin/taxonomy', ops.bearer)).statusCode).toBe(200);
  });

  it('provider bearers, customer bearers, Cognito claims, and anonymous callers get nothing', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, org.orgId, 'owner');
    expect((await inject('GET', '/admin/taxonomy', owner.bearer)).statusCode).toBe(403);
    expect(
      (
        await inject('POST', '/admin/taxonomy/categories', owner.bearer, {
          slug: 'provider-made',
          labelEn: 'Nope',
        })
      ).statusCode,
    ).toBe(403);

    const customer = await bearerForUser(ctx, await createUser(testDb.db), {
      scopes: ['openid', 'cognito:groups:taxonomy-admin', 'custom:role:operations'],
    });
    expect((await inject('GET', '/admin/taxonomy', customer.bearer)).statusCode).toBe(403);
    expect((await inject('GET', '/admin/taxonomy')).statusCode).toBe(401);
  });

  it('revoked operations authority bites on the very next request', async () => {
    const shortLived = await makeAdmin('operations');
    expect((await inject('GET', '/admin/taxonomy', shortLived.bearer)).statusCode).toBe(200);
    await sql`UPDATE admin_role_assignment SET state = 'revoked'
              WHERE user_id = ${shortLived.userId} AND role = 'operations'`.execute(testDb.db);
    expect((await inject('GET', '/admin/taxonomy', shortLived.bearer)).statusCode).toBe(403);
  });
});

describe('creation and editing (docs/24 §2.1 shapes; English required, Arabic optional)', () => {
  it('creates an area, category, activity type, and collection with English-only content', async () => {
    const area = await inject('POST', '/admin/taxonomy/areas', ops.bearer, {
      slug: 'khalifa-city',
      labelEn: 'Khalifa City',
      city: 'Abu Dhabi',
      sortHint: 10,
    });
    expect(area.statusCode).toBe(200);
    expect(area.json().area).toMatchObject({
      slug: 'khalifa-city',
      labelEn: 'Khalifa City',
      labelAr: null,
      active: true,
      version: 1,
    });

    const category = await createCategory('test-adventure', 'Adventure & outdoors');
    expect(category.version).toBe(1);

    const type = await inject('POST', '/admin/taxonomy/activity-types', ops.bearer, {
      slug: 'test-hiking',
      categoryId: category.id,
      labelEn: 'Hiking',
      synonymsEn: ['trekking', 'hill walking'],
    });
    expect(type.statusCode).toBe(200);
    expect(type.json().activityType).toMatchObject({
      slug: 'test-hiking',
      categoryId: category.id,
      synonymsEn: ['trekking', 'hill walking'],
      synonymsAr: [],
      active: true,
    });

    const collection = await inject('POST', '/admin/taxonomy/collections', ops.bearer, {
      titleEn: 'Weekend adventures',
      presetCamps: true,
      audience: 'all',
      state: 'draft',
    });
    expect(collection.statusCode).toBe(200);
    expect(collection.json().collection).toMatchObject({
      titleEn: 'Weekend adventures',
      titleAr: null,
      presetCamps: true,
      state: 'draft',
      version: 1,
    });
  });

  it('requires English labels and a real parent category; ghost parents are typed refusals', async () => {
    const missingLabel = await inject('POST', '/admin/taxonomy/categories', ops.bearer, {
      slug: 'no-label',
      labelEn: '',
    });
    expect(missingLabel.statusCode).toBe(422);
    const orphanType = await inject('POST', '/admin/taxonomy/activity-types', ops.bearer, {
      slug: 'orphan-type',
      categoryId: newId(),
      labelEn: 'Orphan',
    });
    expect(orphanType.statusCode).toBe(422);
    expect(orphanType.json().code).toBe('invalidTaxonomy');
    expect(orphanType.body).not.toMatch(/fk_|constraint|violates/i);
  });

  it('slugs are unique with a typed conflict, and immutable: no edit can rename or re-identify a row', async () => {
    await createCategory('test-unique-slug');
    const duplicate = await inject('POST', '/admin/taxonomy/categories', ops.bearer, {
      slug: 'test-unique-slug',
      labelEn: 'Duplicate',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('slugConflict');
    expect(duplicate.body).not.toMatch(/uq_|constraint/i);

    // The PATCH contract cannot express slug/id changes at all.
    const target = await createCategory('test-immutable-slug');
    const smuggled = await inject(
      'PATCH',
      `/admin/taxonomy/categories/${target.id}`,
      ops.bearer,
      { expectedVersion: 1, slug: 'renamed', labelEn: 'Renamed Label' },
    );
    expect(smuggled.statusCode).toBe(200); // undeclared fields are stripped
    const row = await sql<{ slug: string; label_en: string; id: string }>`
      SELECT id, slug, label_en FROM category WHERE id = ${target.id}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({
      id: target.id,
      slug: 'test-immutable-slug',
      label_en: 'Renamed Label',
    });
  });

  it('edits mutable fields with CAS: stale writers lose deterministically', async () => {
    const category = await createCategory('test-cas-category');
    const first = await inject('PATCH', `/admin/taxonomy/categories/${category.id}`, ops.bearer, {
      expectedVersion: 1,
      labelAr: 'مغامرات',
      sortHint: 42,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().category).toMatchObject({ labelAr: 'مغامرات', sortHint: 42, version: 2 });
    const stale = await inject('PATCH', `/admin/taxonomy/categories/${category.id}`, ops.bearer, {
      expectedVersion: 1,
      labelEn: 'Stale write',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    const ghost = await inject('PATCH', `/admin/taxonomy/categories/${newId()}`, ops.bearer, {
      expectedVersion: 1,
      labelEn: 'Ghost',
    });
    expect(ghost.statusCode).toBe(404);
  });

  it('edits collection editorial fields including preset booleans and state', async () => {
    const created = await inject('POST', '/admin/taxonomy/collections', ops.bearer, {
      titleEn: 'Editable Collection',
    });
    const collectionId = created.json().collection.id;
    const updated = await inject('PATCH', `/admin/taxonomy/collections/${collectionId}`, ops.bearer, {
      expectedVersion: 1,
      subtitleEn: 'Now with a subtitle',
      presetLadiesOnly: true,
      audience: 'adults',
      featured: true,
      state: 'published',
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().collection).toMatchObject({
      subtitleEn: 'Now with a subtitle',
      presetLadiesOnly: true,
      audience: 'adults',
      featured: true,
      state: 'published',
      version: 2,
    });
    const badState = await inject('PATCH', `/admin/taxonomy/collections/${collectionId}`, ops.bearer, {
      expectedVersion: 2,
      state: 'live',
    });
    expect(badState.statusCode).toBe(422);
  });
});

describe('deactivation and reference safety (deactivation, never deletion)', () => {
  it('deactivates and reactivates taxonomy without touching identity or history', async () => {
    const category = await createCategory('test-toggle');
    const off = await inject('PATCH', `/admin/taxonomy/categories/${category.id}`, ops.bearer, {
      expectedVersion: 1,
      active: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().category).toMatchObject({ id: category.id, active: false });
    const on = await inject('PATCH', `/admin/taxonomy/categories/${category.id}`, ops.bearer, {
      expectedVersion: 2,
      active: true,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().category.active).toBe(true);
  });

  it('deactivating in-use taxonomy never cascades: programs and branches keep their references untouched', async () => {
    // Build an in-use graph: category → type → program; area → branch.
    const category = await createCategory('test-in-use');
    const type = await inject('POST', '/admin/taxonomy/activity-types', ops.bearer, {
      slug: 'test-in-use-type',
      categoryId: category.id,
      labelEn: 'In Use',
    });
    const typeId = type.json().activityType.id;
    const org = await createProviderOrg(testDb.db);
    const scope: OrgScope = {
      organizationId: org.orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const program = await createProgram(
      { db: testDb.db },
      scope,
      { userId: newId() },
      {
        titleEn: 'Uses Deactivated Type',
        activityTypeId: typeId,
        setting: 'outdoor',
        genderEligibility: 'mixed',
      },
    );
    if (program.kind !== 'programCreated') throw new Error(program.kind);
    const area = await inject('POST', '/admin/taxonomy/areas', ops.bearer, {
      slug: 'test-in-use-area',
      labelEn: 'In Use Area',
    });
    const areaId = area.json().area.id;
    const branchId = org.branchIds[0]!;
    await sql`UPDATE branch SET area_id = ${areaId} WHERE id = ${branchId}`.execute(testDb.db);

    // Deactivate everything in the chain.
    for (const [url, version] of [
      [`/admin/taxonomy/activity-types/${typeId}`, 1],
      [`/admin/taxonomy/categories/${category.id}`, 1],
      [`/admin/taxonomy/areas/${areaId}`, 1],
    ] as const) {
      const response = await inject('PATCH', url, ops.bearer, {
        expectedVersion: version,
        active: false,
      });
      expect(response.statusCode).toBe(200);
    }

    // Nothing cascaded, nothing was rewritten, nothing vanished.
    const programRow = await sql<{ activity_type_id: string; listing_state: string }>`
      SELECT activity_type_id, listing_state FROM program WHERE id = ${program.program.id}`.execute(
      testDb.db,
    );
    expect(programRow.rows[0]).toEqual({ activity_type_id: typeId, listing_state: 'draft' });
    const branchRow = await sql<{ area_id: string | null; active: boolean }>`
      SELECT area_id, active FROM branch WHERE id = ${branchId}`.execute(testDb.db);
    expect(branchRow.rows[0]).toEqual({ area_id: areaId, active: true });
    const typeRow = await sql<{ id: string; active: boolean }>`
      SELECT id, active FROM activity_type WHERE id = ${typeId}`.execute(testDb.db);
    expect(typeRow.rows[0]).toEqual({ id: typeId, active: false });
  });

  it('providers can no longer SELECT a deactivated type for new listings (S4-2 validation intact)', async () => {
    const category = await createCategory('test-retired-parent');
    const type = await inject('POST', '/admin/taxonomy/activity-types', ops.bearer, {
      slug: 'test-retired-type',
      categoryId: category.id,
      labelEn: 'Retired',
    });
    const typeId = type.json().activityType.id;
    await inject('PATCH', `/admin/taxonomy/activity-types/${typeId}`, ops.bearer, {
      expectedVersion: 1,
      active: false,
    });
    const org = await createProviderOrg(testDb.db);
    const scope: OrgScope = {
      organizationId: org.orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const refused = await createProgram(
      { db: testDb.db },
      scope,
      { userId: newId() },
      {
        titleEn: 'Wants Retired Type',
        activityTypeId: typeId,
        setting: 'indoor',
        genderEligibility: 'mixed',
      },
    );
    expect(refused.kind).toBe('invalidTaxonomy');
  });
});

describe('seed integrity (D-S4-3: the docs/15 §3 launch content is data)', () => {
  it('administration leaves the deterministic seed intact: 11 categories + 2 lens collections, no duplicates', async () => {
    const seededCategories = await sql<{ slug: string }>`
      SELECT slug FROM category WHERE id::text LIKE '01986aa0-%' ORDER BY sort_hint`.execute(
      testDb.db,
    );
    expect(seededCategories.rows.map((row) => row.slug)).toEqual([
      'fitness',
      'martial-arts',
      'swimming',
      'padel-racquet',
      'pilates-yoga',
      'team-outdoor',
      'wellness',
      'learning',
      'quran',
      'tech-stem',
      'arts-creativity',
    ]);
    const duplicates = await sql<{ slug: string; n: string }>`
      SELECT slug, count(*) AS n FROM category GROUP BY slug HAVING count(*) > 1`.execute(testDb.db);
    expect(duplicates.rows).toEqual([]);
    const lenses = await sql<{ title_en: string }>`
      SELECT title_en FROM collection WHERE id::text LIKE '01986aa0-%' ORDER BY id`.execute(
      testDb.db,
    );
    expect(lenses.rows.map((row) => row.title_en)).toEqual(['Kids & Teens', 'Camps & seasonal']);
    // The admin read serves the actual database rows, seed included.
    const view = await inject('GET', '/admin/taxonomy', ops.bearer);
    const categorySlugs = view.json().categories.map((row: { slug: string }) => row.slug);
    expect(categorySlugs).toEqual(expect.arrayContaining(['fitness', 'martial-arts']));
  });
});

describe('audit/outbox and route boundary', () => {
  it('taxonomy mutations write audit + taxonomy.* outbox events atomically with ids-only payloads', async () => {
    const category = await createCategory('test-evented');
    await inject('PATCH', `/admin/taxonomy/categories/${category.id}`, ops.bearer, {
      expectedVersion: 1,
      active: false,
    });
    const events = await sql<{ event_type: string; payload: Record<string, unknown> }>`
      SELECT event_type, payload FROM outbox_event
      WHERE aggregate_type = 'taxonomy' AND aggregate_id = ${category.id}
      ORDER BY sequence_no`.execute(testDb.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'taxonomy.category_changed',
      'taxonomy.category_changed',
    ]);
    for (const event of events.rows) {
      for (const [key, value] of Object.entries(event.payload)) {
        expect(['categoryId', 'change'].includes(key)).toBe(true);
        expect(typeof value).toBe('string');
        expect(String(value).length).toBeLessThanOrEqual(64);
      }
    }
    const audit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'taxonomy.category_changed' AND entity_id = ${category.id}`.execute(testDb.db);
    expect(Number(audit.rows[0]?.n)).toBe(2);
    // A refused mutation (stale CAS) emits nothing.
    await inject('PATCH', `/admin/taxonomy/categories/${category.id}`, ops.bearer, {
      expectedVersion: 99,
      labelEn: 'Stale',
    });
    const after = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_type = 'taxonomy' AND aggregate_id = ${category.id}`.execute(testDb.db);
    expect(Number(after.rows[0]?.n)).toBe(2);
  });

  it('the inventory gains exactly the nine taxonomy-admin routes and no later-slice surface', () => {
    const taxonomyRoutes = app.routePolicyInventory.filter(
      (route) => route.url.startsWith('/admin/taxonomy') && route.method !== 'HEAD',
    );
    expect(taxonomyRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual(
      [
        'GET /admin/taxonomy',
        'POST /admin/taxonomy/areas',
        'PATCH /admin/taxonomy/areas/:areaId',
        'POST /admin/taxonomy/categories',
        'PATCH /admin/taxonomy/categories/:categoryId',
        'POST /admin/taxonomy/activity-types',
        'PATCH /admin/taxonomy/activity-types/:activityTypeId',
        'POST /admin/taxonomy/collections',
        'PATCH /admin/taxonomy/collections/:collectionId',
      ].sort(),
    );
    for (const route of taxonomyRoutes) {
      expect(route.policy).toBe('admin');
    }
    // The customer-public /listings, /catalogue/*, /providers/:id/listings,
    // and /search reads arrived legitimately with their owner-approved
    // Slice-4 tasks (locked by catalogue-public.test.ts and
    // catalogue-search.test.ts); the session/booking/payment domains still
    // must not exist.
    const forbidden = app.routePolicyInventory.filter((route) =>
      /^\/(programs|sessions|bookings|payments)([/?]|$)/.test(route.url),
    );
    expect(forbidden).toEqual([]);
  });
});
