/**
 * W2-12C2 mutation contract tests (task §27–§32, §35, §39): the LIVE
 * listing editor port — Program create/edit · branch associations · price
 * options · media metadata · offers · the automatic protected-edit
 * ProgramRevision routing — against the REAL backend (`buildApp` on real
 * PostgreSQL) through the REAL authenticated W2-12A transport (sign-in +
 * MFA over the deterministic fake Cognito boundary). Every mutation below
 * travels the real HTTP route with the real capability/scope/CAS
 * enforcement; lifecycle state walks use direct SQL only to place a
 * listing INTO a state (the mutations under test never do).
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import type { ProviderRole } from '../../backend/src/modules/provider/provider-roles';
import { createIdentity, createUser } from '../../backend/test/helpers/identity-fixtures';
import { addMembership, createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { ListingEditorPort } from '../src/catalogue/editor-contract';
import {
  createLiveCatalogueReadPorts,
  type LiveCatalogueReadPorts,
} from '../src/services/live/live-catalogue-ports';
import { createLiveListingEditorPort } from '../src/services/live/live-listing-editor-port';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from './support/backend-harness';

let harness: ContractHarness;
let activityTypeId: string;
let inactiveTypeId: string;

beforeAll(async () => {
  harness = await createContractHarness();
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(harness.testDb.db);
  activityTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityTypeId}, ${category.rows[0]!.id}, 'mutation-strength', 'Mutation Strength')`.execute(
    harness.testDb.db,
  );
  inactiveTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en, active)
            VALUES (${inactiveTypeId}, ${category.rows[0]!.id}, 'mutation-retired', 'Mutation Retired', false)`.execute(
    harness.testDb.db,
  );
});

afterAll(async () => {
  await harness.close();
});

let userCounter = 1500;

interface EditorSession {
  editor: ListingEditorPort;
  reads: LiveCatalogueReadPorts;
}

async function provisionUser(): Promise<{ userId: string; email: string; password: string }> {
  userCounter += 1;
  const email = `mutation-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `mutation-sub-${userCounter}`;
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
    displayName: `Mutation ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, email, password };
}

async function signedInEditor(user: { email: string; password: string }): Promise<EditorSession> {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  await runtime.adapter.signIn({ email: user.email, password: user.password });
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  if (signedIn.kind !== 'signedIn') throw new Error(`sign-in failed: ${signedIn.kind}`);
  return {
    editor: createLiveListingEditorPort(runtime.transport),
    reads: createLiveCatalogueReadPorts(runtime.transport),
  };
}

async function provisionOrgWithRole(
  role: ProviderRole,
  options: { branches?: number; scoped?: boolean } = {},
): Promise<{
  session: EditorSession;
  orgId: string;
  branchIds: string[];
  user: { userId: string; email: string; password: string };
}> {
  const user = await provisionUser();
  const org = await createProviderOrg(harness.testDb.db, {
    branches: options.branches ?? 2,
    displayName: `Mutation org ${userCounter}`,
  });
  await addMembership(
    harness.testDb.db,
    user.userId,
    org.orgId,
    role,
    options.scoped === true ? [org.branchIds[0] as string] : undefined,
  );
  const session = await signedInEditor(user);
  return { session, orgId: org.orgId, branchIds: org.branchIds, user };
}

async function createDraft(
  session: EditorSession,
  orgId: string,
  title: string,
): Promise<{ id: string; version: number }> {
  const outcome = await session.editor.createProgram(orgId, {
    titleEn: title,
    activityTypeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (outcome.kind !== 'programCreated') throw new Error(outcome.kind);
  return { id: outcome.program.id, version: outcome.program.version };
}

async function detailOf(session: EditorSession, orgId: string, programId: string) {
  const outcome = await session.reads.listingsPort.loadListing(orgId, programId);
  if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
  return outcome.program;
}

/** Walks a listing into a lifecycle state through legal SQL steps (the
 *  lifecycle ACTIONS are deliberately NOT integrated — W2-12C3). */
