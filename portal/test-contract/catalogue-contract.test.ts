/**
 * W2-12C1 catalogue contract tests (task §25–§27): the LIVE catalogue READ
 * ports — taxonomy (categories · activity types) · provider Listings index
 * (the list-card projection) · provider listing detail — against the REAL
 * backend (`buildApp` on real PostgreSQL) through the REAL authenticated
 * W2-12A transport (sign-in + MFA over the deterministic fake Cognito
 * boundary). Every route, capability check, scope rule, and DTO below is
 * the real thing; catalogue rows are seeded through the real Slice-4
 * services so every database invariant holds.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import {
  addOffer,
  addProgramMedia,
} from '../../backend/src/modules/catalogue/services/media-offer-management';
import {
  addPriceOption,
  archivePriceOption,
} from '../../backend/src/modules/catalogue/services/price-option-management';
import {
  addProgramBranch,
  createProgram,
} from '../../backend/src/modules/catalogue/services/program-management';
import { capabilitiesForRole } from '../../backend/src/modules/provider/provider-capabilities';
import type { ProviderRole } from '../../backend/src/modules/provider/provider-roles';
import type { OrgScope } from '../../backend/src/modules/provider/services/provider-principal';
import { createIdentity, createUser } from '../../backend/test/helpers/identity-fixtures';
import { addMembership, createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import {
  createLiveCatalogueReadPorts,
  type LiveCatalogueReadPorts,
} from '../src/services/live/live-catalogue-ports';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from './support/backend-harness';

let harness: ContractHarness;
let fitnessCategoryId: string;

beforeAll(async () => {
  harness = await createContractHarness();
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(harness.testDb.db);
  fitnessCategoryId = category.rows[0]!.id;
});

afterAll(async () => {
  await harness.close();
});

let userCounter = 900;
const actor = { userId: newId() };
const serviceDeps = () => ({ db: harness.testDb.db });

function scopeFor(orgId: string, role: ProviderRole = 'owner'): OrgScope {
  return {
    organizationId: orgId,
    membershipId: newId(),
    role,
    capabilities: capabilitiesForRole(role),
    branchScope: 'all',
    organizationState: 'live',
  };
}

async function insertActivityType(options: {
  label: string;
  active?: boolean;
}): Promise<string> {
  const id = newId();
  const slug = `contract-${options.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(-6)}`;
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en, active)
            VALUES (${id}, ${fitnessCategoryId}, ${slug}, ${options.label}, ${options.active ?? true})`.execute(
    harness.testDb.db,
  );
  return id;
}

interface LiveCatalogueSession {
  ports: LiveCatalogueReadPorts;
  countAppRequests: () => number;
}

/** MFA sign-in through the REAL live adapter; returns the live catalogue
 *  read ports bound to that session's transport, plus a request counter
 *  over every HTTP call the transport makes to the app (the no-N+1 proof
 *  instrument — fake-Cognito calls are excluded). */
async function signedInCataloguePorts(user: {
  email: string;
  password: string;
}): Promise<LiveCatalogueSession> {
  let appRequests = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(harness.apiBaseUrl)) appRequests += 1;
    return harness.fetchImpl(url, init ?? {});
  };
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: countingFetch,
  });
  await runtime.adapter.signIn({ email: user.email, password: user.password });
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  if (signedIn.kind !== 'signedIn') throw new Error(`sign-in failed: ${signedIn.kind}`);
  return {
    ports: createLiveCatalogueReadPorts(runtime.transport),
    countAppRequests: () => appRequests,
  };
}

async function provisionUser(): Promise<{ userId: string; email: string; password: string }> {
  userCounter += 1;
  const email = `catalogue-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `catalogue-sub-${userCounter}`;
  const userId = await createUser(harness.testDb.db);
  await createIdentity(harness.testDb.db, userId, {
    provider: 'email',
    issuer: CONTRACT_ISSUER,
    subject,
    email,
    emailVerified: true,
  });
  await harness.testDb.db
    .insertInto('mfa_method')
    .values({ id: newId(), user_id: userId, kind: 'totp', state: 'active', confirmed_at: new Date() })
    .execute();
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: `Catalogue ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, email, password };
}

