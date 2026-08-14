import { createUnconfiguredListingLifecyclePort } from '../src/auth/unconfigured-adapter';
import { LISTING_LIFECYCLE_OPERATIONS } from '../src/catalogue/lifecycle-contract';
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
const pearl = fixtureOrganizations.pearl.organizationId;

type Runtime = ReturnType<typeof createFixtureAuthRuntime>;

function runtimeAs(email: string): Runtime {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession(email);
  return runtime;
}

const GHOST_ID = '0198a2f0-5b7a-7000-8000-00000000dead';

async function detailOf(runtime: Runtime, orgId: string, programId: string) {
  const outcome = await runtime.listingsPort.loadListing(orgId, programId);
  if (outcome.kind !== 'loaded') {
    throw new Error(`expected loaded detail, got ${outcome.kind}`);
  }
  return outcome.program;
}

describe('listing lifecycle port — structure and authority (W2-9)', () => {
  test('the port exposes EXACTLY the 4 real named lifecycle actions — nothing else is expressible', () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(Object.keys(runtime.listingLifecyclePort).sort()).toEqual(
      [...LISTING_LIFECYCLE_OPERATIONS].sort(),
    );
    // No resume/unpublish/restore/approve/reject/revision-decision route
    // exists on the wire, so none exists here.
    for (const forbidden of [
      'resumeProgram',
      'unpublishProgram',
      'restoreProgram',
      'approveProgram',
      'rejectProgram',
      'approveRevision',
      'rejectRevision',
      'withdrawRevision',
    ]) {
      expect(forbidden in runtime.listingLifecyclePort).toBe(false);
    }
  });

  test('the unconfigured production port fails CLOSED on all four actions', async () => {
    const port = createUnconfiguredListingLifecyclePort();
    expect((await port.submitProgram(blueWave, fixtureListings.holidayCamp, 2)).kind).toBe('unavailable');
    expect((await port.publishProgram(blueWave, fixtureListings.privateCoaching, 2)).kind).toBe('unavailable');
    expect((await port.pauseProgram(blueWave, fixtureListings.adultSwimming, 2)).kind).toBe('unavailable');
    expect((await port.archiveProgram(blueWave, fixtureListings.adultSwimming, 2)).kind).toBe('unavailable');
  });

  test('submit authority: the four listings.manage roles may submit; coach/front_desk/finance are forbidden', async () => {
    // Complete draft in noor, owned by director (owner seat there).
    const owner = await runtimeAs('director@himma.demo').listingLifecyclePort.submitProgram(
      noor,
      fixtureListings.noorExamPrep,
      2,
    );
    expect(owner.kind).toBe('programSubmitted');

    // Listings Editor may submit (blueWave complete changes_requested row).
    const editor = await runtimeAs('flaky@bluewave.demo').listingLifecyclePort.submitProgram(
      blueWave,
      fixtureListings.aquaTherapy,
      2,
    );
    expect(editor.kind).toBe('programSubmitted');

    // Branch Manager within scope (Marina-only listing) may submit.
    const scoped = await runtimeAs('manager@bluewave.demo').listingLifecyclePort.submitProgram(
      blueWave,
      fixtureListings.aquaTherapy,
      2,
    );
    expect(scoped.kind).toBe('programSubmitted');

    for (const email of ['coach@noor.demo']) {
      const outcome = await runtimeAs(email).listingLifecyclePort.submitProgram(
        noor,
        fixtureListings.noorExamPrep,
        2,
      );
      expect(`${email}:${outcome.kind}`).toBe(`${email}:forbidden`);
    }
    for (const email of ['frontdesk@bluewave.demo', 'finance@bluewave.demo']) {
      const outcome = await runtimeAs(email).listingLifecyclePort.submitProgram(
        blueWave,
        fixtureListings.aquaTherapy,
        2,
      );
      expect(`${email}:${outcome.kind}`).toBe(`${email}:forbidden`);
    }
  });

  test('publication authority is Owner + Organization Manager ONLY: Listings Editor and Branch Manager get forbidden on publish/pause/archive', async () => {
    for (const email of ['flaky@bluewave.demo', 'manager@bluewave.demo']) {
      const runtime = runtimeAs(email);
      const publish = await runtime.listingLifecyclePort.publishProgram(
        blueWave,
        fixtureListings.privateCoaching,
        2,
      );
      const pause = await runtime.listingLifecyclePort.pauseProgram(
        blueWave,
        fixtureListings.adultSwimming,
        2,
      );
      const archive = await runtime.listingLifecyclePort.archiveProgram(
        blueWave,
        fixtureListings.adultSwimming,
        2,
      );
      expect(`${email}:${publish.kind}`).toBe(`${email}:forbidden`);
      expect(`${email}:${pause.kind}`).toBe(`${email}:forbidden`);
      expect(`${email}:${archive.kind}`).toBe(`${email}:forbidden`);
    }

    // Organization Manager publishes (director holds org_manager at blueWave).
    const orgManager = await runtimeAs('director@himma.demo').listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.privateCoaching,
      2,
    );
    expect(orgManager.kind).toBe('programPublished');
  });

  test('Branch Manager submit respects the STRICTER every-rule mutation scope: readable-but-not-mutable never gains submit', async () => {
    // Build a COMPLETE draft associated to Marina AND Bay (readable for the
    // Marina-scoped manager via the some-rule, NOT mutable via every-rule).
    const runtime = runtimeAs('owner@bluewave.demo');
    const created = await runtime.listingEditorPort.createProgram(blueWave, {
      titleEn: 'Cross-branch Aqua Circuit',
      activityTypeId: fixtureActivityTypes.aquaFitness,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    const programId = created.program.id;
    await runtime.listingEditorPort.addBranchAssociation(blueWave, programId, fixtureBranches.blueWaveMarina);
    await runtime.listingEditorPort.addBranchAssociation(blueWave, programId, fixtureBranches.blueWaveBay);
    await runtime.listingEditorPort.addPriceOption(blueWave, programId, {
      kind: 'dropIn',
      amountFils: 5_000,
    });
    const version = (await detailOf(runtime, blueWave, programId)).version;

    runtime.seedSession('manager@bluewave.demo');
    // Readable (some-rule reach through Marina)…
    const read = await runtime.listingsPort.loadListing(blueWave, programId);
    expect(read.kind).toBe('loaded');
    // …but the submit MUTATION refuses under the every-rule.
    const submit = await runtime.listingLifecyclePort.submitProgram(blueWave, programId, version);
    expect(submit.kind).toBe('forbidden');

    // The owner submits the same complete draft fine.
    runtime.seedSession('owner@bluewave.demo');
    const ownerSubmit = await runtime.listingLifecyclePort.submitProgram(blueWave, programId, version);
    expect(ownerSubmit.kind).toBe('programSubmitted');
  });
});

