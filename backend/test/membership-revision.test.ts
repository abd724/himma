/**
 * W2-13 owner-review correction — `membership` through the canonical
 * ProgramRevision moderation path (migration 0019; owner items 1–9).
 * Real PostgreSQL + Fastify injection over the REAL admin review routes.
 *
 * Proves: a review-gated membership option change is REPRESENTED as an
 * ordinary ProgramRevision (no CHECK failure, no special-casing, no
 * moderation bypass) · moderation reads render the membership change set ·
 * approval applies it through the existing certified mechanism · the
 * public catalogue represents the published membership vocabulary · a
 * cross-org provider cannot introduce membership into another provider's
 * revision · capacity/package kinds behave identically · and the immutable
 * fulfillment truth survives the listing revision lifecycle (a sold
 * Entitlement stays bound to F1 while future acquisitions resolve F2).
 * Fulfillment semantics NEVER enter ProgramRevision — the revision carries
 * the commercial kind only.
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
} from '../src/modules/catalogue/services/program-management';
import {
  addPriceOption,
  updatePriceOption,
  type PriceOptionInput,
} from '../src/modules/catalogue/services/price-option-management';
import { setFulfillmentConfig } from '../src/modules/entitlement/services/fulfillment-admin';
import { confirmFreeEntitlementPurchase } from '../src/modules/entitlement/services/entitlement-acquisition';
import { requestEntitlementQuote } from '../src/modules/entitlement/services/entitlement-quote';
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import {
  createAccount,
  createSelfParticipant,
  bootstrapAccessAdmins,
  createUser,
} from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/membership-revision-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let deps: { db: TestDb['db'] };
let org: { orgId: string; branchIds: string[] };
let scope: OrgScope;
let activityType: string;
let ops: { userId: string; bearer: string };
const providerActor = { userId: newId() };

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
  org = await createProviderOrg(testDb.db, { branches: 2, state: 'live' });
  // Public catalogue visibility requires the storefront to be published.
  await sql`UPDATE organization_public_profile SET published = true
            WHERE organization_id = ${org.orgId}`.execute(testDb.db);
  scope = {
    organizationId: org.orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  activityType = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityType}, ${category.rows[0]!.id}, 'membership-revision-type', 'Membership Revision Type')`.execute(
    testDb.db,
  );
  const { adminA, adminB } = await bootstrapAccessAdmins(testDb.db);
  const opsUser = await createUser(testDb.db);
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${opsUser}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
  ops = { userId: opsUser, bearer: (await bearerForUser(ctx, opsUser)).bearer };
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

async function revisionVersion(revisionId: string): Promise<number> {
  return (
    await sql<{ version: number }>`
      SELECT version FROM program_revision WHERE id = ${revisionId}`.execute(testDb.db)
  ).rows[0]!.version;
}

/** Full certified loop: complete draft (branch + option set) → submit →
 *  admin review approve → provider publish. Never a state shortcut. */
async function publishedProgram(
  title: string,
  options: PriceOptionInput[],
): Promise<{ programId: string; optionIds: string[] }> {
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
  const optionIds: string[] = [];
  for (const option of options) {
    const added = await addPriceOption(deps, scope, providerActor, { programId, option });
    if (added.kind !== 'optionAdded') throw new Error(added.kind);
    optionIds.push(added.option.id);
  }
  const submitted = await submitProgram(deps, scope, providerActor, {
    programId,
    expectedVersion: await programVersion(programId),
  });
  if (submitted.kind !== 'programSubmitted') throw new Error(submitted.kind);
  const started = await inject('POST', `/admin/listings/${programId}/review/start`, ops.bearer, {
    expectedVersion: await programVersion(programId),
  });
  if (started.statusCode !== 200) throw new Error(started.body);
  const approved = await inject('POST', `/admin/listings/${programId}/review/approve`, ops.bearer, {
    expectedVersion: await programVersion(programId),
  });
  if (approved.statusCode !== 200) throw new Error(approved.body);
  const published = await publishProgram(deps, scope, providerActor, {
    programId,
    expectedVersion: await programVersion(programId),
  });
  if (published.kind !== 'programPublished') throw new Error(published.kind);
  return { programId, optionIds };
}

/** The ordinary certified revision decision: start review → approve. */
async function approveRevisionById(programId: string, revisionId: string): Promise<void> {
  const base = `/admin/listings/${programId}/revisions/${revisionId}`;
  const started = await inject('POST', `${base}/review/start`, ops.bearer, {
    expectedVersion: await revisionVersion(revisionId),
  });
  if (started.statusCode !== 200) throw new Error(started.body);
  const approved = await inject('POST', `${base}/approve`, ops.bearer, {
    expectedVersion: await revisionVersion(revisionId),
  });
  if (approved.statusCode !== 200) throw new Error(approved.body);
}

