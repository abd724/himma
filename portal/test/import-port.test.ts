import { createUnconfiguredBulkImportPort } from '../src/auth/unconfigured-adapter';
import { BULK_IMPORT_OPERATIONS, type ImportRowInput } from '../src/catalogue/import-contract';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';

const blueWave = fixtureOrganizations.blueWave.organizationId;
const falcon = fixtureOrganizations.falcon.organizationId;
const noor = fixtureOrganizations.noor.organizationId;

type Runtime = ReturnType<typeof createFixtureAuthRuntime>;

function runtimeAs(email: string): Runtime {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession(email);
  return runtime;
}

const VALID_ROW: ImportRowInput = {
  rowNumber: 1,
  values: {
    titleEn: 'Sunrise Aqua Circuit',
    activityType: 'Aqua Fitness',
    setting: 'Indoor',
    whoFor: 'Everyone',
    branches: 'Dubai Marina pool',
    priceKind: 'Monthly',
    priceAed: '390',
  },
};

describe('bulk-import port — structure and authority (W2-10)', () => {
  test('the port exposes EXACTLY dryRun — no execute/commit/import operation can exist (no engine contract does)', () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(Object.keys(runtime.bulkImportPort).sort()).toEqual([...BULK_IMPORT_OPERATIONS].sort());
    for (const forbidden of [
      'executeImport',
      'runImport',
      'commitBatch',
      'submitBatch',
      'importListings',
      'createImportJob',
    ]) {
      expect(forbidden in runtime.bulkImportPort).toBe(false);
    }
  });

  test('the unconfigured production port fails CLOSED', async () => {
    const outcome = await createUnconfiguredBulkImportPort().dryRun(blueWave, [VALID_ROW]);
    expect(outcome.kind).toBe('unavailable');
  });

  test('authority follows listings.manage: owner/org_manager/listings_editor/branch_manager may preview; coach/front_desk/finance are forbidden', async () => {
    for (const email of [
      'owner@bluewave.demo',
      'director@himma.demo',
      'flaky@bluewave.demo',
      'manager@bluewave.demo',
    ]) {
      const outcome = await runtimeAs(email).bulkImportPort.dryRun(blueWave, [VALID_ROW]);
      expect(`${email}:${outcome.kind}`).toBe(`${email}:dryRunComplete`);
    }
    for (const email of ['frontdesk@bluewave.demo', 'finance@bluewave.demo']) {
      const outcome = await runtimeAs(email).bulkImportPort.dryRun(blueWave, [VALID_ROW]);
      expect(`${email}:${outcome.kind}`).toBe(`${email}:forbidden`);
    }
    const coach = await runtimeAs('coach@noor.demo').bulkImportPort.dryRun(noor, [VALID_ROW]);
    expect(coach.kind).toBe('forbidden');
  });

  test('suspended organizations refuse (import is a mutation workflow); unknown/foreign orgs are not-found-shaped; transient failures surface', async () => {
    const suspended = await runtimeAs('director@himma.demo').bulkImportPort.dryRun(falcon, [VALID_ROW]);
    expect(suspended.kind).toBe('organizationSuspended');

    const foreign = await runtimeAs('owner@bluewave.demo').bulkImportPort.dryRun(noor, [VALID_ROW]);
    expect(foreign.kind).toBe('notFound');

    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.failNextListingMutation(blueWave);
    expect((await runtime.bulkImportPort.dryRun(blueWave, [VALID_ROW])).kind).toBe('unavailable');
    expect((await runtime.bulkImportPort.dryRun(blueWave, [VALID_ROW])).kind).toBe('dryRunComplete');
  });

  test('Branch Manager scope: rows referencing branches outside the assigned scope fail validation; in-scope rows pass', async () => {
    const runtime = runtimeAs('manager@bluewave.demo');
    const outside = await runtime.bulkImportPort.dryRun(blueWave, [
      { rowNumber: 1, values: { ...VALID_ROW.values, branches: 'Business Bay pool' } },
    ]);
    if (outside.kind !== 'dryRunComplete') throw new Error(outside.kind);
    expect(outside.report.rows[0]!.issues[0]!.message).toBe('“Business Bay pool” is outside your branch scope.');
    expect(outside.report.summary.errorRows).toBe(1);

    const inside = await runtime.bulkImportPort.dryRun(blueWave, [VALID_ROW]);
    if (inside.kind !== 'dryRunComplete') throw new Error(inside.kind);
    expect(inside.report.summary.validRows).toBe(1);
  });

  test('duplicate-title warnings compare against the CALLER’S reachable catalogue only — a Branch Manager never learns out-of-scope titles', async () => {
    // "Private Swim Coaching" runs at Business Bay only — outside the
    // Marina-scoped manager's reachable set.
    const managerRun = await runtimeAs('manager@bluewave.demo').bulkImportPort.dryRun(blueWave, [
      { rowNumber: 1, values: { ...VALID_ROW.values, titleEn: 'Private Swim Coaching', branches: 'Dubai Marina pool' } },
    ]);
    if (managerRun.kind !== 'dryRunComplete') throw new Error(managerRun.kind);
    expect(
      managerRun.report.rows[0]!.issues.some((issue) => issue.message.match(/already have a listing/)),
    ).toBe(false);

    const ownerRun = await runtimeAs('owner@bluewave.demo').bulkImportPort.dryRun(blueWave, [
      { rowNumber: 1, values: { ...VALID_ROW.values, titleEn: 'Private Swim Coaching' } },
    ]);
    if (ownerRun.kind !== 'dryRunComplete') throw new Error(ownerRun.kind);
    expect(
      ownerRun.report.rows[0]!.issues.some((issue) => issue.message.match(/already have a listing/)),
    ).toBe(true);
  });
});