describe('listing lifecycle port — state machine (W2-9)', () => {
  test('an incomplete draft has NO successful submit path: structured programIncomplete with the exact missing vocabulary', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // holidayCamp: branchless draft → activeBranch gap.
    const branchless = await runtime.listingLifecyclePort.submitProgram(
      blueWave,
      fixtureListings.holidayCamp,
      2,
    );
    expect(branchless).toEqual({ kind: 'programIncomplete', missing: ['activeBranch'] });

    // synchroSquad: deactivated taxonomy.
    const synchro = await detailOf(runtime, blueWave, fixtureListings.synchroSquad);
    const badTaxonomy = await runtime.listingLifecyclePort.submitProgram(
      blueWave,
      fixtureListings.synchroSquad,
      synchro.version,
    );
    if (badTaxonomy.kind !== 'programIncomplete') throw new Error(badTaxonomy.kind);
    expect(badTaxonomy.missing).toContain('activeTaxonomy');

    // aquaExpress: no active price option.
    const express = await detailOf(runtime, blueWave, fixtureListings.aquaExpress);
    const noOption = await runtime.listingLifecyclePort.submitProgram(
      blueWave,
      fixtureListings.aquaExpress,
      express.version,
    );
    if (noOption.kind !== 'programIncomplete') throw new Error(noOption.kind);
    expect(noOption.missing).toContain('activePriceOption');

    // Nothing moved.
    expect((await detailOf(runtime, blueWave, fixtureListings.holidayCamp)).listingState).toBe('draft');
  });

  test('a complete draft submits: draft → submitted, version bumps, shared truth updates everywhere', async () => {
    const runtime = runtimeAs('director@himma.demo');
    const outcome = await runtime.listingLifecyclePort.submitProgram(
      noor,
      fixtureListings.noorExamPrep,
      2,
    );
    expect(outcome).toEqual({ kind: 'programSubmitted', version: 3 });
    const after = await detailOf(runtime, noor, fixtureListings.noorExamPrep);
    expect(after.listingState).toBe('submitted');
    expect(after.version).toBe(3);
  });

  test('changes_requested resubmits through the SAME submit action', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.listingLifecyclePort.submitProgram(
      blueWave,
      fixtureListings.aquaTherapy,
      2,
    );
    expect(outcome.kind).toBe('programSubmitted');
    expect((await detailOf(runtime, blueWave, fixtureListings.aquaTherapy)).listingState).toBe(
      'submitted',
    );
  });

  test('submitted and in_review listings accept NO provider lifecycle action (Himma owns the next step)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    for (const programId of [fixtureListings.schoolTerm, fixtureListings.strokeClinic]) {
      expect(
        (await runtime.listingLifecyclePort.submitProgram(blueWave, programId, 2)).kind,
      ).toBe('lifecycleConflict');
      expect(
        (await runtime.listingLifecyclePort.publishProgram(blueWave, programId, 2)).kind,
      ).toBe('lifecycleConflict');
      expect(
        (await runtime.listingLifecyclePort.pauseProgram(blueWave, programId, 2)).kind,
      ).toBe('lifecycleConflict');
      expect(
        (await runtime.listingLifecyclePort.archiveProgram(blueWave, programId, 2)).kind,
      ).toBe('lifecycleConflict');
    }
  });

  test('approval never auto-publishes; the Owner publishes an approved listing explicitly (publishedAt stamped once)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(before.listingState).toBe('approved');
    expect(before.publishedAt).toBeNull();

    const outcome = await runtime.listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.privateCoaching,
      before.version,
    );
    expect(outcome.kind).toBe('programPublished');
    const after = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(after.listingState).toBe('published');
    expect(after.publishedAt).not.toBeNull();

    // Resume from paused keeps the ORIGINAL first-publication stamp.
    const pause = await runtime.listingLifecyclePort.pauseProgram(
      blueWave,
      fixtureListings.privateCoaching,
      after.version,
    );
    if (pause.kind !== 'programPaused') throw new Error(pause.kind);
    const resume = await runtime.listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.privateCoaching,
      pause.version,
    );
    expect(resume.kind).toBe('programPublished');
    const resumed = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(resumed.publishedAt).toBe(after.publishedAt);
  });

  test('published ⇄ paused via pause/publish; pause is legal from published only', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.listingLifecyclePort.pauseProgram(
      blueWave,
      fixtureListings.adultSwimming,
      2,
    );
    expect(outcome).toEqual({ kind: 'programPaused', version: 3 });
    expect((await detailOf(runtime, blueWave, fixtureListings.adultSwimming)).listingState).toBe(
      'paused',
    );

    // Pausing a paused listing is a lifecycle conflict, not idempotent.
    expect(
      (await runtime.listingLifecyclePort.pauseProgram(blueWave, fixtureListings.adultSwimming, 3))
        .kind,
    ).toBe('lifecycleConflict');

    // Resume is the publish action from paused.
    const resume = await runtime.listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.adultSwimming,
      3,
    );
    expect(resume.kind).toBe('programPublished');
  });

  test('publish is refused from draft/changes_requested/submitted states (no review bypass exists)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    for (const programId of [
      fixtureListings.holidayCamp,
      fixtureListings.aquaTherapy,
      fixtureListings.schoolTerm,
    ]) {
      expect(
        (await runtime.listingLifecyclePort.publishProgram(blueWave, programId, 2)).kind,
      ).toBe('lifecycleConflict');
    }
  });

  test('archive is legal from published and paused ONLY, is terminal, and carries no version', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // Not from approved/draft/submitted.
    for (const programId of [
      fixtureListings.privateCoaching,
      fixtureListings.holidayCamp,
      fixtureListings.schoolTerm,
    ]) {
      expect(
        (await runtime.listingLifecyclePort.archiveProgram(blueWave, programId, 2)).kind,
      ).toBe('lifecycleConflict');
    }

    // From paused (mastersTraining).
    const outcome = await runtime.listingLifecyclePort.archiveProgram(
      blueWave,
      fixtureListings.mastersTraining,
      2,
    );
    expect(outcome).toEqual({ kind: 'programArchived' });
    const archived = await detailOf(runtime, blueWave, fixtureListings.mastersTraining);
    expect(archived.listingState).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();

    // Terminal: nothing works on an archived listing — no restore exists.
    for (const action of ['submitProgram', 'publishProgram', 'pauseProgram', 'archiveProgram'] as const) {
      const refused = await runtime.listingLifecyclePort[action](
        blueWave,
        fixtureListings.mastersTraining,
        archived.version,
      );
      expect(`${action}:${refused.kind}`).toBe(`${action}:lifecycleConflict`);
    }
  });

  test('organizationNotLive: a complete APPROVED listing in a verified-but-not-live organization cannot publish — distinct from completeness', async () => {
    const runtime = runtimeAs('stages@himma.demo');
    const program = await detailOf(runtime, pearl, fixtureListings.pearlFreediving);
    expect(program.listingState).toBe('approved');

    const outcome = await runtime.listingLifecyclePort.publishProgram(
      pearl,
      fixtureListings.pearlFreediving,
      program.version,
    );
    expect(outcome).toEqual({ kind: 'organizationNotLive' });
    // The refusal is the ORGANIZATION gate, never programIncomplete: the
    // listing itself meets every completeness requirement.
    expect(outcome.kind).not.toBe('programIncomplete');
    expect((await detailOf(runtime, pearl, fixtureListings.pearlFreediving)).listingState).toBe(
      'approved',
    );
  });

  test('CAS: a stale lifecycle command never overwrites; the same-version duplicate executes once', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // A concurrent edit bumps the version out from under the caller.
    runtime.controls.simulateConcurrentListingEdit(blueWave, fixtureListings.privateCoaching);
    const stale = await runtime.listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.privateCoaching,
      2,
    );
    expect(stale.kind).toBe('staleVersion');
    expect((await detailOf(runtime, blueWave, fixtureListings.privateCoaching)).listingState).toBe(
      'approved',
    );

    // Fresh version succeeds exactly once; replaying the same command with
    // the consumed version is staleVersion (duplicate cannot re-execute).
    const fresh = await runtime.listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.privateCoaching,
      3,
    );
    expect(fresh.kind).toBe('programPublished');
    // Replaying the consumed command cannot re-execute: the service checks
    // state BEFORE version (exact backend order), so the duplicate lands on
    // lifecycleConflict — and the state advanced exactly once.
    const replay = await runtime.listingLifecyclePort.publishProgram(
      blueWave,
      fixtureListings.privateCoaching,
      3,
    );
    expect(replay.kind).toBe('lifecycleConflict');
    const settled = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(settled.listingState).toBe('published');
    expect(settled.version).toBe(4);
  });

  test('suspended organization: every lifecycle mutation refuses organizationSuspended at the policy layer', async () => {
    const runtime = runtimeAs('director@himma.demo');
    for (const action of ['submitProgram', 'publishProgram', 'pauseProgram', 'archiveProgram'] as const) {
      const outcome = await runtime.listingLifecyclePort[action](
        falcon,
        fixtureListings.falconKickboxing,
        2,
      );
      expect(`${action}:${outcome.kind}`).toBe(`${action}:organizationSuspended`);
    }
  });

  test('not-found shaping: unknown ids, foreign organizations, and no-membership orgs collapse safely', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // Ghost id in the caller's own org.
    expect(
      (await runtime.listingLifecyclePort.submitProgram(blueWave, GHOST_ID, 2)).kind,
    ).toBe('notFound');
    // A real listing addressed through an organization the caller has no
    // seat in — the org membership shaping fires first.
    expect(
      (await runtime.listingLifecyclePort.publishProgram(noor, fixtureListings.noorExamPrep, 2))
        .kind,
    ).toBe('notFound');
  });

  test('transient failure: failNextListingMutation surfaces unavailable and changes nothing', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.failNextListingMutation(blueWave);
    const outcome = await runtime.listingLifecyclePort.pauseProgram(
      blueWave,
      fixtureListings.adultSwimming,
      2,
    );
    expect(outcome.kind).toBe('unavailable');
    expect((await detailOf(runtime, blueWave, fixtureListings.adultSwimming)).listingState).toBe(
      'published',
    );
    // The failure control is one-shot: the retry succeeds.
    const retry = await runtime.listingLifecyclePort.pauseProgram(
      blueWave,
      fixtureListings.adultSwimming,
      2,
    );
    expect(retry.kind).toBe('programPaused');
  });
});
