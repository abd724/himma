import { createUnconfiguredListingEditorPort } from '../src/auth/unconfigured-adapter';
import { LISTING_EDITOR_OPERATIONS } from '../src/catalogue/editor-contract';
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

type Runtime = ReturnType<typeof createFixtureAuthRuntime>;

function runtimeAs(email: string): Runtime {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession(email);
  return runtime;
}

const GHOST_ID = '0198a2f0-5b7a-7000-8000-00000000dead';

const MINIMAL_CREATE = {
  titleEn: 'Sunrise Paddle Club',
  activityTypeId: fixtureActivityTypes.swimming,
  setting: 'outdoor',
  genderEligibility: 'mixed',
} as const;

async function detailOf(runtime: Runtime, orgId: string, programId: string) {
  const outcome = await runtime.listingsPort.loadListing(orgId, programId);
  if (outcome.kind !== 'loaded') {
    throw new Error(`expected loaded detail, got ${outcome.kind}`);
  }
  return outcome.program;
}

describe('listing editor port — structure and authority (W2-8)', () => {
  test('the port exposes EXACTLY the 13 real mutation operations — no lifecycle action can exist', () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(Object.keys(runtime.listingEditorPort).sort()).toEqual(
      [...LISTING_EDITOR_OPERATIONS].sort(),
    );
    // No submit/publish/pause/resume/archive-listing/revision operation.
    for (const forbidden of ['submitProgram', 'publishProgram', 'pauseProgram', 'archiveProgram']) {
      expect(forbidden in runtime.listingEditorPort).toBe(false);
    }
  });

  test('seven-role CREATE matrix: the four listings.manage roles create; coach/front_desk/finance are forbidden', async () => {
    for (const email of [
      'owner@bluewave.demo',
      'director@himma.demo',
      'manager@bluewave.demo',
      'flaky@bluewave.demo',
    ]) {
      const outcome = await runtimeAs(email).listingEditorPort.createProgram(blueWave, MINIMAL_CREATE);
      expect(`${email}:${outcome.kind}`).toBe(`${email}:programCreated`);
    }
    for (const email of ['frontdesk@bluewave.demo', 'finance@bluewave.demo']) {
      const outcome = await runtimeAs(email).listingEditorPort.createProgram(blueWave, MINIMAL_CREATE);
      expect(`${email}:${outcome.kind}`).toBe(`${email}:forbidden`);
    }
    // Coach (no catalogue capability at all) — Coral's assistant seat.
    const coach = await runtimeAs('assistant@coral.demo').listingEditorPort.createProgram(
      fixtureOrganizations.coral.organizationId,
      MINIMAL_CREATE,
    );
    expect(coach.kind).toBe('forbidden');
  });

  test('mutation on a foreign organization or ghost listing is not-found-shaped', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(
      (await runtime.listingEditorPort.updateProgram(blueWave, fixtureListings.noorAfterSchool, 1, { titleEn: 'X' })).kind,
    ).toBe('notFound');
    expect(
      (await runtime.listingEditorPort.updateProgram(blueWave, GHOST_ID, 1, { titleEn: 'X' })).kind,
    ).toBe('notFound');
    expect((await runtime.listingEditorPort.updateProgram(noor, fixtureListings.noorAfterSchool, 1, { titleEn: 'X' })).kind).toBe(
      'notFound', // no Blue Wave membership at Noor
    );
  });

  test('the unconfigured production port fails CLOSED on every operation', async () => {
    const port = createUnconfiguredListingEditorPort();
    expect(Object.keys(port).sort()).toEqual([...LISTING_EDITOR_OPERATIONS].sort());
    for (const operation of LISTING_EDITOR_OPERATIONS) {
      const result = await (
        port[operation] as (...args: unknown[]) => Promise<{ kind: string }>
      )('org', 'a', 'b', 1, {});
      expect(`${operation}:${result.kind}`).toBe(`${operation}:unavailable`);
    }
  });
});

