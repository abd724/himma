/**
 * S4-2 — provider catalogue application services (docs/28 §16.2 semantics at
 * the service layer; D-S4-1/D-S4-2; docs/24 §5.3). Real PostgreSQL: program
 * create/list/edit/submit/publish/pause/archive, structured completeness,
 * price-option management, branch associations on the composite spine,
 * media references, offers, the automatic sensitive-edit revision routing,
 * organization/branch isolation, CAS, and same-transaction audit/outbox.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
  addProgramBranch,
  archiveProgram,
  createProgram,
  getProviderProgram,
  listProviderPrograms,
  pauseProgram,
  publishProgram,
  removeProgramBranch,
  submitProgram,
  updateProgram,
} from '../src/modules/catalogue/services/program-management';
import {
  addPriceOption,
  archivePriceOption,
  updatePriceOption,
} from '../src/modules/catalogue/services/price-option-management';
import {
  addOffer,
  addProgramMedia,
  archiveProgramMedia,
  endOffer,
  updateOffer,
  updateProgramMedia,
} from '../src/modules/catalogue/services/media-offer-management';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { ProviderRole } from '../src/modules/provider/provider-roles';
import type {
  OrganizationState,
  OrgScope,
} from '../src/modules/provider/services/provider-principal';
import { createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let deps: { db: TestDb['db'] };
let orgA: { orgId: string; branchIds: string[] };
let orgB: { orgId: string; branchIds: string[] };
let activityType: string;
let inactiveType: string;
const actor = { userId: newId() };

function scopeFor(
  orgId: string,
  role: ProviderRole,
  options: { branchScope?: 'all' | string[]; organizationState?: OrganizationState } = {},
): OrgScope {
  return {
    organizationId: orgId,
    membershipId: newId(),
    role,
    capabilities: capabilitiesForRole(role),
    branchScope: options.branchScope ?? 'all',
    organizationState: options.organizationState ?? 'live',
  };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  deps = { db: testDb.db };
  orgA = await createProviderOrg(testDb.db, { branches: 3 });
  orgB = await createProviderOrg(testDb.db);
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-jiu-jitsu', 'Jiu-jitsu')`.execute(
    testDb.db,
  );
  inactiveType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en, active)
            VALUES (${inactiveType}, ${category.rows[0]!.id}, 'test-retired', 'Retired', false)`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await testDb.drop();
});

async function draftProgram(
  scope: OrgScope,
  title = 'Adult Beginner Jiu-Jitsu',
): Promise<{ id: string; version: number }> {
  const created = await createProgram(deps, scope, actor, {
    titleEn: title,
    activityTypeId: activityType,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  return { id: created.program.id, version: created.program.version };
}

/** Drives a complete draft to `approved` via the admin edges (SQL — the
 *  admin review services are deliberately NOT part of S4-2). */
async function approveProgram(programId: string): Promise<void> {
  await sql`UPDATE program SET listing_state = 'submitted' WHERE id = ${programId}`.execute(testDb.db);
  await sql`UPDATE program SET listing_state = 'in_review' WHERE id = ${programId}`.execute(testDb.db);
  await sql`UPDATE program SET listing_state = 'approved' WHERE id = ${programId}`.execute(testDb.db);
}

async function completeDraft(scope: OrgScope, title?: string): Promise<string> {
  const program = await draftProgram(scope, title);
  const associated = await addProgramBranch(deps, scope, actor, {
    programId: program.id,
    branchId: orgA.branchIds[0]!,
  });
  if (associated.kind !== 'branchAssociated') throw new Error(associated.kind);
  const option = await addPriceOption(deps, scope, actor, {
    programId: program.id,
    option: { kind: 'monthly', amountFils: 60000, labelEn: 'Monthly', sortHint: 10 },
  });
  if (option.kind !== 'optionAdded') throw new Error(option.kind);
  return program.id;
}

async function currentVersion(programId: string): Promise<number> {
  const row = await sql<{ version: number }>`
    SELECT version FROM program WHERE id = ${programId}`.execute(testDb.db);
  return row.rows[0]!.version;
}

