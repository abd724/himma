/**
 * W2-12C1 — provider listings LIST-CARD projection (docs/28 §16.2 read
 * surface; owner-approved C1 read-projection correction).
 *
 * The provider listings index needs one bounded row projection (activity
 * display info · derived D-S4-1 price summary · concise branch summary ·
 * thumbnail media metadata) instead of N+1 detail requests. This suite
 * locks the projection to the recorded semantics:
 *
 * - price summary derives ONLY from ACTIVE ProgramPriceOptions: an active
 *   free option wins; otherwise the LOWEST active amount; otherwise the
 *   honest `none` readiness state. Archived options never participate.
 *   Never a stored Program.price, never a range, never an average.
 * - branch summary counts ACTIVE associations and names the earliest one —
 *   the same association order the detail view lists. Branch labels are
 *   organization-visible truth (the org view serves every member the full
 *   branch list), so scope safety is the reachability of the PROGRAM
 *   itself: inaccessible programs never appear at all.
 * - thumbnail is the first ACTIVE ProgramMedia by (sort_hint, id) — real
 *   metadata only (mediaRef + English alt text). No URL is fabricated:
 *   media binaries/storage remain the carried gap.
 * - aggregation must not multiply rows (one Program = one row) and must
 *   not degrade into per-row application queries (query-count invariance).
 * - keyset pagination and branch-scope-before-pagination semantics are
 *   unchanged from the corrected W2-7 read.
 */
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import type { DB } from '../src/db/kysely';
import { createPool } from '../src/db/pool';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { ProviderRole } from '../src/modules/provider/provider-roles';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  addProgramBranch,
  createProgram,
  listProviderPrograms,
  removeProgramBranch,
} from '../src/modules/catalogue/services/program-management';
import {
  addPriceOption,
  archivePriceOption,
} from '../src/modules/catalogue/services/price-option-management';
import {
  addProgramMedia,
  archiveProgramMedia,
} from '../src/modules/catalogue/services/media-offer-management';
import { staffBearer, createProviderOrg, type ProviderTestContext } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/list-card-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let deps: { db: TestDb['db'] };
let activityType: string;
let activityTypeLabel: string;
const actor = { userId: newId() };