describe('create listing (drafts may be incomplete)', () => {
  test('a minimal structural create succeeds: draft state, version 1, immediately in the SHARED W2-7 truth, no auto-submission', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.listingEditorPort.createProgram(blueWave, MINIMAL_CREATE);
    if (outcome.kind !== 'programCreated') throw new Error(outcome.kind);
    expect(outcome.program.listingState).toBe('draft');
    expect(outcome.program.version).toBe(1);

    // The same fixture truth the W2-7 index/detail read — no editor copy.
    const detail = await detailOf(runtime, blueWave, outcome.program.id);
    expect(detail.titleEn).toBe('Sunrise Paddle Club');
    expect(detail.listingState).toBe('draft');
    expect(detail.priceOptions).toEqual([]);
    expect(detail.branches).toEqual([]);
    expect('price' in detail).toBe(false);

    const list = await runtime.listingsPort.listListings(blueWave, { limit: 100 });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    const ids = list.page.programs.map((row) => row.id);
    expect(ids[ids.length - 1]).toBe(outcome.program.id); // newest last in (createdAt, id) order
  });

  test('invalid taxonomy is refused: an inactive activity type and a ghost id cannot be newly chosen', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    for (const activityTypeId of [fixtureActivityTypes.synchronizedSwimming, GHOST_ID]) {
      const outcome = await runtime.listingEditorPort.createProgram(blueWave, {
        ...MINIMAL_CREATE,
        activityTypeId,
      });
      expect(outcome.kind).toBe('invalidTaxonomy');
    }
  });

  test('invalid eligibility is refused: minAge > maxAge, allAges with a bound, out-of-range ages', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const cases = [
      { minAge: 12, maxAge: 6 },
      { allAges: true, minAge: 5 },
      { minAge: -1 },
      { maxAge: 500 },
    ];
    for (const eligibility of cases) {
      const outcome = await runtime.listingEditorPort.createProgram(blueWave, {
        ...MINIMAL_CREATE,
        ...eligibility,
      });
      expect(`${JSON.stringify(eligibility)}:${outcome.kind}`).toBe(
        `${JSON.stringify(eligibility)}:invalidEligibility`,
      );
    }
  });
});

