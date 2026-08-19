/**
 * W3-2 — the internal admin organization READ model (docs/31 §11):
 * GET /admin/organizations (directory + review queue) and
 * GET /admin/organizations/:organizationId (operations detail), on real
 * PostgreSQL through the real policy pipeline.
 *
 * The full §33/§34/§35 matrix: operations-only authority (no other admin
 * role, no provider, no customer, no Cognito claims), authoritative
 * search/filter before pagination, keyset walk correctness, the exact
 * per-state review-queue predicate, projection truth, detail privacy, and
 * the constant-statement-count (no-N+1) proof.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { createPool } from '../src/db/pool';
import type { DB } from '../src/db/kysely';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import {
  listAdminOrganizations,
  reviewStateOf,
  REVIEW_QUEUE_STATES,
  ORGANIZATION_STATES,
} from '../src/modules/provider/services/organization-admin-read';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { bootstrapAccessAdmins, createAccount, createUser } from './helpers/identity-fixtures';
import {
  addMembership,
  bearerForUser,
  createProviderOrg,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/admin-org-reads-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let adminA: string;
let adminB: string;

/** Seeded state → orgId (one per canonical state) for predicate pinning. */
const orgByState = new Map<string, string>();
let opsBearer: string;
let opsUserId: string;
/** All org ids this suite seeded (the suite owns the whole database). */
const seededOrgIds = new Set<string>();

async function grantRole(userId: string, role: AdminRole): Promise<void> {
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
}

async function adminBearer(role: AdminRole): Promise<string> {
  const userId = await createUser(testDb.db);
  await grantRole(userId, role);
  return (await bearerForUser(ctx, userId)).bearer;
}