async function walkState(programId: string, target: string): Promise<void> {
  const paths: Record<string, string[]> = {
    submitted: ['submitted'],
    in_review: ['submitted', 'in_review'],
    changes_requested: ['submitted', 'in_review', 'changes_requested'],
    approved: ['submitted', 'in_review', 'approved'],
    published: ['submitted', 'in_review', 'approved', 'published'],
    archived: ['submitted', 'in_review', 'approved', 'published', 'archived'],
  };
  for (const step of paths[target] ?? [target]) {
    if (step === 'published') {
      await sql`UPDATE program SET listing_state = 'published', published_at = now()
                WHERE id = ${programId}`.execute(harness.testDb.db);
    } else if (step === 'archived') {
      await sql`UPDATE program SET listing_state = 'archived', archived_at = now()
                WHERE id = ${programId}`.execute(harness.testDb.db);
    } else {
      await sql`UPDATE program SET listing_state = ${step} WHERE id = ${programId}`.execute(
        harness.testDb.db,
      );
    }
  }
}

describe('program creation (§27)', () => {
  test.each(['owner', 'org_manager', 'listings_editor'] as const)(
    'an authorized %s creates a PRIVATE Draft with the canonical taxonomy id and backend id/version',
    async (role) => {
      const { session, orgId } = await provisionOrgWithRole(role);
      const outcome = await session.editor.createProgram(orgId, {
        titleEn: `Draft by ${role}`,
        titleAr: 'برنامج تجريبي',
        activityTypeId,
        setting: 'outdoor',
        genderEligibility: 'women',
        allAges: true,
      });
      if (outcome.kind !== 'programCreated') throw new Error(outcome.kind);
      // Creation never submits/approves/publishes.
      expect(outcome.program.listingState).toBe('draft');
      expect(outcome.program.version).toBe(1);
      const detail = await detailOf(session, orgId, outcome.program.id);
      expect(detail.activityType.id).toBe(activityTypeId);
      expect(detail.titleAr).toBe('برنامج تجريبي'); // Arabic optional, preserved
      expect(detail.genderEligibility).toBe('women');
      expect(detail.listingState).toBe('draft');
      expect(detail.publishedAt).toBeNull();
    },
  );

  test('English-only creation succeeds (Arabic never required); an inactive activity type is refused', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const englishOnly = await session.editor.createProgram(orgId, {
      titleEn: 'English Only Draft',
      activityTypeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    expect(englishOnly.kind).toBe('programCreated');

    await expect(
      session.editor.createProgram(orgId, {
        titleEn: 'Retired Type Draft',
        activityTypeId: inactiveTypeId,
        setting: 'indoor',
        genderEligibility: 'mixed',
      }),
    ).resolves.toEqual({ kind: 'invalidTaxonomy' });
  });

  test('roles without listings.manage cannot create; a foreign organization is not-found-shaped', async () => {
    for (const role of ['coach', 'front_desk', 'finance'] as const) {
      const { session, orgId } = await provisionOrgWithRole(role);
      await expect(
        session.editor.createProgram(orgId, {
          titleEn: `${role} attempt`,
          activityTypeId,
          setting: 'indoor',
          genderEligibility: 'mixed',
        }),
      ).resolves.toEqual({ kind: 'forbidden' });
    }
    const { session } = await provisionOrgWithRole('owner');
    const foreign = await createProviderOrg(harness.testDb.db);
    await expect(
      session.editor.createProgram(foreign.orgId, {
        titleEn: 'Foreign attempt',
        activityTypeId,
        setting: 'indoor',
        genderEligibility: 'mixed',
      }),
    ).resolves.toEqual({ kind: 'notFound' });
  });
});

describe('program edit — state matrix, CAS, protected-edit revision routing (§28, §32)', () => {
  test('draft and changes_requested edit DIRECTLY and persist; locked states refuse with lifecycleConflict', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const draft = await createDraft(session, orgId, 'Direct Edit Draft');
    const updated = await session.editor.updateProgram(orgId, draft.id, draft.version, {
      titleEn: 'Direct Edit Draft — renamed',
      descriptionEn: 'A direct description edit.',
    });
    expect(updated.kind).toBe('programUpdated');
    expect((await detailOf(session, orgId, draft.id)).titleEn).toBe(
      'Direct Edit Draft — renamed',
    );

    const cr = await createDraft(session, orgId, 'Changes Requested Row');
    await walkState(cr.id, 'changes_requested');
    const crVersion = (await detailOf(session, orgId, cr.id)).version;
    const crEdit = await session.editor.updateProgram(orgId, cr.id, crVersion, {
      descriptionEn: 'Corrected per review.',
    });
    expect(crEdit.kind).toBe('programUpdated');

    for (const locked of ['submitted', 'in_review', 'archived'] as const) {
      const row = await createDraft(session, orgId, `Locked ${locked}`);
      await walkState(row.id, locked);
      const version = (await detailOf(session, orgId, row.id)).version;
      await expect(
        session.editor.updateProgram(orgId, row.id, version, { titleEn: 'Nope' }),
      ).resolves.toEqual({ kind: 'lifecycleConflict' });
    }
  });

  test('published: a non-sensitive edit hot-applies; a PROTECTED edit rides ProgramRevision — live values untouched, competing edits blocked, and reads expose only openRevision state', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const row = await createDraft(session, orgId, 'Published Program');
    await walkState(row.id, 'published');
    let detail = await detailOf(session, orgId, row.id);

    // Non-sensitive (title) applies directly to the live listing.
    const direct = await session.editor.updateProgram(orgId, row.id, detail.version, {
      titleEn: 'Published Program — retitled',
    });
    expect(direct.kind).toBe('programUpdated');
    detail = await detailOf(session, orgId, row.id);
    expect(detail.titleEn).toBe('Published Program — retitled');
    expect(detail.openRevision).toBeNull();

    // Protected (description) auto-routes into an open ProgramRevision.
    const gated = await session.editor.updateProgram(orgId, row.id, detail.version, {
      descriptionEn: 'A protected description change.',
    });
    if (gated.kind !== 'revisionSubmitted') throw new Error(gated.kind);
    expect(gated.deferredFields).toContain('descriptionEn');
    detail = await detailOf(session, orgId, row.id);
    // The LIVE value is untouched until Himma approves…
    expect(detail.descriptionEn).toBeNull();
    // …and the read exposes exactly the open-revision status, nothing more
    // (no reviewer feedback, no diff — none exists on the contract).
    expect(detail.openRevision).toMatchObject({ id: gated.revisionId, state: 'submitted' });

    // A competing protected edit is refused while the revision is open —
    // never a second revision, never an overwrite.
    await expect(
      session.editor.updateProgram(orgId, row.id, detail.version, {
        descriptionEn: 'A competing protected change.',
      }),
    ).resolves.toEqual({ kind: 'revisionPending' });

    // A protected PRICE change is equally revision-blocked while open.
    await expect(
      session.editor.addPriceOption(orgId, row.id, { kind: 'monthly', amountFils: 10_000 }),
    ).resolves.toEqual({ kind: 'revisionPending' });
  });

  test('a stale expectedVersion is refused and nothing overwrites; a cross-org PATCH is not-found-shaped', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const row = await createDraft(session, orgId, 'CAS Program');
    const fresh = await session.editor.updateProgram(orgId, row.id, row.version, {
      titleEn: 'CAS Program v2',
    });
    expect(fresh.kind).toBe('programUpdated');
    await expect(
      session.editor.updateProgram(orgId, row.id, row.version, { titleEn: 'Stale write' }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    expect((await detailOf(session, orgId, row.id)).titleEn).toBe('CAS Program v2');

    const { session: stranger } = await provisionOrgWithRole('owner');
    await expect(
      stranger.editor.updateProgram(orgId, row.id, 2, { titleEn: 'Cross-org write' }),
    ).resolves.toEqual({ kind: 'notFound' });
  });

  test('Branch Manager mutation scope is STRICTER than read scope: readable via one in-scope branch is NOT editable while any association lies outside', async () => {
    const owner = await provisionOrgWithRole('owner');
    const managerUser = await provisionUser();
    await addMembership(harness.testDb.db, managerUser.userId, owner.orgId, 'branch_manager', [
      owner.branchIds[0] as string,
    ]);
    const manager = await signedInEditor(managerUser);

    const row = await createDraft(owner.session, owner.orgId, 'Split Branch Program');
    for (const branchId of owner.branchIds) {
      const associated = await owner.session.editor.addBranchAssociation(
        owner.orgId,
        row.id,
        branchId,
      );
      expect(associated.kind).toBe('branchAssociated');
    }
    // Readable (one association in scope)…
    const readable = await manager.reads.listingsPort.loadListing(owner.orgId, row.id);
    expect(readable.kind).toBe('loaded');
    // …but NOT editable (the every-association rule).
    await expect(
      manager.editor.updateProgram(owner.orgId, row.id, 3, { titleEn: 'BM overreach' }),
    ).resolves.toEqual({ kind: 'forbidden' });
    // And a manually supplied out-of-scope branch id cannot broaden reach.
    const fullyScoped = await createDraft(owner.session, owner.orgId, 'BM Own Draft');
    await expect(
      manager.editor.addBranchAssociation(owner.orgId, fullyScoped.id, owner.branchIds[1]!),
    ).resolves.toEqual({ kind: 'forbidden' });
  });
});

