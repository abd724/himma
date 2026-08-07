/**
 * Slice 4 — production search foundation (docs/28 §9.11–12/§11/§12/§13/§16.1;
 * docs/24 §11). Real PostgreSQL + Fastify injection: the derived
 * `program_search_document` projection (one document per LISTING), FTS +
 * trigram + synonym matching with deterministic ranking, the §11 filter
 * vocabulary over real columns only, server-side collection resolution,
 * same-transaction + event-driven projection maintenance (idempotent,
 * replay-safe, stale-event-safe), the live §6 predicate as the stale-search
 * fail-safe, opaque relevance-cursor pagination, DTO hygiene/parity, and
 * index/plan evidence.
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
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { transitionOrganization } from '../src/modules/provider/services/organization-admin';
import {
  addProgramBranch,
  archiveProgram,
  createProgram,
  pauseProgram,
  publishProgram,
  removeProgramBranch,
  submitProgram,
  updateProgram,
} from '../src/modules/catalogue/services/program-management';
import {
  addPriceOption,
  archivePriceOption,
  type PriceOptionKind,
} from '../src/modules/catalogue/services/price-option-management';
import { addOffer, endOffer } from '../src/modules/catalogue/services/media-offer-management';
import {
  approveRevision,
  reviewProgram,
  startRevisionReview,
} from '../src/modules/catalogue/services/moderation';
import { updateActivityType } from '../src/modules/catalogue/services/taxonomy-admin';
import {
  processSearchProjectionEvents,
  rebuildAllSearchDocuments,
} from '../src/modules/catalogue/services/search-projection';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/catalogue-search-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let categoryId: string;
let activityTypeId: string;
let ops: { userId: string; bearer: string };

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
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  categoryId = category.rows[0]!.id;
  activityTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en, synonyms_en)
            VALUES (${activityTypeId}, ${categoryId}, 'search-jiu-jitsu', 'Jiu-jitsu',
                    ${sql.raw(`ARRAY['bjj','grappling']::text[]`)})`.execute(testDb.db);
  ops = await makeAdmin('operations');
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Fixtures — SQL walks for state matrices (rebuild makes projections), real
// services for maintenance proofs (same-transaction refresh under test).
// ---------------------------------------------------------------------------

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

async function makePublicOrg(
  options: { displayName?: string; state?: string; published?: boolean; branches?: number } = {},
): Promise<{ orgId: string; branchIds: string[] }> {
  const org = await createProviderOrg(testDb.db, {
    state: options.state ?? 'live',
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    branches: options.branches ?? 1,
  });
  await sql`UPDATE organization_public_profile SET published = ${options.published ?? true}
            WHERE organization_id = ${org.orgId}`.execute(testDb.db);
  return org;
}

function ownerScope(orgId: string): OrgScope {
  return {
    organizationId: orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
}

const STATE_WALKS: Record<string, string[]> = {
  draft: [],
  submitted: ['submitted'],
  in_review: ['submitted', 'in_review'],
  approved: ['submitted', 'in_review', 'approved'],
  changes_requested: ['submitted', 'in_review', 'changes_requested'],
  published: ['submitted', 'in_review', 'approved', 'published'],
  paused: ['submitted', 'in_review', 'approved', 'published', 'paused'],
  archived: ['submitted', 'in_review', 'approved', 'published', 'archived'],
};

interface OptionFixture {
  kind: string;
  amountFils?: number | null;
  sessionsCount?: number | null;
  sortHint?: number;
  state?: string;
}

/** Direct-SQL program fixture (state walked through the real triggers).
 *  Projection rows are then produced by rebuildAllSearchDocuments. */