function list(bearer: string | undefined, query = '') {
  return app.inject({
    method: 'GET',
    url: `/admin/organizations${query}`,
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
}

function detail(bearer: string, organizationId: string) {
  return app.inject({
    method: 'GET',
    url: `/admin/organizations/${organizationId}`,
    headers: { authorization: `Bearer ${bearer}` },
  });
}

async function seedOrg(
  state: string,
  displayName: string,
  options: { legalName?: string; branches?: number } = {},
): Promise<string> {
  const { orgId } = await createProviderOrg(testDb.db, {
    state,
    displayName,
    ...(options.legalName !== undefined ? { legalName: options.legalName } : {}),
    branches: options.branches ?? 1,
  });
  seededOrgIds.add(orgId);
  return orgId;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };

  opsUserId = await createUser(testDb.db);
  await grantRole(opsUserId, 'operations');
  opsBearer = (await bearerForUser(ctx, opsUserId)).bearer;

  // One organization per canonical state — the §35 predicate matrix seeds.
  orgByState.set('draft', await seedOrg('draft', 'Pearl Diving Centre'));
  orgByState.set('submitted', await seedOrg('submitted', 'Blue Wave Swimming'));
  orgByState.set('in_review', await seedOrg('in_review', 'Desert Climb Club'));
  orgByState.set(
    'verified',
    await seedOrg('verified', 'Falcon Karate Academy', { legalName: 'Aquatic Ventures LLC' }),
  );
  orgByState.set('rejected', await seedOrg('rejected', 'Oasis Yoga Studio'));
  orgByState.set('live', await seedOrg('live', 'Marina Tennis', { branches: 3 }));
  orgByState.set('suspended', await seedOrg('suspended', 'Sunset Riding School'));
  orgByState.set('offboarded', await seedOrg('offboarded', 'Retired Gym'));
  // The live org's storefront is published (effectively public); the
  // submitted org is ALSO published — intent without liveness stays
  // invisible (Amendment A1), which the projection must show truthfully.
  await sql`UPDATE organization_public_profile SET published = true
            WHERE organization_id IN (${orgByState.get('live')!}, ${orgByState.get('submitted')!})`.execute(
    testDb.db,
  );
  // Branch-count truth: one of Marina Tennis's three branches is inactive.
  await sql`UPDATE branch SET active = false WHERE organization_id = ${orgByState.get('live')!}
            AND id IN (SELECT id FROM branch WHERE organization_id = ${orgByState.get('live')!}
                       ORDER BY created_at LIMIT 1)`.execute(testDb.db);
  // Wildcard-literal search target.
  orgByState.set('wildcard', await seedOrg('live', 'Fun 100% Padel_Club'));
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('directory authorization (§33.1–5, §30)', () => {
  it('an operations admin lists the complete directory — one row per organization', async () => {
    const response = await list(opsBearer, '?limit=100');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { organizations: Array<{ organizationId: string }> };
    const ids = body.organizations.map((row) => row.organizationId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates, ever
    expect(new Set(ids)).toEqual(seededOrgIds);
  });

  it.each(['access_admin', 'auditor', 'support', 'finance'] as const)(
    'a %s admin is refused — provider operational data is operations-only in current canon',
    async (role) => {
      const response = await list(await adminBearer(role));
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('forbidden');
    },
  );

  it('a provider staff identity is refused: cross-provider membership grants no internal directory', async () => {
    const providerUser = await createUser(testDb.db);
    await addMembership(testDb.db, providerUser, orgByState.get('live')!, 'owner');
    const { bearer } = await bearerForUser(ctx, providerUser);
    expect((await list(bearer)).statusCode).toBe(403);
    // …and the detail route is no enumeration oracle either: an EXISTING
    // organization id answers exactly like a nonexistent one (403, before
    // any existence lookup).
    expect((await detail(bearer, orgByState.get('live')!)).statusCode).toBe(403);
    expect((await detail(bearer, newId())).statusCode).toBe(403);
  });

  it('a customer identity and admin-looking Cognito scopes are refused; no bearer is 401', async () => {
    const customer = await createUser(testDb.db);
    const { bearer } = await bearerForUser(ctx, customer, {
      scopes: ['openid', 'aws.cognito.signin.user.admin', 'himma/admin'],
    });
    expect((await list(bearer)).statusCode).toBe(403);
    expect((await list(undefined)).statusCode).toBe(401);
  });
});

describe('authoritative search and filters (§33.6–14, §7/§8)', () => {
  it('name search is case-insensitive, whitespace-normalized, and matches display, trade, and legal names', async () => {
    const byDisplay = await list(opsBearer, '?q=blue%20%20WAVE');
    expect(byDisplay.statusCode).toBe(200);
    expect(byDisplay.json().organizations.map((row: { displayName: string }) => row.displayName)).toEqual([
      'Blue Wave Swimming',
    ]);
    // Legal name is a legitimate management identifier (ops pastes it from
    // documents) — never exposed in the summary row, still searchable.
    const byLegal = await list(opsBearer, '?q=aquatic%20ventures');
    expect(byLegal.json().organizations.map((row: { displayName: string }) => row.displayName)).toEqual([
      'Falcon Karate Academy',
    ]);
  });

  it('LIKE wildcards are literal text; blank search applies no predicate', async () => {
    const wildcard = await list(opsBearer, `?q=${encodeURIComponent('100% Padel_Club')}`);
    expect(wildcard.json().organizations.map((row: { displayName: string }) => row.displayName)).toEqual([
      'Fun 100% Padel_Club',
    ]);
    const blank = await list(opsBearer, '?q=%20%20&limit=100');
    expect(blank.json().organizations.length).toBe(seededOrgIds.size);
  });

  it('the state filter is exact; an invalid state fails schema validation (422); search composes conjunctively', async () => {
    const live = await list(opsBearer, '?state=live&limit=100');
    const liveRows = live.json().organizations as Array<{
      organizationId: string;
      verificationState: string;
    }>;
    expect(liveRows.every((row) => row.verificationState === 'live')).toBe(true);
    expect(liveRows.map((row) => row.organizationId)).toContain(orgByState.get('live'));

    expect((await list(opsBearer, '?state=very_live')).statusCode).toBe(422);
    expect((await list(opsBearer, '?needsReview=maybe')).statusCode).toBe(422);

    // Conjunctive composition: the search term matches a live org, but the
    // state predicate excludes it.
    const conjunctive = await list(opsBearer, '?q=marina&state=draft');
    expect(conjunctive.json().organizations).toEqual([]);
  });

  it('filtering happens BEFORE pagination: a filtered walk visits every match exactly once, holding filters constant', async () => {
    // Grow the queue set beyond one page.
    const extraIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      extraIds.push(await seedOrg('submitted', `Queue Extra ${i + 1}`));
    }
    const expected = new Set([
      orgByState.get('submitted')!,
      orgByState.get('in_review')!,
      orgByState.get('verified')!,
      ...extraIds,
    ]);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?needsReview=true&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const response = await list(opsBearer, query);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        organizations: Array<{ organizationId: string; reviewState: string }>;
        nextCursor: string | null;
      };
      for (const row of body.organizations) {
        expect(seen.has(row.organizationId)).toBe(false); // no duplicates
        expect(row.reviewState).not.toBe('none'); // the filter held on every page
        seen.add(row.organizationId);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(expected); // no skips
    expect(pages).toBeGreaterThan(1); // proves it actually paged

    // A stale/unknown cursor is deterministic and safe: the walk restarts
    // from the beginning of the filtered set instead of erroring.
    const stale = await list(opsBearer, `?needsReview=true&limit=3&cursor=${newId()}`);
    expect(stale.statusCode).toBe(200);
    expect(stale.json().organizations.length).toBe(3);
  });
});

describe('projection truth and the review-queue predicate (§33.15–18, §35)', () => {
  it('pins the derived review state for EVERY canonical organization state', () => {
    // The exact deterministic function — state-driven, no time/SLA/risk.
    expect(reviewStateOf('submitted')).toBe('awaiting_review');
    expect(reviewStateOf('in_review')).toBe('in_review');
    expect(reviewStateOf('verified')).toBe('awaiting_go_live');
    for (const state of ['draft', 'rejected', 'live', 'suspended', 'offboarded']) {
      expect(reviewStateOf(state)).toBe('none');
    }
    expect([...REVIEW_QUEUE_STATES]).toEqual(['submitted', 'in_review', 'verified']);
    expect(ORGANIZATION_STATES).toHaveLength(8);
  });

  it('the queue includes exactly the states requiring HIMMA action — pinned per seeded organization', async () => {
    const response = await list(opsBearer, '?needsReview=true&limit=100');
    const ids = new Set(
      (response.json().organizations as Array<{ organizationId: string }>).map(
        (row) => row.organizationId,
      ),
    );
    // In: Himma must start review / owns the review / owns go-live.
    expect(ids.has(orgByState.get('submitted')!)).toBe(true);
    expect(ids.has(orgByState.get('in_review')!)).toBe(true);
    expect(ids.has(orgByState.get('verified')!)).toBe(true);
    // Out: provider action (draft, rejected) and settled states.
    expect(ids.has(orgByState.get('draft')!)).toBe(false);
    expect(ids.has(orgByState.get('rejected')!)).toBe(false);
    expect(ids.has(orgByState.get('live')!)).toBe(false);
    expect(ids.has(orgByState.get('suspended')!)).toBe(false);
    expect(ids.has(orgByState.get('offboarded')!)).toBe(false);
  });

  it('summary rows carry the exact bounded projection: states, storefront truth, and the ACTIVE branch count', async () => {
    const response = await list(opsBearer, '?limit=100');
    const rows = response.json().organizations as Array<{
      organizationId: string;
      displayName: string;
      tradeName: string;
      verificationState: string;
      reviewState: string;
      storefront: { published: boolean; publiclyVisible: boolean };
      activeBranchCount: number;
    }>;
    const byId = new Map(rows.map((row) => [row.organizationId, row]));

    const live = byId.get(orgByState.get('live')!)!;
    expect(live.displayName).toBe('Marina Tennis');
    expect(live.verificationState).toBe('live');
    expect(live.reviewState).toBe('none');
    expect(live.storefront).toEqual({ published: true, publiclyVisible: true });
    expect(live.activeBranchCount).toBe(2); // 3 branches, 1 deactivated

    // Published intent WITHOUT liveness is not publicly visible.
    const submitted = byId.get(orgByState.get('submitted')!)!;
    expect(submitted.storefront).toEqual({ published: true, publiclyVisible: false });
    expect(submitted.reviewState).toBe('awaiting_review');

    const unpublished = byId.get(orgByState.get('draft')!)!;
    expect(unpublished.storefront).toEqual({ published: false, publiclyVisible: false });

    // DTO exactness — the row is the bounded summary, not the org graph.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'activeBranchCount',
      'createdAt',
      'displayName',
      'organizationId',
      'reviewState',
      'storefront',
      'tradeName',
      'updatedAt',
      'verificationState',
    ]);
  });

  it('issues a CONSTANT number of SQL statements regardless of page size (no N+1)', async () => {
    const statements: string[] = [];
    const pool = createPool(testDb.config);
    const countingDb = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql);
      },
    });
    try {
      statements.length = 0;
      const small = await listAdminOrganizations({ db: countingDb }, { userId: opsUserId }, { limit: 2 });
      if (small.kind !== 'organizations') throw new Error(small.kind);
      expect(small.organizations).toHaveLength(2);
      const smallCount = statements.length;

      statements.length = 0;
      const large = await listAdminOrganizations({ db: countingDb }, { userId: opsUserId }, { limit: 100 });
      if (large.kind !== 'organizations') throw new Error(large.kind);
      expect(large.organizations.length).toBeGreaterThan(10);
      expect(statements.length).toBe(smallCount);
    } finally {
      await countingDb.destroy();
    }
  });
});