describe('bulk-import dry run is READ-ONLY (W2-10 §25–§27)', () => {
  test('a dry run mutates NOTHING: catalogue rows, states, counts, and details are byte-identical before and after; no listing appears, none is submitted or published', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');

    const snapshot = async () => {
      const list = await runtime.listingsPort.listListings(blueWave, { limit: 100 });
      if (list.kind !== 'loaded') throw new Error(list.kind);
      const detail = await runtime.listingsPort.loadListing(blueWave, fixtureListings.holidayCamp);
      if (detail.kind !== 'loaded') throw new Error(detail.kind);
      return { list: list.page, detail: detail.program };
    };

    const before = await snapshot();
    const outcome = await runtime.bulkImportPort.dryRun(blueWave, [
      VALID_ROW,
      { rowNumber: 2, values: { ...VALID_ROW.values, titleEn: 'Second Import Candidate' } },
    ]);
    if (outcome.kind !== 'dryRunComplete') throw new Error(outcome.kind);
    expect(outcome.report.summary.validRows).toBe(2);
    const after = await snapshot();

    // Deep-equal: same rows, same states, same versions — nothing imported,
    // nothing submitted, nothing published, no draft appeared.
    expect(after).toEqual(before);
    expect(after.list.programs).toHaveLength(before.list.programs.length);
    expect(
      after.list.programs.some((program) => program.titleEn === 'Sunrise Aqua Circuit'),
    ).toBe(false);
  });

  test('the dry-run report carries no fabricated persistence: no ids, no job, no imported/created claims', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.bulkImportPort.dryRun(blueWave, [VALID_ROW]);
    if (outcome.kind !== 'dryRunComplete') throw new Error(outcome.kind);
    const serialized = JSON.stringify(outcome.report);
    // No uuid-shaped identifiers (fixture ids share this prefix), no job
    // vocabulary, no success-past-tense claims.
    expect(serialized).not.toMatch(/0198a2f0/);
    expect(serialized).not.toMatch(/jobId|importId|batchId/i);
    expect(serialized.toLowerCase()).not.toMatch(/imported successfully|listings created/);
  });
});
