/**
 * Slice 4 — internal Himma catalogue moderation and ProgramRevision
 * decisions (docs/28 §6/§7/§8/§15/§16.3; docs/24 §5.3; D-S4-2). Real
 * PostgreSQL + Fastify injection: the admin role matrix (operations-only),
 * surface separation (provider/customer bearers worthless), the
 * submitted→in_review→approved|changes_requested review machine with named
 * actions, revision decisions with atomic protected-change-set application,
 * CAS/no-double-decision guarantees, and audit/outbox atomicity + hygiene.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  addProgramBranch,
  createProgram,
  publishProgram,
  submitProgram,
  updateProgram,
} from '../src/modules/catalogue/services/program-management';
import {
  addPriceOption,
  updatePriceOption,
} from '../src/modules/catalogue/services/price-option-management';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/catalogue-moderation-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let deps: { db: TestDb['db'] };
let org: { orgId: string; branchIds: string[] };
let scope: OrgScope;
let activityType: string;
let ops: { userId: string; bearer: string };
const providerActor = { userId: newId() };

async function makeAdmin(role: string): Promise<{ userId: string; bearer: string }> {
  const seeded = Number(
    (await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(testDb.db)).rows[0]
      ?.n,
  );
  let approverA: string;
  let approverB: string;
  if (seeded > 0) {
    const admins = await sql<{ user_id: string }>`
      SELECT user_id FROM admin_role_assignment
      WHERE role = 'access_admin' AND state = 'active' LIMIT 2`.execute(testDb.db);
    approverA = admins.rows[0]!.user_id;
    approverB = admins.rows[1]!.user_id;
  } else {
    ({ adminA: approverA, adminB: approverB } = await bootstrapAccessAdmins(testDb.db));
  }
  const userId = await createUser(testDb.db);
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${approverA}, ${approverB})`.execute(
    testDb.db,
  );
  const { bearer } = await bearerForUser(ctx, userId);
  return { userId, bearer };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  deps = { db: testDb.db };
  const verifier = new FakeAccessTokenVerifier();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  org = await createProviderOrg(testDb.db, { branches: 2 });
  scope = {
    organizationId: org.orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'test-jiu-jitsu', 'Jiu-jitsu')`.execute(
    testDb.db,
  );
  ops = await makeAdmin('operations');
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function inject(method: 'GET' | 'POST', url: string, bearer?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function programVersion(programId: string): Promise<number> {
  return (
    await sql<{ version: number }>`SELECT version FROM program WHERE id = ${programId}`.execute(
      testDb.db,
    )
  ).rows[0]!.version;
}

async function programState(programId: string): Promise<string> {
  return (
    await sql<{ s: string }>`SELECT listing_state AS s FROM program WHERE id = ${programId}`.execute(
      testDb.db,
    )
  ).rows[0]!.s;
}

/** Provider-side setup: a complete draft (branch + option). */
async function completeDraft(title: string): Promise<{ programId: string; optionId: string }> {
  const created = await createProgram(deps, scope, providerActor, {
    titleEn: title,
    activityTypeId: activityType,
    setting: 'indoor',
    genderEligibility: 'mixed',
  });
  if (created.kind !== 'programCreated') throw new Error(created.kind);
  const programId = created.program.id;
  const branch = await addProgramBranch(deps, scope, providerActor, {
    programId,
    branchId: org.branchIds[0]!,
  });
  if (branch.kind !== 'branchAssociated') throw new Error(branch.kind);
  const option = await addPriceOption(deps, scope, providerActor, {
    programId,
    option: { kind: 'monthly', amountFils: 60000, labelEn: 'Monthly', sortHint: 10 },
  });
  if (option.kind !== 'optionAdded') throw new Error(option.kind);
  return { programId, optionId: option.option.id };
}

async function submittedProgram(title: string): Promise<{ programId: string; optionId: string }> {
  const made = await completeDraft(title);
  const submitted = await submitProgram(deps, scope, providerActor, {
    programId: made.programId,
    expectedVersion: await programVersion(made.programId),
  });
  if (submitted.kind !== 'programSubmitted') throw new Error(submitted.kind);
  return made;
}

