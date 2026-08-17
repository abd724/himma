/**
 * W2-12C1 final correction — AUTHORITATIVE provider listing search & status
 * filtering (docs/28 §16.2 read surface).
 *
 * The approved Listings index searches by title and filters by lifecycle
 * state; a paginated production management list cannot do that client-side
 * over the loaded page (a matching listing on a later page would look
 * nonexistent). This suite locks the corrected contract:
 *
 * - `q` = bounded management search over the English title — substring,
 *   case-insensitive, whitespace-normalized, LIKE-wildcard-safe,
 *   parameterized; blank means no predicate. Not marketplace search: no
 *   ranking, no fuzziness, no index/migration.
 * - `status` = one canonical docs/24 §5.3 lifecycle value; anything else
 *   is the normal schema validation refusal, never silently everything.
 * - ordering is fixed: authoritative org/branch scope → filter predicates
 *   → deterministic (created_at, id) order → cursor window → the C1
 *   list-card projection. Filters see the COMPLETE authorized set;
 *   pagination applies after them; the card projection, one-row-per-
 *   Program, and constant statement count are unchanged.
 * - the cursor is a POSITION in (created_at, id) order: a walk holds its
 *   filters constant (the portal does); a cursor replayed under different
 *   filters deterministically continues the NEW filtered ordered set
 *   after that position — never corrupted pagination.
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
} from '../src/modules/catalogue/services/program-management';
import { addPriceOption } from '../src/modules/catalogue/services/price-option-management';
import {
  staffBearer,
  createProviderOrg,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/list-filtering-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let deps: { db: TestDb['db'] };
let activityType: string;
const actor = { userId: newId() };

function scopeFor(
  orgId: string,
  role: ProviderRole = 'owner',
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
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-list-filter', 'Filter Sport')`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

async function draft(owner: OrgScope, title: string): Promise<string> {
  const created = await createProgram(deps, owner, actor, {
    titleEn: title,
    activityTypeId: activityType,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return created.program.id;
}

async function setState(programId: string, target: string): Promise<void> {
  // Walk the lifecycle in legal steps so DB transition guards stay honest.
  const path: Record<string, string[]> = {
    submitted: ['submitted'],
    in_review: ['submitted', 'in_review'],
    approved: ['submitted', 'in_review', 'approved'],
    published: ['submitted', 'in_review', 'approved', 'published'],
  };
  for (const step of path[target] ?? [target]) {
    if (step === 'published') {
      await sql`UPDATE program SET listing_state = 'published', published_at = now()
                WHERE id = ${programId}`.execute(testDb.db);
    } else {
      await sql`UPDATE program SET listing_state = ${step} WHERE id = ${programId}`.execute(
        testDb.db,
      );
    }
  }
}

function idsOf(page: { programs: Array<{ id: string }> }): string[] {
  return page.programs.map((row) => row.id);
}

describe('title search (q)', () => {
  it('matches a case-insensitive substring of the English title and nothing else', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const swim = await draft(owner, 'Adult Beginner Swimming');
    const yoga = await draft(owner, 'Morning Yoga');
    const page = await listProviderPrograms(deps, owner, { q: 'SWIM' });
    expect(idsOf(page)).toEqual([swim]);
    expect(idsOf(page)).not.toContain(yoga);
  });

  it('blank and whitespace-only search means NO predicate', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    await draft(owner, 'Alpha');
    await draft(owner, 'Beta');
    for (const q of [undefined, '', '   ', '\t']) {
      const page = await listProviderPrograms(deps, owner, { ...(q === undefined ? {} : { q }) });
      expect(page.programs).toHaveLength(2);
    }
  });

  it('normalizes internal whitespace runs so "beginner   swimming" still matches', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const target = await draft(owner, 'Adult Beginner Swimming');
    const page = await listProviderPrograms(deps, owner, { q: '  beginner   swimming ' });
    expect(idsOf(page)).toEqual([target]);
  });

  it('treats LIKE wildcards as literal text — "%" and "_" cannot broaden a search', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    await draft(owner, 'Plain Title');
    const literal = await draft(owner, '100% Fun_Time');
    expect(idsOf(await listProviderPrograms(deps, owner, { q: '%' }))).toEqual([literal]);
    expect(idsOf(await listProviderPrograms(deps, owner, { q: 'n_Time' }))).toEqual([literal]);
    expect(idsOf(await listProviderPrograms(deps, owner, { q: '100% fun' }))).toEqual([literal]);
  });
});

describe('lifecycle status filter', () => {
  it('returns exactly the authorized rows in that canonical state', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const draftRow = await draft(owner, 'Still Draft');
    const publishedRow = await draft(owner, 'Now Published');
    await setState(publishedRow, 'published');
    expect(idsOf(await listProviderPrograms(deps, owner, { status: 'published' }))).toEqual([
      publishedRow,
    ]);
    expect(idsOf(await listProviderPrograms(deps, owner, { status: 'draft' }))).toEqual([draftRow]);
    expect(idsOf(await listProviderPrograms(deps, owner, { status: 'archived' }))).toEqual([]);
  });

  it('HTTP: an out-of-canon status value is the normal schema validation refusal — never silently everything', async () => {
    const org = await createProviderOrg(testDb.db);
    const staff = await staffBearer(ctx, org.orgId, 'owner');
    const response = await app.inject({
      method: 'GET',
      url: `/provider/organizations/${org.orgId}/listings?status=live`,
      headers: { authorization: `Bearer ${staff.bearer}` },
    });
    // The repository's normal schema-validation refusal (422) — never a
    // silent unfiltered result.
    expect(response.statusCode).toBe(422);
  });

  it('HTTP: q and status ride the wire and compose', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const match = await draft(owner, 'Wire Swim Squad');
    await setState(match, 'published');
    const decoyDraft = await draft(owner, 'Wire Swim Draft');
    const decoyPublished = await draft(owner, 'Wire Run Club');
    await setState(decoyPublished, 'published');
    expect(decoyDraft).not.toBe(match);
    const staff = await staffBearer(ctx, org.orgId, 'owner');
    const response = await app.inject({
      method: 'GET',
      url: `/provider/organizations/${org.orgId}/listings?q=swim&status=published`,
      headers: { authorization: `Bearer ${staff.bearer}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { programs: Array<{ id: string }> };
    expect(body.programs.map((row) => row.id)).toEqual([match]);
  });
});

describe('combined search + status (conjunctive)', () => {
  it('returns only rows satisfying BOTH predicates', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const swimPublished = await draft(owner, 'Swim Sprint');
    await setState(swimPublished, 'published');
    await draft(owner, 'Swim Draft Only');
    const runPublished = await draft(owner, 'Run Published');
    await setState(runPublished, 'published');
    const page = await listProviderPrograms(deps, owner, { q: 'swim', status: 'published' });
    expect(idsOf(page)).toEqual([swimPublished]);
  });
});

describe('scope → filter → pagination ordering', () => {
  it('filters see the COMPLETE authorized set: a match beyond the first unfiltered page is found on the filtered FIRST page', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    for (let i = 0; i < 4; i += 1) {
      await draft(owner, `Filler ${i}`);
    }
    const lateMatch = await draft(owner, 'Late Swimming Star');
    // An unfiltered page of 3 would never contain the late row…
    const unfiltered = await listProviderPrograms(deps, owner, { limit: 3 });
    expect(idsOf(unfiltered)).not.toContain(lateMatch);
    // …the authoritative filtered read returns it immediately.
    const filtered = await listProviderPrograms(deps, owner, { limit: 3, q: 'swimming' });
    expect(idsOf(filtered)).toEqual([lateMatch]);
    expect(filtered.nextCursor).toBeNull();
  });

  it('a filtered walk pages the filtered set with stable cursors — no duplicates, no skips, full page slots', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const matching: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      matching.push(await draft(owner, `Match Swim ${i}`));
      await draft(owner, `Decoy Run ${i}`);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listProviderPrograms(deps, owner, {
        limit: 2,
        q: 'swim',
        ...(cursor === undefined ? {} : { cursor }),
      });
      // Non-matching rows never consume page slots.
      if (page.nextCursor !== null) expect(page.programs).toHaveLength(2);
      seen.push(...idsOf(page));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(matching);
  });

  it('a cursor replayed under DIFFERENT filters deterministically continues the new filtered set after that position', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    const swimA = await draft(owner, 'Swim A');
    const runB = await draft(owner, 'Run B');
    const swimC = await draft(owner, 'Swim C');
    const runD = await draft(owner, 'Run D');
    expect(swimA).not.toBe(runB);
    // Walk the swim set to get a cursor positioned at Swim A…
    const first = await listProviderPrograms(deps, owner, { limit: 1, q: 'swim' });
    expect(idsOf(first)).toEqual([swimA]);
    const cursor = first.nextCursor!;
    // …replaying it with the run filter yields exactly the run rows after
    // that (created_at, id) position — deterministic, never corrupted.
    const replayed = await listProviderPrograms(deps, owner, { q: 'run', cursor });
    expect(idsOf(replayed)).toEqual([runB, runD]);
    expect(idsOf(replayed)).not.toContain(swimC);
  });
});

describe('Branch Manager security with filters active', () => {
  it('search cannot discover an unreachable Program; hidden matches never leak through results, slots, or cursors', async () => {
    const org = await createProviderOrg(testDb.db, { branches: 2 });
    const owner = scopeFor(org.orgId);
    const manager = scopeFor(org.orgId, 'branch_manager', [org.branchIds[0]!]);
    const reachableMatch = await draft(owner, 'Scoped Swim Reachable');
    await addProgramBranch(deps, owner, actor, {
      programId: reachableMatch,
      branchId: org.branchIds[0]!,
    });
    const hiddenMatch = await draft(owner, 'Scoped Swim Hidden');
    await addProgramBranch(deps, owner, actor, {
      programId: hiddenMatch,
      branchId: org.branchIds[1]!,
    });
    const page = await listProviderPrograms(deps, manager, { q: 'scoped swim' });
    expect(idsOf(page)).toEqual([reachableMatch]);
    expect(page.nextCursor).toBeNull();

    const byStatus = await listProviderPrograms(deps, manager, { status: 'draft' });
    expect(idsOf(byStatus)).toContain(reachableMatch);
    expect(idsOf(byStatus)).not.toContain(hiddenMatch);
  });
});

describe('the C1 card projection is untouched by filtering', () => {
  it('a searched row keeps its card fields, stays ONE row despite joins, and the statement count stays constant', async () => {
    const org = await createProviderOrg(testDb.db);
    const owner = scopeFor(org.orgId);
    for (let i = 0; i < 8; i += 1) {
      const programId = await draft(owner, `Card Swim ${i}`);
      const option = await addPriceOption(deps, owner, actor, {
        programId,
        option: { kind: 'monthly', amountFils: 20_000 + i },
      });
      expect(option.kind).toBe('optionAdded');
      await addProgramBranch(deps, owner, actor, { programId, branchId: org.branchIds[0]! });
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
      const small = await listProviderPrograms({ db: countingDb }, owner, {
        limit: 2,
        q: 'card swim',
        status: 'draft',
      });
      expect(small.programs).toHaveLength(2);
      const smallCount = statements.length;
      expect(small.programs[0]).toMatchObject({
        activityType: { labelEn: 'Filter Sport', active: true },
        priceSummary: { kind: 'from', amountFils: 20_000, currency: 'AED' },
        branchSummary: { firstLabel: 'Branch 1', activeCount: 1 },
        thumbnail: null,
      });

      statements.length = 0;
      const large = await listProviderPrograms({ db: countingDb }, owner, {
        limit: 8,
        q: 'card swim',
        status: 'draft',
      });
      expect(large.programs).toHaveLength(8);
      expect(new Set(large.programs.map((row) => row.id)).size).toBe(8);
      expect(statements.length).toBe(smallCount);
    } finally {
      await countingDb.destroy();
    }
  });
});
