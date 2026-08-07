/**
 * S4-2 — provider-private catalogue HTTP routes (docs/28 §16.2; D-S4-2).
 * Real PostgreSQL + Fastify injection: the role × route authorization
 * matrix, MFA baseline, per-request organization binding (cross-org
 * not-found shape, Cognito claims inert, revocation/suspension effect),
 * publication as a named action with no state-patch bypass, typed
 * completeness/stale outcomes, response hygiene, and structural
 * deny-by-default (reserved capabilities refuse registration; no
 * moderation/decision route exists).
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

const ISSUER = 'https://cognito.test/catalogue-routes-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let orgA: { orgId: string; branchIds: string[] };
let orgB: { orgId: string; branchIds: string[] };
let activityType: string;

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
  orgA = await createProviderOrg(testDb.db, { branches: 2 });
  orgB = await createProviderOrg(testDb.db);
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-strength', 'Strength')`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, bearer: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const CREATE_BODY = {
  titleEn: 'Group Strength Training',
  activityTypeId: () => activityType,
  setting: 'indoor',
  genderEligibility: 'mixed',
};

function createBody(title?: string): Record<string, unknown> {
  return {
    ...CREATE_BODY,
    activityTypeId: activityType,
    ...(title === undefined ? {} : { titleEn: title }),
  };
}

async function createViaHttp(bearer: string, title?: string): Promise<{ id: string; version: number }> {
  const response = await inject(
    'POST',
    `/provider/organizations/${orgA.orgId}/listings`,
    bearer,
    createBody(title),
  );
  if (response.statusCode !== 200) throw new Error(response.body);
  const program = response.json().program;
  return { id: program.id, version: program.version };
}

async function completeViaHttp(bearer: string, title?: string): Promise<string> {
  const program = await createViaHttp(bearer, title);
  const base = `/provider/organizations/${orgA.orgId}/listings/${program.id}`;
  const branch = await inject('POST', `${base}/branches`, bearer, {
    branchId: orgA.branchIds[0],
  });
  if (branch.statusCode !== 200) throw new Error(branch.body);
  const option = await inject('POST', `${base}/price-options`, bearer, {
    kind: 'monthly',
    amountFils: 25000,
    labelEn: 'Monthly',
  });
  if (option.statusCode !== 200) throw new Error(option.body);
  return program.id;
}

async function approveViaSql(programId: string): Promise<void> {
  await sql`UPDATE program SET listing_state = 'submitted' WHERE id = ${programId}`.execute(testDb.db);
  await sql`UPDATE program SET listing_state = 'in_review' WHERE id = ${programId}`.execute(testDb.db);
  await sql`UPDATE program SET listing_state = 'approved' WHERE id = ${programId}`.execute(testDb.db);
}

async function versionOf(programId: string): Promise<number> {
  const row = await sql<{ version: number }>`
    SELECT version FROM program WHERE id = ${programId}`.execute(testDb.db);
  return row.rows[0]!.version;
}

describe('route inventory and structural deny-by-default', () => {
  it('registers the §16.2 catalogue routes, all provider-policy-declared, and no revision-decision route', () => {
    // Fastify auto-registers HEAD alongside GET; the declared PROVIDER
    // surface is 19 (the internal-admin moderation routes under
    // /admin/listings are locked by their own suite).
    const catalogueRoutes = app.routePolicyInventory.filter(
      (route) =>
        route.url.startsWith('/provider/organizations/:organizationId/listings') &&
        route.method !== 'HEAD',
    );
    expect(catalogueRoutes).toHaveLength(19);
    for (const route of catalogueRoutes) {
      expect(route.policy).toBe('provider');
      expect(route.url.startsWith('/provider/organizations/:organizationId/listings')).toBe(true);
    }
    // Amended by the moderation + taxonomy-admin tasks: those internal-admin
    // surfaces now legitimately exist under /admin (their own suites lock
    // them). The PROVIDER surface still carries no decision path.
    const decisionish = app.routePolicyInventory.filter(
      (route) => route.policy !== 'admin' && /revision|review|approve|moderat/i.test(route.url),
    );
    expect(decisionish).toEqual([]);
  });

  it('a route declaring the still-reserved offers.manage capability refuses registration', async () => {
    const rogue = buildApp();
    expect(() =>
      rogue.get(
        '/rogue-offers',
        { config: { authPolicy: 'provider', providerCapability: 'offers.manage' as never } },
        async () => ({}),
      ),
    ).toThrow(/reserved capabilities cannot become executable/i);
    await rogue.close();
  });
});

describe('role × route authorization matrix (docs/28 §6; D-S4-2)', () => {
  it('reads and creates follow the catalogue capability matrix exactly', async () => {
    const expectations: Array<[string, number, number]> = [
      // [role, GET /listings status, POST /listings status]
      ['owner', 200, 200],
      ['org_manager', 200, 200],
      ['branch_manager', 200, 200],
      ['listings_editor', 200, 200],
      ['coach', 403, 403],
      ['front_desk', 403, 403],
      ['finance', 403, 403],
    ];
    for (const [role, getStatus, postStatus] of expectations) {
      const staff = await staffBearer(ctx, orgA.orgId, role as never);
      const list = await inject('GET', `/provider/organizations/${orgA.orgId}/listings`, staff.bearer);
      expect(`${role}:GET:${list.statusCode}`).toBe(`${role}:GET:${getStatus}`);
      const create = await inject(
        'POST',
        `/provider/organizations/${orgA.orgId}/listings`,
        staff.bearer,
        createBody(`Matrix ${role}`),
      );
      expect(`${role}:POST:${create.statusCode}`).toBe(`${role}:POST:${postStatus}`);
    }
  });

  it('publication is Owner/Organization Manager only, and only after approval', async () => {
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const editor = await staffBearer(ctx, orgA.orgId, 'listings_editor');

    // The Listings Editor drives create → edit → submit, then CANNOT publish.
    const programId = await completeViaHttp(editor.bearer, 'Editor Cannot Publish');
    const base = `/provider/organizations/${orgA.orgId}/listings/${programId}`;
    const edit = await inject('PATCH', base, editor.bearer, {
      expectedVersion: await versionOf(programId),
      titleEn: 'Editor Cannot Publish v2',
    });
    expect(edit.statusCode).toBe(200);
    const submitted = await inject('POST', `${base}/submit`, editor.bearer, {
      expectedVersion: await versionOf(programId),
    });
    expect(submitted.statusCode).toBe(200);
    await approveViaSql(programId);
    const editorPublish = await inject('POST', `${base}/publish`, editor.bearer, {
      expectedVersion: await versionOf(programId),
    });
    expect(editorPublish.statusCode).toBe(403);
    expect(editorPublish.json().code).toBe('forbidden');

    for (const role of ['branch_manager', 'coach', 'front_desk', 'finance'] as const) {
      const staff = await staffBearer(ctx, orgA.orgId, role);
      const refused = await inject('POST', `${base}/publish`, staff.bearer, {
        expectedVersion: await versionOf(programId),
      });
      expect(`${role}:${refused.statusCode}`).toBe(`${role}:403`);
    }

    // Approval rested — publish is the explicit Owner/Org-Manager action.
    expect((await sql<{ s: string }>`SELECT listing_state AS s FROM program WHERE id = ${programId}`.execute(testDb.db)).rows[0]?.s).toBe('approved');
    const published = await inject('POST', `${base}/publish`, owner.bearer, {
      expectedVersion: await versionOf(programId),
    });
    expect(published.statusCode).toBe(200);

    // A draft can never be published (no shortcut edge at any layer).
    const draft = await createViaHttp(owner.bearer, 'Draft No Publish');
    const early = await inject(
      'POST',
      `/provider/organizations/${orgA.orgId}/listings/${draft.id}/publish`,
      owner.bearer,
      { expectedVersion: draft.version },
    );
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('lifecycleConflict');
  });

  it('there is no state-patch bypass: a smuggled listingState is inexpressible and never applied', async () => {
    // The PATCH contract cannot express a listing state: the app-wide Ajv
    // config strips undeclared properties (additionalProperties: false), so
    // the smuggled field is discarded before the handler and the state
    // machine is reachable ONLY through the named lifecycle actions.
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const program = await createViaHttp(owner.bearer, 'No State Patch');
    const attempt = await inject(
      'PATCH',
      `/provider/organizations/${orgA.orgId}/listings/${program.id}`,
      owner.bearer,
      { expectedVersion: program.version, listingState: 'published', titleEn: 'Still Draft' },
    );
    expect(attempt.statusCode).toBe(200);
    expect(attempt.json().status).toBe('programUpdated');
    const state = await sql<{ s: string }>`
      SELECT listing_state AS s FROM program WHERE id = ${program.id}`.execute(testDb.db);
    expect(state.rows[0]?.s).toBe('draft');
  });
});

describe('typed outcomes over HTTP', () => {
  it('submission incompleteness returns the structured missing list', async () => {
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const bare = await createViaHttp(owner.bearer, 'Incomplete Over HTTP');
    const refused = await inject(
      'POST',
      `/provider/organizations/${orgA.orgId}/listings/${bare.id}/submit`,
      owner.bearer,
      { expectedVersion: bare.version },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      code: 'programIncomplete',
      message: expect.stringContaining('not ready'),
      missing: ['activeBranch', 'activePriceOption'],
    });
  });

  it('stale edits and option mutations return staleVersion; archived options conflict', async () => {
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const programId = await completeViaHttp(owner.bearer, 'Stale Over HTTP');
    const base = `/provider/organizations/${orgA.orgId}/listings/${programId}`;
    const stale = await inject('PATCH', base, owner.bearer, {
      expectedVersion: 999,
      titleEn: 'Stale',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    const detail = await inject('GET', base, owner.bearer);
    const optionId = detail.json().program.priceOptions[0].id;
    const staleOption = await inject('PATCH', `${base}/price-options/${optionId}`, owner.bearer, {
      expectedVersion: 999,
      amountFils: 30000,
    });
    expect(staleOption.statusCode).toBe(409);
    const archived = await inject('POST', `${base}/price-options/${optionId}/archive`, owner.bearer, {
      expectedVersion: 1,
    });
    expect(archived.statusCode).toBe(200);
    const editArchived = await inject('PATCH', `${base}/price-options/${optionId}`, owner.bearer, {
      expectedVersion: 2,
      amountFils: 30000,
    });
    expect(editArchived.statusCode).toBe(409);
    expect(editArchived.json().code).toBe('lifecycleConflict');
  });

  it('a sensitive edit on a published listing returns revisionSubmitted over HTTP', async () => {
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const programId = await completeViaHttp(owner.bearer, 'HTTP Revision Target');
    const base = `/provider/organizations/${orgA.orgId}/listings/${programId}`;
    await inject('POST', `${base}/submit`, owner.bearer, {
      expectedVersion: await versionOf(programId),
    });
    await approveViaSql(programId);
    await inject('POST', `${base}/publish`, owner.bearer, {
      expectedVersion: await versionOf(programId),
    });
    const sensitive = await inject('PATCH', base, owner.bearer, {
      expectedVersion: await versionOf(programId),
      minAge: 18,
    });
    expect(sensitive.statusCode).toBe(200);
    const body = sensitive.json();
    expect(body.status).toBe('revisionSubmitted');
    expect(typeof body.revisionId).toBe('string');
    // The open revision surfaces in the provider detail view.
    const detail = await inject('GET', base, owner.bearer);
    expect(detail.json().program.openRevision?.id).toBe(body.revisionId);
  });
});

describe('organization binding, MFA baseline, and isolation', () => {
  it('requires the MFA baseline on every catalogue route', async () => {
    const unenrolled = await staffBearer(ctx, orgA.orgId, 'owner', { enrolled: false });
    const refused = await inject(
      'GET',
      `/provider/organizations/${orgA.orgId}/listings`,
      unenrolled.bearer,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('mfaRequired');
  });

  it('cross-organization access is not-found-shaped and byte-identical to a ghost organization', async () => {
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const real = await inject('GET', `/provider/organizations/${orgB.orgId}/listings`, owner.bearer);
    const ghost = await inject('GET', `/provider/organizations/${newId()}/listings`, owner.bearer);
    expect(real.statusCode).toBe(404);
    expect(real.body).toBe(ghost.body);

    // A's staff cannot reach B's program detail through B's addressing.
    const bOwner = await staffBearer(ctx, orgB.orgId, 'owner');
    const bProgram = await inject(
      'POST',
      `/provider/organizations/${orgB.orgId}/listings`,
      bOwner.bearer,
      createBody('B Program'),
    );
    const bProgramId = bProgram.json().program.id;
    const probe = await inject(
      'GET',
      `/provider/organizations/${orgB.orgId}/listings/${bProgramId}`,
      owner.bearer,
    );
    expect(probe.statusCode).toBe(404);
    // And A's addressing of B's program id is equally not-found-shaped.
    const crossed = await inject(
      'GET',
      `/provider/organizations/${orgA.orgId}/listings/${bProgramId}`,
      owner.bearer,
    );
    expect(crossed.statusCode).toBe(404);
  });

  it('Cognito group/claim material grants nothing; membership revocation bites immediately', async () => {
    const outsider = await createUser(testDb.db);
    const { bearer } = await bearerForUser(ctx, outsider, {
      scopes: ['openid', 'cognito:groups:catalogue-admin', `custom:organization:${orgA.orgId}`],
    });
    expect(
      (await inject('GET', `/provider/organizations/${orgA.orgId}/listings`, bearer)).statusCode,
    ).toBe(404);

    const staff = await staffBearer(ctx, orgA.orgId, 'listings_editor');
    expect(
      (await inject('GET', `/provider/organizations/${orgA.orgId}/listings`, staff.bearer)).statusCode,
    ).toBe(200);
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE id = ${staff.membershipId}`.execute(testDb.db);
    expect(
      (await inject('GET', `/provider/organizations/${orgA.orgId}/listings`, staff.bearer)).statusCode,
    ).toBe(404);
  });

  it('a suspended organization keeps catalogue reads and refuses catalogue mutations', async () => {
    const suspended = await createProviderOrg(testDb.db, { state: 'suspended' });
    const owner = await staffBearer(ctx, suspended.orgId, 'owner');
    expect(
      (await inject('GET', `/provider/organizations/${suspended.orgId}/listings`, owner.bearer))
        .statusCode,
    ).toBe(200);
    const mutation = await inject(
      'POST',
      `/provider/organizations/${suspended.orgId}/listings`,
      owner.bearer,
      createBody('Suspended Create'),
    );
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().code).toBe('organizationSuspended');
  });

  it('admin roles never satisfy the provider catalogue surface', async () => {
    const { adminA } = await bootstrapAccessAdmins(testDb.db);
    const { bearer } = await bearerForUser(ctx, adminA);
    expect(
      (await inject('GET', `/provider/organizations/${orgA.orgId}/listings`, bearer)).statusCode,
    ).toBe(404);
  });
});

describe('response hygiene', () => {
  it('the provider detail view serializes the explicit camelCase contract only', async () => {
    const owner = await staffBearer(ctx, orgA.orgId, 'owner');
    const programId = await completeViaHttp(owner.bearer, 'Hygiene Check');
    const detail = await inject(
      'GET',
      `/provider/organizations/${orgA.orgId}/listings/${programId}`,
      owner.bearer,
    );
    expect(detail.statusCode).toBe(200);
    const program = detail.json().program;
    expect(Object.keys(program).sort()).toEqual(
      [
        'id',
        'organizationId',
        'activityType',
        'titleEn',
        'titleAr',
        'descriptionEn',
        'descriptionAr',
        'setting',
        'minAge',
        'maxAge',
        'allAges',
        'genderEligibility',
        'skillLevel',
        'eligibilityNotes',
        'listingState',
        'publishedAt',
        'archivedAt',
        'sensitiveFieldsVersion',
        'version',
        'createdAt',
        'updatedAt',
        'priceOptions',
        'branches',
        'media',
        'offers',
        'openRevision',
      ].sort(),
    );
    // No snake_case column leaks through any nested view.
    expect(detail.body).not.toMatch(/"[a-z]+_[a-z_]+":/);
  });
});