async function programState(programId: string): Promise<string> {
  const row = await sql<{ listing_state: string }>`
    SELECT listing_state FROM program WHERE id = ${programId}`.execute(testDb.db);
  return row.rows[0]!.listing_state;
}

describe('program creation and drafts', () => {
  it('creates an incomplete draft with taxonomy validation and emits listing.created', async () => {
    const scope = scopeFor(orgA.orgId, 'listings_editor');
    const created = await createProgram(deps, scope, actor, {
      titleEn: 'Junior Karate',
      activityTypeId: activityType,
      setting: 'indoor',
      genderEligibility: 'mixed',
      minAge: 6,
      maxAge: 12,
    });
    expect(created.kind).toBe('programCreated');
    if (created.kind !== 'programCreated') return;
    expect(created.program.listingState).toBe('draft');
    expect(created.program.version).toBe(1);

    const outbox = await sql<{ payload: { programId?: string; organizationId?: string } }>`
      SELECT payload FROM outbox_event
      WHERE aggregate_type = 'program' AND aggregate_id = ${created.program.id}
        AND event_type = 'listing.created'`.execute(testDb.db);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]?.payload).toEqual({
      programId: created.program.id,
      organizationId: orgA.orgId,
    });
    const audit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'listing.created' AND entity_id = ${created.program.id}`.execute(testDb.db);
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('refuses an inactive or unknown activity type with a typed outcome', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const inactive = await createProgram(deps, scope, actor, {
      titleEn: 'Bad taxonomy',
      activityTypeId: inactiveType,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    expect(inactive.kind).toBe('invalidTaxonomy');
    const unknown = await createProgram(deps, scope, actor, {
      titleEn: 'Bad taxonomy',
      activityTypeId: newId(),
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    expect(unknown.kind).toBe('invalidTaxonomy');
  });

  it('refuses contradictory eligibility with a typed outcome, never a raw constraint error', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const inverted = await createProgram(deps, scope, actor, {
      titleEn: 'Bad ages',
      activityTypeId: activityType,
      setting: 'indoor',
      genderEligibility: 'mixed',
      minAge: 12,
      maxAge: 6,
    });
    expect(inverted.kind).toBe('invalidEligibility');
    const allAgesWithRange = await createProgram(deps, scope, actor, {
      titleEn: 'Bad ages',
      activityTypeId: activityType,
      setting: 'indoor',
      genderEligibility: 'mixed',
      allAges: true,
      minAge: 6,
    });
    expect(allAgesWithRange.kind).toBe('invalidEligibility');
  });

  it('lists only the addressed organization and reads cross-org ids as not found', async () => {
    const scopeA = scopeFor(orgA.orgId, 'owner');
    const scopeB = scopeFor(orgB.orgId, 'owner');
    const mine = await draftProgram(scopeA, 'Isolation Check A');
    const listedB = await listProviderPrograms(deps, scopeB, {});
    expect(listedB.programs.map((program) => program.id)).not.toContain(mine.id);
    const probe = await getProviderProgram(deps, scopeB, { programId: mine.id });
    expect(probe.kind).toBe('programNotFound');
  });
});

describe('program editing, CAS, and lifecycle', () => {
  it('drafts edit directly (including sensitive fields) with CAS; stale writers lose', async () => {
    const scope = scopeFor(orgA.orgId, 'listings_editor');
    const program = await draftProgram(scope);
    const updated = await updateProgram(deps, scope, actor, {
      programId: program.id,
      expectedVersion: 1,
      patch: { titleEn: 'Adult BJJ', minAge: 16, skillLevel: 'beginner' },
    });
    expect(updated.kind).toBe('programUpdated');
    const stale = await updateProgram(deps, scope, actor, {
      programId: program.id,
      expectedVersion: 1,
      patch: { titleEn: 'Stale write' },
    });
    expect(stale.kind).toBe('staleVersion');
    const row = await sql<{ title_en: string; min_age: number }>`
      SELECT title_en, min_age FROM program WHERE id = ${program.id}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({ title_en: 'Adult BJJ', min_age: 16 });
  });

  it('refuses edits while a listing is submitted or in review', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const programId = await completeDraft(scope, 'Under Review');
    const submitted = await submitProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(submitted.kind).toBe('programSubmitted');
    const editAttempt = await updateProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
      patch: { titleEn: 'Mid-review edit' },
    });
    expect(editAttempt.kind).toBe('lifecycleConflict');
  });

  it('submission enforces structured completeness: branch + active price option required', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const bare = await draftProgram(scope, 'Incomplete Listing');
    const refused = await submitProgram(deps, scope, actor, {
      programId: bare.id,
      expectedVersion: bare.version,
    });
    expect(refused).toEqual({
      kind: 'programIncomplete',
      missing: ['activeBranch', 'activePriceOption'],
    });
    // Complete it: both requirements satisfied → submits.
    await addProgramBranch(deps, scope, actor, { programId: bare.id, branchId: orgA.branchIds[1]! });
    await addPriceOption(deps, scope, actor, {
      programId: bare.id,
      option: { kind: 'dropIn', amountFils: 9000 },
    });
    const submitted = await submitProgram(deps, scope, actor, {
      programId: bare.id,
      expectedVersion: await currentVersion(bare.id),
    });
    expect(submitted.kind).toBe('programSubmitted');
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${bare.id} AND event_type = 'listing.submitted'`.execute(testDb.db);
    expect(Number(events.rows[0]?.n)).toBe(1);
  });

  it('publication is separate from approval (D-S4-2) and requires a live organization + completeness', async () => {
    const scope = scopeFor(orgA.orgId, 'org_manager');
    const programId = await completeDraft(scope, 'Publish Flow');
    await submitProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });

    // Publishing before approval is a lifecycle conflict — no shortcut edge.
    const early = await publishProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(early.kind).toBe('lifecycleConflict');

    await approveProgram(programId);
    expect(await programState(programId)).toBe('approved'); // approval rested

    // A not-yet-live organization cannot publish.
    const preLive = scopeFor(orgA.orgId, 'org_manager', { organizationState: 'verified' });
    const notLive = await publishProgram(deps, preLive, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(notLive.kind).toBe('organizationNotLive');

    const published = await publishProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(published.kind).toBe('programPublished');
    expect(await programState(programId)).toBe('published');

    // Pause → re-publish → archive (terminal).
    const paused = await pauseProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(paused.kind).toBe('programPaused');
    const republished = await publishProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(republished.kind).toBe('programPublished');
    const archived = await archiveProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(archived.kind).toBe('programArchived');
    const afterTerminal = await updateProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
      patch: { titleEn: 'Necromancy' },
    });
    expect(afterTerminal.kind).toBe('lifecycleConflict');
    for (const eventType of ['listing.published', 'listing.paused', 'listing.archived']) {
      const events = await sql<{ n: string }>`
        SELECT count(*) AS n FROM outbox_event
        WHERE aggregate_id = ${programId} AND event_type = ${eventType}`.execute(testDb.db);
      expect(Number(events.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    }
  });

  it('publication completeness bites again at publish time when the last option was archived', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const programId = await completeDraft(scope, 'Archived Option Publish');
    // Archive the only option while still a draft.
    const detail = await getProviderProgram(deps, scope, { programId });
    if (detail.kind !== 'programView') throw new Error(detail.kind);
    const optionId = detail.program.priceOptions[0]!.id;
    const archivedOption = await archivePriceOption(deps, scope, actor, {
      programId,
      optionId,
      expectedVersion: 1,
    });
    expect(archivedOption.kind).toBe('optionArchived');
    await approveProgram(programId);
    const refused = await publishProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    expect(refused).toEqual({ kind: 'programIncomplete', missing: ['activePriceOption'] });
  });
});

describe('sensitive-edit revision routing (docs/28 §7)', () => {
  async function publishedProgram(scope: OrgScope, title: string): Promise<string> {
    const programId = await completeDraft(scope, title);
    await submitProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    await approveProgram(programId);
    const published = await publishProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
    });
    if (published.kind !== 'programPublished') throw new Error(published.kind);
    return programId;
  }

  it('a sensitive edit on a published listing creates a revision and never touches live fields', async () => {
    const scope = scopeFor(orgA.orgId, 'listings_editor');
    const programId = await publishedProgram(scope, 'Sensitive Edit Target');
    const result = await updateProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
      patch: { minAge: 18, eligibilityNotes: 'Adults only from next term' },
    });
    expect(result.kind).toBe('revisionSubmitted');
    if (result.kind !== 'revisionSubmitted') return;

    const live = await sql<{ min_age: number | null; eligibility_notes: string | null }>`
      SELECT min_age, eligibility_notes FROM program WHERE id = ${programId}`.execute(testDb.db);
    expect(live.rows[0]).toEqual({ min_age: null, eligibility_notes: null });
    const revision = await sql<{
      state: string;
      min_age: number | null;
      submitted_by: string;
    }>`SELECT state, min_age, submitted_by FROM program_revision
       WHERE id = ${result.revisionId}`.execute(testDb.db);
    expect(revision.rows[0]).toEqual({
      state: 'submitted',
      min_age: 18,
      submitted_by: actor.userId,
    });
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${programId} AND event_type = 'listing.revision_submitted'`.execute(
      testDb.db,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);

    // Only one open revision per listing: the next sensitive edit is refused.
    const second = await updateProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
      patch: { maxAge: 40 },
    });
    expect(second.kind).toBe('revisionPending');
  });

  it('a mixed patch applies non-sensitive fields directly while deferring sensitive ones', async () => {
    const scope = scopeFor(orgA.orgId, 'org_manager');
    const programId = await publishedProgram(scope, 'Mixed Patch Target');
    const result = await updateProgram(deps, scope, actor, {
      programId,
      expectedVersion: await currentVersion(programId),
      patch: { titleEn: 'Renamed While Live', genderEligibility: 'women' },
    });
    expect(result.kind).toBe('revisionSubmitted');
    if (result.kind !== 'revisionSubmitted') return;
    expect(result.appliedFields).toEqual(['titleEn']);
    expect(result.deferredFields).toEqual(['genderEligibility']);
    const row = await sql<{ title_en: string; gender_eligibility: string }>`
      SELECT title_en, gender_eligibility FROM program WHERE id = ${programId}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({ title_en: 'Renamed While Live', gender_eligibility: 'mixed' });
  });

  it('price-option changes on a published listing route through the revision flow', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const programId = await publishedProgram(scope, 'Option Revision Target');
    const added = await addPriceOption(deps, scope, actor, {
      programId,
      option: { kind: 'term', amountFils: 150000, labelEn: '3 months' },
    });
    expect(added.kind).toBe('revisionSubmitted');
    if (added.kind !== 'revisionSubmitted') return;
    const revision = await sql<{
      option_id: string | null;
      option_kind: string | null;
      option_amount_fils: string | null;
    }>`SELECT option_id, option_kind, option_amount_fils FROM program_revision
       WHERE id = ${added.revisionId}`.execute(testDb.db);
    expect(revision.rows[0]?.option_id).toBeNull(); // add-intent
    expect(revision.rows[0]?.option_kind).toBe('term');
    expect(Number(revision.rows[0]?.option_amount_fils)).toBe(150000);
    // The live option set is untouched — one option, unchanged.
    const options = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_price_option WHERE program_id = ${programId}`.execute(
      testDb.db,
    );
    expect(Number(options.rows[0]?.n)).toBe(1);
    // No S4-2 surface can decide a revision: the provider modules export no
    // approval path, and direct SQL from the app role still obeys the
    // machine (proven in S4-1). Here: the revision is still 'submitted'.
    const state = await sql<{ state: string }>`
      SELECT state FROM program_revision WHERE id = ${added.revisionId}`.execute(testDb.db);
    expect(state.rows[0]?.state).toBe('submitted');
  });
});