function scopeFor(
  orgId: string,
  role: ProviderRole,
  branchScope: 'all' | string[] = 'all',
): OrgScope {
  return {
    organizationId: orgId,
    membershipId: newId(),
    role,
    capabilities: capabilitiesForRole(role),
    branchScope,
    organizationState: 'live',
  };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  deps = { db: testDb.db };
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
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  activityType = newId();
  activityTypeLabel = 'Card Strength';
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-card-strength', ${activityTypeLabel})`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

async function draft(owner: OrgScope, title: string, typeId = activityType): Promise<string> {
  const created = await createProgram(deps, owner, actor, {
    titleEn: title,
    activityTypeId: typeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return created.program.id;
}

async function activeOption(
  owner: OrgScope,
  programId: string,
  kind: 'dropIn' | 'monthly' | 'free',
  amountFils: number | null,
): Promise<{ id: string; version: number }> {
  const added = await addPriceOption(deps, owner, actor, {
    programId,
    option: { kind, ...(amountFils === null ? {} : { amountFils }) },
  });
  if (added.kind !== 'optionAdded') throw new Error(added.kind);
  return { id: added.option.id, version: added.option.version };
}

async function cardOf(owner: OrgScope, programId: string) {
  const page = await listProviderPrograms(deps, owner, {});
  const row = page.programs.find((candidate) => candidate.id === programId);
  if (row === undefined) throw new Error(`program ${programId} missing from list`);
  return row;
}

describe('activity display information', () => {
  it('projects the canonical activity relationship: id, provider-friendly label, active flag', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Activity Info');
    const row = await cardOf(owner, programId);
    expect(row.activityType).toEqual({
      id: activityType,
      labelEn: activityTypeLabel,
      active: true,
    });
  });

  it('keeps a historical inactive activity type representable: label preserved, active false', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const category = await sql<{ id: string }>`
      SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
    const retiredType = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
              VALUES (${retiredType}, ${category.rows[0]!.id}, 'test-card-retired', 'Retired Sport')`.execute(
      testDb.db,
    );
    const programId = await draft(owner, 'Historical Type', retiredType);
    await sql`UPDATE activity_type SET active = false WHERE id = ${retiredType}`.execute(testDb.db);
    const row = await cardOf(owner, programId);
    expect(row.activityType).toEqual({ id: retiredType, labelEn: 'Retired Sport', active: false });
  });
});

describe('price summary (D-S4-1 derived, ACTIVE options only)', () => {
  it('no price option at all → the honest none readiness state', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'No Pricing');
    expect((await cardOf(owner, programId)).priceSummary).toEqual({ kind: 'none' });
  });

  it('an active free option wins even when paid options exist', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Free Wins');
    await activeOption(owner, programId, 'monthly', 25_000);
    await activeOption(owner, programId, 'free', null);
    expect((await cardOf(owner, programId)).priceSummary).toEqual({ kind: 'free' });
  });

  it('otherwise the LOWEST active amount — never a range, never an average', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Lowest Active');
    await activeOption(owner, programId, 'monthly', 40_000);
    await activeOption(owner, programId, 'dropIn', 7_500);
    expect((await cardOf(owner, programId)).priceSummary).toEqual({
      kind: 'from',
      amountFils: 7_500,
      currency: 'AED',
    });
  });

  it('archived options never participate: archived cheapest is ignored; archiving the only option returns none', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Archive Semantics');
    const cheap = await activeOption(owner, programId, 'dropIn', 2_000);
    await activeOption(owner, programId, 'monthly', 30_000);
    const archived = await archivePriceOption(deps, owner, actor, {
      programId,
      optionId: cheap.id,
      expectedVersion: cheap.version,
    });
    expect(archived.kind).toBe('optionArchived');
    expect((await cardOf(owner, programId)).priceSummary).toEqual({
      kind: 'from',
      amountFils: 30_000,
      currency: 'AED',
    });

    const solo = await draft(owner, 'Only Option Archived');
    const only = await activeOption(owner, solo, 'monthly', 10_000);
    const soloArchived = await archivePriceOption(deps, owner, actor, {
      programId: solo,
      optionId: only.id,
      expectedVersion: only.version,
    });
    expect(soloArchived.kind).toBe('optionArchived');
    expect((await cardOf(owner, solo)).priceSummary).toEqual({ kind: 'none' });
  });
});

describe('branch summary (ACTIVE associations, earliest-association order)', () => {
  it('no association → null label, zero count', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Placeless Draft');
    expect((await cardOf(owner, programId)).branchSummary).toEqual({
      firstLabel: null,
      activeCount: 0,
    });
  });

  it('names the earliest active association and counts all active ones', async () => {
    const org = await createProviderOrg(testDb.db, { branches: 3 });
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Placed Everywhere');
    for (const branchId of org.branchIds) {
      const associated = await addProgramBranch(deps, owner, actor, { programId, branchId });
      expect(associated.kind).toBe('branchAssociated');
    }
    expect((await cardOf(owner, programId)).branchSummary).toEqual({
      firstLabel: 'Branch 1',
      activeCount: 3,
    });
  });

  it('a removed (deactivated) association leaves the summary to the next earliest active one', async () => {
    const org = await createProviderOrg(testDb.db, { branches: 3 });
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'First Removed');
    for (const branchId of org.branchIds) {
      await addProgramBranch(deps, owner, actor, { programId, branchId });
    }
    const removed = await removeProgramBranch(deps, owner, actor, {
      programId,
      branchId: org.branchIds[0]!,
    });
    expect(removed.kind).toBe('branchAssociationRemoved');
    expect((await cardOf(owner, programId)).branchSummary).toEqual({
      firstLabel: 'Branch 2',
      activeCount: 2,
    });
  });
});