describe('branch associations (§29)', () => {
  test('associate/remove persist through the real routes and the index card follows; foreign and inactive branches are refused; no hidden data leaks', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner', { branches: 2 });
    const row = await createDraft(session, orgId, 'Association Program');

    const associated = await session.editor.addBranchAssociation(orgId, row.id, branchIds[0]!);
    expect(associated.kind).toBe('branchAssociated');
    let list = await session.reads.listingsPort.listListings(orgId, { q: 'association' });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs[0]!.branchSummary).toEqual({
      firstLabel: 'Branch 1',
      activeCount: 1,
    });

    const removed = await session.editor.removeBranchAssociation(orgId, row.id, branchIds[0]!);
    expect(removed.kind).toBe('branchAssociationRemoved');
    list = await session.reads.listingsPort.listListings(orgId, { q: 'association' });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs[0]!.branchSummary).toEqual({ firstLabel: null, activeCount: 0 });

    // A foreign organization's branch id is invalidBranch — and nothing
    // about the foreign branch (name, existence detail) comes back.
    const foreign = await createProviderOrg(harness.testDb.db);
    const refused = await session.editor.addBranchAssociation(
      orgId,
      row.id,
      foreign.branchIds[0]!,
    );
    expect(refused).toEqual({ kind: 'invalidBranch' });

    // A deactivated branch cannot newly qualify as a location.
    await sql`UPDATE branch SET active = false WHERE id = ${branchIds[1]}`.execute(
      harness.testDb.db,
    );
    await expect(
      session.editor.addBranchAssociation(orgId, row.id, branchIds[1]!),
    ).resolves.toEqual({ kind: 'invalidBranch' });
  });
});