/** Full loop to `published`, using the REAL admin review routes. */
async function publishedProgram(title: string): Promise<{ programId: string; optionId: string }> {
  const made = await submittedProgram(title);
  const base = `/admin/listings/${made.programId}`;
  const started = await inject('POST', `${base}/review/start`, ops.bearer, {
    expectedVersion: await programVersion(made.programId),
  });
  if (started.statusCode !== 200) throw new Error(started.body);
  const approved = await inject('POST', `${base}/review/approve`, ops.bearer, {
    expectedVersion: await programVersion(made.programId),
  });
  if (approved.statusCode !== 200) throw new Error(approved.body);
  const published = await publishProgram(deps, scope, providerActor, {
    programId: made.programId,
    expectedVersion: await programVersion(made.programId),
  });
  if (published.kind !== 'programPublished') throw new Error(published.kind);
  return made;
}

/** Provider-side sensitive edit creating an open revision on a published listing. */
async function openRevision(
  programId: string,
  patch: Parameters<typeof updateProgram>[3]['patch'],
): Promise<string> {
  const result = await updateProgram(deps, scope, providerActor, {
    programId,
    expectedVersion: await programVersion(programId),
    patch,
  });
  if (result.kind !== 'revisionSubmitted') throw new Error(result.kind);
  return result.revisionId;
}

async function revisionRow(revisionId: string): Promise<{ state: string; version: number }> {
  const row = await sql<{ state: string; version: number }>`
    SELECT state, version FROM program_revision WHERE id = ${revisionId}`.execute(testDb.db);
  return row.rows[0]!;
}

describe('authorization surface (docs/28 §16.3: admin policy + operations role)', () => {
  it('only the operations role may act: support, finance, access_admin, and auditor are refused', async () => {
    const { programId } = await submittedProgram('Role Matrix Target');
    const url = `/admin/listings/${programId}/review/start`;
    for (const role of ['support', 'finance', 'auditor'] as const) {
      const admin = await makeAdmin(role);
      const queue = await inject('GET', '/admin/listings?state=submitted', admin.bearer);
      expect(`${role}:queue:${queue.statusCode}`).toBe(`${role}:queue:403`);
      const act = await inject('POST', url, admin.bearer, { expectedVersion: 1 });
      expect(`${role}:act:${act.statusCode}`).toBe(`${role}:act:403`);
    }
    // The seeded access admins (bootstrap already sealed in beforeAll).
    const seededAccessAdmin = await sql<{ user_id: string }>`
      SELECT user_id FROM admin_role_assignment
      WHERE role = 'access_admin' AND state = 'active' LIMIT 1`.execute(testDb.db);
    const accessAdmin = await bearerForUser(ctx, seededAccessAdmin.rows[0]!.user_id);
    expect((await inject('POST', url, accessAdmin.bearer, { expectedVersion: 1 })).statusCode).toBe(
      403,
    );
    // Operations reaches the queue and sees the submitted listing.
    const queue = await inject('GET', '/admin/listings?state=submitted', ops.bearer);
    expect(queue.statusCode).toBe(200);
    expect(
      queue.json().listings.map((row: { id: string }) => row.id),
    ).toContain(programId);
  });

  it('provider and customer bearers are never accepted on moderation routes — including for their own listings', async () => {
    const { programId } = await submittedProgram('Self Approval Attempt');
    const owner = await staffBearer(ctx, org.orgId, 'owner');
    const url = `/admin/listings/${programId}/review/approve`;
    const providerAttempt = await inject('POST', url, owner.bearer, { expectedVersion: 2 });
    expect(providerAttempt.statusCode).toBe(403);
    const customer = await bearerForUser(ctx, await createUser(testDb.db));
    expect((await inject('POST', url, customer.bearer, { expectedVersion: 2 })).statusCode).toBe(403);
    expect((await inject('GET', '/admin/listings', customer.bearer)).statusCode).toBe(403);
    expect((await inject('POST', url, undefined, { expectedVersion: 2 })).statusCode).toBe(401);
    expect(await programState(programId)).toBe('submitted');
  });

  it('revoked admin authority bites on the very next request', async () => {
    const shortLived = await makeAdmin('operations');
    expect((await inject('GET', '/admin/listings', shortLived.bearer)).statusCode).toBe(200);
    await sql`UPDATE admin_role_assignment SET state = 'revoked'
              WHERE user_id = ${shortLived.userId} AND role = 'operations'`.execute(testDb.db);
    expect((await inject('GET', '/admin/listings', shortLived.bearer)).statusCode).toBe(403);
  });
});