describe('program editing (edit-state matrix + CAS)', () => {
  test('a draft edits DIRECTLY: dirty-field patch, version bump, shared detail reflects immediately', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    const outcome = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.holidayCamp,
      before.version,
      { titleEn: 'Holiday Swim Camp Plus', minAge: 7 },
    );
    if (outcome.kind !== 'programUpdated') throw new Error(outcome.kind);
    expect(outcome.version).toBe(before.version + 1);
    const after = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    expect(after.titleEn).toBe('Holiday Swim Camp Plus');
    expect(after.minAge).toBe(7);
    // Untouched fields stay exactly as they were (dirty-field semantics).
    expect(after.descriptionEn).toBe(before.descriptionEn);
    expect(after.maxAge).toBe(before.maxAge);
    expect(after.openRevision).toBeNull(); // direct edit — no revision on drafts
  });

  test('a changes-requested listing edits directly (provider corrections); resubmission stays out of W2-8', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.aquaTherapy);
    expect(before.listingState).toBe('changes_requested');
    const outcome = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.aquaTherapy,
      before.version,
      { descriptionEn: 'Rehab-friendly aqua therapy with certified instructors.' },
    );
    expect(outcome.kind).toBe('programUpdated');
    const after = await detailOf(runtime, blueWave, fixtureListings.aquaTherapy);
    expect(after.listingState).toBe('changes_requested'); // no lifecycle movement
  });

  test('submitted, in-review, and archived listings are LOCKED (lifecycleConflict) — fixtures cannot edit what the backend refuses', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    for (const programId of [
      fixtureListings.schoolTerm, // submitted
      fixtureListings.strokeClinic, // in_review
      fixtureListings.sunsetOpenWater, // archived
    ]) {
      const before = await detailOf(runtime, blueWave, programId);
      const outcome = await runtime.listingEditorPort.updateProgram(blueWave, programId, before.version, {
        titleEn: 'Hijacked',
      });
      expect(`${before.listingState}:${outcome.kind}`).toBe(`${before.listingState}:lifecycleConflict`);
      expect((await detailOf(runtime, blueWave, programId)).titleEn).toBe(before.titleEn);
    }
  });

  test('a stale program edit NEVER overwrites: the second writer gets staleVersion and the first save stands', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    const first = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.holidayCamp,
      before.version,
      { titleEn: 'First Writer Wins' },
    );
    expect(first.kind).toBe('programUpdated');
    const second = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.holidayCamp,
      before.version, // stale
      { titleEn: 'Second Writer Overwrites' },
    );
    expect(second.kind).toBe('staleVersion');
    expect((await detailOf(runtime, blueWave, fixtureListings.holidayCamp)).titleEn).toBe(
      'First Writer Wins',
    );
  });

  test('review-gated states: NON-sensitive fields apply directly; sensitive fields create a ProgramRevision (live values untouched)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(before.listingState).toBe('approved');
    expect(before.openRevision).toBeNull();

    // Non-sensitive only: applies directly even though the listing is gated.
    const direct = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.privateCoaching,
      before.version,
      { titleEn: 'Private Swim Coaching Pro' },
    );
    if (direct.kind !== 'programUpdated') throw new Error(direct.kind);

    // Mixed patch: title applies, the sensitive description defers to review.
    const mixed = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.privateCoaching,
      direct.version,
      { titleAr: 'تدريب سباحة خاص', descriptionEn: 'Updated protected copy.' },
    );
    if (mixed.kind !== 'revisionSubmitted') throw new Error(mixed.kind);
    expect(mixed.appliedFields).toEqual(['titleAr']);
    expect(mixed.deferredFields).toEqual(['descriptionEn']);

    const after = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(after.titleEn).toBe('Private Swim Coaching Pro');
    expect(after.titleAr).toBe('تدريب سباحة خاص');
    expect(after.descriptionEn).toBe(before.descriptionEn); // live value stands until review
    expect(after.openRevision).not.toBeNull(); // ONE open revision now recorded
  });

  test('at most ONE open revision: a further sensitive change while one is pending is revisionPending', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const pending = await detailOf(runtime, blueWave, fixtureListings.juniorSquad);
    expect(pending.openRevision).not.toBeNull();
    const outcome = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.juniorSquad,
      pending.version,
      { minAge: 9 },
    );
    expect(outcome.kind).toBe('revisionPending');
    expect((await detailOf(runtime, blueWave, fixtureListings.juniorSquad)).minAge).toBe(pending.minAge);
  });
});

describe('Branch Manager mutation scope (stricter than the read rule — on purpose)', () => {
  test('READ access does NOT grant mutation: a some-in-scope listing is readable but its edit is forbidden under the every-rule', async () => {
    const runtime = runtimeAs('manager@bluewave.demo');
    // adultSwimming runs at Marina (assigned) AND Bay (not assigned):
    // reachable for reading, NOT mutable (every-rule fails).
    const readable = await detailOf(runtime, blueWave, fixtureListings.adultSwimming);
    expect(readable.titleEn).toBe('Adult Beginner Swimming');
    const edit = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.adultSwimming,
      readable.version,
      { titleEn: 'Hijacked' },
    );
    expect(edit.kind).toBe('forbidden');
    const optionAdd = await runtime.listingEditorPort.addPriceOption(blueWave, fixtureListings.adultSwimming, {
      kind: 'dropIn',
      amountFils: 5_000,
    });
    expect(optionAdd.kind).toBe('forbidden');
  });

  test('a listing whose EVERY active association is assigned edits normally', async () => {
    const runtime = runtimeAs('manager@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.ladiesAqua); // Marina only
    const outcome = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.ladiesAqua,
      before.version,
      { titleEn: 'Ladies Aqua Fitness Club' },
    );
    expect(outcome.kind).toBe('programUpdated');
  });

  test('branch associations respect the target scope: an assigned branch associates; an unassigned branch is forbidden', async () => {
    const runtime = runtimeAs('manager@bluewave.demo');
    const created = await runtime.listingEditorPort.createProgram(blueWave, MINIMAL_CREATE);
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    expect(
      (
        await runtime.listingEditorPort.addBranchAssociation(
          blueWave,
          created.program.id,
          fixtureBranches.blueWaveMarina,
        )
      ).kind,
    ).toBe('branchAssociated');
    expect(
      (
        await runtime.listingEditorPort.addBranchAssociation(
          blueWave,
          created.program.id,
          fixtureBranches.blueWaveBay,
        )
      ).kind,
    ).toBe('forbidden');
  });
});