describe('thumbnail metadata (real ProgramMedia only — no fabricated URL)', () => {
  it('no media → null thumbnail', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'No Media');
    expect((await cardOf(owner, programId)).thumbnail).toBeNull();
  });

  it('picks the first ACTIVE media by (sort_hint, id) and carries mediaRef + English alt text', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Sorted Media');
    const laterRef = newId();
    const firstRef = newId();
    const later = await addProgramMedia(deps, owner, actor, {
      programId,
      mediaRef: laterRef,
      sortHint: 10,
      altTextEn: 'Later image',
    });
    expect(later.kind).toBe('mediaAdded');
    const first = await addProgramMedia(deps, owner, actor, {
      programId,
      mediaRef: firstRef,
      sortHint: 1,
      altTextEn: 'Front image',
    });
    expect(first.kind).toBe('mediaAdded');
    expect((await cardOf(owner, programId)).thumbnail).toEqual({
      mediaRef: firstRef,
      altTextEn: 'Front image',
    });
  });

  it('archived (inactive) media never serves as the thumbnail', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Archived Media');
    const frontRef = newId();
    const backRef = newId();
    const front = await addProgramMedia(deps, owner, actor, {
      programId,
      mediaRef: frontRef,
      sortHint: 1,
      altTextEn: 'Front',
    });
    if (front.kind !== 'mediaAdded') throw new Error(front.kind);
    const back = await addProgramMedia(deps, owner, actor, {
      programId,
      mediaRef: backRef,
      sortHint: 2,
      altTextEn: 'Back',
    });
    expect(back.kind).toBe('mediaAdded');
    const archived = await archiveProgramMedia(deps, owner, actor, {
      programId,
      mediaId: front.media.id,
      expectedVersion: front.media.version,
    });
    expect(archived.kind).toBe('mediaArchived');
    expect((await cardOf(owner, programId)).thumbnail).toEqual({
      mediaRef: backRef,
      altTextEn: 'Back',
    });
  });
});

describe('one Program stays one row', () => {
  it('a fully composed listing (3 options · 2 branches · 2 media) appears exactly once', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Fully Composed');
    await activeOption(owner, programId, 'monthly', 20_000);
    await activeOption(owner, programId, 'dropIn', 5_000);
    await activeOption(owner, programId, 'free', null);
    for (const branchId of org.branchIds) {
      await addProgramBranch(deps, owner, actor, { programId, branchId });
    }
    await addProgramMedia(deps, owner, actor, { programId, mediaRef: newId(), sortHint: 1 });
    await addProgramMedia(deps, owner, actor, { programId, mediaRef: newId(), sortHint: 2 });
    const page = await listProviderPrograms(deps, owner, {});
    expect(page.programs.filter((row) => row.id === programId)).toHaveLength(1);
    expect(page.programs).toHaveLength(1);
  });
});

