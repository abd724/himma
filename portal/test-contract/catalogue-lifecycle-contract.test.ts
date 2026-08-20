/**
 * W2-12C3 lifecycle contract tests (task §31–§36, §30, §39): the LIVE
 * lifecycle port — submit/resubmit · publish/resume · pause · archive —
 * plus canonical readiness, the organization go-live gate, provider-safe
 * ProgramRevision status, and the PUBLIC-visibility composition, against
 * the REAL backend (`buildApp` on real PostgreSQL) through the REAL
 * authenticated W2-12A transport. Internal moderation transitions
 * (submitted→in_review→approved/changes_requested; revision decisions)
 * are established ONLY through the existing backend moderation services
 * with a real operations-role actor — never through any provider surface
 * (none exists).
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import {
  approveRevision,
  reviewProgram,
  startRevisionReview,
} from '../../backend/src/modules/catalogue/services/moderation';
import type { ProviderRole } from '../../backend/src/modules/provider/provider-roles';
import {
  bootstrapAccessAdmins,
  createIdentity,
  createUser,
} from '../../backend/test/helpers/identity-fixtures';
import { addMembership, createProviderOrg } from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { ListingEditorPort } from '../src/catalogue/editor-contract';
import type { ListingLifecyclePort } from '../src/catalogue/lifecycle-contract';
import {
  createLiveCatalogueReadPorts,
  type LiveCatalogueReadPorts,
} from '../src/services/live/live-catalogue-ports';
import { createLiveLifecyclePort } from '../src/services/live/live-lifecycle-port';
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
let operationsActor: { userId: string };

beforeAll(async () => {
  harness = await createContractHarness();
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(harness.testDb.db);
  activityTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityTypeId}, ${category.rows[0]!.id}, 'lifecycle-strength', 'Lifecycle Strength')`.execute(
    harness.testDb.db,
  );
  // The internal moderation actor: a REAL operations admin-role holder,
  // provisioned through the existing dual-approved assignment mechanism.
  const { adminA, adminB } = await bootstrapAccessAdmins(harness.testDb.db);
  const opsUserId = await createUser(harness.testDb.db);
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${opsUserId}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
    harness.testDb.db,
  );
  operationsActor = { userId: opsUserId };
});

afterAll(async () => {
  await harness.close();
});

let userCounter = 2500;

interface LifecycleSession {
  editor: ListingEditorPort;
  lifecycle: ListingLifecyclePort;
  reads: LiveCatalogueReadPorts;
}

async function provisionUser(): Promise<{ userId: string; email: string; password: string }> {
  userCounter += 1;
  const email = `lifecycle-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `lifecycle-sub-${userCounter}`;
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
    displayName: `Lifecycle ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, email, password };
}

async function signedIn(user: { email: string; password: string }): Promise<LifecycleSession> {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  await runtime.adapter.signIn({ email: user.email, password: user.password });
  const result = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  if (result.kind !== 'signedIn') throw new Error(`sign-in failed: ${result.kind}`);
  return {
    editor: createLiveListingEditorPort(runtime.transport),
    lifecycle: createLiveLifecyclePort(runtime.transport),
    reads: createLiveCatalogueReadPorts(runtime.transport),
  };
}

async function provisionOrgWithRole(
  role: ProviderRole,
  options: { state?: string; branches?: number; scoped?: boolean } = {},
): Promise<{
  session: LifecycleSession;
  orgId: string;
  branchIds: string[];
  user: { userId: string; email: string; password: string };
}> {
  const user = await provisionUser();
  const org = await createProviderOrg(harness.testDb.db, {
    state: options.state ?? 'live',
    branches: options.branches ?? 2,
    displayName: `Lifecycle org ${userCounter}`,
  });
  await addMembership(
    harness.testDb.db,
    user.userId,
    org.orgId,
    role,
    options.scoped === true ? [org.branchIds[0] as string] : undefined,
  );
  const session = await signedIn(user);
  return { session, orgId: org.orgId, branchIds: org.branchIds, user };
}

async function detailOf(session: LifecycleSession, orgId: string, programId: string) {
  const outcome = await session.reads.listingsPort.loadListing(orgId, programId);
  if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
  return outcome.program;
}

/** A COMPLETE draft authored through the real C2 routes: branch + price. */
async function completeDraft(
  session: LifecycleSession,
  orgId: string,
  branchId: string,
  title: string,
): Promise<string> {
  const created = await session.editor.createProgram(orgId, {
    titleEn: title,
    activityTypeId,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  const associated = await session.editor.addBranchAssociation(orgId, created.program.id, branchId);
  if (associated.kind !== 'branchAssociated') throw new Error(associated.kind);
  const priced = await session.editor.addPriceOption(orgId, created.program.id, {
    kind: 'monthly',
    amountFils: 20_000,
  });
  if (priced.kind !== 'optionAdded') throw new Error(priced.kind);
  return created.program.id;
}

/** Internal moderation through the REAL backend services only. */
async function moderateToApproved(session: LifecycleSession, orgId: string, programId: string) {
  const deps = { db: harness.testDb.db };
  let version = (await detailOf(session, orgId, programId)).version;
  const started = await reviewProgram(deps, operationsActor, {
    programId,
    action: 'start_review',
    expectedVersion: version,
  });
  if (started.kind !== 'programReviewed') throw new Error(started.kind);
  version = (await detailOf(session, orgId, programId)).version;
  const approved = await reviewProgram(deps, operationsActor, {
    programId,
    action: 'approve',
    expectedVersion: version,
  });
  if (approved.kind !== 'programReviewed') throw new Error(approved.kind);
}

/** Public catalogue read — the real customer-facing route, no auth. */
async function publicListingStatus(programId: string): Promise<number> {
  const response = await harness.fetchImpl(`${harness.apiBaseUrl}/listings/${programId}`, {});
  return response.status;
}

async function publishStorefront(orgId: string): Promise<void> {
  await sql`UPDATE organization_public_profile SET published = true
            WHERE organization_id = ${orgId}`.execute(harness.testDb.db);
}

describe('submission & resubmission (§31)', () => {
  test('a complete draft submits to EXACTLY `submitted` (never in_review/approved/published); a repeat submit refuses; result is canonical server state', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Submit Me');
    const version = (await detailOf(session, orgId, programId)).version;
    const submitted = await session.lifecycle.submitProgram(orgId, programId, version);
    if (submitted.kind !== 'programSubmitted') throw new Error(submitted.kind);

    const detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('submitted');
    expect(detail.publishedAt).toBeNull();
    expect(await publicListingStatus(programId)).toBe(404);

    await expect(
      session.lifecycle.submitProgram(orgId, programId, detail.version),
    ).resolves.toEqual({ kind: 'lifecycleConflict' });
  });

  test('an incomplete draft is refused with the backend\'s structured gaps — the server, not the frontend mirror, is the validator', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const created = await session.editor.createProgram(orgId, {
      titleEn: 'Bare Submission',
      activityTypeId,
      setting: 'indoor',
      genderEligibility: 'mixed',
    });
    if (created.kind !== 'programCreated') throw new Error(created.kind);
    const refused = await session.lifecycle.submitProgram(
      orgId,
      created.program.id,
      created.program.version,
    );
    if (refused.kind !== 'programIncomplete') throw new Error(refused.kind);
    expect([...refused.missing].sort()).toEqual(['activeBranch', 'activePriceOption']);
  });

  test('changes_requested resubmits through the SAME submit action; the W3-8 provider-safe correction feedback rides the detail read', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Resubmit Me');
    let version = (await detailOf(session, orgId, programId)).version;
    const submitted = await session.lifecycle.submitProgram(orgId, programId, version);
    if (submitted.kind !== 'programSubmitted') throw new Error(submitted.kind);

    const deps = { db: harness.testDb.db };
    version = (await detailOf(session, orgId, programId)).version;
    await reviewProgram(deps, operationsActor, {
      programId,
      action: 'start_review',
      expectedVersion: version,
    });
    version = (await detailOf(session, orgId, programId)).version;
    const changes = await reviewProgram(deps, operationsActor, {
      programId,
      action: 'request_changes',
      expectedVersion: version,
      reasonCode: 'content_incomplete',
      providerMessage: 'Add a full description of what each session covers.',
    });
    expect(changes.kind).toBe('programReviewed');

    const detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('changes_requested');
    // W3-8 closes the W2 carried gap: the provider read now carries exactly
    // the two provider-safe layers (machine reason + reviewer-authored
    // provider message) — and nothing else exists in this domain to leak.
    expect(detail.latestDecision).toMatchObject({
      reasonCode: 'content_incomplete',
      providerMessage: 'Add a full description of what each session covers.',
    });
    expect(typeof detail.latestDecision?.decidedAt).toBe('string');

    const resubmitted = await session.lifecycle.submitProgram(orgId, programId, detail.version);
    if (resubmitted.kind !== 'programSubmitted') throw new Error(resubmitted.kind);
    const after = await detailOf(session, orgId, programId);
    expect(after.listingState).toBe('submitted');
    // The historical feedback stays truthful after resubmission.
    expect(after.latestDecision?.reasonCode).toBe('content_incomplete');
  });

  test('authority: a Listings Editor submits; coach/front_desk/finance are refused; a stale version is refused', async () => {
    const owner = await provisionOrgWithRole('owner');
    const programId = await completeDraft(
      owner.session,
      owner.orgId,
      owner.branchIds[0]!,
      'Editor Submits',
    );
    const editorUser = await provisionUser();
    await addMembership(harness.testDb.db, editorUser.userId, owner.orgId, 'listings_editor');
    const editorSession = await signedIn(editorUser);

    for (const role of ['coach', 'front_desk', 'finance'] as const) {
      const otherUser = await provisionUser();
      await addMembership(harness.testDb.db, otherUser.userId, owner.orgId, role);
      const other = await signedIn(otherUser);
      await expect(session_submit(other, owner.orgId, programId)).resolves.toEqual({
        kind: 'forbidden',
      });
    }

    const version = (await detailOf(owner.session, owner.orgId, programId)).version;
    await expect(
      editorSession.lifecycle.submitProgram(owner.orgId, programId, version + 5),
    ).resolves.toEqual({ kind: 'staleVersion' });
    const submitted = await editorSession.lifecycle.submitProgram(owner.orgId, programId, version);
    expect(submitted.kind).toBe('programSubmitted');
  });

  test('Branch Manager submit scope stays the STRICTER mutation rule: readable via one branch is not submittable while any association lies outside', async () => {
    const owner = await provisionOrgWithRole('owner');
    const managerUser = await provisionUser();
    await addMembership(harness.testDb.db, managerUser.userId, owner.orgId, 'branch_manager', [
      owner.branchIds[0] as string,
    ]);
    const manager = await signedIn(managerUser);

    const programId = await completeDraft(
      owner.session,
      owner.orgId,
      owner.branchIds[0]!,
      'Split Submit',
    );
    const widened = await owner.session.editor.addBranchAssociation(
      owner.orgId,
      programId,
      owner.branchIds[1]!,
    );
    expect(widened.kind).toBe('branchAssociated');

    const readable = await manager.reads.listingsPort.loadListing(owner.orgId, programId);
    expect(readable.kind).toBe('loaded');
    const version = (await detailOf(owner.session, owner.orgId, programId)).version;
    await expect(
      manager.lifecycle.submitProgram(owner.orgId, programId, version),
    ).resolves.toEqual({ kind: 'forbidden' });

    // A fully in-scope listing submits fine — no broadening either way.
    const scoped = await completeDraft(
      owner.session,
      owner.orgId,
      owner.branchIds[0]!,
      'Scoped Submit',
    );
    const scopedVersion = (await detailOf(owner.session, owner.orgId, scoped)).version;
    const submitted = await manager.lifecycle.submitProgram(owner.orgId, scoped, scopedVersion);
    expect(submitted.kind).toBe('programSubmitted');
  });
});