describe('branch associations (composite spine semantics)', () => {
  test('associate + remove + re-associate: same-org active branches only, history preserved, idempotent removal', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // Associate an active branch with the branchless draft.
    expect(
      (
        await runtime.listingEditorPort.addBranchAssociation(
          blueWave,
          fixtureListings.holidayCamp,
          fixtureBranches.blueWaveMarina,
        )
      ).kind,
    ).toBe('branchAssociated');
    let detail = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0]!).toMatchObject({
      branchId: fixtureBranches.blueWaveMarina,
      associationActive: true,
      branchActive: true,
    });

    // Remove → history row stays, inactive; removal is idempotent.
    expect(
      (
        await runtime.listingEditorPort.removeBranchAssociation(
          blueWave,
          fixtureListings.holidayCamp,
          fixtureBranches.blueWaveMarina,
        )
      ).kind,
    ).toBe('branchAssociationRemoved');
    detail = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0]!.associationActive).toBe(false);
    expect(
      (
        await runtime.listingEditorPort.removeBranchAssociation(
          blueWave,
          fixtureListings.holidayCamp,
          fixtureBranches.blueWaveMarina,
        )
      ).kind,
    ).toBe('branchAssociationRemoved');

    // Re-association reactivates the SAME historical row.
    expect(
      (
        await runtime.listingEditorPort.addBranchAssociation(
          blueWave,
          fixtureListings.holidayCamp,
          fixtureBranches.blueWaveMarina,
        )
      ).kind,
    ).toBe('branchAssociated');
    detail = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    expect(detail.branches).toHaveLength(1);
    expect(detail.branches[0]!.associationActive).toBe(true);
  });

  test('a foreign organization’s branch and a deactivated branch are invalidBranch', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(
      (
        await runtime.listingEditorPort.addBranchAssociation(
          blueWave,
          fixtureListings.holidayCamp,
          fixtureBranches.noorBarsha,
        )
      ).kind,
    ).toBe('invalidBranch');
    expect(
      (
        await runtime.listingEditorPort.addBranchAssociation(
          blueWave,
          fixtureListings.holidayCamp,
          fixtureBranches.blueWaveSufouh, // deactivated
        )
      ).kind,
    ).toBe('invalidBranch');
  });
});