async function provisionOrgWithRole(
  role: ProviderRole,
  options: { branches?: number; scoped?: boolean } = {},
): Promise<{ session: LiveCatalogueSession; orgId: string; branchIds: string[] }> {
  const user = await provisionUser();
  const org = await createProviderOrg(harness.testDb.db, {
    branches: options.branches ?? 2,
    displayName: `Catalogue org ${userCounter}`,
  });
  await addMembership(
    harness.testDb.db,
    user.userId,
    org.orgId,
    role,
    options.scoped === true ? [org.branchIds[0] as string] : undefined,
  );
  const session = await signedInCataloguePorts(user);
  return { session, orgId: org.orgId, branchIds: org.branchIds };
}

async function seedProgram(
  orgId: string,
  input: { title: string; activityTypeId: string },
): Promise<string> {
  const created = await createProgram(serviceDeps(), scopeFor(orgId), actor, {
    titleEn: input.title,
    activityTypeId: input.activityTypeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return created.program.id;
}

async function seedOption(
  orgId: string,
  programId: string,
  kind: 'dropIn' | 'monthly' | 'free',
  amountFils: number | null,
): Promise<{ id: string; version: number }> {
  const added = await addPriceOption(serviceDeps(), scopeFor(orgId), actor, {
    programId,
    option: { kind, ...(amountFils === null ? {} : { amountFils }) },
  });
  if (added.kind !== 'optionAdded') throw new Error(added.kind);
  return { id: added.option.id, version: added.option.version };
}

describe('taxonomy reads (§25)', () => {
  test('live categories mirror the REAL active category rows in the canonical order — deterministic mapping, no frontend duplicate', async () => {
    const { ports } = await signedInCataloguePorts(await provisionUser());
    const outcome = await ports.categoryPort.listCategories();
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    const dbRows = await harness.testDb.db
      .selectFrom('category')
      .select(['id', 'slug', 'label_en'])
      .where('active', '=', true)
      .orderBy('sort_hint')
      .orderBy('slug')
      .execute();
    expect(dbRows.length).toBeGreaterThan(0);
    expect(outcome.categories.map((row) => ({ id: row.id, slug: row.slug, label_en: row.labelEn }))).toEqual(
      dbRows,
    );
  });

  test('live activity types serve ACTIVE rows with their real category relationship; an inactive type is absent from the new-choice collection', async () => {
    const activeType = await insertActivityType({ label: 'Contract Rowing' });
    const retiredType = await insertActivityType({ label: 'Contract Retired', active: false });
    const { ports } = await signedInCataloguePorts(await provisionUser());
    const outcome = await ports.activityTypePort.listActivityTypes();
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    const active = outcome.activityTypes.find((row) => row.id === activeType);
    expect(active).toMatchObject({ labelEn: 'Contract Rowing', categoryId: fitnessCategoryId });
    expect(outcome.activityTypes.find((row) => row.id === retiredType)).toBeUndefined();

    // The category relationship resolves against the same public read.
    const categories = await ports.categoryPort.listCategories();
    if (categories.kind !== 'loaded') throw new Error(categories.kind);
    expect(categories.categories.some((row) => row.id === active!.categoryId)).toBe(true);
  });

  test('deactivating a category removes it from the read — active-only is database truth, not frontend filtering', async () => {
    const id = newId();
    await sql`INSERT INTO category (id, slug, label_en, sort_hint)
              VALUES (${id}, 'contract-temp-category', 'Temp Category', 9_900)`.execute(
      harness.testDb.db,
    );
    const { ports } = await signedInCataloguePorts(await provisionUser());
    const before = await ports.categoryPort.listCategories();
    if (before.kind !== 'loaded') throw new Error(before.kind);
    expect(before.categories.some((row) => row.id === id)).toBe(true);
    await sql`UPDATE category SET active = false WHERE id = ${id}`.execute(harness.testDb.db);
    const after = await ports.categoryPort.listCategories();
    if (after.kind !== 'loaded') throw new Error(after.kind);
    expect(after.categories.some((row) => row.id === id)).toBe(false);
  });

  test('taxonomy is a PUBLIC read: it resolves without any session and grants nothing (§25.5)', async () => {
    const runtime = createLiveAuthRuntime({
      apiBaseUrl: harness.apiBaseUrl,
      cognitoIssuer: CONTRACT_ISSUER,
      cognitoClientId: CONTRACT_CLIENT_ID,
      fetchImpl: harness.fetchImpl,
    });
    // Never signed in — the public taxonomy reads still serve real rows...
    const ports = createLiveCatalogueReadPorts(runtime.transport);
    const taxonomy = await ports.activityTypePort.listActivityTypes();
    expect(taxonomy.kind).toBe('loaded');
    // ...while the provider catalogue read stays sealed without a session.
    await expect(ports.listingsPort.listListings(newId())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

describe('Listings index — the list-card projection (§26)', () => {
  test('an owner reads real organization rows: one card per Program with real activity label, lifecycle state, updated timestamp, and D-S4-1 price semantics', async () => {
    const typeId = await insertActivityType({ label: 'Contract Strength' });
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');

    // Program A: paid options where the ARCHIVED cheapest must not price
    // the card, associated to branch 1, with real media metadata.
    const programA = await seedProgram(orgId, { title: 'Strength Foundations', activityTypeId: typeId });
    const cheap = await seedOption(orgId, programA, 'dropIn', 2_000);
    await seedOption(orgId, programA, 'monthly', 30_000);
    const archived = await archivePriceOption(serviceDeps(), scopeFor(orgId), actor, {
      programId: programA,
      optionId: cheap.id,
      expectedVersion: cheap.version,
    });
    expect(archived.kind).toBe('optionArchived');
    const associated = await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
      programId: programA,
      branchId: branchIds[0]!,
    });
    expect(associated.kind).toBe('branchAssociated');
    const media = await addProgramMedia(serviceDeps(), scopeFor(orgId), actor, {
      programId: programA,
      mediaRef: newId(),
      altTextEn: 'Hero image',
    });
    expect(media.kind).toBe('mediaAdded');

    // Program B: an active free option wins over the paid one.
    const programB = await seedProgram(orgId, { title: 'Community Session', activityTypeId: typeId });
    await seedOption(orgId, programB, 'monthly', 10_000);
    await seedOption(orgId, programB, 'free', null);

    // Program C: nothing configured — the honest readiness card.
    const programC = await seedProgram(orgId, { title: 'Bare Draft', activityTypeId: typeId });

    const outcome = await session.ports.listingsPort.listListings(orgId);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.page.programs).toHaveLength(3);
    expect(outcome.page.programs.filter((row) => row.id === programA)).toHaveLength(1);

    const cardA = outcome.page.programs.find((row) => row.id === programA)!;
    expect(cardA).toMatchObject({
      titleEn: 'Strength Foundations',
      listingState: 'draft',
      activityType: { id: typeId, labelEn: 'Contract Strength', active: true },
      priceSummary: { kind: 'from', amountFils: 30_000 },
      branchSummary: { firstLabel: 'Branch 1', activeCount: 1 },
    });
    expect(Date.parse(cardA.updatedAt)).not.toBeNaN();
    // Real media METADATA exists on the wire, but no binary/URL source
    // exists — the presentation stays the truthful placeholder (§26.15).
    expect(cardA.thumbnailUrl).toBeNull();

    expect(outcome.page.programs.find((row) => row.id === programB)!.priceSummary).toEqual({
      kind: 'free',
    });
    const cardC = outcome.page.programs.find((row) => row.id === programC)!;
    expect(cardC.priceSummary).toEqual({ kind: 'none' });
    expect(cardC.branchSummary).toEqual({ firstLabel: null, activeCount: 0 });
    expect(cardC.thumbnailUrl).toBeNull();
  });

  test('one page = ONE backend request — the card never degrades into N+1 detail/price/branch calls (§26.16)', async () => {
    const typeId = await insertActivityType({ label: 'Contract Cycling' });
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    for (let i = 0; i < 5; i += 1) {
      const programId = await seedProgram(orgId, { title: `Ride ${i}`, activityTypeId: typeId });
      await seedOption(orgId, programId, 'monthly', 12_000 + i);
      await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
        programId,
        branchId: branchIds[0]!,
      });
    }
    const before = session.countAppRequests();
    const outcome = await session.ports.listingsPort.listListings(orgId, { limit: 50 });
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.page.programs).toHaveLength(5);
    for (const row of outcome.page.programs) {
      expect(row.priceSummary.kind).toBe('from');
      expect(row.branchSummary.activeCount).toBe(1);
    }
    expect(session.countAppRequests() - before).toBe(1);
  });

  test('real keyset pagination stays stable under the projection: pages walk every row exactly once in (createdAt, id) order', async () => {
    const typeId = await insertActivityType({ label: 'Contract Walks' });
    const { session, orgId } = await provisionOrgWithRole('owner');
    const created: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      created.push(await seedProgram(orgId, { title: `Walk ${i}`, activityTypeId: typeId }));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const outcome = await session.ports.listingsPort.listListings(orgId, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      seen.push(...outcome.page.programs.map((row) => row.id));
      if (outcome.page.nextCursor === null) break;
      cursor = outcome.page.nextCursor;
    }
    expect(seen).toEqual(created);
  });

  test('a Branch Manager receives ONLY backend-authorized reachable rows — scope applies before the page window, and counts never leak hidden truth (§26.2/14)', async () => {
    const typeId = await insertActivityType({ label: 'Contract Scoped' });
    const { session, orgId, branchIds } = await provisionOrgWithRole('branch_manager', {
      scoped: true,
    });
    const reachable: string[] = [];
    const hidden: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const inScope = await seedProgram(orgId, { title: `In ${i}`, activityTypeId: typeId });
      await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
        programId: inScope,
        branchId: branchIds[0]!,
      });
      reachable.push(inScope);
      const outOfScope = await seedProgram(orgId, { title: `Out ${i}`, activityTypeId: typeId });
      await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
        programId: outOfScope,
        branchId: branchIds[1]!,
      });
      hidden.push(outOfScope);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const outcome = await session.ports.listingsPort.listListings(orgId, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
      seen.push(...outcome.page.programs.map((row) => row.id));
      if (outcome.page.nextCursor === null) break;
      cursor = outcome.page.nextCursor;
    }
    expect(seen).toEqual(reachable);
    for (const id of hidden) expect(seen).not.toContain(id);
  });

  test('a foreign organization and a member without catalogue.read stay sealed on the index (§26.3, §31)', async () => {
    const { session } = await provisionOrgWithRole('owner');
    const foreign = await createProviderOrg(harness.testDb.db, {
      displayName: 'Foreign catalogue org',
    });
    await expect(session.ports.listingsPort.listListings(foreign.orgId)).resolves.toEqual({
      kind: 'notFound',
    });

    const { session: finance, orgId } = await provisionOrgWithRole('finance');
    await expect(finance.ports.listingsPort.listListings(orgId)).resolves.toEqual({
      kind: 'forbidden',
    });
  });
});