describe('program review machine (docs/24 §5.3; D-S4-2)', () => {
  it('walks submitted → in_review → approved with named actions, and approval never publishes', async () => {
    const { programId } = await submittedProgram('Approve Path');
    const base = `/admin/listings/${programId}`;
    const started = await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: await programVersion(programId),
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: 'programReviewed', state: 'in_review' });

    const approved = await inject('POST', `${base}/review/approve`, ops.bearer, {
      expectedVersion: await programVersion(programId),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state).toBe('approved');
    // D-S4-2: approval RESTS at approved — publication stays a provider act.
    expect(await programState(programId)).toBe('approved');
    const published = await publishProgram(deps, scope, providerActor, {
      programId,
      expectedVersion: await programVersion(programId),
    });
    expect(published.kind).toBe('programPublished');

    for (const eventType of ['listing.review_started', 'listing.approved']) {
      const events = await sql<{ payload: Record<string, unknown> }>`
        SELECT payload FROM outbox_event
        WHERE aggregate_id = ${programId} AND event_type = ${eventType}`.execute(testDb.db);
      expect(events.rows).toHaveLength(1);
    }
  });

  it('walks submitted → in_review → changes_requested and back around via provider resubmission', async () => {
    const { programId } = await submittedProgram('Changes Requested Path');
    const base = `/admin/listings/${programId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: await programVersion(programId),
    });
    const changes = await inject('POST', `${base}/review/request-changes`, ops.bearer, {
      expectedVersion: await programVersion(programId),
      reasonCode: 'unclear_title',
    });
    expect(changes.statusCode).toBe(200);
    expect(await programState(programId)).toBe('changes_requested');
    // The provider edits and resubmits through the S4-2 surface.
    const edited = await updateProgram(deps, scope, providerActor, {
      programId,
      expectedVersion: await programVersion(programId),
      patch: { titleEn: 'Clearer Title' },
    });
    expect(edited.kind).toBe('programUpdated');
    const resubmitted = await submitProgram(deps, scope, providerActor, {
      programId,
      expectedVersion: await programVersion(programId),
    });
    expect(resubmitted.kind).toBe('programSubmitted');
    const event = await sql<{ payload: { reasonCode?: string } }>`
      SELECT payload FROM outbox_event
      WHERE aggregate_id = ${programId} AND event_type = 'listing.changes_requested'`.execute(
      testDb.db,
    );
    expect(event.rows[0]?.payload.reasonCode).toBe('unclear_title');
  });

  it('refuses invalid review transitions with typed outcomes and never leaks trigger names', async () => {
    const draft = await completeDraft('Still A Draft');
    const startDraft = await inject('POST', `/admin/listings/${draft.programId}/review/start`, ops.bearer, {
      expectedVersion: await programVersion(draft.programId),
    });
    expect(startDraft.statusCode).toBe(409);
    expect(startDraft.json().code).toBe('lifecycleConflict');
    expect(startDraft.body).not.toMatch(/trigger|constraint|ck_|trg_/i);

    const { programId } = await submittedProgram('No Skip To Approved');
    const skip = await inject('POST', `/admin/listings/${programId}/review/approve`, ops.bearer, {
      expectedVersion: await programVersion(programId),
    });
    expect(skip.statusCode).toBe(409);
    expect(skip.json().code).toBe('lifecycleConflict');

    const ghost = await inject('POST', `/admin/listings/${newId()}/review/start`, ops.bearer, {
      expectedVersion: 1,
    });
    expect(ghost.statusCode).toBe(404);
  });

  it('review decisions are CAS-guarded: stale versions and double decisions fail safely', async () => {
    const { programId } = await submittedProgram('CAS Review');
    const base = `/admin/listings/${programId}`;
    const version = await programVersion(programId);
    const stale = await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: version + 5,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    // Two admins racing the same decision from the same version: exactly one
    // wins; the loser gets a typed conflict, and no duplicate event exists.
    const first = await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: version,
    });
    const second = await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: version,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${programId} AND event_type = 'listing.review_started'`.execute(
      testDb.db,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
  });

  it('serves the moderation projection with organization identity and no private/credential data', async () => {
    const { programId } = await submittedProgram('Projection Target');
    const detail = await inject('GET', `/admin/listings/${programId}`, ops.bearer);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.program.id).toBe(programId);
    expect(body.organization).toMatchObject({ id: org.orgId });
    expect(typeof body.organization.displayName).toBe('string');
    expect(body.program.priceOptions).toHaveLength(1);
    // Hygiene: no snake_case leakage, no token/secret/digest material.
    expect(detail.body).not.toMatch(/"[a-z]+_[a-z_]+":/);
    expect(detail.body).not.toMatch(/token|digest|secret|password|totp/i);
  });
});

