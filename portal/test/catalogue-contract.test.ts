import {
  createUnconfiguredActivityTypePort,
  createUnconfiguredListingsPort,
} from '../src/auth/unconfigured-adapter';
import {
  createFixtureAuthRuntime,
  fixtureActivityTypes,
  fixtureBranches,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';

const blueWave = fixtureOrganizations.blueWave.organizationId;
const noor = fixtureOrganizations.noor.organizationId;
const falcon = fixtureOrganizations.falcon.organizationId;
const coral = fixtureOrganizations.coral.organizationId;

type Runtime = ReturnType<typeof createFixtureAuthRuntime>;

function runtimeAs(email: string): Runtime {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession(email);
  return runtime;
}

async function pageOf(runtime: Runtime, orgId: string, params?: { limit?: number; cursor?: string }) {
  const outcome = await runtime.listingsPort.listListings(orgId, params);
  if (outcome.kind !== 'loaded') {
    throw new Error(`expected loaded page, got ${outcome.kind}`);
  }
  return outcome.page;
}

async function detailOf(runtime: Runtime, orgId: string, programId: string) {
  const outcome = await runtime.listingsPort.loadListing(orgId, programId);
  if (outcome.kind !== 'loaded') {
    throw new Error(`expected loaded detail, got ${outcome.kind}`);
  }
  return outcome.program;
}

describe('listings read port (fixture semantics, W2-7)', () => {
  test('the port exposes EXACTLY the two real read operations — no mutation of any kind', () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(Object.keys(runtime.listingsPort).sort()).toEqual(['listListings', 'loadListing']);
  });

  test('catalogue READ mirrors the exact registry on the LIST: owner, org_manager, branch_manager, listings_editor — coach/front_desk/finance forbidden', async () => {
    expect((await runtimeAs('owner@bluewave.demo').listingsPort.listListings(blueWave)).kind).toBe('loaded');
    expect((await runtimeAs('director@himma.demo').listingsPort.listListings(blueWave)).kind).toBe('loaded');
    expect((await runtimeAs('manager@bluewave.demo').listingsPort.listListings(blueWave)).kind).toBe('loaded');
    expect((await runtimeAs('flaky@bluewave.demo').listingsPort.listListings(blueWave)).kind).toBe('loaded');
    expect((await runtimeAs('assistant@coral.demo').listingsPort.listListings(coral)).kind).toBe('forbidden');
    expect((await runtimeAs('frontdesk@bluewave.demo').listingsPort.listListings(blueWave)).kind).toBe('forbidden');
    expect((await runtimeAs('finance@bluewave.demo').listingsPort.listListings(blueWave)).kind).toBe('forbidden');
  });

  test('catalogue READ mirrors the exact registry on the DETAIL as well', async () => {
    const target = fixtureListings.adultSwimming;
    expect((await runtimeAs('owner@bluewave.demo').listingsPort.loadListing(blueWave, target)).kind).toBe('loaded');
    expect((await runtimeAs('director@himma.demo').listingsPort.loadListing(blueWave, target)).kind).toBe('loaded');
    expect((await runtimeAs('manager@bluewave.demo').listingsPort.loadListing(blueWave, target)).kind).toBe('loaded');
    expect((await runtimeAs('flaky@bluewave.demo').listingsPort.loadListing(blueWave, target)).kind).toBe('loaded');
    expect((await runtimeAs('frontdesk@bluewave.demo').listingsPort.loadListing(blueWave, target)).kind).toBe('forbidden');
    expect((await runtimeAs('finance@bluewave.demo').listingsPort.loadListing(blueWave, target)).kind).toBe('forbidden');
  });

  test('the list row carries EXACTLY the real seven fields — no price, branch, media, offer, revision, or operational data', async () => {
    const page = await pageOf(runtimeAs('owner@bluewave.demo'), blueWave);
    const first = page.programs[0]!;
    expect(Object.keys(first).sort()).toEqual([
      'activityTypeId',
      'createdAt',
      'id',
      'listingState',
      'titleEn',
      'updatedAt',
      'version',
    ]);
  });

  test('the detail record carries EXACTLY the real ProgramDetailView fields', async () => {
    const program = await detailOf(runtimeAs('owner@bluewave.demo'), blueWave, fixtureListings.adultSwimming);
    expect(Object.keys(program).sort()).toEqual([
      'activityType',
      'allAges',
      'archivedAt',
      'branches',
      'createdAt',
      'descriptionAr',
      'descriptionEn',
      'eligibilityNotes',
      'genderEligibility',
      'id',
      'listingState',
      'maxAge',
      'media',
      'minAge',
      'offers',
      'openRevision',
      'organizationId',
      'priceOptions',
      'publishedAt',
      'sensitiveFieldsVersion',
      'setting',
      'skillLevel',
      'titleAr',
      'titleEn',
      'updatedAt',
      'version',
    ]);
    expect(Object.keys(program.priceOptions[0]!).sort()).toEqual([
      'amountFils',
      'currency',
      'id',
      'kind',
      'labelAr',
      'labelEn',
      'sessionsCount',
      'sortHint',
      'state',
      'version',
    ]);
    expect(Object.keys(program.branches[0]!).sort()).toEqual([
      'associationActive',
      'branchActive',
      'branchId',
      'label',
      'version',
    ]);
    // No authoritative single Program.price exists anywhere (D-S4-1).
    expect('price' in program).toBe(false);
  });

  test('a multi-option Program is ONE listing: one list row, several ProgramPriceOptions under the detail', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const page = await pageOf(runtime, blueWave);
    const rows = page.programs.filter((row) => row.titleEn === 'Adult Beginner Swimming');
    expect(rows).toHaveLength(1);
    const program = await detailOf(runtime, blueWave, fixtureListings.adultSwimming);
    expect(program.priceOptions).toHaveLength(3);
    // Deterministic (sortHint, id) order; archive-only retirement preserved.
    expect(program.priceOptions.map((option) => option.state)).toEqual([
      'active',
      'active',
      'archived',
    ]);
    expect(program.priceOptions.every((option) => option.currency === 'AED')).toBe(true);
  });

  test('offers are a separate truth from price options (Offer ≠ ProgramPriceOption)', async () => {
    const program = await detailOf(runtimeAs('owner@bluewave.demo'), blueWave, fixtureListings.adultSwimming);
    expect(program.offers).toHaveLength(1);
    expect(program.offers[0]!.kind).toBe('freeTrial');
    // Trials are Offers, never price-option rows (docs/24 §12.1).
    expect(program.priceOptions.some((option) => option.kind === 'freeTrial')).toBe(false);
  });

  test('keyset pagination walks the full catalogue in (createdAt, id) order with the opaque id cursor', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const first = await pageOf(runtime, blueWave, { limit: 5 });
    expect(first.programs).toHaveLength(5);
    expect(first.nextCursor).toBe(first.programs[4]!.id);
    const second = await pageOf(runtime, blueWave, { limit: 5, cursor: first.nextCursor! });
    expect(second.programs).toHaveLength(5);
    const third = await pageOf(runtime, blueWave, { limit: 5, cursor: second.nextCursor! });
    expect(third.programs).toHaveLength(2);
    expect(third.nextCursor).toBeNull();
    const walked = [...first.programs, ...second.programs, ...third.programs];
    expect(new Set(walked.map((row) => row.id)).size).toBe(12);
    const createdAts = walked.map((row) => row.createdAt);
    expect([...createdAts].sort()).toEqual(createdAts);
  });

  test('an unknown or foreign cursor is ignored exactly like the real service (the list restarts)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const fromStart = await pageOf(runtime, blueWave, { limit: 3 });
    const unknownCursor = await pageOf(runtime, blueWave, {
      limit: 3,
      cursor: '0198a2f0-5b7a-7000-8000-000000000000',
    });
    expect(unknownCursor).toEqual(fromStart);
    const foreignCursor = await pageOf(runtime, blueWave, {
      limit: 3,
      cursor: fixtureListings.noorAfterSchool,
    });
    expect(foreignCursor).toEqual(fromStart);
  });

  test('a branch-scoped membership lists only REACHABLE listings: branchless drafts plus active associations inside the assigned active branches', async () => {
    const page = await pageOf(runtimeAs('manager@bluewave.demo'), blueWave, { limit: 50 });
    const ids = page.programs.map((row) => row.id);
    expect(ids).toEqual([
      fixtureListings.adultSwimming, // Marina + Bay: some association in scope
      fixtureListings.ladiesAqua, // Marina
      fixtureListings.holidayCamp, // branchless draft — reachable everywhere
      fixtureListings.strokeClinic, // Marina
      fixtureListings.aquaTherapy, // Marina
      fixtureListings.mastersTraining, // Marina + Bay
      fixtureListings.synchroSquad, // Marina
      fixtureListings.aquaExpress, // Marina
    ]);
    expect(ids).not.toContain(fixtureListings.juniorSquad); // Bay only
    expect(ids).not.toContain(fixtureListings.privateCoaching); // Bay only
    expect(ids).not.toContain(fixtureListings.schoolTerm); // Bay only
    expect(ids).not.toContain(fixtureListings.sunsetOpenWater); // Bay + deactivated Sufouh
    expect(page.nextCursor).toBeNull();
  });

  test('scope participates BEFORE the pagination window: pages fill with reachable listings and the cursor walks the whole reachable set', async () => {
    const runtime = runtimeAs('manager@bluewave.demo');
    // With limit 10 every one of the 8 reachable listings arrives — the old
    // defective mirror filtered the limit+1 window after the fact, returned
    // 7 rows, and silently dropped Aqua Fitness Express.
    const single = await pageOf(runtime, blueWave, { limit: 10 });
    expect(single.programs).toHaveLength(8);
    expect(single.programs.map((row) => row.id)).toContain(fixtureListings.aquaExpress);
    expect(single.nextCursor).toBeNull();

    // A small-limit walk: inaccessible listings never consume page slots,
    // the cursor advances over the reachable ordered set, and every
    // reachable listing arrives exactly once.
    const first = await pageOf(runtime, blueWave, { limit: 3 });
    expect(first.programs).toHaveLength(3);
    expect(first.nextCursor).toBe(first.programs[2]!.id);
    const second = await pageOf(runtime, blueWave, { limit: 3, cursor: first.nextCursor! });
    expect(second.programs).toHaveLength(3);
    const third = await pageOf(runtime, blueWave, { limit: 3, cursor: second.nextCursor! });
    expect(third.programs).toHaveLength(2);
    expect(third.nextCursor).toBeNull();
    const walked = [...first.programs, ...second.programs, ...third.programs].map((row) => row.id);
    expect(walked).toEqual([
      fixtureListings.adultSwimming,
      fixtureListings.ladiesAqua,
      fixtureListings.holidayCamp,
      fixtureListings.strokeClinic,
      fixtureListings.aquaTherapy,
      fixtureListings.mastersTraining,
      fixtureListings.synchroSquad,
      fixtureListings.aquaExpress,
    ]);
  });

  test('the DETAIL shares the list reachability rule: an out-of-scope in-organization listing is not-found-shaped exactly like unknown and foreign ids', async () => {
    const runtime = runtimeAs('manager@bluewave.demo');
    const outOfScope = await runtime.listingsPort.loadListing(
      blueWave,
      fixtureListings.juniorSquad, // Bay-only: outside Salem's Marina scope
    );
    const unknown = await runtime.listingsPort.loadListing(
      blueWave,
      '0198a2f0-5b7a-7000-8000-000000000000',
    );
    const foreign = await runtime.listingsPort.loadListing(blueWave, fixtureListings.noorAfterSchool);
    expect(outOfScope).toEqual({ kind: 'notFound' });
    expect(unknown).toEqual(outOfScope);
    expect(foreign).toEqual(outOfScope);
    // Reachable listings still load — in scope and branchless drafts alike.
    expect((await runtime.listingsPort.loadListing(blueWave, fixtureListings.ladiesAqua)).kind).toBe('loaded');
    expect((await runtime.listingsPort.loadListing(blueWave, fixtureListings.holidayCamp)).kind).toBe('loaded');
    // Organization-wide catalogue readers keep the org-wide detail read.
    expect(
      (await runtimeAs('owner@bluewave.demo').listingsPort.loadListing(blueWave, fixtureListings.juniorSquad)).kind,
    ).toBe('loaded');
    expect(
      (await runtimeAs('director@himma.demo').listingsPort.loadListing(blueWave, fixtureListings.juniorSquad)).kind,
    ).toBe('loaded');
  });

  test('unknown listing ids and a foreign organization’s listing id collapse into ONE byte-identical not-found shape', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const unknown = await runtime.listingsPort.loadListing(
      blueWave,
      '0198a2f0-5b7a-7000-8000-000000000000',
    );
    const foreign = await runtime.listingsPort.loadListing(blueWave, fixtureListings.noorAfterSchool);
    expect(unknown).toEqual({ kind: 'notFound' });
    expect(foreign).toEqual(unknown);
    // A foreign ORGANIZATION is equally not-found-shaped (no membership).
    expect(await runtime.listingsPort.listListings(noor)).toEqual({ kind: 'notFound' });
  });

  test('a suspended organization still serves catalogue READS (list and detail)', async () => {
    const runtime = runtimeAs('director@himma.demo');
    const page = await pageOf(runtime, falcon);
    expect(page.programs).toHaveLength(1);
    const program = await detailOf(runtime, falcon, fixtureListings.falconKickboxing);
    expect(program.listingState).toBe('published');
  });

  test('branch associations render the shared W2-5 branch truth: labels, deactivated branch, removed association', async () => {
    const program = await detailOf(runtimeAs('owner@bluewave.demo'), blueWave, fixtureListings.adultSwimming);
    expect(program.branches).toEqual([
      {
        branchId: fixtureBranches.blueWaveMarina,
        label: 'Dubai Marina pool',
        branchActive: true,
        associationActive: true,
        version: 1,
      },
      {
        branchId: fixtureBranches.blueWaveBay,
        label: 'Business Bay pool',
        branchActive: true,
        associationActive: true,
        version: 1,
      },
      {
        branchId: fixtureBranches.blueWaveSufouh,
        label: 'Al Sufouh training pool',
        branchActive: false,
        associationActive: false,
        version: 1,
      },
    ]);
  });

  test('an open ProgramRevision is exposed read-only on the detail; absent otherwise', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const pending = await detailOf(runtime, blueWave, fixtureListings.juniorSquad);
    expect(pending.openRevision).toEqual({
      id: '0198a2f0-5b7a-7000-8000-1e5f2a7b3d01',
      state: 'submitted',
      createdAt: '2026-08-01T08:00:00.000Z',
      version: 1,
    });
    const clean = await detailOf(runtime, blueWave, fixtureListings.ladiesAqua);
    expect(clean.openRevision).toBeNull();
  });

  test('transient list/detail failures are retryable', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.failNextListingsLoad(blueWave);
    expect((await runtime.listingsPort.listListings(blueWave)).kind).toBe('unavailable');
    expect((await runtime.listingsPort.listListings(blueWave)).kind).toBe('loaded');
    runtime.controls.failNextListingDetailLoad(blueWave);
    expect(
      (await runtime.listingsPort.loadListing(blueWave, fixtureListings.adultSwimming)).kind,
    ).toBe('unavailable');
    expect(
      (await runtime.listingsPort.loadListing(blueWave, fixtureListings.adultSwimming)).kind,
    ).toBe('loaded');
  });

  test('the activity-type read serves ACTIVE taxonomy rows only, shaped on the real public contract', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.activityTypePort.listActivityTypes();
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.activityTypes.map((type) => type.slug)).not.toContain('synchronized-swimming');
    expect(Object.keys(outcome.activityTypes[0]!).sort()).toEqual([
      'categoryId',
      'id',
      'labelAr',
      'labelEn',
      'slug',
    ]);
    // …while the DETAIL of a listing referencing the deactivated type
    // carries its truthful embedded activity type with active: false.
    const program = await detailOf(runtime, blueWave, fixtureListings.synchroSquad);
    expect(program.activityType).toMatchObject({
      id: fixtureActivityTypes.synchronizedSwimming,
      active: false,
    });
  });

  test('the unconfigured production ports fail CLOSED on every read', async () => {
    const listings = createUnconfiguredListingsPort();
    expect(await listings.listListings('any-org')).toEqual({ kind: 'unavailable' });
    expect(await listings.loadListing('any-org', 'any-listing')).toEqual({ kind: 'unavailable' });
    const taxonomy = createUnconfiguredActivityTypePort();
    expect(await taxonomy.listActivityTypes()).toEqual({ kind: 'unavailable' });
  });
});