describe('authoritative search & status filtering (W2-12C1 final correction)', () => {
  async function publish(orgId: string, programId: string): Promise<void> {
    for (const step of ['submitted', 'in_review', 'approved'] as const) {
      await sql`UPDATE program SET listing_state = ${step} WHERE id = ${programId}`.execute(
        harness.testDb.db,
      );
    }
    await sql`UPDATE program SET listing_state = 'published', published_at = now()
              WHERE id = ${programId}`.execute(harness.testDb.db);
  }

  test('THE original defect is gone: a matching listing beyond the first unfiltered page is found by authoritative server search', async () => {
    const typeId = await insertActivityType({ label: 'Contract Search' });
    const { session, orgId } = await provisionOrgWithRole('owner');
    for (let i = 0; i < 4; i += 1) {
      await seedProgram(orgId, { title: `Search Filler ${i}`, activityTypeId: typeId });
    }
    const lateMatch = await seedProgram(orgId, {
      title: 'Late Kayaking Adventure',
      activityTypeId: typeId,
    });

    // The first unfiltered page (limit 3) can never contain the late row…
    const unfiltered = await session.ports.listingsPort.listListings(orgId, { limit: 3 });
    if (unfiltered.kind !== 'loaded') throw new Error(unfiltered.kind);
    expect(unfiltered.page.programs.map((row) => row.id)).not.toContain(lateMatch);

    // …the authoritative search returns it on ITS first page — the old
    // client-side filter would have said it does not exist.
    const searched = await session.ports.listingsPort.listListings(orgId, {
      limit: 3,
      q: 'kayaking',
    });
    if (searched.kind !== 'loaded') throw new Error(searched.kind);
    expect(searched.page.programs.map((row) => row.id)).toEqual([lateMatch]);
    expect(searched.page.nextCursor).toBeNull();
  });

  test('status-filtered pagination walks the filtered set with stable cursors; search+status compose conjunctively', async () => {
    const typeId = await insertActivityType({ label: 'Contract Status' });
    const { session, orgId } = await provisionOrgWithRole('owner');
    const published: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const match = await seedProgram(orgId, { title: `Live Row ${i}`, activityTypeId: typeId });
      await publish(orgId, match);
      published.push(match);
      await seedProgram(orgId, { title: `Draft Row ${i}`, activityTypeId: typeId });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await session.ports.listingsPort.listListings(orgId, {
        limit: 2,
        status: 'published',
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.kind !== 'loaded') throw new Error(page.kind);
      seen.push(...page.page.programs.map((row) => row.id));
      for (const row of page.page.programs) expect(row.listingState).toBe('published');
      if (page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    expect(seen).toEqual(published);

    const combined = await session.ports.listingsPort.listListings(orgId, {
      q: 'row 1',
      status: 'published',
    });
    if (combined.kind !== 'loaded') throw new Error(combined.kind);
    expect(combined.page.programs.map((row) => row.id)).toEqual([published[1]]);
  });

  test('a Branch Manager searching cannot discover an unreachable matching listing, and foreign rows never appear', async () => {
    const typeId = await insertActivityType({ label: 'Contract Hidden' });
    const { session, orgId, branchIds } = await provisionOrgWithRole('branch_manager', {
      scoped: true,
    });
    const reachable = await seedProgram(orgId, {
      title: 'Hidden Search Reachable',
      activityTypeId: typeId,
    });
    await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
      programId: reachable,
      branchId: branchIds[0]!,
    });
    const hidden = await seedProgram(orgId, {
      title: 'Hidden Search Sealed',
      activityTypeId: typeId,
    });
    await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
      programId: hidden,
      branchId: branchIds[1]!,
    });
    const foreign = await createProviderOrg(harness.testDb.db);
    await seedProgram(foreign.orgId, { title: 'Hidden Search Foreign', activityTypeId: typeId });

    const outcome = await session.ports.listingsPort.listListings(orgId, { q: 'hidden search' });
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.page.programs.map((row) => row.id)).toEqual([reachable]);
    expect(outcome.page.nextCursor).toBeNull();
    expect(JSON.stringify(outcome)).not.toContain('Sealed');
    expect(JSON.stringify(outcome)).not.toContain('Foreign');
  });
});