describe('price options (D-S4-1: stable ids, integer fils, archive-only)', () => {
  test('add/edit/reorder on a draft: stable id, version CAS, deterministic (sortHint, id) order', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const added = await runtime.listingEditorPort.addPriceOption(blueWave, fixtureListings.holidayCamp, {
      kind: 'monthly',
      amountFils: 45_000,
      sortHint: 20,
    });
    if (added.kind !== 'optionAdded') throw new Error(added.kind);
    expect(added.option.version).toBe(1);
    expect(added.option.amountFils).toBe(45_000);
    expect(added.option.currency).toBe('AED');

    const updated = await runtime.listingEditorPort.updatePriceOption(
      blueWave,
      fixtureListings.holidayCamp,
      added.option.id,
      1,
      { amountFils: 50_000 },
    );
    if (updated.kind !== 'optionUpdated') throw new Error(updated.kind);
    expect(updated.option.amountFils).toBe(50_000);
    expect(updated.option.version).toBe(2);
    expect(updated.option.id).toBe(added.option.id); // stable id survives edits

    // Stale second writer refused; saved value stands.
    const stale = await runtime.listingEditorPort.updatePriceOption(
      blueWave,
      fixtureListings.holidayCamp,
      added.option.id,
      1,
      { amountFils: 1_000 },
    );
    expect(stale.kind).toBe('staleVersion');

    // Reorder = sortHint PATCH; detail order is (sortHint, id).
    const reordered = await runtime.listingEditorPort.updatePriceOption(
      blueWave,
      fixtureListings.holidayCamp,
      added.option.id,
      2,
      { sortHint: 1 },
    );
    expect(reordered.kind).toBe('optionUpdated');
    const detail = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    expect(detail.priceOptions[0]!.id).toBe(added.option.id);
  });

  test('shape invariants: free ⇔ no amount; paid ⇒ positive fils; package ⇔ positive sessions; others carry none', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const cases = [
      { kind: 'free', amountFils: 1_000 },
      { kind: 'monthly', amountFils: null },
      { kind: 'monthly' },
      { kind: 'package', amountFils: 10_000 }, // sessions missing
      { kind: 'monthly', amountFils: 5_000, sessionsCount: 8 }, // sessions on non-package
    ];
    for (const option of cases) {
      const outcome = await runtime.listingEditorPort.addPriceOption(
        blueWave,
        fixtureListings.holidayCamp,
        option,
      );
      expect(`${JSON.stringify(option)}:${outcome.kind}`).toBe(
        `${JSON.stringify(option)}:invalidPriceOption`,
      );
    }
    expect(
      (
        await runtime.listingEditorPort.addPriceOption(blueWave, fixtureListings.holidayCamp, {
          kind: 'free',
        })
      ).kind,
    ).toBe('optionAdded');
    expect(
      (
        await runtime.listingEditorPort.addPriceOption(blueWave, fixtureListings.holidayCamp, {
          kind: 'package',
          amountFils: 160_000,
          sessionsCount: 8,
        })
      ).kind,
    ).toBe('optionAdded');
  });

  test('archive is one-way history: archived option refuses edits, archive is idempotent, the row stays visible', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const added = await runtime.listingEditorPort.addPriceOption(blueWave, fixtureListings.holidayCamp, {
      kind: 'dropIn',
      amountFils: 6_000,
    });
    if (added.kind !== 'optionAdded') throw new Error(added.kind);
    expect(
      (
        await runtime.listingEditorPort.archivePriceOption(
          blueWave,
          fixtureListings.holidayCamp,
          added.option.id,
          1,
        )
      ).kind,
    ).toBe('optionArchived');
    // Immutable history — no edit, no reactivation path of any kind.
    expect(
      (
        await runtime.listingEditorPort.updatePriceOption(
          blueWave,
          fixtureListings.holidayCamp,
          added.option.id,
          2,
          { amountFils: 9_000 },
        )
      ).kind,
    ).toBe('lifecycleConflict');
    // Idempotent re-archive.
    expect(
      (
        await runtime.listingEditorPort.archivePriceOption(
          blueWave,
          fixtureListings.holidayCamp,
          added.option.id,
          2,
        )
      ).kind,
    ).toBe('optionArchived');
    const detail = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    expect(detail.priceOptions.find((option) => option.id === added.option.id)?.state).toBe(
      'archived',
    );
  });

  test('on a review-gated listing EVERY option operation routes through revision (no live change); a pending revision blocks further ones', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    const packageOption = before.priceOptions[0]!;

    const add = await runtime.listingEditorPort.addPriceOption(blueWave, fixtureListings.privateCoaching, {
      kind: 'dropIn',
      amountFils: 30_000,
    });
    expect(add.kind).toBe('revisionSubmitted');
    const after = await detailOf(runtime, blueWave, fixtureListings.privateCoaching);
    expect(after.priceOptions).toHaveLength(before.priceOptions.length); // live set untouched
    expect(after.openRevision).not.toBeNull();

    const edit = await runtime.listingEditorPort.updatePriceOption(
      blueWave,
      fixtureListings.privateCoaching,
      packageOption.id,
      packageOption.version,
      { amountFils: 170_000 },
    );
    expect(edit.kind).toBe('revisionPending'); // one open revision at a time
  });
});