describe('price options (§30)', () => {
  test('paid + free options live on ONE Program with exact integer fils; the index card follows every change; archive is terminal', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const row = await createDraft(session, orgId, 'Pricing Program');

    const paid = await session.editor.addPriceOption(orgId, row.id, {
      kind: 'monthly',
      amountFils: 25_000,
      labelEn: 'Monthly',
    });
    if (paid.kind !== 'optionAdded') throw new Error(paid.kind);
    expect(paid.option.amountFils).toBe(25_000);
    const free = await session.editor.addPriceOption(orgId, row.id, { kind: 'free' });
    if (free.kind !== 'optionAdded') throw new Error(free.kind);
    expect(free.option.amountFils).toBeNull();

    // ONE Program, one row — an active free option wins the card.
    let list = await session.reads.listingsPort.listListings(orgId, { q: 'pricing program' });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs).toHaveLength(1);
    expect(list.page.programs[0]!.priceSummary).toEqual({ kind: 'free' });

    // Update the paid amount (CAS) — exact fils, stable id.
    const updated = await session.editor.updatePriceOption(
      orgId,
      row.id,
      paid.option.id,
      paid.option.version,
      { amountFils: 27_550 },
    );
    if (updated.kind !== 'optionUpdated') throw new Error(updated.kind);
    expect(updated.option.id).toBe(paid.option.id);
    expect(updated.option.amountFils).toBe(27_550);

    // A stale version never overwrites.
    await expect(
      session.editor.updatePriceOption(orgId, row.id, paid.option.id, paid.option.version, {
        amountFils: 1,
      }),
    ).resolves.toEqual({ kind: 'staleVersion' });

    // Archive the free option → the card falls back to the lowest paid.
    const archived = await session.editor.archivePriceOption(
      orgId,
      row.id,
      free.option.id,
      free.option.version,
    );
    expect(archived.kind).toBe('optionArchived');
    list = await session.reads.listingsPort.listListings(orgId, { q: 'pricing program' });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs[0]!.priceSummary).toEqual({ kind: 'from', amountFils: 27_550 });

    // Archived is terminal history — an update is a lifecycle conflict.
    const archivedVersion = (await detailOf(session, orgId, row.id)).priceOptions.find(
      (option) => option.id === free.option.id,
    )!.version;
    await expect(
      session.editor.updatePriceOption(orgId, row.id, free.option.id, archivedVersion, {
        amountFils: 5_000,
      }),
    ).resolves.toEqual({ kind: 'lifecycleConflict' });
  });

  test('an unauthorized role cannot touch pricing; a protected-live price change rides the revision model', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const row = await createDraft(session, orgId, 'Priced Live Program');
    await walkState(row.id, 'published');

    const financeUser = await provisionUser();
    await addMembership(harness.testDb.db, financeUser.userId, orgId, 'finance');
    const finance = await signedInEditor(financeUser);
    await expect(
      finance.editor.addPriceOption(orgId, row.id, { kind: 'monthly', amountFils: 1_000 }),
    ).resolves.toEqual({ kind: 'forbidden' });

    const gated = await session.editor.addPriceOption(orgId, row.id, {
      kind: 'monthly',
      amountFils: 40_000,
    });
    if (gated.kind !== 'revisionSubmitted') throw new Error(gated.kind);
    // Live truth unchanged: the published listing still has NO options.
    const detail = await detailOf(session, orgId, row.id);
    expect(detail.priceOptions).toHaveLength(0);
    expect(detail.openRevision).toMatchObject({ id: gated.revisionId });
  });
});