describe('listing detail (§27)', () => {
  test('authorized detail is the real ProgramDetailView: price options, associations, media metadata, offers, lifecycle — and NOTHING fabricated', async () => {
    const typeId = await insertActivityType({ label: 'Contract Detail' });
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    const programId = await seedProgram(orgId, { title: 'Detail Program', activityTypeId: typeId });
    await seedOption(orgId, programId, 'monthly', 25_000);
    await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
      programId,
      branchId: branchIds[0]!,
    });
    const mediaRef = newId();
    await addProgramMedia(serviceDeps(), scopeFor(orgId), actor, {
      programId,
      mediaRef,
      altTextEn: 'Front',
    });
    const offer = await addOffer(serviceDeps(), scopeFor(orgId), actor, {
      programId,
      offer: { kind: 'freeTrial', labelEn: 'Try a session' },
    });
    expect(offer.kind).toBe('offerAdded');

    const outcome = await session.ports.listingsPort.loadListing(orgId, programId);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    const program = outcome.program;
    expect(program).toMatchObject({
      id: programId,
      organizationId: orgId,
      listingState: 'draft',
      activityType: { id: typeId, labelEn: 'Contract Detail', active: true, categoryId: fitnessCategoryId },
    });
    expect(program.priceOptions).toHaveLength(1);
    expect(program.priceOptions[0]).toMatchObject({
      kind: 'monthly',
      amountFils: 25_000,
      currency: 'AED',
      state: 'active',
    });
    expect(program.branches).toEqual([
      expect.objectContaining({
        branchId: branchIds[0],
        label: 'Branch 1',
        branchActive: true,
        associationActive: true,
      }),
    ]);
    expect(program.media).toEqual([
      expect.objectContaining({ mediaRef, altTextEn: 'Front', active: true }),
    ]);
    expect(program.offers).toEqual([
      expect.objectContaining({ kind: 'freeTrial', labelEn: 'Try a session', state: 'active' }),
    ]);
    // Protected-revision status maps only what the read contract exposes:
    // no open revision → null; and NO reviewer-feedback/moderation field
    // exists anywhere on the record (§27.9/10).
    expect(program.openRevision).toBeNull();
    expect(Object.keys(program).sort()).toEqual([
      'activityType', 'allAges', 'archivedAt', 'branches', 'createdAt',
      'descriptionAr', 'descriptionEn', 'eligibilityNotes', 'genderEligibility',
      'id', 'listingState', 'maxAge', 'media', 'minAge', 'offers',
      'openRevision', 'organizationId', 'priceOptions', 'publishedAt',
      'sensitiveFieldsVersion', 'setting', 'skillLevel', 'titleAr', 'titleEn',
      'updatedAt', 'version',
    ]);
  });

  test("a manually entered inaccessible id cannot reveal detail: a foreign org's listing, a Branch Manager's out-of-scope listing, and a ghost id share ONE refusal shape (§27.2/3)", async () => {
    const typeId = await insertActivityType({ label: 'Contract Sealed' });
    const { session: manager, orgId, branchIds } = await provisionOrgWithRole('branch_manager', {
      scoped: true,
    });
    const outOfScope = await seedProgram(orgId, { title: 'Bay Only', activityTypeId: typeId });
    await addProgramBranch(serviceDeps(), scopeFor(orgId), actor, {
      programId: outOfScope,
      branchId: branchIds[1]!,
    });

    const foreign = await createProviderOrg(harness.testDb.db);
    const foreignProgram = await seedProgram(foreign.orgId, {
      title: 'Foreign Secret Listing',
      activityTypeId: typeId,
    });
    await seedOption(foreign.orgId, foreignProgram, 'monthly', 99_000);

    const outOfScopeRead = await manager.ports.listingsPort.loadListing(orgId, outOfScope);
    const foreignRead = await manager.ports.listingsPort.loadListing(orgId, foreignProgram);
    const ghostRead = await manager.ports.listingsPort.loadListing(orgId, newId());
    expect(outOfScopeRead).toEqual({ kind: 'notFound' });
    expect(foreignRead).toEqual(outOfScopeRead);
    expect(ghostRead).toEqual(outOfScopeRead);
    // No price from an inaccessible Program leaked anywhere (§31).
    expect(JSON.stringify([outOfScopeRead, foreignRead, ghostRead])).not.toContain('99000');
  });
});