describe('price options (D-S4-1)', () => {
  it('one listing carries several options: trial Offer + monthly + term, one program row', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const program = await draftProgram(scope, 'One Listing Many Options');
    const offer = await addOffer(deps, scope, actor, {
      programId: program.id,
      offer: { kind: 'freeTrial', labelEn: 'Free trial class' },
    });
    expect(offer.kind).toBe('offerAdded');
    for (const [kind, amount, label, sort] of [
      ['monthly', 60000, 'Monthly', 10],
      ['term', 150000, '3 months', 20],
    ] as const) {
      const added = await addPriceOption(deps, scope, actor, {
        programId: program.id,
        option: { kind, amountFils: amount, labelEn: label, sortHint: sort },
      });
      expect(added.kind).toBe('optionAdded');
    }
    const detail = await getProviderProgram(deps, scope, { programId: program.id });
    if (detail.kind !== 'programView') throw new Error(detail.kind);
    expect(detail.program.priceOptions.map((option) => option.labelEn)).toEqual([
      'Monthly',
      '3 months',
    ]);
    expect(detail.program.offers).toHaveLength(1);
    const programs = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program WHERE title_en = 'One Listing Many Options'`.execute(
      testDb.db,
    );
    expect(Number(programs.rows[0]?.n)).toBe(1);
    // Offer ≠ ProgramPriceOption: the trial created no option row.
    expect(detail.program.priceOptions).toHaveLength(2);
  });

  it('validates option shapes with typed outcomes and supports reorder + archive with CAS', async () => {
    const scope = scopeFor(orgA.orgId, 'listings_editor');
    const program = await draftProgram(scope, 'Option Validation');
    for (const option of [
      { kind: 'free' as const, amountFils: 900 },
      { kind: 'monthly' as const },
      { kind: 'monthly' as const, amountFils: 0 },
      { kind: 'package' as const, amountFils: 90000 },
      { kind: 'dropIn' as const, amountFils: 9000, sessionsCount: 5 },
    ]) {
      const refused = await addPriceOption(deps, scope, actor, { programId: program.id, option });
      expect(refused.kind).toBe('invalidPriceOption');
    }
    const added = await addPriceOption(deps, scope, actor, {
      programId: program.id,
      option: { kind: 'package', amountFils: 135000, sessionsCount: 5, sortHint: 10 },
    });
    if (added.kind !== 'optionAdded') throw new Error(added.kind);

    const reordered = await updatePriceOption(deps, scope, actor, {
      programId: program.id,
      optionId: added.option.id,
      expectedVersion: 1,
      patch: { sortHint: 99 },
    });
    expect(reordered.kind).toBe('optionUpdated');
    const staleWriter = await updatePriceOption(deps, scope, actor, {
      programId: program.id,
      optionId: added.option.id,
      expectedVersion: 1,
      patch: { amountFils: 140000 },
    });
    expect(staleWriter.kind).toBe('staleVersion');

    const archived = await archivePriceOption(deps, scope, actor, {
      programId: program.id,
      optionId: added.option.id,
      expectedVersion: 2,
    });
    expect(archived.kind).toBe('optionArchived');
    // Archive-only retirement: no reactivation or edit path exists.
    const afterArchive = await updatePriceOption(deps, scope, actor, {
      programId: program.id,
      optionId: added.option.id,
      expectedVersion: 3,
      patch: { amountFils: 100 },
    });
    expect(afterArchive.kind).toBe('lifecycleConflict');
  });

  it('cross-organization option management is not-found-shaped', async () => {
    const scopeA = scopeFor(orgA.orgId, 'owner');
    const scopeB = scopeFor(orgB.orgId, 'owner');
    const program = await draftProgram(scopeA, 'Foreign Option Probe');
    const foreignAdd = await addPriceOption(deps, scopeB, actor, {
      programId: program.id,
      option: { kind: 'monthly', amountFils: 50000 },
    });
    expect(foreignAdd.kind).toBe('programNotFound');
  });
});

describe('branch associations (composite spine)', () => {
  it('associates one or several own branches; foreign and inactive branches are refused', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const program = await draftProgram(scope, 'Branch Assoc');
    expect(
      (await addProgramBranch(deps, scope, actor, { programId: program.id, branchId: orgA.branchIds[0]! }))
        .kind,
    ).toBe('branchAssociated');
    expect(
      (await addProgramBranch(deps, scope, actor, { programId: program.id, branchId: orgA.branchIds[1]! }))
        .kind,
    ).toBe('branchAssociated');
    // Provider B's branch is invalid here regardless of honesty.
    expect(
      (await addProgramBranch(deps, scope, actor, { programId: program.id, branchId: orgB.branchIds[0]! }))
        .kind,
    ).toBe('invalidBranch');
    // A deactivated branch cannot newly qualify as an offering location.
    const dormant = newId();
    await sql`INSERT INTO branch (id, organization_id, label, area_label, active)
              VALUES (${dormant}, ${orgA.orgId}, 'Dormant', 'Area', false)`.execute(testDb.db);
    expect(
      (await addProgramBranch(deps, scope, actor, { programId: program.id, branchId: dormant })).kind,
    ).toBe('invalidBranch');

    // Removal deactivates the association but preserves the history row.
    const removed = await removeProgramBranch(deps, scope, actor, {
      programId: program.id,
      branchId: orgA.branchIds[0]!,
    });
    expect(removed.kind).toBe('branchAssociationRemoved');
    const rows = await sql<{ branch_id: string; active: boolean }>`
      SELECT branch_id, active FROM program_branch
      WHERE program_id = ${program.id} ORDER BY created_at`.execute(testDb.db);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find((row) => row.branch_id === orgA.branchIds[0])?.active).toBe(false);
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${program.id}
        AND event_type = 'listing.branch_association_changed'`.execute(testDb.db);
    expect(Number(events.rows[0]?.n)).toBe(3);
  });

  it('branch-scoped staff manage only programs and associations inside their assigned branches', async () => {
    const owner = scopeFor(orgA.orgId, 'owner');
    const scoped = scopeFor(orgA.orgId, 'branch_manager', { branchScope: [orgA.branchIds[0]!] });

    // A program anchored to an unassigned branch is outside their reach.
    const foreignBranchProgram = await draftProgram(owner, 'Other Branch Program');
    await addProgramBranch(deps, owner, actor, {
      programId: foreignBranchProgram.id,
      branchId: orgA.branchIds[1]!,
    });
    const editRefused = await updateProgram(deps, scoped, actor, {
      programId: foreignBranchProgram.id,
      expectedVersion: await currentVersion(foreignBranchProgram.id),
      patch: { titleEn: 'Hijacked' },
    });
    expect(editRefused.kind).toBe('forbidden');
    const associateRefused = await addProgramBranch(deps, scoped, actor, {
      programId: foreignBranchProgram.id,
      branchId: orgA.branchIds[0]!,
    });
    expect(associateRefused.kind).toBe('forbidden');

    // Inside their branch: create, associate their branch, edit — allowed;
    // associating an unassigned branch is refused.
    const own = await draftProgram(scoped, 'Branch Scoped Program');
    expect(
      (await addProgramBranch(deps, scoped, actor, { programId: own.id, branchId: orgA.branchIds[0]! }))
        .kind,
    ).toBe('branchAssociated');
    expect(
      (await addProgramBranch(deps, scoped, actor, { programId: own.id, branchId: orgA.branchIds[1]! }))
        .kind,
    ).toBe('forbidden');
    expect(
      (
        await updateProgram(deps, scoped, actor, {
          programId: own.id,
          expectedVersion: await currentVersion(own.id),
          patch: { titleEn: 'Branch Scoped Program v2' },
        })
      ).kind,
    ).toBe('programUpdated');
    // The scoped list shows only reachable programs.
    const listed = await listProviderPrograms(deps, scoped, {});
    const ids = listed.programs.map((program) => program.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreignBranchProgram.id);
  });
});