async function makeProgram(
  org: { orgId: string; branchIds: string[] },
  fixture: {
    state?: string;
    titleEn?: string;
    activityTypeId?: string;
    setting?: string;
    gender?: string;
    minAge?: number | null;
    maxAge?: number | null;
    allAges?: boolean;
    skillLevel?: string | null;
    branchIds?: string[];
    options?: OptionFixture[];
    offers?: { kind: string; labelEn: string; trialAmountFils?: number; state?: string }[];
  } = {},
): Promise<{ programId: string; optionIds: string[] }> {
  const programId = newId();
  await sql`
    INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                         min_age, max_age, all_ages, gender_eligibility, skill_level)
    VALUES (${programId}, ${org.orgId}, ${fixture.activityTypeId ?? activityTypeId},
            ${fixture.titleEn ?? 'Search Fixture Program'}, ${fixture.setting ?? 'indoor'},
            ${fixture.minAge ?? null}, ${fixture.maxAge ?? null}, ${fixture.allAges ?? false},
            ${fixture.gender ?? 'mixed'}, ${fixture.skillLevel ?? null})`.execute(testDb.db);
  for (const branchId of fixture.branchIds ?? [org.branchIds[0]!]) {
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${programId}, ${branchId}, ${org.orgId})`.execute(testDb.db);
  }
  const optionIds: string[] = [];
  for (const option of fixture.options ?? [{ kind: 'monthly', amountFils: 60000 }]) {
    const optionId = newId();
    await sql`
      INSERT INTO program_price_option
        (id, program_id, organization_id, kind, amount_fils, sessions_count, sort_hint, state)
      VALUES (${optionId}, ${programId}, ${org.orgId}, ${option.kind},
              ${option.amountFils ?? null}, ${option.sessionsCount ?? null},
              ${option.sortHint ?? 0}, ${option.state ?? 'active'})`.execute(testDb.db);
    optionIds.push(optionId);
  }
  for (const offer of fixture.offers ?? []) {
    await sql`
      INSERT INTO offer (id, program_id, organization_id, kind, label_en, trial_amount_fils, state)
      VALUES (${newId()}, ${programId}, ${org.orgId}, ${offer.kind}, ${offer.labelEn},
              ${offer.trialAmountFils ?? null}, ${offer.state ?? 'active'})`.execute(testDb.db);
  }
  for (const state of STATE_WALKS[fixture.state ?? 'published'] ?? []) {
    await sql`
      UPDATE program SET listing_state = ${state},
        published_at = CASE WHEN ${state} = 'published' THEN now() ELSE published_at END,
        archived_at  = CASE WHEN ${state} = 'archived'  THEN now() ELSE archived_at  END
      WHERE id = ${programId}`.execute(testDb.db);
  }
  return { programId, optionIds };
}

/** Full service-path published program (create → submit → review → publish)
 *  so the same-transaction projection maintenance is what's under test. */
async function servicePublishedProgram(
  org: { orgId: string; branchIds: string[] },
  scope: OrgScope,
  input: {
    titleEn: string;
    options?: { kind: PriceOptionKind; amountFils?: number | null; sessionsCount?: number }[];
  },
): Promise<{ programId: string; optionIds: string[] }> {
  const deps = { db: testDb.db };
  const actor = { userId: newId() };
  const created = await createProgram(deps, scope, actor, {
    titleEn: input.titleEn,
    activityTypeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  const programId = created.program.id;
  const associated = await addProgramBranch(deps, scope, actor, {
    programId,
    branchId: org.branchIds[0]!,
  });
  if (associated.kind !== 'branchAssociated') throw new Error(associated.kind);
  const optionIds: string[] = [];
  for (const option of input.options ?? [{ kind: 'monthly', amountFils: 60000 }]) {
    const added = await addPriceOption(deps, scope, actor, {
      programId,
      option: { kind: option.kind, amountFils: option.amountFils ?? null, ...(option.sessionsCount !== undefined ? { sessionsCount: option.sessionsCount } : {}) },
    });
    if (added.kind !== 'optionAdded') throw new Error(added.kind);
    optionIds.push(added.option.id);
  }
  const submitted = await submitProgram(deps, scope, actor, {
    programId,
    expectedVersion: await rowVersion(programId),
  });
  if (submitted.kind !== 'programSubmitted') throw new Error(submitted.kind);
  const started = await reviewProgram(deps, { userId: ops.userId }, {
    programId,
    action: 'start_review',
    expectedVersion: await rowVersion(programId),
  });
  if (started.kind !== 'programReviewed') throw new Error(started.kind);
  const approved = await reviewProgram(deps, { userId: ops.userId }, {
    programId,
    action: 'approve',
    expectedVersion: await rowVersion(programId),
  });
  if (approved.kind !== 'programReviewed') throw new Error(approved.kind);
  const published = await publishProgram(deps, scope, actor, {
    programId,
    expectedVersion: await rowVersion(programId),
  });
  if (published.kind !== 'programPublished') throw new Error(published.kind);
  return { programId, optionIds };
}

async function rowVersion(programId: string): Promise<number> {
  const row = await sql<{ version: number }>`
    SELECT version FROM program WHERE id = ${programId}`.execute(testDb.db);
  return row.rows[0]!.version;
}

async function searchDoc(programId: string): Promise<Record<string, unknown> | undefined> {
  const row = await sql<Record<string, unknown>>`
    SELECT * FROM program_search_document WHERE program_id = ${programId}`.execute(testDb.db);
  return row.rows[0];
}

function search(params: Record<string, string | number | boolean>, bearer?: string) {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return app.inject({
    method: 'GET',
    url: `/search${query.length > 0 ? `?${query}` : ''}`,
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
}

async function searchIds(params: Record<string, string | number | boolean>): Promise<string[]> {
  const response = await search(params);
  expect(response.statusCode).toBe(200);
  return (response.json().results as { id: string }[]).map((result) => result.id);
}

const RESULT_KEYS = [
  'activityType',
  'allAges',
  'category',
  'fromPrice',
  'genderEligibility',
  'id',
  'maxAge',
  'media',
  'minAge',
  'offerBadges',
  'provider',
  'setting',
  'skillLevel',
  'titleAr',
  'titleEn',
];

// ---------------------------------------------------------------------------
// Projection schema and shape.
// ---------------------------------------------------------------------------

describe('search projection schema (docs/28 §9.11–12)', () => {
  it('program_search_document exists with exactly the canonical columns, pg_trgm, GIN/trigram indexes, and no-DELETE grants', async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'program_search_document'`.execute(testDb.db);
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'active',
      'activity_type_id',
      'all_ages',
      'area_ids',
      'branch_ids',
      'category_id',
      'created_at',
      'display_name',
      'gender_eligibility',
      'has_trial',
      'max_age',
      'min_age',
      'min_price_fils',
      'organization_id',
      'price_kinds',
      'program_id',
      'published_at',
      'rebuilt_at',
      'search_vector',
      'setting',
      'skill_level',
      'title_en',
      'updated_at',
      'version',
    ]);

    const extension = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`.execute(testDb.db);
    expect(extension.rows).toHaveLength(1);

    const indexes = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'program_search_document'`.execute(testDb.db);
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('ix_program_search_document_vector')).toMatch(/gin.*search_vector/i);
    expect(byName.get('ix_program_search_document_title_trgm')).toMatch(/gin.*title_en.*trgm/i);
    expect(byName.get('ix_program_search_document_display_trgm')).toMatch(
      /gin.*display_name.*trgm/i,
    );

    const grants = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'program_search_document' AND grantee = 'himma_app'`.execute(testDb.db);
    expect(grants.rows.map((row) => row.privilege_type).sort()).toEqual([
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  it('builds exactly one document per searchable Program with denormalized filter columns from authoritative state', async () => {
    const areaId = newId();
    await sql`INSERT INTO area (id, slug, label_en, sort_hint)
              VALUES (${areaId}, 'search-doc-area', 'Doc Area', 400)`.execute(testDb.db);
    const org = await makePublicOrg({ displayName: 'Doc Shape Gym', branches: 2 });
    await sql`UPDATE branch SET area_id = ${areaId}
              WHERE id = ${org.branchIds[0]!}`.execute(testDb.db);
    const listing = await makeProgram(org, {
      titleEn: 'Docshape Jiu-Jitsu',
      minAge: 16,
      maxAge: null,
      gender: 'women',
      skillLevel: 'beginner',
      branchIds: org.branchIds,
      options: [
        { kind: 'monthly', amountFils: 60000 },
        { kind: 'dropIn', amountFils: 8000 },
        { kind: 'dropIn', amountFils: 45000, state: 'archived' },
      ],
      offers: [{ kind: 'freeTrial', labelEn: 'Free trial' }],
    });
    await rebuildAllSearchDocuments({ db: testDb.db });

    const docs = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_search_document
      WHERE program_id = ${listing.programId}`.execute(testDb.db);
    expect(Number(docs.rows[0]!.n)).toBe(1); // one document per LISTING (D-S4-1)

    const doc = (await searchDoc(listing.programId))!;
    expect(doc.active).toBe(true);
    expect(doc.organization_id).toBe(org.orgId);
    expect(doc.display_name).toBe('Doc Shape Gym');
    expect(doc.title_en).toBe('Docshape Jiu-Jitsu');
    expect(doc.category_id).toBe(categoryId);
    expect(doc.activity_type_id).toBe(activityTypeId);
    expect((doc.branch_ids as string[]).sort()).toEqual([...org.branchIds].sort());
    expect(doc.area_ids).toEqual([areaId]);
    expect(doc.min_age).toBe(16);
    expect(doc.max_age).toBeNull();
    expect(doc.gender_eligibility).toBe('women');
    expect(doc.skill_level).toBe('beginner');
    // Active options only: archived 45000 dropIn is invisible to pricing.
    expect((doc.price_kinds as string[]).sort()).toEqual(['dropIn', 'monthly']);
    expect(Number(doc.min_price_fils)).toBe(8000);
    expect(doc.has_trial).toBe(true);
    expect(doc.published_at).not.toBeNull();
    expect(doc.rebuilt_at).not.toBeNull();
  });

  it('rebuild is idempotent and never mutates source-of-record catalogue rows', async () => {
    const org = await makePublicOrg();
    const listing = await makeProgram(org, { titleEn: 'Idempotent Rebuild Fixture' });
    const before = await rowVersion(listing.programId);
    const orgBefore = await sql<{ version: number }>`
      SELECT version FROM organization WHERE id = ${org.orgId}`.execute(testDb.db);

    await rebuildAllSearchDocuments({ db: testDb.db });
    const first = (await searchDoc(listing.programId))!;
    await rebuildAllSearchDocuments({ db: testDb.db });
    const second = (await searchDoc(listing.programId))!;
    expect(second.program_id).toBe(first.program_id);
    expect(second.active).toBe(true);

    expect(await rowVersion(listing.programId)).toBe(before);
    const orgAfter = await sql<{ version: number }>`
      SELECT version FROM organization WHERE id = ${org.orgId}`.execute(testDb.db);
    expect(orgAfter.rows[0]!.version).toBe(orgBefore.rows[0]!.version);
  });
});