describe('pagination and branch scope are unchanged by the projection', () => {
  it('keyset pages walk every row exactly once, each carrying its card fields', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const created: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const programId = await draft(owner, `Page Walk ${i}`);
      await activeOption(owner, programId, 'monthly', 10_000 + i);
      created.push(programId);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listProviderPrograms(deps, owner, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const row of page.programs) {
        seen.push(row.id);
        expect(row.priceSummary).toEqual({
          kind: 'from',
          amountFils: 10_000 + created.indexOf(row.id),
          currency: 'AED',
        });
        expect(row.branchSummary).toEqual({ firstLabel: null, activeCount: 0 });
        expect(row.thumbnail).toBeNull();
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(created);
  });

  it('branch-scoped staff still see only reachable programs — scope applies before the page window', async () => {
    const org = await createProviderOrg(testDb.db, { branches: 2 });
    const owner = scopeFor(org.orgId, 'owner');
    const managerScope = scopeFor(org.orgId, 'branch_manager', [org.branchIds[0]!]);

    const reachable: string[] = [];
    const hidden: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const inScope = await draft(owner, `In Scope ${i}`);
      await addProgramBranch(deps, owner, actor, { programId: inScope, branchId: org.branchIds[0]! });
      reachable.push(inScope);
      const outOfScope = await draft(owner, `Out Of Scope ${i}`);
      await addProgramBranch(deps, owner, actor, {
        programId: outOfScope,
        branchId: org.branchIds[1]!,
      });
      hidden.push(outOfScope);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listProviderPrograms(deps, managerScope, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.programs.map((row) => row.id));
      // Reachable rows fill every page slot — hidden rows never consume one.
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(reachable);
    for (const id of hidden) {
      expect(seen).not.toContain(id);
    }
  });

  it("the reachable card's branch summary reflects its own active associations (organization-visible truth)", async () => {
    const org = await createProviderOrg(testDb.db, { branches: 2 });
    const owner = scopeFor(org.orgId, 'owner');
    const managerScope = scopeFor(org.orgId, 'branch_manager', [org.branchIds[0]!]);
    const programId = await draft(owner, 'Shared Program');
    await addProgramBranch(deps, owner, actor, { programId, branchId: org.branchIds[0]! });
    await addProgramBranch(deps, owner, actor, { programId, branchId: org.branchIds[1]! });
    // The branch list (labels included) is served to every member by the
    // organization view, and the detail read exposes every association of a
    // reachable program — the card mirrors exactly that truth.
    expect((await cardOf(managerScope, programId)).branchSummary).toEqual({
      firstLabel: 'Branch 1',
      activeCount: 2,
    });
  });
});

describe('query efficiency (no O(N) application-level composition)', () => {
  it('issues the same number of SQL statements for a large page as for a small one', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    for (let i = 0; i < 25; i += 1) {
      const programId = await draft(owner, `Bulk ${String(i).padStart(2, '0')}`);
      await activeOption(owner, programId, 'monthly', 15_000 + i);
      await addProgramBranch(deps, owner, actor, { programId, branchId: org.branchIds[0]! });
      await addProgramMedia(deps, owner, actor, { programId, mediaRef: newId(), sortHint: 1 });
    }

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
      const small = await listProviderPrograms({ db: countingDb }, owner, { limit: 2 });
      expect(small.programs).toHaveLength(2);
      const smallCount = statements.length;

      statements.length = 0;
      const large = await listProviderPrograms({ db: countingDb }, owner, { limit: 25 });
      expect(large.programs).toHaveLength(25);
      expect(statements.length).toBe(smallCount);
    } finally {
      await countingDb.destroy();
    }
  });
});

describe('HTTP wire shape (GET /provider/organizations/:orgId/listings)', () => {
  it('serves the full card projection through the route schema', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId, 'owner');
    const programId = await draft(owner, 'Wire Shape');
    await activeOption(owner, programId, 'dropIn', 4_500);
    await addProgramBranch(deps, owner, actor, { programId, branchId: org.branchIds[0]! });
    const mediaRef = newId();
    await addProgramMedia(deps, owner, actor, { programId, mediaRef, altTextEn: 'Hero' });

    const staff = await staffBearer(ctx, org.orgId, 'owner');
    const response = await app.inject({
      method: 'GET',
      url: `/provider/organizations/${org.orgId}/listings`,
      headers: { authorization: `Bearer ${staff.bearer}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      programs: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.programs).toHaveLength(1);
    const row = body.programs[0]!;
    expect(row).toEqual({
      id: programId,
      titleEn: 'Wire Shape',
      listingState: 'draft',
      version: expect.any(Number) as unknown,
      createdAt: expect.any(String) as unknown,
      updatedAt: expect.any(String) as unknown,
      activityType: { id: activityType, labelEn: activityTypeLabel, active: true },
      priceSummary: { kind: 'from', amountFils: 4_500, currency: 'AED' },
      branchSummary: { firstLabel: 'Branch 1', activeCount: 1 },
      thumbnail: { mediaRef, altTextEn: 'Hero' },
    });
  });
});