describe('organization detail (§34)', () => {
  it('an operations admin reads the full internal detail: identity, states, storefront, branches, team, catalogue counts', async () => {
    const orgId = orgByState.get('live')!;
    // Team: one member with the canonical display identity, one synthetic
    // user without an account row (projects null — never invented).
    const named = await createUser(testDb.db);
    await createAccount(testDb.db, named);
    await addMembership(testDb.db, named, orgId, 'owner');
    const unnamed = await createUser(testDb.db);
    await addMembership(testDb.db, unnamed, orgId, 'coach');
    // A revoked membership never appears.
    const revoked = await createUser(testDb.db);
    const revokedMembership = await addMembership(testDb.db, revoked, orgId, 'front_desk');
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE id = ${revokedMembership}`.execute(testDb.db);
    // Catalogue truth: two published, one draft.
    const category = await sql<{ id: string }>`SELECT id FROM category WHERE slug = 'fitness'`.execute(
      testDb.db,
    );
    const activityType = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
              VALUES (${activityType}, ${category.rows[0]!.id}, 'admin-read-type', 'Read Type')`.execute(
      testDb.db,
    );
    for (const [title, state] of [
      ['Padel Basics', 'published'],
      ['Padel Advanced', 'published'],
      ['Padel Draft', 'draft'],
    ] as const) {
      await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                                     gender_eligibility, listing_state, published_at)
                VALUES (${newId()}, ${orgId}, ${activityType}, ${title}, 'indoor', 'mixed',
                        ${state}, ${state === 'published' ? new Date() : null})`.execute(testDb.db);
    }

    const response = await detail(opsBearer, orgId);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      organization: Record<string, unknown>;
      profile: Record<string, unknown>;
      branches: Array<{ label: string; active: boolean; areaLabel: string }>;
      team: Array<{ displayName: string | null; role: string; branchScopeKind: string }>;
      catalogue: { total: number; byState: Record<string, number> };
    };

    expect(body.organization.verificationState).toBe('live');
    expect(body.organization.reviewState).toBe('none');
    expect(body.organization.legalName).toMatch(/LLC$/);
    expect(body.organization.suspendedAt).toBeNull();
    expect(body.profile.displayName).toBe('Marina Tennis');
    expect(body.profile.published).toBe(true);
    expect(body.profile.publiclyVisible).toBe(true);

    expect(body.branches).toHaveLength(3);
    expect(body.branches.filter((branch) => branch.active)).toHaveLength(2);
    expect(body.branches[0]!.areaLabel).toBe('Area');

    // ACTIVE memberships only (the earlier authorization test added one
    // more owner to this org): the revoked front_desk row is absent.
    expect(body.team.map((member) => member.role)).not.toContain('front_desk');
    const owner = body.team.find((member) => member.displayName === 'Test Customer')!;
    expect(owner.role).toBe('owner'); // canonical account display identity
    expect(owner.branchScopeKind).toBe('all');
    const coach = body.team.find((member) => member.role === 'coach')!;
    expect(coach.displayName).toBeNull(); // no account row → null, not invented

    expect(body.catalogue.total).toBe(3);
    expect(body.catalogue.byState.published).toBe(2);
    expect(body.catalogue.byState.draft).toBe(1);
    expect(body.catalogue.byState.in_review).toBe(0); // total shape, honest zeros
  });

  it('a suspended organization shows its suspension truthfully', async () => {
    const response = await detail(opsBearer, orgByState.get('suspended')!);
    const body = response.json() as { organization: { suspendedAt: string | null; reviewState: string } };
    expect(body.organization.suspendedAt).not.toBeNull();
    expect(body.organization.reviewState).toBe('none');
  });

  it('nonexistent and malformed ids answer safely (404 / 422) for the authorized admin', async () => {
    expect((await detail(opsBearer, newId())).statusCode).toBe(404);
    expect((await detail(opsBearer, 'not-a-uuid')).statusCode).toBe(422);
  });

  it('unauthorized admin roles are refused the detail', async () => {
    const auditor = await adminBearer('auditor');
    const response = await detail(auditor, orgByState.get('live')!);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('the detail DTO carries NO secret/session/auth material and NO fabricated verification evidence', async () => {
    const response = await detail(opsBearer, orgByState.get('in_review')!);
    expect(response.statusCode).toBe(200);
    const serialized = JSON.stringify(response.json()).toLowerCase();
    for (const leak of [
      'token',
      'secret',
      'password',
      'digest',
      'cognito',
      'jti',
      'refresh',
      'invitation',
      'user_id',
      'userid',
    ]) {
      expect(serialized).not.toContain(leak);
    }
    // No VerificationCase/evidence exists — the DTO must not pretend.
    for (const fabricated of ['evidence', 'document', 'checklist', 'reviewer', 'score']) {
      expect(serialized).not.toContain(fabricated);
    }
    // The current verification STATE is the honest truth it does show.
    expect(response.json().organization.verificationState).toBe('in_review');
    expect(response.json().organization.reviewState).toBe('in_review');
  });
});