describe('ProgramRevision decisions (docs/28 §7)', () => {
  it('a submitted revision leaves canonical state untouched; approval applies it atomically', async () => {
    const { programId } = await publishedProgram('Revision Apply Target');
    const revisionId = await openRevision(programId, { minAge: 16, eligibilityNotes: 'Teens and up' });

    // Canonical fields untouched pre-decision.
    let live = await sql<{ min_age: number | null; sensitive_fields_version: number }>`
      SELECT min_age, sensitive_fields_version FROM program WHERE id = ${programId}`.execute(
      testDb.db,
    );
    expect(live.rows[0]).toEqual({ min_age: null, sensitive_fields_version: 1 });

    const base = `/admin/listings/${programId}/revisions/${revisionId}`;
    const started = await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    expect(started.statusCode).toBe(200);
    const approved = await inject('POST', `${base}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('revisionApproved');

    live = await sql<{ min_age: number | null; sensitive_fields_version: number }>`
      SELECT min_age, sensitive_fields_version FROM program WHERE id = ${programId}`.execute(
      testDb.db,
    );
    expect(live.rows[0]).toEqual({ min_age: 16, sensitive_fields_version: 2 });
    // The listing's publication state is untouched by revision approval.
    expect(await programState(programId)).toBe('published');
    expect((await revisionRow(revisionId)).state).toBe('approved');
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${programId} AND event_type = 'listing.revision_approved'`.execute(
      testDb.db,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
    // The provider can open a NEW revision afterwards (previous one closed).
    const next = await openRevision(programId, { maxAge: 40 });
    expect(typeof next).toBe('string');
  });

  it('rejection freezes the revision, changes nothing canonical, and applies nothing later', async () => {
    const { programId } = await publishedProgram('Revision Reject Target');
    const revisionId = await openRevision(programId, { genderEligibility: 'women' });
    const base = `/admin/listings/${programId}/revisions/${revisionId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    const rejected = await inject('POST', `${base}/reject`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
      reasonCode: 'insufficient_detail',
    });
    expect(rejected.statusCode).toBe(200);
    const gender = await sql<{ g: string }>`
      SELECT gender_eligibility AS g FROM program WHERE id = ${programId}`.execute(testDb.db);
    expect(gender.rows[0]?.g).toBe('mixed');
    expect((await revisionRow(revisionId)).state).toBe('rejected');
    // Decided revisions cannot be re-decided (frozen row → typed conflict).
    const again = await inject('POST', `${base}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('lifecycleConflict');
  });

  it('an approved (not yet published) listing stays approved through revision application', async () => {
    const { programId } = await submittedProgram('Approved Stays Approved');
    const base = `/admin/listings/${programId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: await programVersion(programId),
    });
    await inject('POST', `${base}/review/approve`, ops.bearer, {
      expectedVersion: await programVersion(programId),
    });
    const revisionId = await openRevision(programId, { skillLevel: 'beginner' });
    const revisionBase = `${base}/revisions/${revisionId}`;
    await inject('POST', `${revisionBase}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    const approved = await inject('POST', `${revisionBase}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    expect(approved.statusCode).toBe(200);
    expect(await programState(programId)).toBe('approved');
    const skill = await sql<{ s: string | null }>`
      SELECT skill_level AS s FROM program WHERE id = ${programId}`.execute(testDb.db);
    expect(skill.rows[0]?.s).toBe('beginner');
  });

  it('applies option change sets: edits keep stable identity, add-intents create the option, invariants hold', async () => {
    const { programId, optionId } = await publishedProgram('Option Revision Apply');
    // Provider re-prices the existing option → revision with option target.
    const reprice = await updatePriceOption(deps, scope, providerActor, {
      programId,
      optionId,
      expectedVersion: 1,
      patch: { amountFils: 75000 },
    });
    if (reprice.kind !== 'revisionSubmitted') throw new Error(reprice.kind);
    const base = `/admin/listings/${programId}/revisions/${reprice.revisionId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(reprice.revisionId)).version,
    });
    const applied = await inject('POST', `${base}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(reprice.revisionId)).version,
    });
    expect(applied.statusCode).toBe(200);
    const option = await sql<{ amount_fils: string; id: string; program_id: string }>`
      SELECT id, program_id, amount_fils FROM program_price_option WHERE id = ${optionId}`.execute(
      testDb.db,
    );
    expect(option.rows[0]?.id).toBe(optionId); // stable identity
    expect(Number(option.rows[0]?.amount_fils)).toBe(75000);

    // Add-intent revision → approval creates a NEW active option in place.
    const addIntent = await addPriceOption(deps, scope, providerActor, {
      programId,
      option: { kind: 'term', amountFils: 150000, labelEn: '3 months', sortHint: 20 },
    });
    if (addIntent.kind !== 'revisionSubmitted') throw new Error(addIntent.kind);
    const addBase = `/admin/listings/${programId}/revisions/${addIntent.revisionId}`;
    await inject('POST', `${addBase}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(addIntent.revisionId)).version,
    });
    const addApplied = await inject('POST', `${addBase}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(addIntent.revisionId)).version,
    });
    expect(addApplied.statusCode).toBe(200);
    const options = await sql<{ kind: string; organization_id: string; state: string }>`
      SELECT kind, organization_id, state FROM program_price_option
      WHERE program_id = ${programId} ORDER BY sort_hint`.execute(testDb.db);
    expect(options.rows).toHaveLength(2);
    expect(options.rows[1]).toEqual({ kind: 'term', organization_id: org.orgId, state: 'active' });
    // No fake Program price appeared through application.
    const priceColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'program' AND column_name ~ '(price|amount|fils)'`.execute(testDb.db);
    expect(priceColumns.rows).toEqual([]);
  });

  it('a revision made stale by canonical drift cannot apply: archived target options stay retired', async () => {
    const { programId, optionId } = await publishedProgram('Stale Option Revision');
    const reprice = await updatePriceOption(deps, scope, providerActor, {
      programId,
      optionId,
      expectedVersion: 1,
      patch: { amountFils: 90000 },
    });
    if (reprice.kind !== 'revisionSubmitted') throw new Error(reprice.kind);
    // Simulated drift: the target option is archived out-of-band.
    await sql`UPDATE program_price_option SET state = 'archived' WHERE id = ${optionId}`.execute(
      testDb.db,
    );
    const base = `/admin/listings/${programId}/revisions/${reprice.revisionId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(reprice.revisionId)).version,
    });
    const refused = await inject('POST', `${base}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(reprice.revisionId)).version,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('lifecycleConflict');
    // Nothing changed: option stays archived at its old amount, revision open.
    const option = await sql<{ state: string; amount_fils: string }>`
      SELECT state, amount_fils FROM program_price_option WHERE id = ${optionId}`.execute(testDb.db);
    expect(option.rows[0]?.state).toBe('archived');
    expect(Number(option.rows[0]?.amount_fils)).toBe(60000);
    expect((await revisionRow(reprice.revisionId)).state).toBe('in_review');
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${programId} AND event_type = 'listing.revision_approved'`.execute(
      testDb.db,
    );
    expect(Number(events.rows[0]?.n)).toBe(0);
  });

  it('revision decisions are CAS-guarded and cannot double-apply', async () => {
    const { programId } = await publishedProgram('Revision CAS');
    const revisionId = await openRevision(programId, { minAge: 10 });
    const base = `/admin/listings/${programId}/revisions/${revisionId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    const version = (await revisionRow(revisionId)).version;
    const stale = await inject('POST', `${base}/approve`, ops.bearer, {
      expectedVersion: version + 3,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    const first = await inject('POST', `${base}/approve`, ops.bearer, { expectedVersion: version });
    const second = await inject('POST', `${base}/approve`, ops.bearer, { expectedVersion: version });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    // Applied exactly once: one event, sensitive_fields_version bumped once.
    const events = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE aggregate_id = ${programId} AND event_type = 'listing.revision_approved'`.execute(
      testDb.db,
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
    const sfv = await sql<{ v: number }>`
      SELECT sensitive_fields_version AS v FROM program WHERE id = ${programId}`.execute(testDb.db);
    expect(sfv.rows[0]?.v).toBe(2);
  });

  it('moderation cannot move ownership: organization and program identity survive every decision', async () => {
    const { programId } = await publishedProgram('Ownership Survives');
    const revisionId = await openRevision(programId, { minAge: 8 });
    const base = `/admin/listings/${programId}/revisions/${revisionId}`;
    await inject('POST', `${base}/review/start`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    await inject('POST', `${base}/approve`, ops.bearer, {
      expectedVersion: (await revisionRow(revisionId)).version,
    });
    const row = await sql<{ organization_id: string }>`
      SELECT organization_id FROM program WHERE id = ${programId}`.execute(testDb.db);
    expect(row.rows[0]?.organization_id).toBe(org.orgId);
  });

  it('lists the revision queue for operations admins', async () => {
    const { programId } = await publishedProgram('Revision Queue Target');
    const revisionId = await openRevision(programId, { minAge: 12 });
    const queue = await inject('GET', '/admin/revisions?state=submitted', ops.bearer);
    expect(queue.statusCode).toBe(200);
    const entry = queue
      .json()
      .revisions.find((row: { id: string }) => row.id === revisionId);
    expect(entry).toMatchObject({ id: revisionId, programId, state: 'submitted' });
  });
});

describe('event payload hygiene and route boundary', () => {
  it('moderation event payloads carry ids and safe metadata only', async () => {
    const events = await sql<{ event_type: string; payload: Record<string, unknown> }>`
      SELECT event_type, payload FROM outbox_event
      WHERE event_type LIKE 'listing.review%' OR event_type LIKE 'listing.revision%'
         OR event_type IN ('listing.approved', 'listing.changes_requested')`.execute(testDb.db);
    expect(events.rows.length).toBeGreaterThan(0);
    const allowedKeys = new Set([
      'programId',
      'organizationId',
      'revisionId',
      'optionId',
      'newOptionId',
      'previousState',
      'reasonCode',
    ]);
    for (const event of events.rows) {
      for (const [key, value] of Object.entries(event.payload)) {
        expect(allowedKeys.has(key)).toBe(true);
        expect(typeof value).toBe('string');
        // Never descriptions/labels/free text: ids are uuids, states/reasons
        // are bounded slugs.
        expect(String(value).length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('the inventory gains exactly the nine internal-admin moderation routes and nothing public', () => {
    const moderation = app.routePolicyInventory.filter(
      (route) =>
        (route.url.startsWith('/admin/listings') || route.url.startsWith('/admin/revisions')) &&
        route.method !== 'HEAD',
    );
    expect(
      moderation.map((route) => `${route.method} ${route.url}`).sort(),
    ).toEqual(
      [
        'GET /admin/listings',
        'GET /admin/listings/:programId',
        'POST /admin/listings/:programId/review/start',
        'POST /admin/listings/:programId/review/approve',
        'POST /admin/listings/:programId/review/request-changes',
        'GET /admin/revisions',
        'POST /admin/listings/:programId/revisions/:revisionId/review/start',
        'POST /admin/listings/:programId/revisions/:revisionId/approve',
        'POST /admin/listings/:programId/revisions/:revisionId/reject',
      ].sort(),
    );
    for (const route of moderation) {
      expect(route.policy).toBe('admin');
    }
    // Still no public catalogue, storefront-listings, search, or
    // session/booking/payment surface. (The Slice-2 /auth/session identity
    // routes are the AUTH session store — not the booking-domain Session;
    // /admin/taxonomy arrived legitimately with the taxonomy-admin task and
    // is locked by its own suite.)
    const forbidden = app.routePolicyInventory.filter(
      (route) =>
        /^\/(listings|programs|search|catalogue|sessions|bookings|payments)([/?]|$)/.test(
          route.url,
        ) || /^\/providers\/.+\/listings/.test(route.url),
    );
    expect(forbidden).toEqual([]);
  });
});