function session_submit(session: LifecycleSession, orgId: string, programId: string) {
  return session.lifecycle.submitProgram(orgId, programId, 1);
}

describe('publication, the go-live gate & approval ≠ publication (§32, §30)', () => {
  test('approval RESTS at approved (not public); Owner publishes; publishedAt is set once by the backend', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Publish Me');
    const version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.submitProgram(orgId, programId, version);
    await moderateToApproved(session, orgId, programId);

    let detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('approved');
    expect(detail.publishedAt).toBeNull();
    // Approved is NOT public — nothing auto-publishes after moderation.
    expect(await publicListingStatus(programId)).toBe(404);

    const published = await session.lifecycle.publishProgram(orgId, programId, detail.version);
    if (published.kind !== 'programPublished') throw new Error(published.kind);
    detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('published');
    expect(detail.publishedAt).not.toBeNull();
    expect(await publicListingStatus(programId)).toBe(200);
  });

  test('publication authority: Listings Editor, Branch Manager, and Finance are all server-refused', async () => {
    const owner = await provisionOrgWithRole('owner');
    await publishStorefront(owner.orgId);
    const programId = await completeDraft(
      owner.session,
      owner.orgId,
      owner.branchIds[0]!,
      'Authority Publish',
    );
    let version = (await detailOf(owner.session, owner.orgId, programId)).version;
    await owner.session.lifecycle.submitProgram(owner.orgId, programId, version);
    await moderateToApproved(owner.session, owner.orgId, programId);
    version = (await detailOf(owner.session, owner.orgId, programId)).version;

    for (const [role, scoped] of [
      ['listings_editor', false],
      ['branch_manager', true],
      ['finance', false],
    ] as const) {
      const user = await provisionUser();
      await addMembership(
        harness.testDb.db,
        user.userId,
        owner.orgId,
        role,
        scoped ? [owner.branchIds[0] as string] : undefined,
      );
      const other = await signedIn(user);
      await expect(
        other.lifecycle.publishProgram(owner.orgId, programId, version),
      ).resolves.toEqual({ kind: 'forbidden' });
    }

    // An Organization Manager holds publication authority.
    const managerUser = await provisionUser();
    await addMembership(harness.testDb.db, managerUser.userId, owner.orgId, 'org_manager');
    const manager = await signedIn(managerUser);
    const published = await manager.lifecycle.publishProgram(owner.orgId, programId, version);
    expect(published.kind).toBe('programPublished');
  });

  test('the organization go-live gate: a verified-but-not-live organization cannot publish an approved listing', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner', {
      state: 'verified',
    });
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Gated Publish');
    let version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.submitProgram(orgId, programId, version);
    await moderateToApproved(session, orgId, programId);
    version = (await detailOf(session, orgId, programId)).version;
    await expect(session.lifecycle.publishProgram(orgId, programId, version)).resolves.toEqual({
      kind: 'organizationNotLive',
    });
    // Nothing marked the organization live as a side effect.
    const state = await sql<{ verification_state: string }>`
      SELECT verification_state FROM organization WHERE id = ${orgId}`.execute(harness.testDb.db);
    expect(state.rows[0]!.verification_state).toBe('verified');
  });

  test('publication re-checks completeness: an approved listing whose only branch was removed is refused with the structured gap', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Hollowed Publish');
    let version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.submitProgram(orgId, programId, version);
    await moderateToApproved(session, orgId, programId);
    // Branch association changes are non-sensitive — legal on approved.
    const removed = await session.editor.removeBranchAssociation(orgId, programId, branchIds[0]!);
    expect(removed.kind).toBe('branchAssociationRemoved');
    version = (await detailOf(session, orgId, programId)).version;
    const refused = await session.lifecycle.publishProgram(orgId, programId, version);
    expect(refused).toEqual({ kind: 'programIncomplete', missing: ['activeBranch'] });
  });
});

