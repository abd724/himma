/**
 * Branch Manager provider-private catalogue READ scope (correction to the
 * W2-7-exposed defects; docs/28 §6 "branch_manager within branch scope
 * only" applied to the read surface with ONE reachability rule shared by
 * the list and the detail):
 *
 * - the scope filter participates in the authoritative SQL query BEFORE
 *   ordering/cursor/LIMIT, so keyset pagination walks the reachable result
 *   set without silently truncating it (the old implementation filtered a
 *   `limit + 1` organization-wide window in memory);
 * - the detail read applies the SAME reachability rule: an in-organization
 *   but out-of-scope Program is not-found-shaped exactly like a foreign or
 *   ghost id (no enumeration oracle);
 * - org-wide catalogue readers (owner, org_manager, listings_editor) keep
 *   their organization-wide read;
 * - scope changes bite immediately from database truth (no caching).
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
  addProgramBranch,
  createProgram,
  getProviderProgram,
  listProviderPrograms,
  removeProgramBranch,
} from '../src/modules/catalogue/services/program-management';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { ProviderRole } from '../src/modules/provider/provider-roles';
import {
  resolveOrgScope,
  type OrgScope,
} from '../src/modules/provider/services/provider-principal';
import { createUser } from './helpers/identity-fixtures';
import { addMembership, createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let deps: { db: TestDb['db'] };
let activityType: string;
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
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-scope-read', 'Scope Read')`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await testDb.drop();
});

async function draftAt(
  owner: OrgScope,
  title: string,
  branchIds: string[],
): Promise<string> {
  const created = await createProgram(deps, owner, actor, {
    titleEn: title,
    activityTypeId: activityType,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  for (const branchId of branchIds) {
    const associated = await addProgramBranch(deps, owner, actor, {
      programId: created.program.id,
      branchId,
    });
    if (associated.kind !== 'branchAssociated') throw new Error(associated.kind);
  }
  return created.program.id;
}

async function walkAllPages(
  scope: OrgScope,
  limit: number,
): Promise<{ ids: string[]; pageSizes: number[] }> {
  const ids: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listProviderPrograms(deps, scope, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    ids.push(...page.programs.map((program) => program.id));
    pageSizes.push(page.programs.length);
    if (page.nextCursor === null) return { ids, pageSizes };
    cursor = page.nextCursor;
  }
}

describe('branch-scoped LIST pagination (scope applied before the window)', () => {
  let org: { orgId: string; branchIds: string[] };
  let owner: OrgScope;
  let scoped: OrgScope;
  const reachableIds: string[] = [];
  const unreachableIds: string[] = [];

  beforeAll(async () => {
    org = await createProviderOrg(testDb.db, { branches: 2 });
    owner = scopeFor(org.orgId, 'owner');
    scoped = scopeFor(org.orgId, 'branch_manager', [org.branchIds[0]!]);
    // Deliberately interleaved creation order: even → assigned branch
    // (reachable), odd → the other branch (unreachable), then one
    // branchless draft (reachable everywhere by the canonical rule).
    for (let i = 0; i < 12; i += 1) {
      const reachable = i % 2 === 0;
      const id = await draftAt(owner, `Interleaved ${i}`, [
        org.branchIds[reachable ? 0 : 1]!,
      ]);
      (reachable ? reachableIds : unreachableIds).push(id);
    }
    reachableIds.push(await draftAt(owner, 'Branchless draft', []));
  });

  it('a small-limit first page fills with reachable programs — inaccessible rows consume no page slots', async () => {
    // Old implementation: window = first 4 rows org-wide, of which only 2
    // are reachable → a 2-row page and a null cursor (demonstrable
    // truncation). Corrected: 3 reachable rows and a live cursor.
    const first = await listProviderPrograms(deps, scoped, { limit: 3 });
    expect(first.programs.map((program) => program.id)).toEqual(reachableIds.slice(0, 3));
    expect(first.nextCursor).toBe(reachableIds[2]);
  });

  it('walking every page returns every reachable program exactly once, in order, and nothing else', async () => {
    const { ids, pageSizes } = await walkAllPages(scoped, 3);
    expect(ids).toEqual(reachableIds);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of unreachableIds) expect(ids).not.toContain(id);
    // Full pages of the requested size until the terminal remainder.
    expect(pageSizes).toEqual([3, 3, 1]);
  });

  it('the org-wide walk is unchanged: every program, reachable or not', async () => {
    const { ids } = await walkAllPages(owner, 5);
    expect(ids).toHaveLength(13);
    for (const id of [...reachableIds, ...unreachableIds]) expect(ids).toContain(id);
  });

  it('an empty branch scope grants only branchless drafts — never a fallback to org-wide', async () => {
    const none = scopeFor(org.orgId, 'branch_manager', []);
    const { ids } = await walkAllPages(none, 3);
    expect(ids).toEqual([reachableIds[reachableIds.length - 1]]);
  });
});

describe('branch-scoped DETAIL read (same reachability rule as the list)', () => {
  let org: { orgId: string; branchIds: string[] };
  let foreignOrg: { orgId: string; branchIds: string[] };
  let owner: OrgScope;
  let scoped: OrgScope;
  let inScopeId: string;
  let outOfScopeId: string;
  let mixedId: string;
  let branchlessId: string;
  let foreignId: string;

  beforeAll(async () => {
    org = await createProviderOrg(testDb.db, { branches: 3 });
    foreignOrg = await createProviderOrg(testDb.db);
    owner = scopeFor(org.orgId, 'owner');
    scoped = scopeFor(org.orgId, 'branch_manager', [org.branchIds[0]!]);
    inScopeId = await draftAt(owner, 'In Scope', [org.branchIds[0]!]);
    outOfScopeId = await draftAt(owner, 'Out Of Scope', [org.branchIds[1]!]);
    mixedId = await draftAt(owner, 'Mixed Reach', [org.branchIds[0]!, org.branchIds[1]!]);
    branchlessId = await draftAt(owner, 'Unplaced Draft', []);
    foreignId = await draftAt(scopeFor(foreignOrg.orgId, 'owner'), 'Foreign Program', [
      foreignOrg.branchIds[0]!,
    ]);
  });

  it('reads an in-scope program, a some-association-in-scope program, and a branchless draft', async () => {
    for (const programId of [inScopeId, mixedId, branchlessId]) {
      const detail = await getProviderProgram(deps, scoped, { programId });
      expect(detail.kind).toBe('programView');
    }
  });

  it('an in-organization out-of-scope program is not-found-shaped exactly like foreign and ghost ids', async () => {
    const outOfScope = await getProviderProgram(deps, scoped, { programId: outOfScopeId });
    const foreign = await getProviderProgram(deps, scoped, { programId: foreignId });
    const ghost = await getProviderProgram(deps, scoped, { programId: newId() });
    expect(outOfScope).toEqual({ kind: 'programNotFound' });
    expect(foreign).toEqual(outOfScope);
    expect(ghost).toEqual(outOfScope);
  });

  it('detail readability matches list reachability exactly (no direct-URL oracle)', async () => {
    const listed = (await walkAllPages(scoped, 2)).ids;
    for (const programId of [inScopeId, outOfScopeId, mixedId, branchlessId]) {
      const detail = await getProviderProgram(deps, scoped, { programId });
      expect(`${programId}:${detail.kind}`).toBe(
        `${programId}:${listed.includes(programId) ? 'programView' : 'programNotFound'}`,
      );
    }
  });

  it('org-wide catalogue readers keep their organization-wide detail read', async () => {
    for (const role of ['owner', 'org_manager', 'listings_editor'] as const) {
      const detail = await getProviderProgram(deps, scopeFor(org.orgId, role), {
        programId: outOfScopeId,
      });
      expect(`${role}:${detail.kind}`).toBe(`${role}:programView`);
    }
  });

  it('scope changes bite immediately: losing the qualifying association removes reach; a now-branchless draft is reachable again', async () => {
    // `mixedId` is reachable through the assigned branch only.
    const before = await getProviderProgram(deps, scoped, { programId: mixedId });
    expect(before.kind).toBe('programView');
    const removed = await removeProgramBranch(deps, owner, actor, {
      programId: mixedId,
      branchId: org.branchIds[0]!,
    });
    expect(removed.kind).toBe('branchAssociationRemoved');
    // Only the out-of-scope association remains active → unreachable.
    expect((await getProviderProgram(deps, scoped, { programId: mixedId })).kind).toBe(
      'programNotFound',
    );
    expect((await walkAllPages(scoped, 3)).ids).not.toContain(mixedId);
    // The org-wide reader is unaffected.
    expect((await getProviderProgram(deps, owner, { programId: mixedId })).kind).toBe('programView');

    // Removing the LAST active association turns the program branchless —
    // the canonical branchless-draft handling makes it reachable again.
    const lastRemoved = await removeProgramBranch(deps, owner, actor, {
      programId: mixedId,
      branchId: org.branchIds[1]!,
    });
    expect(lastRemoved.kind).toBe('branchAssociationRemoved');
    expect((await getProviderProgram(deps, scoped, { programId: mixedId })).kind).toBe('programView');
  });

  it('branch deactivation bites through fresh scope resolution (database truth, no cached authorization)', async () => {
    const userId = await createUser(testDb.db);
    await addMembership(testDb.db, userId, org.orgId, 'branch_manager', [org.branchIds[2]!]);
    const programId = await draftAt(owner, 'Deactivation Bite', [org.branchIds[2]!]);

    const resolvedBefore = await resolveOrgScope(deps, { userId, organizationId: org.orgId });
    if (resolvedBefore.kind !== 'resolved') throw new Error(resolvedBefore.kind);
    expect(resolvedBefore.orgScope.branchScope).toEqual([org.branchIds[2]!]);
    expect(
      (await getProviderProgram(deps, resolvedBefore.orgScope, { programId })).kind,
    ).toBe('programView');

    await sql`UPDATE branch SET active = false WHERE id = ${org.branchIds[2]!}`.execute(testDb.db);
    const resolvedAfter = await resolveOrgScope(deps, { userId, organizationId: org.orgId });
    if (resolvedAfter.kind !== 'resolved') throw new Error(resolvedAfter.kind);
    // The deactivated branch vanishes from the resolved scope…
    expect(resolvedAfter.orgScope.branchScope).toEqual([]);
    // …and with it the program's reachability, while org-wide reads hold.
    expect(
      (await getProviderProgram(deps, resolvedAfter.orgScope, { programId })).kind,
    ).toBe('programNotFound');
    expect((await getProviderProgram(deps, owner, { programId })).kind).toBe('programView');
  });
});