describe('membership through the ordinary ProgramRevision lifecycle (0019)', () => {
  it('a review-gated membership ADD is represented, readable by moderation, approved through the certified path, applied, and publicly representable', async () => {
    const { programId } = await publishedProgram('Membership Revision Listing', [
      { kind: 'monthly', amountFils: 45_000 },
    ]);

    // ADD on the published (review-gated) listing → an ordinary revision,
    // no CHECK failure, nothing applied yet.
    const added = await addPriceOption(deps, scope, providerActor, {
      programId,
      option: { kind: 'membership', amountFils: 60_000, labelEn: 'Club membership' },
    });
    if (added.kind !== 'revisionSubmitted') throw new Error(added.kind);
    const stored = await sql<{ option_kind: string | null; state: string }>`
      SELECT option_kind, state FROM program_revision WHERE id = ${added.revisionId}`.execute(
      testDb.db,
    );
    expect(stored.rows[0]).toEqual({ option_kind: 'membership', state: 'submitted' });
    const liveBefore = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_price_option
      WHERE program_id = ${programId} AND kind = 'membership'`.execute(testDb.db);
    expect(Number(liveBefore.rows[0]!.n)).toBe(0);

    // Moderation READS represent the membership change set (existing
    // authority — no new admin surface).
    const view = await inject('GET', `/admin/listings/${programId}`, ops.bearer);
    expect(view.statusCode).toBe(200);
    expect(view.json().revision).toMatchObject({
      option: { kind: 'membership', amountFils: 60_000, labelEn: 'Club membership' },
    });
    const queue = await inject('GET', '/admin/revisions', ops.bearer);
    expect(queue.statusCode).toBe(200);
    expect(
      queue.json().revisions.some((row: { id: string }) => row.id === added.revisionId),
    ).toBe(true);

    // Approval applies through the EXISTING certified mechanism: the live
    // membership option exists afterwards; nothing else moved.
    await approveRevisionById(programId, added.revisionId);
    const applied = await sql<{ kind: string; amount_fils: string; label_en: string }>`
      SELECT kind, amount_fils, label_en FROM program_price_option
      WHERE program_id = ${programId} AND kind = 'membership'`.execute(testDb.db);
    expect(applied.rows).toHaveLength(1);
    expect(Number(applied.rows[0]!.amount_fils)).toBe(60_000);
    expect(applied.rows[0]!.label_en).toBe('Club membership');

    // Public catalogue truth represents the published membership
    // vocabulary without any CHECK failure.
    const publicDetail = await inject('GET', `/listings/${programId}`);
    expect(publicDetail.statusCode).toBe(200);
    const kinds = publicDetail
      .json()
      .listing.priceOptions.map((option: { kind: string }) => option.kind)
      .sort();
    expect(kinds).toEqual(['membership', 'monthly']);
  });

  it('a review-gated KIND PATCH to membership follows the same lifecycle; capacity kinds behave identically through it', async () => {
    const { programId, optionIds } = await publishedProgram('Kind Patch Listing', [
      { kind: 'monthly', amountFils: 40_000 },
      { kind: 'term', amountFils: 90_000 },
    ]);

    // Membership PATCH (kind change) → ordinary revision → apply.
    const patched = await updatePriceOption(deps, scope, providerActor, {
      programId,
      optionId: optionIds[0]!,
      expectedVersion: 1,
      patch: { kind: 'membership' },
    });
    if (patched.kind !== 'revisionSubmitted') throw new Error(patched.kind);
    await approveRevisionById(programId, patched.revisionId);
    const live = await sql<{ kind: string }>`
      SELECT kind FROM program_price_option WHERE id = ${optionIds[0]!}`.execute(testDb.db);
    expect(live.rows[0]!.kind).toBe('membership');

    // A capacity kind rides the SAME path unchanged — no special-casing.
    const capacity = await updatePriceOption(deps, scope, providerActor, {
      programId,
      optionId: optionIds[1]!,
      expectedVersion: 1,
      patch: { kind: 'camp' },
    });
    if (capacity.kind !== 'revisionSubmitted') throw new Error(capacity.kind);
    await approveRevisionById(programId, capacity.revisionId);
    const liveCapacity = await sql<{ kind: string }>`
      SELECT kind FROM program_price_option WHERE id = ${optionIds[1]!}`.execute(testDb.db);
    expect(liveCapacity.rows[0]!.kind).toBe('camp');
  });

  it('a cross-org provider cannot introduce membership into another provider’s revision (not-found-shaped)', async () => {
    const { programId, optionIds } = await publishedProgram('Foreign Revision Target', [
      { kind: 'monthly', amountFils: 30_000 },
    ]);
    const foreignOrg = await createProviderOrg(testDb.db, { branches: 1, state: 'live' });
    const foreignScope: OrgScope = {
      organizationId: foreignOrg.orgId,
      membershipId: newId(),
      role: 'owner',
      capabilities: capabilitiesForRole('owner'),
      branchScope: 'all',
      organizationState: 'live',
    };
    const add = await addPriceOption(deps, foreignScope, providerActor, {
      programId,
      option: { kind: 'membership', amountFils: 10_000 },
    });
    expect(add.kind).toBe('programNotFound');
    const patch = await updatePriceOption(deps, foreignScope, providerActor, {
      programId,
      optionId: optionIds[0]!,
      expectedVersion: 1,
      patch: { kind: 'membership' },
    });
    expect(patch.kind).toBe('programNotFound');
    const untouched = await sql<{ n: string }>`
      SELECT count(*) AS n FROM program_revision WHERE program_id = ${programId}`.execute(
      testDb.db,
    );
    expect(Number(untouched.rows[0]!.n)).toBe(0);
  });

  it('IMMUTABLE fulfillment truth survives the listing revision lifecycle: sold Entitlement stays on F1; future acquisition resolves F2', async () => {
    // A published listing whose membership option was created on the
    // ordinary draft path, with fulfillment F1 configured via the REAL
    // W2-13 service.
    const { programId, optionIds } = await publishedProgram('F1 F2 Listing', [
      { kind: 'membership', amountFils: 0 },
    ]);
    const optionId = optionIds[0]!;
    const f1 = await setFulfillmentConfig(deps, scope, providerActor, {
      programId,
      optionId,
      terms: {
        usageKind: 'finite',
        usesTotal: 3,
        validityKind: 'daysFromConfirmation',
        validityDays: 30,
        reservationRequired: false,
        walkInAllowed: true,
      },
    });
    if (f1.kind !== 'revisionCreated') throw new Error(f1.kind);

    // Customer purchases under F1.
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    const participantId = await createSelfParticipant(testDb.db, accountId);
    const quote1 = await requestEntitlementQuote(deps, { accountId }, {
      programId,
      priceOptionId: optionId,
      participantId,
    });
    if (quote1.kind !== 'quoteIssued') throw new Error(quote1.kind);
    const purchase1 = await confirmFreeEntitlementPurchase(deps, { accountId }, {
      quoteId: quote1.quote.quoteId,
      idempotencyKey: newId(),
    });
    if (purchase1.outcome.kind !== 'purchaseConfirmed') throw new Error(purchase1.outcome.kind);
    const soldEntitlementId = purchase1.outcome.purchase.entitlement!.entitlementId;

    // Provider creates F2 for FUTURE purchases, then runs an ordinary
    // moderated listing revision to completion (a protected price change).
    const f2 = await setFulfillmentConfig(deps, scope, providerActor, {
      programId,
      optionId,
      terms: {
        usageKind: 'finite',
        usesTotal: 5,
        validityKind: 'daysFromConfirmation',
        validityDays: 60,
        reservationRequired: false,
        walkInAllowed: true,
      },
    });
    if (f2.kind !== 'revisionCreated') throw new Error(f2.kind);
    const priceChange = await updatePriceOption(deps, scope, providerActor, {
      programId,
      optionId,
      expectedVersion: 1,
      patch: { amountFils: 15_000 },
    });
    if (priceChange.kind !== 'revisionSubmitted') throw new Error(priceChange.kind);
    await approveRevisionById(programId, priceChange.revisionId);

    // The sold Entitlement still references F1 — revision application
    // NEVER rewrites historical entitlements.
    const sold = await sql<{ fulfillment_revision_id: string }>`
      SELECT fulfillment_revision_id FROM entitlement WHERE id = ${soldEntitlementId}`.execute(
      testDb.db,
    );
    expect(sold.rows[0]!.fulfillment_revision_id).toBe(f1.revision.revisionId);
    const f1Row = await sql<{ state: string; uses_total: number }>`
      SELECT state, uses_total FROM price_option_fulfillment_revision
      WHERE id = ${f1.revision.revisionId}`.execute(testDb.db);
    expect(f1Row.rows[0]).toEqual({ state: 'superseded', uses_total: 3 });

    // A FUTURE acquisition (post-moderation, at the applied price) binds
    // the ACTIVE F2 terms.
    const quote2 = await requestEntitlementQuote(deps, { accountId }, {
      programId,
      priceOptionId: optionId,
      participantId,
    });
    if (quote2.kind !== 'quoteIssued') throw new Error(quote2.kind);
    expect(quote2.quote.totalFils).toBe(15_000);
    const paidQuoteRow = await sql<{ fulfillment_revision_id: string }>`
      SELECT fulfillment_revision_id FROM price_quote
      WHERE id = ${quote2.quote.quoteId}`.execute(testDb.db);
    expect(paidQuoteRow.rows[0]!.fulfillment_revision_id).toBe(f2.revision.revisionId);
  });
});