// ---------------------------------------------------------------------------
// Search visibility === public visibility.
// ---------------------------------------------------------------------------

describe('search visibility equals public visibility (docs/28 §6/§13)', () => {
  it('only a published listing of a live, published-storefront org with an active branch is searchable', async () => {
    const org = await makePublicOrg({ displayName: 'Visibility Matrix Org' });
    const visible = await makeProgram(org, { titleEn: 'Visimatrix Visible Padel' });
    const hidden: string[] = [];
    for (const state of [
      'draft',
      'submitted',
      'in_review',
      'approved',
      'changes_requested',
      'paused',
      'archived',
    ]) {
      const listing = await makeProgram(org, { state, titleEn: `Visimatrix Hidden ${state}` });
      hidden.push(listing.programId);
    }
    const suspended = await makePublicOrg({ state: 'suspended' });
    hidden.push((await makeProgram(suspended, { titleEn: 'Visimatrix Suspended Org' })).programId);
    const notLive = await makePublicOrg({ state: 'verified' });
    hidden.push((await makeProgram(notLive, { titleEn: 'Visimatrix Notlive Org' })).programId);
    const unpublishedStorefront = await makePublicOrg({ published: false });
    hidden.push(
      (await makeProgram(unpublishedStorefront, { titleEn: 'Visimatrix Unpublished Storefront' }))
        .programId,
    );
    const branchless = await makePublicOrg();
    const noBranch = await makeProgram(branchless, { titleEn: 'Visimatrix No Branch' });
    await sql`UPDATE program_branch SET active = false
              WHERE program_id = ${noBranch.programId}`.execute(testDb.db);
    hidden.push(noBranch.programId);

    await rebuildAllSearchDocuments({ db: testDb.db });
    const ids = await searchIds({ q: 'visimatrix' });
    expect(ids).toEqual([visible.programId]);
    for (const hiddenId of hidden) {
      expect(ids).not.toContain(hiddenId);
    }
  });

  it('a stale or poisoned search document can never bypass the live public predicate', async () => {
    const org = await makePublicOrg({ displayName: 'Poison Test Org' });
    const draft = await makeProgram(org, { state: 'draft', titleEn: 'Poisoned Draft Yoga' });
    // Forge an ACTIVE document for a draft listing directly in SQL — the
    // projection is deliberately never trusted for authorization (§13c).
    await sql`
      INSERT INTO program_search_document
        (program_id, organization_id, active, title_en, display_name, search_vector,
         category_id, activity_type_id, branch_ids, all_ages, gender_eligibility,
         setting, published_at)
      VALUES (${draft.programId}, ${org.orgId}, true, 'Poisoned Draft Yoga', 'Poison Test Org',
              to_tsvector('english', 'Poisoned Draft Yoga'),
              ${categoryId}, ${activityTypeId},
              ${sql.raw(`ARRAY['${org.branchIds[0]!}']::uuid[]`)},
              false, 'mixed', 'indoor', now())`.execute(testDb.db);
    expect(await searchIds({ q: 'poisoned draft yoga' })).toEqual([]);

    // Same fail-safe for a suspension that has not been projected yet.
    const live = await makePublicOrg({ displayName: 'Stale Suspend Org' });
    const listing = await makeProgram(live, { titleEn: 'Stalesafe Swimming' });
    await rebuildAllSearchDocuments({ db: testDb.db });
    expect(await searchIds({ q: 'stalesafe' })).toEqual([listing.programId]);
    await sql`UPDATE organization SET verification_state = 'suspended', suspended_at = now()
              WHERE id = ${live.orgId}`.execute(testDb.db);
    // Document still says active=true — the live predicate hides it anyway.
    expect((await searchDoc(listing.programId))!.active).toBe(true);
    expect(await searchIds({ q: 'stalesafe' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Matching and ranking.
// ---------------------------------------------------------------------------

describe('keyword matching and deterministic ranking (docs/28 §11/§12)', () => {
  it('finds cross-provider listings by title, activity-type label, synonym, and category label — one result per listing', async () => {
    const orgA = await makePublicOrg({ displayName: 'Desert Grapplers' });
    const orgB = await makePublicOrg({ displayName: 'Marina Combat Club' });
    const listingA = await makeProgram(orgA, {
      titleEn: 'Adult Beginner Jiu-Jitsu',
      options: [
        { kind: 'monthly', amountFils: 60000 },
        { kind: 'term', amountFils: 150000 },
        { kind: 'package', amountFils: 90000, sessionsCount: 5 },
      ],
    });
    const listingB = await makeProgram(orgB, { titleEn: 'Fundamentals of Grappling Arts' });
    await rebuildAllSearchDocuments({ db: testDb.db });

    // Title + type label: both providers' listings, each exactly once.
    const byLabel = await searchIds({ q: 'jiu-jitsu' });
    expect(byLabel).toContain(listingA.programId);
    expect(byLabel).toContain(listingB.programId); // matched via type label in vector
    expect(byLabel.filter((id) => id === listingA.programId)).toHaveLength(1); // multi-option ≠ multi-result

    // Synonym: 'bjj' reaches both through the type synonyms.
    const bySynonym = await searchIds({ q: 'bjj' });
    expect(bySynonym).toContain(listingA.programId);
    expect(bySynonym).toContain(listingB.programId);

    // Category label reaches the martial-arts listings.
    const byCategory = await searchIds({ q: 'martial arts' });
    expect(byCategory).toContain(listingA.programId);

    // Provider display name matches.
    const byProvider = await searchIds({ q: 'desert grapplers' });
    expect(byProvider).toContain(listingA.programId);
    expect(byProvider).not.toContain(listingB.programId);

    // Every result names its provider storefront for navigation.
    const response = await search({ q: 'jiu-jitsu' });
    for (const result of response.json().results as {
      id: string;
      provider: { id: string; displayName: string };
    }[]) {
      if (result.id === listingA.programId) {
        expect(result.provider).toEqual({ id: orgA.orgId, displayName: 'Desert Grapplers' });
      }
      if (result.id === listingB.programId) {
        expect(result.provider).toEqual({ id: orgB.orgId, displayName: 'Marina Combat Club' });
      }
    }
  });

  it('ranks an exact title match first and tolerates typos through trigram similarity', async () => {
    const org = await makePublicOrg({ displayName: 'Ranking Fixture Org' });
    const exact = await makeProgram(org, { titleEn: 'Aqua Padel' });
    const longer = await makeProgram(org, { titleEn: 'Aqua Padel Fundamentals Course' });
    await rebuildAllSearchDocuments({ db: testDb.db });

    const ranked = await searchIds({ q: 'aqua padel' });
    expect(ranked[0]).toBe(exact.programId); // exact-title boost
    expect(ranked).toContain(longer.programId);

    // Typo tolerance: FTS finds nothing for 'aqua pdael'; trigram does.
    const typo = await searchIds({ q: 'aqua pdael' });
    expect(typo).toContain(exact.programId);
  });

  it('breaks ranking ties deterministically by published recency then id', async () => {
    const org = await makePublicOrg({ displayName: 'Tie Break Org' });
    const first = await makeProgram(org, { titleEn: 'Tiebreak Rowing' });
    const second = await makeProgram(org, { titleEn: 'Tiebreak Rowing' });
    // Equal rank + equal recency → ascending id decides, stably.
    await sql`UPDATE program SET published_at = '2026-08-01T10:00:00Z'
              WHERE id IN (${first.programId}, ${second.programId})`.execute(testDb.db);
    await rebuildAllSearchDocuments({ db: testDb.db });
    const expected = [first.programId, second.programId].sort();
    expect(await searchIds({ q: 'tiebreak rowing' })).toEqual(expected);
    expect(await searchIds({ q: 'tiebreak rowing' })).toEqual(expected); // stable across calls
  });

  it('an empty or whitespace query browses the eligible catalogue in published-recency order; oversized queries are refused', async () => {
    const org = await makePublicOrg({ displayName: 'Browse Org' });
    const older = await makeProgram(org, { titleEn: 'Browseorder Older' });
    const newer = await makeProgram(org, { titleEn: 'Browseorder Newer' });
    await sql`UPDATE program SET published_at = '2026-08-01T09:00:00Z' WHERE id = ${older.programId}`.execute(
      testDb.db,
    );
    await sql`UPDATE program SET published_at = '2026-08-02T09:00:00Z' WHERE id = ${newer.programId}`.execute(
      testDb.db,
    );
    await rebuildAllSearchDocuments({ db: testDb.db });

    const all = await searchIds({});
    expect(all.indexOf(newer.programId)).toBeLessThan(all.indexOf(older.programId));
    const whitespace = await search({ q: '   ' });
    expect(whitespace.statusCode).toBe(200); // normalized to the empty browse

    const oversized = await search({ q: 'x'.repeat(300) });
    expect(oversized.statusCode).toBe(422);
    expect(oversized.json().code).toBe('validationError');
  });

  it('Arabic remains optional: an English-only listing is fully searchable', async () => {
    const org = await makePublicOrg();
    const listing = await makeProgram(org, { titleEn: 'Arabicnull Fencing' });
    await rebuildAllSearchDocuments({ db: testDb.db });
    const ids = await searchIds({ q: 'arabicnull fencing' });
    expect(ids).toEqual([listing.programId]);
    const row = await search({ q: 'arabicnull fencing' });
    expect(row.json().results[0].titleAr).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filters (docs/28 §11 — real columns only) and collection resolution.
// ---------------------------------------------------------------------------

describe('filter vocabulary (docs/28 §11)', () => {
  let org: { orgId: string; branchIds: string[] };
  let areaId: string;
  let women: string;
  let kids: string;
  let outdoorCamp: string;
  let freeIntro: string;
  let advanced: string;

  beforeAll(async () => {
    org = await makePublicOrg({ displayName: 'Filter Matrix Org', branches: 2 });
    areaId = newId();
    await sql`INSERT INTO area (id, slug, label_en, sort_hint)
              VALUES (${areaId}, 'filter-matrix-area', 'Filter Area', 410)`.execute(testDb.db);
    await sql`UPDATE branch SET area_id = ${areaId}
              WHERE id = ${org.branchIds[1]!}`.execute(testDb.db);

    women = (
      await makeProgram(org, {
        titleEn: 'Filtermatrix Ladies Strength',
        gender: 'women',
        minAge: 18,
        options: [{ kind: 'monthly', amountFils: 30000 }],
      })
    ).programId;
    kids = (
      await makeProgram(org, {
        titleEn: 'Filtermatrix Kids Swim',
        minAge: 6,
        maxAge: 12,
        options: [{ kind: 'term', amountFils: 4000 }],
        offers: [{ kind: 'paidTrial', labelEn: 'Trial', trialAmountFils: 2000 }],
      })
    ).programId;
    outdoorCamp = (
      await makeProgram(org, {
        titleEn: 'Filtermatrix Desert Camp',
        setting: 'outdoor',
        allAges: true,
        branchIds: [org.branchIds[1]!],
        options: [{ kind: 'camp', amountFils: 90000 }],
      })
    ).programId;
    freeIntro = (
      await makeProgram(org, {
        titleEn: 'Filtermatrix Free Intro',
        allAges: true,
        options: [{ kind: 'free', amountFils: null }],
      })
    ).programId;
    advanced = (
      await makeProgram(org, {
        titleEn: 'Filtermatrix Advanced Squad',
        minAge: 16,
        skillLevel: 'advanced',
        options: [{ kind: 'monthly', amountFils: 120000 }],
      })
    ).programId;
    await rebuildAllSearchDocuments({ db: testDb.db });
  });

  it('applies gender, audience, age-band, skill, setting, format, area, taxonomy, price, free, and trial filters over authoritative columns', async () => {
    const base = { q: 'filtermatrix' };
    expect(await searchIds({ ...base, ladiesOnly: true })).toEqual([women]);
    expect(await searchIds({ ...base, audience: 'children' })).toEqual(
      expect.arrayContaining([kids, outdoorCamp, freeIntro]),
    );
    expect(await searchIds({ ...base, audience: 'children' })).not.toContain(women);
    expect(await searchIds({ ...base, ageMin: 5, ageMax: 10 })).toEqual(
      expect.arrayContaining([kids, outdoorCamp, freeIntro]),
    );
    expect(await searchIds({ ...base, ageMin: 5, ageMax: 10 })).not.toContain(advanced);
    expect(await searchIds({ ...base, skillLevel: 'advanced' })).toEqual([advanced]);
    expect(await searchIds({ ...base, setting: 'outdoor' })).toEqual([outdoorCamp]);
    expect(await searchIds({ ...base, formats: 'camp' })).toEqual([outdoorCamp]);
    expect(await searchIds({ ...base, formats: 'camp,term' }).then((ids) => ids.sort())).toEqual(
      [kids, outdoorCamp].sort(),
    );
    expect(await searchIds({ ...base, areaId })).toEqual([outdoorCamp]);
    expect(await searchIds({ ...base, categoryId })).toHaveLength(5);
    expect(await searchIds({ ...base, activityTypeId })).toHaveLength(5);
    expect(await searchIds({ ...base, free: true })).toEqual([freeIntro]);
    expect(await searchIds({ ...base, trial: true })).toEqual([kids]);
    // Price bands over the derived value (free ⇒ 0; else min active option).
    expect((await searchIds({ ...base, priceBand: 'under-100' })).sort()).toEqual(
      [kids, freeIntro].sort(),
    );
    expect(await searchIds({ ...base, priceBand: '100-500' })).toEqual([women]);
    expect((await searchIds({ ...base, priceBand: 'over-500' })).sort()).toEqual(
      [outdoorCamp, advanced].sort(),
    );
  });

  it('refuses unsupported or future filter dimensions instead of silently pretending', async () => {
    for (const params of [
      { q: 'filtermatrix', when: 'today' },
      { q: 'filtermatrix', offers: 'true' },
      { q: 'filtermatrix', topRated: 'true' },
      { q: 'filtermatrix', rating: '4' },
      { q: 'filtermatrix', nearMe: 'true' },
      { q: 'filtermatrix', sort: 'rating' },
      { q: 'filtermatrix', sort: 'popular' },
      { q: 'filtermatrix', formats: 'freeTrial' },
      { q: 'filtermatrix', limit: 500 },
    ]) {
      const response = await search(params as Record<string, string>);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('validationError');
    }
  });

  it('sorts by derived price and by published recency when requested', async () => {
    const byPrice = await searchIds({ q: 'filtermatrix', sort: 'price' });
    expect(byPrice[0]).toBe(freeIntro); // Free ⇒ 0
    expect(byPrice[1]).toBe(kids); // 40 AED term
    expect(byPrice[byPrice.length - 1]).toBe(advanced); // 1200 AED

    const byNewest = await searchIds({ q: 'filtermatrix', sort: 'newest' });
    expect(byNewest).toHaveLength(5); // deterministic full ordering
  });

  it('resolves collection presets server-side from the DB-managed collection rows', async () => {
    const camps = await sql<{ id: string }>`
      SELECT id FROM collection WHERE title_en = 'Camps & seasonal'`.execute(testDb.db);
    const kidsTeens = await sql<{ id: string }>`
      SELECT id FROM collection WHERE title_en = 'Kids & Teens'`.execute(testDb.db);

    const campResults = await searchIds({ q: 'filtermatrix', collectionId: camps.rows[0]!.id });
    expect(campResults).toEqual([outdoorCamp]);

    const kidsResults = await searchIds({ q: 'filtermatrix', collectionId: kidsTeens.rows[0]!.id });
    expect(kidsResults).toContain(kids);
    expect(kidsResults).not.toContain(women);

    // Unknown and unpublished collections are not-found-shaped.
    expect((await search({ collectionId: newId() })).statusCode).toBe(404);
    const draftCollection = newId();
    await sql`INSERT INTO collection (id, title_en, state)
              VALUES (${draftCollection}, 'Search Draft Collection', 'draft')`.execute(testDb.db);
    expect((await search({ collectionId: draftCollection })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Projection maintenance — same-transaction service wiring + events.
// ---------------------------------------------------------------------------

describe('projection maintenance (docs/28 §13)', () => {
  it('publication creates the document; edit, pause, archive, offers, and branch removal maintain it in the same transaction', async () => {
    const org = await makePublicOrg({ displayName: 'Maintenance Org', branches: 2 });
    const scope = ownerScope(org.orgId);
    const deps = { db: testDb.db };
    const actor = { userId: newId() };

    const listing = await servicePublishedProgram(org, scope, {
      titleEn: 'Maintwire Fencing Foundations',
    });
    expect((await searchDoc(listing.programId))!.active).toBe(true);
    expect(await searchIds({ q: 'fencing foundations' })).toEqual([listing.programId]);

    // Non-sensitive hot-publish edit refreshes the searchable text: the
    // dropped tokens stop matching, the new ones match. (The retained
    // distinctive token "maintwire" keeps matching by design — trigram.)
    const updated = await updateProgram(deps, scope, actor, {
      programId: listing.programId,
      expectedVersion: await rowVersion(listing.programId),
      patch: { titleEn: 'Maintwire Sabre Academy' },
    });
    if (updated.kind !== 'programUpdated') throw new Error(updated.kind);
    expect(await searchIds({ q: 'maintwire sabre' })).toEqual([listing.programId]);
    expect(await searchIds({ q: 'fencing foundations' })).toEqual([]);

    // Trial offers flip has_trial both ways.
    const offer = await addOffer(deps, scope, actor, {
      programId: listing.programId,
      offer: { kind: 'freeTrial', labelEn: 'Try sabre free' },
    });
    if (offer.kind !== 'offerAdded') throw new Error(offer.kind);
    expect(await searchIds({ q: 'maintwire sabre', trial: true })).toEqual([listing.programId]);
    const ended = await endOffer(deps, scope, actor, {
      programId: listing.programId,
      offerId: offer.offer.id,
      expectedVersion: 1,
    });
    if (ended.kind !== 'offerEnded') throw new Error(ended.kind);
    expect(await searchIds({ q: 'maintwire sabre', trial: true })).toEqual([]);

    // Pause suppresses; republish restores.
    const paused = await pauseProgram(deps, scope, actor, {
      programId: listing.programId,
      expectedVersion: await rowVersion(listing.programId),
    });
    if (paused.kind !== 'programPaused') throw new Error(paused.kind);
    expect((await searchDoc(listing.programId))!.active).toBe(false);
    expect(await searchIds({ q: 'maintwire sabre' })).toEqual([]);
    const republished = await publishProgram(deps, scope, actor, {
      programId: listing.programId,
      expectedVersion: await rowVersion(listing.programId),
    });
    if (republished.kind !== 'programPublished') throw new Error(republished.kind);
    expect(await searchIds({ q: 'maintwire sabre' })).toEqual([listing.programId]);

    // Removing the last active branch association suppresses the listing.
    const second = await servicePublishedProgram(org, scope, {
      titleEn: 'Maintwire Branchless Check',
    });
    const removed = await removeProgramBranch(deps, scope, actor, {
      programId: second.programId,
      branchId: org.branchIds[0]!,
    });
    if (removed.kind !== 'branchAssociationRemoved') throw new Error(removed.kind);
    expect(await searchIds({ q: 'maintwire branchless' })).toEqual([]);

    // Archive is terminal for searchability.
    const archived = await archiveProgram(deps, scope, actor, {
      programId: listing.programId,
      expectedVersion: await rowVersion(listing.programId),
    });
    if (archived.kind !== 'programArchived') throw new Error(archived.kind);
    expect((await searchDoc(listing.programId))!.active).toBe(false);
    expect(await searchIds({ q: 'maintwire sabre' })).toEqual([]);
  });

  it('an approved sensitive revision (archiving the cheapest option) atomically refreshes projection pricing', async () => {
    const org = await makePublicOrg({ displayName: 'Revision Price Org' });
    const scope = ownerScope(org.orgId);
    const deps = { db: testDb.db };
    const actor = { userId: newId() };
    const listing = await servicePublishedProgram(org, scope, {
      titleEn: 'Revprice Climbing Club',
      options: [
        { kind: 'dropIn', amountFils: 8000 },
        { kind: 'monthly', amountFils: 60000 },
      ],
    });
    expect(Number((await searchDoc(listing.programId))!.min_price_fils)).toBe(8000);
    expect(await searchIds({ q: 'revprice', priceBand: 'under-100' })).toEqual([listing.programId]);

    // Archiving a price option of a PUBLISHED listing routes via revision.
    const requested = await archivePriceOption(deps, scope, actor, {
      programId: listing.programId,
      optionId: listing.optionIds[0]!,
      expectedVersion: 1,
    });
    if (requested.kind !== 'revisionSubmitted') throw new Error(requested.kind);
    const revisionId = requested.revisionId;
    const started = await startRevisionReview(deps, { userId: ops.userId }, {
      programId: listing.programId,
      revisionId,
      expectedVersion: 1,
    });
    if (started.kind !== 'revisionReviewStarted') throw new Error(started.kind);
    const approved = await approveRevision(deps, { userId: ops.userId }, {
      programId: listing.programId,
      revisionId,
      expectedVersion: 2,
    });
    if (approved.kind !== 'revisionApproved') throw new Error(approved.kind);

    expect(Number((await searchDoc(listing.programId))!.min_price_fils)).toBe(60000);
    expect(await searchIds({ q: 'revprice', priceBand: 'under-100' })).toEqual([]);
    expect(await searchIds({ q: 'revprice', priceBand: 'over-500' })).toEqual([listing.programId]);
    // The live public detail agrees (regression identity).
    const detail = await app.inject({ method: 'GET', url: `/listings/${listing.programId}` });
    expect(detail.json().listing.fromPrice).toEqual({
      kind: 'from',
      amountFils: 60000,
      currency: 'AED',
    });
  });

  it('taxonomy label/synonym changes refresh affected documents same-transaction; deactivation never hides a published listing', async () => {
    const typeId = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
              VALUES (${typeId}, ${categoryId}, 'search-taxrefresh', 'Taxrefresh Silat')`.execute(
      testDb.db,
    );
    const org = await makePublicOrg({ displayName: 'Taxonomy Refresh Org' });
    const listing = await makeProgram(org, {
      titleEn: 'Taxfixture Evening Class',
      activityTypeId: typeId,
    });
    await rebuildAllSearchDocuments({ db: testDb.db });
    expect(await searchIds({ q: 'taxrefresh silat' })).toEqual([listing.programId]);

    const relabeled = await updateActivityType({ db: testDb.db }, { userId: ops.userId }, {
      activityTypeId: typeId,
      expectedVersion: 1,
      patch: { labelEn: 'Taxrefresh Kalari', synonymsEn: ['taxsynword'] },
    });
    if (relabeled.kind !== 'activityTypeUpdated') throw new Error(relabeled.kind);
    expect(await searchIds({ q: 'taxrefresh kalari' })).toEqual([listing.programId]);
    expect(await searchIds({ q: 'taxsynword' })).toEqual([listing.programId]);
    expect(await searchIds({ q: 'taxrefresh silat' })).toEqual([listing.programId]); // still matches 'taxrefresh'

    // Canon: taxonomy deactivation never hides existing published listings.
    const deactivated = await updateActivityType({ db: testDb.db }, { userId: ops.userId }, {
      activityTypeId: typeId,
      expectedVersion: 2,
      patch: { active: false },
    });
    if (deactivated.kind !== 'activityTypeUpdated') throw new Error(deactivated.kind);
    expect(await searchIds({ q: 'taxfixture evening' })).toEqual([listing.programId]);
  });

  it('organization lifecycle events drive the consumer idempotently, and stale events cannot resurrect older state', async () => {
    const org = await makePublicOrg({ displayName: 'Event Consumer Org' });
    const scope = ownerScope(org.orgId);
    const listing = await servicePublishedProgram(org, scope, {
      titleEn: 'Eventflow Archery Range',
    });
    expect((await searchDoc(listing.programId))!.active).toBe(true);

    const adminDeps = {
      db: testDb.db,
      mailSender: new CaptureMailSender(),
      invitationConfig: parseStaffInvitationConfig('test', {}),
      lifecycle: { nodeEnv: 'test' as const, verificationEvidenceCapabilityReady: false },
    };
    const orgVersion = async () =>
      (
        await sql<{ version: number }>`SELECT version FROM organization WHERE id = ${org.orgId}`.execute(
          testDb.db,
        )
      ).rows[0]!.version;

    const suspendedResult = await transitionOrganization(adminDeps, { userId: ops.userId }, {
      organizationId: org.orgId,
      action: 'suspend',
      expectedVersion: await orgVersion(),
    });
    if (suspendedResult.kind !== 'organizationTransitioned') throw new Error(suspendedResult.kind);
    // Search already hides it through the live predicate (fail-safe window).
    expect(await searchIds({ q: 'eventflow archery' })).toEqual([]);

    const reinstated = await transitionOrganization(adminDeps, { userId: ops.userId }, {
      organizationId: org.orgId,
      action: 'reinstate',
      expectedVersion: await orgVersion(),
    });
    if (reinstated.kind !== 'organizationTransitioned') throw new Error(reinstated.kind);

    // Process ONLY the older 'suspended' event: refresh reads LIVE truth, so
    // the stale event cannot deactivate the now-reinstated org's documents.
    const first = await processSearchProjectionEvents({ db: testDb.db }, { limit: 1 });
    expect(first.processed).toBeGreaterThanOrEqual(1);
    expect((await searchDoc(listing.programId))!.active).toBe(true);
    expect(await searchIds({ q: 'eventflow archery' })).toEqual([listing.programId]);

    // Drain the rest; replaying everything again is a pure no-op.
    await processSearchProjectionEvents({ db: testDb.db }, { limit: 500 });
    const replay = await processSearchProjectionEvents({ db: testDb.db }, { limit: 500 });
    expect(replay.processed).toBe(0);
    expect((await searchDoc(listing.programId))!.active).toBe(true);

    // Suspend again and let the consumer project the deactivation.
    const resuspended = await transitionOrganization(adminDeps, { userId: ops.userId }, {
      organizationId: org.orgId,
      action: 'suspend',
      expectedVersion: await orgVersion(),
    });
    if (resuspended.kind !== 'organizationTransitioned') throw new Error(resuspended.kind);
    await processSearchProjectionEvents({ db: testDb.db }, { limit: 500 });
    expect((await searchDoc(listing.programId))!.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DTO hygiene, parity, pagination, inventory, plans, regression.
// ---------------------------------------------------------------------------

describe('search DTO, pagination, and surface boundaries', () => {
  it('returns exactly the public result shape — no search internals, no private fields, and identical bodies for privileged bearers', async () => {
    const org = await makePublicOrg({ displayName: 'Hygiene Search Org' });
    await makeProgram(org, { titleEn: 'Hygienic Karate Dojo' });
    await rebuildAllSearchDocuments({ db: testDb.db });

    const anonymous = await search({ q: 'hygienic karate' });
    expect(anonymous.statusCode).toBe(200);
    const results = anonymous.json().results as Record<string, unknown>[];
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual(RESULT_KEYS);
    expect(anonymous.body).not.toMatch(
      /searchVector|search_vector|tsvector|tsquery|rebuilt|rank|score|"version"|listingState|listing_state|sensitiveFields|revision|moderation|audit|outbox|legalName|legal_name|verificationState|suspended|token|payout|bank|commercial|staff|invitation/i,
    );
    expect(anonymous.body).not.toMatch(
      /rating|reviewCount|popularity|availableToday|nextSession|bookedCount|attendance|scheduleLabel|bookingStatus|paymentStatus/,
    );

    const owner = await staffBearer(ctx, org.orgId, 'owner');
    expect((await search({ q: 'hygienic karate' }, owner.bearer)).body).toBe(anonymous.body);
    expect((await search({ q: 'hygienic karate' }, ops.bearer)).body).toBe(anonymous.body);
    expect((await search({ q: 'hygienic karate' }, 'garbage-token')).body).toBe(anonymous.body);
  });

  it('paginates the ranked order with an opaque cursor — no duplicates, no gaps, malformed cursors typed-refused', async () => {
    const org = await makePublicOrg({ displayName: 'Search Page Org' });
    for (let i = 0; i < 5; i += 1) {
      await makeProgram(org, { titleEn: `Pagesearch Tennis ${i + 1}` });
    }
    await rebuildAllSearchDocuments({ db: testDb.db });

    const full = await searchIds({ q: 'pagesearch tennis', limit: 50 });
    expect(full).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const params: Record<string, string | number> = { q: 'pagesearch tennis', limit: 2 };
      if (cursor !== null) params.cursor = cursor;
      const page = await search(params);
      expect(page.statusCode).toBe(200);
      const json = page.json();
      seen.push(...(json.results as { id: string }[]).map((result) => result.id));
      cursor = json.nextCursor;
      if (cursor !== null) {
        expect(cursor).not.toMatch(/^[0-9a-f]{8}-/); // opaque, never a raw id
      }
      rounds += 1;
    } while (cursor !== null && rounds < 10);
    expect(seen).toEqual(full); // exact ranked order, complete, no duplicates

    for (const bad of [
      '@@@@',
      Buffer.from('nonsense').toString('base64url'),
      Buffer.from('{"v":"psc1","sort":"recommended"}').toString('base64url'),
    ]) {
      const response = await search({ q: 'pagesearch tennis', cursor: bad });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('invalidCursor');
    }
  });

  it('adds exactly the public GET /search route and no other surface', () => {
    const searchRoutes = app.routePolicyInventory.filter((route) => /search/i.test(route.url));
    expect(searchRoutes.map((route) => `${route.method} ${route.url} ${route.policy}`).sort()).toEqual([
      'GET /search public',
      'HEAD /search public',
    ]);
    for (const route of app.routePolicyInventory.filter((r) => r.policy === 'public')) {
      expect(['GET', 'HEAD']).toContain(route.method);
    }
    expect(
      app.routePolicyInventory.filter((route) =>
        /^\/(sessions|bookings|payments|schedules)([/?]|$)/.test(route.url),
      ),
    ).toEqual([]);
  });

  it('search result identities remain compatible with the approved public listing and storefront-listing endpoints', async () => {
    const org = await makePublicOrg({ displayName: 'Identity Regression Org' });
    const listing = await makeProgram(org, { titleEn: 'Identityreg Rowing Club' });
    await rebuildAllSearchDocuments({ db: testDb.db });
    const [resultId] = await searchIds({ q: 'identityreg rowing' });
    expect(resultId).toBe(listing.programId);

    const detail = await app.inject({ method: 'GET', url: `/listings/${resultId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().listing.provider.id).toBe(org.orgId);

    const storefront = await app.inject({
      method: 'GET',
      url: `/providers/${org.orgId}/listings`,
    });
    expect(storefront.statusCode).toBe(200);
    expect(
      (storefront.json().listings as { id: string }[]).map((row) => row.id),
    ).toContain(resultId);
  });

  it('the canonical query shapes can use the FTS and trigram indexes (plan evidence)', async () => {
    // Enough rows that the planner has a real choice, then force index paths
    // to prove usability of the canonical operators against the indexes.
    const org = await makePublicOrg({ displayName: 'Plan Evidence Org' });
    for (let i = 0; i < 40; i += 1) {
      await makeProgram(org, { titleEn: `Planseed Activity ${i}` });
    }
    await rebuildAllSearchDocuments({ db: testDb.db });
    await sql`ANALYZE program_search_document`.execute(testDb.db);

    await sql`SET enable_seqscan = off`.execute(testDb.db);
    try {
      const fts = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN SELECT program_id FROM program_search_document
        WHERE active AND search_vector @@ websearch_to_tsquery('english', 'planseed')`.execute(
        testDb.db,
      );
      const ftsPlan = fts.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(ftsPlan).toContain('ix_program_search_document_vector');

      const trigram = await sql<{ 'QUERY PLAN': string }>`
        EXPLAIN SELECT program_id FROM program_search_document
        WHERE title_en % 'plansed activty'`.execute(testDb.db);
      const trigramPlan = trigram.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(trigramPlan).toContain('ix_program_search_document_title_trgm');
    } finally {
      await sql`SET enable_seqscan = on`.execute(testDb.db);
    }
  });
});