describe('media reference metadata (Class-C binary gap carried)', () => {
  test('metadata add/update/archive hot-apply even on a published listing; CAS protects updates; archive idempotent', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.adultSwimming);
    const activeMedia = before.media.find((entry) => entry.active)!;

    const updated = await runtime.listingEditorPort.updateMedia(
      blueWave,
      fixtureListings.adultSwimming,
      activeMedia.id,
      activeMedia.version,
      { altTextEn: 'Coach with adult beginners, main pool' },
    );
    if (updated.kind !== 'mediaUpdated') throw new Error(updated.kind);
    expect(updated.media.altTextEn).toBe('Coach with adult beginners, main pool');

    const stale = await runtime.listingEditorPort.updateMedia(
      blueWave,
      fixtureListings.adultSwimming,
      activeMedia.id,
      activeMedia.version, // stale after the successful update
      { altTextEn: 'Overwrite attempt' },
    );
    expect(stale.kind).toBe('staleVersion');

    const added = await runtime.listingEditorPort.addMedia(blueWave, fixtureListings.adultSwimming, {
      mediaRef: '0198a2f0-5b7a-7000-8000-4b8c5d0e6fff',
      altTextEn: 'Lane ropes at sunrise',
    });
    if (added.kind !== 'mediaAdded') throw new Error(added.kind);

    expect(
      (
        await runtime.listingEditorPort.archiveMedia(
          blueWave,
          fixtureListings.adultSwimming,
          added.media.id,
          added.media.version,
        )
      ).kind,
    ).toBe('mediaArchived');
    expect(
      (
        await runtime.listingEditorPort.archiveMedia(
          blueWave,
          fixtureListings.adultSwimming,
          added.media.id,
          added.media.version,
        )
      ).kind,
    ).toBe('mediaArchived'); // idempotent
  });

  test('media on a LOCKED listing refuses with lifecycleConflict', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.listingEditorPort.addMedia(blueWave, fixtureListings.schoolTerm, {
      mediaRef: '0198a2f0-5b7a-7000-8000-4b8c5d0e6f77',
    });
    expect(outcome.kind).toBe('lifecycleConflict');
  });
});