describe('media references and offers', () => {
  it('manages media metadata only, org-scoped, with deactivation retirement', async () => {
    const scope = scopeFor(orgA.orgId, 'listings_editor');
    const program = await draftProgram(scope, 'Media Program');
    const added = await addProgramMedia(deps, scope, actor, {
      programId: program.id,
      mediaRef: newId(),
      sortHint: 10,
      altTextEn: 'Mat area',
    });
    if (added.kind !== 'mediaAdded') throw new Error(added.kind);
    const updated = await updateProgramMedia(deps, scope, actor, {
      programId: program.id,
      mediaId: added.media.id,
      expectedVersion: 1,
      patch: { sortHint: 20, altTextEn: 'Main mat area' },
    });
    expect(updated.kind).toBe('mediaUpdated');
    const retired = await archiveProgramMedia(deps, scope, actor, {
      programId: program.id,
      mediaId: added.media.id,
      expectedVersion: 2,
    });
    expect(retired.kind).toBe('mediaArchived');
    const row = await sql<{ active: boolean }>`
      SELECT active FROM program_media WHERE id = ${added.media.id}`.execute(testDb.db);
    expect(row.rows[0]?.active).toBe(false);

    const scopeB = scopeFor(orgB.orgId, 'owner');
    const foreign = await addProgramMedia(deps, scopeB, actor, {
      programId: program.id,
      mediaRef: newId(),
    });
    expect(foreign.kind).toBe('programNotFound');
  });

  it('offers: paid-trial amount tie, effective-range validation, end lifecycle, isolation', async () => {
    const scope = scopeFor(orgA.orgId, 'owner');
    const program = await draftProgram(scope, 'Offer Program');
    const missingAmount = await addOffer(deps, scope, actor, {
      programId: program.id,
      offer: { kind: 'paidTrial', labelEn: 'Paid trial' },
    });
    expect(missingAmount.kind).toBe('invalidOffer');
    const badRange = await addOffer(deps, scope, actor, {
      programId: program.id,
      offer: {
        kind: 'promo',
        labelEn: 'Backwards window',
        effectiveStart: new Date('2026-09-01T00:00:00Z'),
        effectiveEnd: new Date('2026-08-01T00:00:00Z'),
      },
    });
    expect(badRange.kind).toBe('invalidOffer');
    const paid = await addOffer(deps, scope, actor, {
      programId: program.id,
      offer: { kind: 'paidTrial', labelEn: 'Trial for AED 50', trialAmountFils: 5000 },
    });
    if (paid.kind !== 'offerAdded') throw new Error(paid.kind);
    const relabelled = await updateOffer(deps, scope, actor, {
      programId: program.id,
      offerId: paid.offer.id,
      expectedVersion: 1,
      patch: { labelEn: 'Intro session — AED 50' },
    });
    expect(relabelled.kind).toBe('offerUpdated');
    const ended = await endOffer(deps, scope, actor, {
      programId: program.id,
      offerId: paid.offer.id,
      expectedVersion: 2,
    });
    expect(ended.kind).toBe('offerEnded');

    const scopeB = scopeFor(orgB.orgId, 'owner');
    const foreign = await endOffer(deps, scopeB, actor, {
      programId: program.id,
      offerId: paid.offer.id,
      expectedVersion: 3,
    });
    expect(foreign.kind).toBe('programNotFound');
    const events = await sql<{ event_type: string }>`
      SELECT event_type FROM outbox_event
      WHERE aggregate_id = ${program.id} AND event_type LIKE 'offer.%'
      ORDER BY sequence_no`.execute(testDb.db);
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'offer.created',
      'offer.updated',
      'offer.ended',
    ]);
  });
});
