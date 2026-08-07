import {
  createUnconfiguredProfilePort,
} from '../src/auth/unconfigured-adapter';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';

/**
 * Profile port semantics at the seam (task §18/§19): the fixture mirrors
 * `GET /provider/organizations/:organizationId` and
 * `PATCH .../profile` — capability shaping, refusal order, version CAS,
 * and the shared-store composition with the onboarding read model.
 */
describe('organization profile port (fixture semantics)', () => {
  const blueWave = fixtureOrganizations.blueWave.organizationId;
  const coral = fixtureOrganizations.coral.organizationId;
  const falcon = fixtureOrganizations.falcon.organizationId;
  const pearl = fixtureOrganizations.pearl.organizationId;

  function ownerRuntime() {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    return runtime;
  }

  test('owner view mirrors the capability-shaped private management record', async () => {
    const runtime = ownerRuntime();
    const outcome = await runtime.profilePort.loadOrganizationView(blueWave);
    expect(outcome.kind).toBe('loaded');
    if (outcome.kind !== 'loaded') {
      return;
    }
    const { view } = outcome;
    // Owner holds org.legal.view + commercial_terms.view → both seats present.
    expect(view.organization.legalName).toBe('Blue Wave Swimming LLC');
    expect('commercialTermsRef' in view.organization).toBe(true);
    expect(view.organization.verificationState).toBe('live');
    expect(view.profile.published).toBe(true);
    expect(view.profile.version).toBeGreaterThanOrEqual(1);
    expect(view.membership.role).toBe('owner');
    expect(view.membership.capabilities).toContain('profile.edit');
    expect(view.branches.length).toBeGreaterThan(0);
  });

  test('a coach view carries neither legal identity nor commercial seat', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('assistant@coral.demo');
    const outcome = await runtime.profilePort.loadOrganizationView(coral);
    expect(outcome.kind).toBe('loaded');
    if (outcome.kind !== 'loaded') {
      return;
    }
    expect(outcome.view.organization.legalName).toBeUndefined();
    expect('commercialTermsRef' in outcome.view.organization).toBe(false);
    expect(outcome.view.membership.capabilities).not.toContain('profile.edit');
  });

  test('a valid save mutates the store, bumps the profile version, and feeds onboarding readiness', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept('HIMMA-INVITE-OWNER-CORAL');

    const before = await runtime.onboardingPort.loadSnapshot(coral);
    expect(before.kind === 'loaded' && before.snapshot.profile.displayName).toBe('');

    const loaded = await runtime.profilePort.loadOrganizationView(coral);
    if (loaded.kind !== 'loaded') {
      throw new Error('expected loaded view');
    }
    const outcome = await runtime.profilePort.updateProfile(coral, loaded.view.profile.version, {
      displayName: 'Coral Kids Climbing',
      descriptionEn: 'Indoor climbing for children.',
    });
    expect(outcome).toEqual({ kind: 'profileUpdated', version: loaded.view.profile.version + 1 });

    // ONE canonical fixture store: the onboarding read model sees the same
    // truth — no separate completion flag exists anywhere (task §11).
    const after = await runtime.onboardingPort.loadSnapshot(coral);
    expect(after.kind === 'loaded' && after.snapshot.profile.displayName).toBe(
      'Coral Kids Climbing',
    );
    // Profile completion does NOT touch verification/lifecycle.
    expect(after.kind === 'loaded' && after.snapshot.organization.verificationState).toBe('draft');
  });

  test('a stale writer receives staleVersion and the store is not overwritten', async () => {
    const runtime = ownerRuntime();
    const loaded = await runtime.profilePort.loadOrganizationView(blueWave);
    if (loaded.kind !== 'loaded') {
      throw new Error('expected loaded view');
    }
    // Another staff member saves while this editor holds the old version.
    runtime.controls.simulateConcurrentProfileEdit(blueWave);
    const outcome = await runtime.profilePort.updateProfile(blueWave, loaded.view.profile.version, {
      displayName: 'Stale Writer Name',
    });
    expect(outcome).toEqual({ kind: 'staleVersion' });
    const reloaded = await runtime.profilePort.loadOrganizationView(blueWave);
    expect(reloaded.kind === 'loaded' && reloaded.view.profile.displayName).toBe(
      'Blue Wave Swimming',
    );
  });

  test('backend-mirror validation refuses an out-of-contract patch (validationError)', async () => {
    const runtime = ownerRuntime();
    const loaded = await runtime.profilePort.loadOrganizationView(blueWave);
    if (loaded.kind !== 'loaded') {
      throw new Error('expected loaded view');
    }
    const outcome = await runtime.profilePort.updateProfile(blueWave, loaded.view.profile.version, {
      descriptionEn: 'x'.repeat(2001),
    });
    expect(outcome).toEqual({ kind: 'validationError' });
  });

  test('a role without profile.edit is refused with forbidden', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('assistant@coral.demo');
    const outcome = await runtime.profilePort.updateProfile(coral, 1, {
      displayName: 'Coach Takeover',
    });
    expect(outcome).toEqual({ kind: 'forbidden' });
  });

  test('a suspended organization refuses profile mutation (organizationSuspended)', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('director@himma.demo');
    const outcome = await runtime.profilePort.updateProfile(falcon, 2, {
      displayName: 'Falcon Rebrand',
    });
    expect(outcome).toEqual({ kind: 'organizationSuspended' });
  });

  test('an organization outside the membership is not-found-shaped', async () => {
    const runtime = ownerRuntime();
    expect(await runtime.profilePort.loadOrganizationView(coral)).toEqual({ kind: 'notFound' });
    expect(await runtime.profilePort.updateProfile(coral, 1, { displayName: 'X' })).toEqual({
      kind: 'notFound',
    });
  });

  test('transient load/save failures surface as unavailable and recover on retry', async () => {
    const runtime = ownerRuntime();
    runtime.controls.failNextProfileLoad(blueWave);
    expect(await runtime.profilePort.loadOrganizationView(blueWave)).toEqual({
      kind: 'unavailable',
    });
    expect((await runtime.profilePort.loadOrganizationView(blueWave)).kind).toBe('loaded');

    runtime.controls.failNextProfileSave(blueWave);
    const loaded = await runtime.profilePort.loadOrganizationView(blueWave);
    if (loaded.kind !== 'loaded') {
      throw new Error('expected loaded view');
    }
    expect(
      await runtime.profilePort.updateProfile(blueWave, loaded.view.profile.version, {
        publicPhone: '+971 4 555 0111',
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      (
        await runtime.profilePort.updateProfile(blueWave, loaded.view.profile.version, {
          publicPhone: '+971 4 555 0111',
        })
      ).kind,
    ).toBe('profileUpdated');
  });

  test('publication is the published field of the SAME patch and never implies live', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('stages@himma.demo');
    // Pearl: verified + already published — published-but-not-live is real.
    const loaded = await runtime.profilePort.loadOrganizationView(pearl);
    if (loaded.kind !== 'loaded') {
      throw new Error('expected loaded view');
    }
    expect(loaded.view.profile.published).toBe(true);
    expect(loaded.view.organization.verificationState).toBe('verified');

    const unpublish = await runtime.profilePort.updateProfile(
      pearl,
      loaded.view.profile.version,
      { published: false },
    );
    expect(unpublish.kind).toBe('profileUpdated');
    const after = await runtime.profilePort.loadOrganizationView(pearl);
    expect(after.kind === 'loaded' && after.view.profile.published).toBe(false);
    // Publication changes never move the lifecycle.
    expect(after.kind === 'loaded' && after.view.organization.verificationState).toBe('verified');
  });

  test('no session → unavailable; the unconfigured production port is fail-closed', async () => {
    const runtime = createFixtureAuthRuntime();
    expect(await runtime.profilePort.loadOrganizationView(blueWave)).toEqual({
      kind: 'unavailable',
    });

    const unconfigured = createUnconfiguredProfilePort();
    expect(await unconfigured.loadOrganizationView(blueWave)).toEqual({ kind: 'unavailable' });
    expect(await unconfigured.updateProfile(blueWave, 1, { displayName: 'X' })).toEqual({
      kind: 'unavailable',
    });
  });
});