describe('offers (informational; Offer ≠ ProgramPriceOption)', () => {
  test('add/edit/end with exact shape rules: paidTrial amount tie, window validation, ended = terminal, CAS', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');

    // Shape refusals.
    expect(
      (
        await runtime.listingEditorPort.addOffer(blueWave, fixtureListings.holidayCamp, {
          kind: 'paidTrial',
          labelEn: 'Paid trial',
        })
      ).kind,
    ).toBe('invalidOffer');
    expect(
      (
        await runtime.listingEditorPort.addOffer(blueWave, fixtureListings.holidayCamp, {
          kind: 'discount',
          labelEn: 'Discount with amount',
          trialAmountFils: 500,
        })
      ).kind,
    ).toBe('invalidOffer');
    expect(
      (
        await runtime.listingEditorPort.addOffer(blueWave, fixtureListings.holidayCamp, {
          kind: 'promo',
          labelEn: 'Backwards window',
          effectiveStart: '2026-09-01T00:00:00.000Z',
          effectiveEnd: '2026-08-01T00:00:00.000Z',
        })
      ).kind,
    ).toBe('invalidOffer');

    // A valid paid trial adds — even on a PUBLISHED listing (offers are not
    // review-gated; they hot-apply).
    const added = await runtime.listingEditorPort.addOffer(blueWave, fixtureListings.adultSwimming, {
      kind: 'paidTrial',
      labelEn: 'Trial for AED 50',
      trialAmountFils: 5_000,
    });
    if (added.kind !== 'offerAdded') throw new Error(added.kind);
    expect(added.offer.state).toBe('active');

    const updated = await runtime.listingEditorPort.updateOffer(
      blueWave,
      fixtureListings.adultSwimming,
      added.offer.id,
      1,
      { labelEn: 'Trial for AED 55', trialAmountFils: 5_500 },
    );
    expect(updated.kind).toBe('offerUpdated');

    const staleEnd = await runtime.listingEditorPort.endOffer(
      blueWave,
      fixtureListings.adultSwimming,
      added.offer.id,
      1, // stale
    );
    expect(staleEnd.kind).toBe('staleVersion');
    expect(
      (await runtime.listingEditorPort.endOffer(blueWave, fixtureListings.adultSwimming, added.offer.id, 2))
        .kind,
    ).toBe('offerEnded');
    // Idempotent end; ended offers refuse edits (terminal history).
    expect(
      (await runtime.listingEditorPort.endOffer(blueWave, fixtureListings.adultSwimming, added.offer.id, 3))
        .kind,
    ).toBe('offerEnded');
    expect(
      (
        await runtime.listingEditorPort.updateOffer(
          blueWave,
          fixtureListings.adultSwimming,
          added.offer.id,
          3,
          { labelEn: 'Zombie edit' },
        )
      ).kind,
    ).toBe('lifecycleConflict');

    // An offer never becomes a price-option row.
    const detail = await detailOf(runtime, blueWave, fixtureListings.adultSwimming);
    expect(detail.priceOptions.some((option) => option.id === added.offer.id)).toBe(false);
  });
});

describe('suspension, transient failure, and shared truth', () => {
  test('a suspended organization cannot mutate the catalogue in any way (reads stay)', async () => {
    const runtime = runtimeAs('director@himma.demo');
    const detail = await detailOf(runtime, falcon, fixtureListings.falconKickboxing);
    const outcomes = [
      (await runtime.listingEditorPort.createProgram(falcon, MINIMAL_CREATE)).kind,
      (
        await runtime.listingEditorPort.updateProgram(falcon, fixtureListings.falconKickboxing, detail.version, {
          titleEn: 'X',
        })
      ).kind,
      (
        await runtime.listingEditorPort.addPriceOption(falcon, fixtureListings.falconKickboxing, {
          kind: 'dropIn',
          amountFils: 4_000,
        })
      ).kind,
      (
        await runtime.listingEditorPort.addOffer(falcon, fixtureListings.falconKickboxing, {
          kind: 'freeTrial',
          labelEn: 'Trial',
        })
      ).kind,
    ];
    expect(outcomes).toEqual([
      'organizationSuspended',
      'organizationSuspended',
      'organizationSuspended',
      'organizationSuspended',
    ]);
  });

  test('a transient mutation failure is retryable and leaves the truth unchanged', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    runtime.controls.failNextListingMutation(blueWave);
    const failed = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.holidayCamp,
      before.version,
      { titleEn: 'Should not apply' },
    );
    expect(failed.kind).toBe('unavailable');
    expect((await detailOf(runtime, blueWave, fixtureListings.holidayCamp)).titleEn).toBe(before.titleEn);
    const retried = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.holidayCamp,
      before.version,
      { titleEn: before.titleEn },
    );
    expect(retried.kind).toBe('programUpdated');
  });

  test('concurrent-edit simulation control produces the canonical stale conflict', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await detailOf(runtime, blueWave, fixtureListings.holidayCamp);
    runtime.controls.simulateConcurrentListingEdit(blueWave, fixtureListings.holidayCamp);
    const outcome = await runtime.listingEditorPort.updateProgram(
      blueWave,
      fixtureListings.holidayCamp,
      before.version,
      { titleEn: 'Stale writer' },
    );
    expect(outcome.kind).toBe('staleVersion');
  });
});