describe('offers (§31)', () => {
  test('canonical kinds create/update/end through the real routes; invalid windows are refused; the detail refetch is canonical truth', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const row = await createDraft(session, orgId, 'Offer Program');

    const trial = await session.editor.addOffer(orgId, row.id, {
      kind: 'freeTrial',
      labelEn: 'First session free',
    });
    if (trial.kind !== 'offerAdded') throw new Error(trial.kind);
    const promo = await session.editor.addOffer(orgId, row.id, {
      kind: 'promo',
      labelEn: 'Summer promotion',
      effectiveStart: '2026-09-01T08:00:00.000Z',
      effectiveEnd: '2026-09-30T08:00:00.000Z',
    });
    if (promo.kind !== 'offerAdded') throw new Error(promo.kind);

    // An inverted window is invalidOffer; a paid trial without a positive
    // trial amount violates the S4-1 tie the same way.
    await expect(
      session.editor.addOffer(orgId, row.id, {
        kind: 'promo',
        labelEn: 'Backwards window',
        effectiveStart: '2026-09-30T08:00:00.000Z',
        effectiveEnd: '2026-09-01T08:00:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'invalidOffer' });
    await expect(
      session.editor.addOffer(orgId, row.id, { kind: 'paidTrial', labelEn: 'No amount' }),
    ).resolves.toEqual({ kind: 'invalidOffer' });

    const relabelled = await session.editor.updateOffer(
      orgId,
      row.id,
      trial.offer.id,
      trial.offer.version,
      { labelEn: 'Try your first session free' },
    );
    expect(relabelled.kind).toBe('offerUpdated');
    const ended = await session.editor.endOffer(
      orgId,
      row.id,
      promo.offer.id,
      promo.offer.version,
    );
    expect(ended.kind).toBe('offerEnded');

    const detail = await detailOf(session, orgId, row.id);
    const offers = new Map(detail.offers.map((offer) => [offer.id, offer]));
    expect(offers.get(trial.offer.id)).toMatchObject({
      labelEn: 'Try your first session free',
      state: 'active',
    });
    expect(offers.get(promo.offer.id)?.state).toBe('ended');
  });
});

describe('central provider-authoring journey (§34/§35)', () => {
  test('authenticate → create Draft → edit → associate branch → two price options → offer → media metadata → fresh-context reload sees canonical persisted truth and the index card follows', async () => {
    const { session, orgId, branchIds, user } = await provisionOrgWithRole('owner');

    // Create the draft.
    const created = await session.editor.createProgram(orgId, {
      titleEn: 'Journey Climbing Club',
      activityTypeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    const programId = created.program.id;

    // Edit details (direct, draft state).
    const edited = await session.editor.updateProgram(orgId, programId, created.program.version, {
      descriptionEn: 'Indoor climbing for adults.',
      minAge: 16,
      allAges: false,
      skillLevel: 'beginner',
    });
    expect(edited.kind).toBe('programUpdated');

    // Associate a location.
    expect(
      (await session.editor.addBranchAssociation(orgId, programId, branchIds[0]!)).kind,
    ).toBe('branchAssociated');

    // Two price options — one Program throughout.
    const monthly = await session.editor.addPriceOption(orgId, programId, {
      kind: 'monthly',
      amountFils: 35_000,
      labelEn: 'Monthly pass',
    });
    expect(monthly.kind).toBe('optionAdded');
    const dropIn = await session.editor.addPriceOption(orgId, programId, {
      kind: 'dropIn',
      amountFils: 7_500,
      labelEn: 'Drop-in',
    });
    expect(dropIn.kind).toBe('optionAdded');

    // A supported Offer.
    const offer = await session.editor.addOffer(orgId, programId, {
      kind: 'freeTrial',
      labelEn: 'First climb free',
    });
    expect(offer.kind).toBe('offerAdded');

    // Supported media METADATA (references only — binaries do not exist).
    const media = await session.editor.addMedia(orgId, programId, {
      mediaRef: newId(),
      altTextEn: 'Climbing wall',
    });
    if (media.kind !== 'mediaAdded') throw new Error(media.kind);
    const captioned = await session.editor.updateMedia(
      orgId,
      programId,
      media.media.id,
      media.media.version,
      { altTextEn: 'Main climbing wall' },
    );
    expect(captioned.kind).toBe('mediaUpdated');

    // "Reload the browser": a completely FRESH sign-in context (new
    // runtime, new transport) reads the same canonical PostgreSQL truth.
    const reloaded = await signedInEditor(user);
    const detail = await detailOf(reloaded, orgId, programId);
    expect(detail).toMatchObject({
      titleEn: 'Journey Climbing Club',
      descriptionEn: 'Indoor climbing for adults.',
      minAge: 16,
      skillLevel: 'beginner',
      listingState: 'draft', // authored, still NOT submitted/published
      publishedAt: null,
    });
    expect(detail.branches).toEqual([
      expect.objectContaining({ label: 'Branch 1', associationActive: true }),
    ]);
    expect(
      detail.priceOptions.map((option) => option.amountFils).sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([7_500, 35_000]);
    expect(detail.offers).toEqual([
      expect.objectContaining({ kind: 'freeTrial', labelEn: 'First climb free' }),
    ]);
    expect(detail.media).toEqual([
      expect.objectContaining({ altTextEn: 'Main climbing wall', active: true }),
    ]);

    // The Listings index card reflects the authored truth.
    const list = await reloaded.reads.listingsPort.listListings(orgId, { q: 'journey climbing' });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs).toHaveLength(1);
    expect(list.page.programs[0]).toMatchObject({
      id: programId,
      listingState: 'draft',
      priceSummary: { kind: 'from', amountFils: 7_500 },
      branchSummary: { firstLabel: 'Branch 1', activeCount: 1 },
    });
  });
});