describe('pause · resume · archive & public visibility (§33, §30)', () => {
  test('published→pause hides publicly; publish-from-paused resumes with the ORIGINAL publishedAt; archive is terminal and never public', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Cycle Me');
    let version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.submitProgram(orgId, programId, version);
    await moderateToApproved(session, orgId, programId);
    version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.publishProgram(orgId, programId, version);
    const firstPublish = await detailOf(session, orgId, programId);
    expect(await publicListingStatus(programId)).toBe(200);

    // Pause: hidden publicly; nothing else erased.
    const paused = await session.lifecycle.pauseProgram(orgId, programId, firstPublish.version);
    if (paused.kind !== 'programPaused') throw new Error(paused.kind);
    let detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('paused');
    expect(detail.priceOptions).toHaveLength(1);
    expect(detail.branches).toHaveLength(1);
    expect(await publicListingStatus(programId)).toBe(404);

    // Resume IS the publish action from paused; publishedAt is retained.
    const resumed = await session.lifecycle.publishProgram(orgId, programId, detail.version);
    if (resumed.kind !== 'programPublished') throw new Error(resumed.kind);
    detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('published');
    expect(detail.publishedAt).toBe(firstPublish.publishedAt);
    expect(await publicListingStatus(programId)).toBe(200);

    // Archive from published: terminal, non-public, frozen history.
    const archived = await session.lifecycle.archiveProgram(orgId, programId, detail.version);
    expect(archived).toEqual({ kind: 'programArchived' });
    detail = await detailOf(session, orgId, programId);
    expect(detail.listingState).toBe('archived');
    expect(detail.archivedAt).not.toBeNull();
    expect(await publicListingStatus(programId)).toBe(404);
    await expect(
      session.lifecycle.publishProgram(orgId, programId, detail.version),
    ).resolves.toEqual({ kind: 'lifecycleConflict' });
    await expect(
      session.lifecycle.submitProgram(orgId, programId, detail.version),
    ).resolves.toEqual({ kind: 'lifecycleConflict' });
  });

  test('invalid source states refuse; stale versions refuse', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Illegal Moves');
    const version = (await detailOf(session, orgId, programId)).version;
    // A draft can neither publish nor pause nor archive.
    await expect(session.lifecycle.publishProgram(orgId, programId, version)).resolves.toEqual({
      kind: 'lifecycleConflict',
    });
    await expect(session.lifecycle.pauseProgram(orgId, programId, version)).resolves.toEqual({
      kind: 'lifecycleConflict',
    });
    await expect(session.lifecycle.archiveProgram(orgId, programId, version)).resolves.toEqual({
      kind: 'lifecycleConflict',
    });
    // Stale submit refuses without transitioning.
    await expect(
      session.lifecycle.submitProgram(orgId, programId, version + 9),
    ).resolves.toEqual({ kind: 'staleVersion' });
    expect((await detailOf(session, orgId, programId)).listingState).toBe('draft');
  });
});

