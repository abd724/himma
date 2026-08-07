import {
  createUnconfiguredAreaPort,
  createUnconfiguredBranchPort,
} from '../src/auth/unconfigured-adapter';
import {
  FIXTURE_INVITATIONS,
  createFixtureAuthRuntime,
  fixtureBranches,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';

const blueWave = fixtureOrganizations.blueWave.organizationId;
const noor = fixtureOrganizations.noor.organizationId;
const falcon = fixtureOrganizations.falcon.organizationId;
const coral = fixtureOrganizations.coral.organizationId;

describe('branch port (fixture semantics, W2-5)', () => {
  function runtimeAs(email: string) {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession(email);
    return runtime;
  }

  async function branchesOf(runtime: ReturnType<typeof createFixtureAuthRuntime>, orgId: string) {
    const outcome = await runtime.profilePort.loadOrganizationView(orgId);
    if (outcome.kind !== 'loaded') {
      throw new Error(`expected loaded view, got ${outcome.kind}`);
    }
    return outcome.view.branches;
  }

  test('the port exposes EXACTLY the three real mutations — no reactivate, delete, or transfer', () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(Object.keys(runtime.branchPort).sort()).toEqual([
      'createBranch',
      'deactivateBranch',
      'updateBranch',
    ]);
  });

  test('an Owner creates a branch: version 1, active, appended in creation order to the shared view', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.branchPort.createBranch(blueWave, {
      label: 'JLT pool',
      areaLabel: 'Jumeirah',
      addressLine: 'Cluster D',
      facilities: ['Parking'],
    });
    expect(outcome.kind).toBe('branchCreated');
    if (outcome.kind !== 'branchCreated') {
      return;
    }
    expect(outcome.branch.version).toBe(1);
    expect(outcome.branch.active).toBe(true);
    const branches = await branchesOf(runtime, blueWave);
    expect(branches.map((branch) => branch.label).at(-1)).toBe('JLT pool');
  });

  test('creation authority mirrors the registry: coach forbidden, suspended org refused, foreign org not-found-shaped', async () => {
    const coach = runtimeAs('assistant@coral.demo');
    expect(
      (await coach.branchPort.createBranch(coral, { label: 'X', areaLabel: 'Deira' })).kind,
    ).toBe('forbidden');

    const director = runtimeAs('director@himma.demo');
    expect(
      (await director.branchPort.createBranch(falcon, { label: 'X', areaLabel: 'Deira' })).kind,
    ).toBe('organizationSuspended');

    const owner = runtimeAs('owner@bluewave.demo');
    // No membership at Coral and an unknown org id collapse into ONE shape.
    expect(
      (await owner.branchPort.createBranch(coral, { label: 'X', areaLabel: 'Deira' })).kind,
    ).toBe('notFound');
    expect(
      (
        await owner.branchPort.createBranch('0198a2f0-5b7a-7000-8000-000000000000', {
          label: 'X',
          areaLabel: 'Deira',
        })
      ).kind,
    ).toBe('notFound');
  });

  test('the backend-mirror validation refuses out-of-contract fields (validationError)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(
      (
        await runtime.branchPort.createBranch(blueWave, {
          label: 'x'.repeat(121),
          areaLabel: 'Jumeirah',
        })
      ).kind,
    ).toBe('validationError');
    expect(
      (
        await runtime.branchPort.updateBranch(blueWave, fixtureBranches.blueWaveMarina, 1, {
          geoPoint: { longitude: 200, latitude: 0 },
        })
      ).kind,
    ).toBe('validationError');
    expect(
      (
        await runtime.branchPort.updateBranch(blueWave, fixtureBranches.blueWaveMarina, 1, {
          facilities: Array.from({ length: 21 }, (_, index) => `F${index}`),
        })
      ).kind,
    ).toBe('validationError');
  });

  test('a partial PATCH mutates only the given fields and bumps the branch version', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.branchPort.updateBranch(
      blueWave,
      fixtureBranches.blueWaveMarina,
      1,
      { label: 'Dubai Marina flagship pool' },
    );
    expect(outcome.kind).toBe('branchUpdated');
    if (outcome.kind !== 'branchUpdated') {
      return;
    }
    expect(outcome.branch.version).toBe(2);
    expect(outcome.branch.label).toBe('Dubai Marina flagship pool');
    // Untouched fields survive exactly.
    expect(outcome.branch.addressLine).toBe('Marina Promenade, Block C');
    expect(outcome.branch.facilities).toEqual(['Indoor pool', 'Changing rooms', 'Parking']);
    expect(outcome.branch.areaLabel).toBe('Dubai Marina');
  });

  test('a stale writer receives staleVersion and the store is NOT overwritten', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.simulateConcurrentBranchEdit(blueWave, fixtureBranches.blueWaveMarina);
    const outcome = await runtime.branchPort.updateBranch(
      blueWave,
      fixtureBranches.blueWaveMarina,
      1,
      { label: 'Should not stick' },
    );
    expect(outcome.kind).toBe('staleVersion');
    const branches = await branchesOf(runtime, blueWave);
    expect(branches[0]?.label).toBe('Dubai Marina pool');
  });

  test('cross-organization branch ids are not-found-shaped — never an existence oracle', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // Noor's real branch id addressed through Blue Wave's org scope…
    const foreign = await runtime.branchPort.updateBranch(
      blueWave,
      fixtureBranches.noorBarsha,
      1,
      { label: 'X' },
    );
    // …and a branch id that exists nowhere: byte-identical outcomes.
    const unknown = await runtime.branchPort.updateBranch(
      blueWave,
      '0198a2f0-5b7a-7000-8000-2b6c3e8f7aff',
      1,
      { label: 'X' },
    );
    expect(foreign).toEqual({ kind: 'notFound' });
    expect(unknown).toEqual({ kind: 'notFound' });
  });

  test('branch scope binds mutation reach: assigned branch editable, unassigned forbidden, deactivation removes reach', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('manager@bluewave.demo');
    const assigned = await runtime.branchPort.updateBranch(
      blueWave,
      fixtureBranches.blueWaveMarina,
      1,
      { addressLine: 'Marina Promenade, Block C — Gate 2' },
    );
    expect(assigned.kind).toBe('branchUpdated');
    const unassigned = await runtime.branchPort.updateBranch(
      blueWave,
      fixtureBranches.blueWaveBay,
      1,
      { label: 'X' },
    );
    expect(unassigned.kind).toBe('forbidden');
    // Branch managers hold no deactivation capability at all.
    expect(
      (
        await runtime.branchPort.deactivateBranch(blueWave, fixtureBranches.blueWaveMarina, 2)
      ).kind,
    ).toBe('forbidden');

    // An owner deactivates the assigned branch → the manager's reach is gone.
    runtime.seedSession('owner@bluewave.demo');
    expect(
      (
        await runtime.branchPort.deactivateBranch(blueWave, fixtureBranches.blueWaveMarina, 2)
      ).kind,
    ).toBe('branchDeactivated');
    runtime.seedSession('manager@bluewave.demo');
    expect(
      (
        await runtime.branchPort.updateBranch(blueWave, fixtureBranches.blueWaveMarina, 3, {
          label: 'X',
        })
      ).kind,
    ).toBe('forbidden');
  });

  test('deactivation uses CAS, is idempotent when already inactive, and never deletes the row', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.simulateConcurrentBranchEdit(blueWave, fixtureBranches.blueWaveMarina);
    expect(
      (
        await runtime.branchPort.deactivateBranch(blueWave, fixtureBranches.blueWaveMarina, 1)
      ).kind,
    ).toBe('staleVersion');
    expect(
      (
        await runtime.branchPort.deactivateBranch(blueWave, fixtureBranches.blueWaveMarina, 2)
      ).kind,
    ).toBe('branchDeactivated');
    // Idempotent: no CAS refusal, no version change, still present in the view.
    expect(
      (
        await runtime.branchPort.deactivateBranch(blueWave, fixtureBranches.blueWaveMarina, 999)
      ).kind,
    ).toBe('branchDeactivated');
    const branches = await branchesOf(runtime, blueWave);
    const marina = branches.find((branch) => branch.id === fixtureBranches.blueWaveMarina);
    expect(marina).toBeDefined();
    expect(marina?.active).toBe(false);
    expect(marina?.version).toBe(3);
  });

  test('the first active branch completes the canonical onboarding requirement — and ONLY that', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);

    const before = await runtime.onboardingPort.loadSnapshot(coral);
    if (before.kind !== 'loaded') {
      throw new Error('expected snapshot');
    }
    expect(before.snapshot.branches.some((branch) => branch.active)).toBe(false);

    const created = await runtime.branchPort.createBranch(coral, {
      label: 'Climbing hall',
      areaLabel: 'Al Barsha',
    });
    expect(created.kind).toBe('branchCreated');

    const after = await runtime.onboardingPort.loadSnapshot(coral);
    if (after.kind !== 'loaded') {
      throw new Error('expected snapshot');
    }
    expect(after.snapshot.branches.some((branch) => branch.active)).toBe(true);
    // Branch completeness ≠ verification ≠ live: the lifecycle is unmoved.
    expect(after.snapshot.organization.verificationState).toBe('draft');
  });

  test('deactivating the only active branch makes the requirement incomplete again', async () => {
    const runtime = runtimeAs('director@himma.demo');
    const outcome = await runtime.branchPort.deactivateBranch(
      noor,
      fixtureBranches.noorBarsha,
      1,
    );
    expect(outcome.kind).toBe('branchDeactivated');
    const snapshot = await runtime.onboardingPort.loadSnapshot(noor);
    if (snapshot.kind !== 'loaded') {
      throw new Error('expected snapshot');
    }
    expect(snapshot.snapshot.branches.some((branch) => branch.active)).toBe(false);
    expect(snapshot.snapshot.organization.verificationState).toBe('live');
  });

  test('transient failures surface as unavailable and recover on retry', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.failNextBranchMutation(blueWave);
    expect(
      (
        await runtime.branchPort.updateBranch(blueWave, fixtureBranches.blueWaveMarina, 1, {
          label: 'Retry me',
        })
      ).kind,
    ).toBe('unavailable');
    expect(
      (
        await runtime.branchPort.updateBranch(blueWave, fixtureBranches.blueWaveMarina, 1, {
          label: 'Retry me',
        })
      ).kind,
    ).toBe('branchUpdated');
  });

  test('the area read mirrors GET /catalogue/areas: active rows, deterministic order, transient failure recovers', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const loaded = await runtime.areaPort.listAreas();
    expect(loaded.kind).toBe('loaded');
    if (loaded.kind !== 'loaded') {
      return;
    }
    const labels = loaded.areas.map((area) => area.labelEn);
    expect(labels).toEqual([...labels].sort());
    // The historical label referenced by the deactivated Blue Wave branch is
    // NOT offered by the active taxonomy.
    expect(labels).not.toContain('Al Sufouh');
    expect(labels).toContain('Dubai Marina');

    runtime.controls.failNextAreaLoad();
    expect((await runtime.areaPort.listAreas()).kind).toBe('unavailable');
    expect((await runtime.areaPort.listAreas()).kind).toBe('loaded');
  });

  test('no session → unavailable; the unconfigured production ports are fail-closed', async () => {
    const runtime = createFixtureAuthRuntime();
    expect(
      (await runtime.branchPort.createBranch(blueWave, { label: 'X', areaLabel: 'Deira' })).kind,
    ).toBe('unavailable');

    const unconfiguredBranches = createUnconfiguredBranchPort();
    expect(
      (
        await unconfiguredBranches.createBranch(blueWave, { label: 'X', areaLabel: 'Deira' })
      ).kind,
    ).toBe('unavailable');
    expect(
      (await unconfiguredBranches.updateBranch(blueWave, fixtureBranches.blueWaveMarina, 1, {}))
        .kind,
    ).toBe('unavailable');
    expect(
      (
        await unconfiguredBranches.deactivateBranch(blueWave, fixtureBranches.blueWaveMarina, 1)
      ).kind,
    ).toBe('unavailable');
    expect((await createUnconfiguredAreaPort().listAreas()).kind).toBe('unavailable');
  });
});