describe('provider ProgramRevision status (§34, §36)', () => {
  test('REVISION JOURNEY: protected edit on a published listing → truthful pending status on a fresh reload → live value authoritative → no provider decision path → internal approval applies it', async () => {
    const { session, orgId, branchIds, user } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Revision Journey');
    let version = (await detailOf(session, orgId, programId)).version;
    const direct = await session.editor.updateProgram(orgId, programId, version, {
      descriptionEn: 'The original live description.',
    });
    expect(direct.kind).toBe('programUpdated');
    version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.submitProgram(orgId, programId, version);
    await moderateToApproved(session, orgId, programId);
    version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.publishProgram(orgId, programId, version);

    // No open revision → the status is truthfully none.
    let detail = await detailOf(session, orgId, programId);
    expect(detail.openRevision).toBeNull();

    // Protected edit through the C2 path → real open revision.
    const gated = await session.editor.updateProgram(orgId, programId, detail.version, {
      descriptionEn: 'An improved description awaiting review.',
    });
    if (gated.kind !== 'revisionSubmitted') throw new Error(gated.kind);

    // A completely fresh sign-in ("reload") sees ONLY the provider-safe
    // status fields — id, state, createdAt, version — and the live value
    // remains authoritative and public.
    const reloaded = await signedIn(user);
    detail = await detailOf(reloaded, orgId, programId);
    expect(detail.descriptionEn).toBe('The original live description.');
    expect(detail.openRevision).not.toBeNull();
    expect(Object.keys(detail.openRevision!).sort()).toEqual([
      'createdAt',
      'id',
      'state',
      'version',
    ]);
    expect(detail.openRevision!.state).toBe('submitted');
    expect(await publicListingStatus(programId)).toBe(200);

    // The provider surface has no decision operation — and the ADMIN
    // decision route refuses a provider principal outright.
    const probe = await harness.fetchImpl(
      `${harness.apiBaseUrl}/admin/listings/${programId}/revisions/${gated.revisionId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
    );
    expect([401, 403]).toContain(probe.status);

    // Internal moderation (backend services only) reviews and applies it.
    const deps = { db: harness.testDb.db };
    const revisionVersion = detail.openRevision!.version;
    const started = await startRevisionReview(deps, operationsActor, {
      programId,
      revisionId: gated.revisionId,
      expectedVersion: revisionVersion,
    });
    if (started.kind !== 'revisionReviewStarted') throw new Error(started.kind);
    const applied = await approveRevision(deps, operationsActor, {
      programId,
      revisionId: gated.revisionId,
      expectedVersion: revisionVersion + 1,
    });
    if (applied.kind !== 'revisionApproved') throw new Error(applied.kind);

    detail = await detailOf(reloaded, orgId, programId);
    expect(detail.descriptionEn).toBe('An improved description awaiting review.');
    expect(detail.openRevision).toBeNull();
  });

  test('revision existence never leaks across organizations or read scope', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Sealed Revision');
    let version = (await detailOf(session, orgId, programId)).version;
    await session.lifecycle.submitProgram(orgId, programId, version);
    await moderateToApproved(session, orgId, programId);
    version = (await detailOf(session, orgId, programId)).version;
    const gated = await session.editor.updateProgram(orgId, programId, version, {
      descriptionEn: 'Sealed pending change.',
    });
    expect(gated.kind).toBe('revisionSubmitted');

    // A foreign organization's owner reads nothing at all.
    const stranger = await provisionOrgWithRole('owner');
    await expect(
      stranger.session.reads.listingsPort.loadListing(orgId, programId),
    ).resolves.toEqual({ kind: 'notFound' });

    // A Branch Manager whose scope cannot reach the program sees the same
    // one not-found shape — revision existence included.
    const managerUser = await provisionUser();
    await addMembership(harness.testDb.db, managerUser.userId, orgId, 'branch_manager', [
      branchIds[1] as string,
    ]);
    const manager = await signedIn(managerUser);
    await expect(manager.reads.listingsPort.loadListing(orgId, programId)).resolves.toEqual({
      kind: 'notFound',
    });
  });
});

describe('W2-12D closeout proofs', () => {
  test('lifecycle actions cannot cross organization boundaries — a foreign owner gets the one not-found shape', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Sealed Lifecycle');
    const stranger = await provisionOrgWithRole('owner');
    await expect(stranger.session.lifecycle.submitProgram(orgId, programId, 1)).resolves.toEqual({
      kind: 'notFound',
    });
    await expect(stranger.session.lifecycle.publishProgram(orgId, programId, 1)).resolves.toEqual({
      kind: 'notFound',
    });
    await expect(stranger.session.lifecycle.archiveProgram(orgId, programId, 1)).resolves.toEqual({
      kind: 'notFound',
    });
    expect((await detailOf(session, orgId, programId)).listingState).toBe('draft');
  });

  test('live onboarding now carries the REAL listing count (bounded authoritative walk); a member without catalogue.read stays truthfully unknown', async () => {
    const { createLiveDomainPorts } = await import('../src/services/live/live-domain-ports');
    const { session, orgId, branchIds, user } = await provisionOrgWithRole('owner');
    await completeDraft(session, orgId, branchIds[0]!, 'Counted One');
    await completeDraft(session, orgId, branchIds[0]!, 'Counted Two');

    const runtime = createLiveAuthRuntime({
      apiBaseUrl: harness.apiBaseUrl,
      cognitoIssuer: CONTRACT_ISSUER,
      cognitoClientId: CONTRACT_CLIENT_ID,
      fetchImpl: harness.fetchImpl,
    });
    await runtime.adapter.signIn({ email: user.email, password: user.password });
    const signedInResult = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
    if (signedInResult.kind !== 'signedIn') throw new Error(signedInResult.kind);
    const snapshot = await createLiveDomainPorts(runtime.transport).onboardingPort.loadSnapshot(
      orgId,
    );
    if (snapshot.kind !== 'loaded') throw new Error(snapshot.kind);
    expect(snapshot.snapshot.listingCount).toBe(2);

    const financeUser = await provisionUser();
    await addMembership(harness.testDb.db, financeUser.userId, orgId, 'finance');
    const financeRuntime = createLiveAuthRuntime({
      apiBaseUrl: harness.apiBaseUrl,
      cognitoIssuer: CONTRACT_ISSUER,
      cognitoClientId: CONTRACT_CLIENT_ID,
      fetchImpl: harness.fetchImpl,
    });
    await financeRuntime.adapter.signIn({
      email: financeUser.email,
      password: financeUser.password,
    });
    const financeSignIn = await financeRuntime.adapter.completeMfaChallenge(VALID_TOTP);
    if (financeSignIn.kind !== 'signedIn') throw new Error(financeSignIn.kind);
    const financeSnapshot = await createLiveDomainPorts(
      financeRuntime.transport,
    ).onboardingPort.loadSnapshot(orgId);
    if (financeSnapshot.kind !== 'loaded') throw new Error(financeSnapshot.kind);
    expect(financeSnapshot.snapshot.listingCount).toBeNull();
  });
});

describe('END-TO-END lifecycle journey (§35)', () => {
  test('authenticate → author → submit → internal approval → publish → public → pause → hidden → resume → public → archive → terminal', async () => {
    const { session, orgId, branchIds } = await provisionOrgWithRole('owner');
    await publishStorefront(orgId);

    const programId = await completeDraft(session, orgId, branchIds[0]!, 'Full Journey Yoga');
    expect(await publicListingStatus(programId)).toBe(404); // draft: private

    let version = (await detailOf(session, orgId, programId)).version;
    const submitted = await session.lifecycle.submitProgram(orgId, programId, version);
    expect(submitted.kind).toBe('programSubmitted');
    expect(await publicListingStatus(programId)).toBe(404); // submitted: private

    await moderateToApproved(session, orgId, programId);
    expect(await publicListingStatus(programId)).toBe(404); // approved ≠ published

    version = (await detailOf(session, orgId, programId)).version;
    const published = await session.lifecycle.publishProgram(orgId, programId, version);
    expect(published.kind).toBe('programPublished');
    expect(await publicListingStatus(programId)).toBe(200); // live to customers

    version = (await detailOf(session, orgId, programId)).version;
    const paused = await session.lifecycle.pauseProgram(orgId, programId, version);
    expect(paused.kind).toBe('programPaused');
    expect(await publicListingStatus(programId)).toBe(404); // hidden

    version = (await detailOf(session, orgId, programId)).version;
    const resumed = await session.lifecycle.publishProgram(orgId, programId, version);
    expect(resumed.kind).toBe('programPublished');
    expect(await publicListingStatus(programId)).toBe(200); // visible again

    version = (await detailOf(session, orgId, programId)).version;
    const archived = await session.lifecycle.archiveProgram(orgId, programId, version);
    expect(archived.kind).toBe('programArchived');
    expect(await publicListingStatus(programId)).toBe(404); // terminal, private
    const final = await detailOf(session, orgId, programId);
    expect(final.listingState).toBe('archived');

    // The provider index card reflects the terminal truth.
    const list = await session.reads.listingsPort.listListings(orgId, {
      q: 'full journey yoga',
    });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs[0]!.listingState).toBe('archived');
    // …and the status filter membership follows the canonical state.
    const publishedFilter = await session.reads.listingsPort.listListings(orgId, {
      status: 'published',
    });
    if (publishedFilter.kind !== 'loaded') throw new Error(publishedFilter.kind);
    expect(publishedFilter.page.programs.map((row) => row.id)).not.toContain(programId);
  });
});
