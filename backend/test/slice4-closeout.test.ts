/**
 * Slice-4 closeout hardening (S4-6) — targeted audit proofs that the
 * combined catalogue/listings/search system holds its canon under the
 * closeout matrix (docs/28 §18; task §§6–14):
 *  · offer effective-window crossings cannot leave the trial FILTER stale
 *    (time passage emits no event — the filter must evaluate live truth);
 *  · direct price-option mutations are structurally confined to
 *    never-published listings, and the revision paths (edit amount, add
 *    option) refresh projected price_kinds/min_price_fils atomically;
 *  · deep pagination walks per sort with tied ordering keys, cross-sort
 *    cursor rejection, and float-score round-trip continuation;
 *  · organization display-name changes propagate to searchable text
 *    through the event consumer;
 *  · three-surface visibility parity (detail / storefront listings /
 *    search) through a live pause → republish walk with a stale document.
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
import { capabilitiesForRole } from '../src/modules/provider/provider-capabilities';
import type { OrgScope } from '../src/modules/provider/services/provider-principal';
import { updatePublicProfile } from '../src/modules/provider/services/organization-management';
import {
  addPriceOption,
  updatePriceOption,
} from '../src/modules/catalogue/services/price-option-management';
import {
  approveRevision,
  startRevisionReview,
} from '../src/modules/catalogue/services/moderation';
import {
  processSearchProjectionEvents,
  rebuildAllSearchDocuments,
} from '../src/modules/catalogue/services/search-projection';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/slice4-closeout-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let categoryId: string;
let activityTypeId: string;
let ops: { userId: string };

beforeAll(async () => {
  testDb = await createMigratedTestDb();
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
  const category = await sql<{ id: string }>`
    SELECT id FROM category WHERE slug = 'fitness'`.execute(testDb.db);
  categoryId = category.rows[0]!.id;
  activityTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityTypeId}, ${categoryId}, 'closeout-fitness', 'Functional Fitness')`.execute(
    testDb.db,
  );
  const { adminA, adminB } = await bootstrapAccessAdmins(testDb.db);
  const userId = await createUser(testDb.db);
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
  await bearerForUser(ctx, userId);
  ops = { userId };
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

async function makePublicOrg(
  options: { displayName?: string } = {},
): Promise<{ orgId: string; branchIds: string[] }> {
  const org = await createProviderOrg(testDb.db, {
    state: 'live',
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    branches: 1,
  });
  await sql`UPDATE organization_public_profile SET published = true
            WHERE organization_id = ${org.orgId}`.execute(testDb.db);
  return org;
}

function ownerScope(orgId: string): OrgScope {
  return {
    organizationId: orgId,
    membershipId: newId(),
    role: 'owner',
    capabilities: capabilitiesForRole('owner'),
    branchScope: 'all',
    organizationState: 'live',
  };
}

const PUBLISH_WALK = ['submitted', 'in_review', 'approved', 'published'];

async function makePublishedProgram(
  org: { orgId: string; branchIds: string[] },
  fixture: {
    titleEn: string;
    options?: { kind: string; amountFils?: number | null; sortHint?: number }[];
    offers?: {
      kind: string;
      labelEn: string;
      trialAmountFils?: number;
      start?: Date | null;
      end?: Date | null;
    }[];
  },
): Promise<{ programId: string; optionIds: string[] }> {
  const programId = newId();
  await sql`
    INSERT INTO program (id, organization_id, activity_type_id, title_en, setting,
                         gender_eligibility, all_ages)
    VALUES (${programId}, ${org.orgId}, ${activityTypeId}, ${fixture.titleEn},
            'indoor', 'mixed', true)`.execute(testDb.db);
  await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
            VALUES (${programId}, ${org.branchIds[0]!}, ${org.orgId})`.execute(testDb.db);
  const optionIds: string[] = [];
  for (const option of fixture.options ?? [{ kind: 'monthly', amountFils: 60000 }]) {
    const optionId = newId();
    await sql`
      INSERT INTO program_price_option
        (id, program_id, organization_id, kind, amount_fils, sort_hint)
      VALUES (${optionId}, ${programId}, ${org.orgId}, ${option.kind},
              ${option.amountFils ?? null}, ${option.sortHint ?? 0})`.execute(testDb.db);
    optionIds.push(optionId);
  }
  for (const offer of fixture.offers ?? []) {
    await sql`
      INSERT INTO offer (id, program_id, organization_id, kind, label_en,
                         trial_amount_fils, effective_start, effective_end)
      VALUES (${newId()}, ${programId}, ${org.orgId}, ${offer.kind}, ${offer.labelEn},
              ${offer.trialAmountFils ?? null}, ${offer.start ?? null},
              ${offer.end ?? null})`.execute(testDb.db);
  }
  for (const state of PUBLISH_WALK) {
    await sql`
      UPDATE program SET listing_state = ${state},
        published_at = CASE WHEN ${state} = 'published' THEN now() ELSE published_at END
      WHERE id = ${programId}`.execute(testDb.db);
  }
  return { programId, optionIds };
}

function search(params: Record<string, string | number | boolean>) {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return app.inject({ method: 'GET', url: `/search${query.length > 0 ? `?${query}` : ''}` });
}

async function searchIds(params: Record<string, string | number | boolean>): Promise<string[]> {
  const response = await search(params);
  expect(response.statusCode).toBe(200);
  return (response.json().results as { id: string }[]).map((result) => result.id);
}

async function docField(programId: string, field: string): Promise<unknown> {
  const row = await sql<Record<string, unknown>>`
    SELECT * FROM program_search_document WHERE program_id = ${programId}`.execute(testDb.db);
  return row.rows[0]?.[field];
}

// ---------------------------------------------------------------------------
// Offer effective windows: time passage emits no event — the trial filter
// must evaluate LIVE truth, never the projected boolean alone.
// ---------------------------------------------------------------------------

describe('trial filter across offer effective-window crossings', () => {
  it('a trial whose window ENDS by pure time passage stops matching the trial filter immediately', async () => {
    const org = await makePublicOrg({ displayName: 'Trialwindow Gym' });
    const listing = await makePublishedProgram(org, {
      titleEn: 'Trialwindow Circuit Training',
      offers: [
        {
          kind: 'paidTrial',
          labelEn: 'Trial week',
          trialAmountFils: 5000,
          end: new Date(Date.now() + 3_600_000), // still open at refresh time
        },
      ],
    });
    await rebuildAllSearchDocuments({ db: testDb.db });
    expect(await docField(listing.programId, 'has_trial')).toBe(true);
    expect(await searchIds({ q: 'trialwindow circuit', trial: true })).toEqual([
      listing.programId,
    ]);

    // Simulate the clock crossing the window boundary: no service call, no
    // event, no refresh — exactly what real time passage looks like.
    await sql`UPDATE offer SET effective_end = now() - interval '1 hour'
              WHERE program_id = ${listing.programId}`.execute(testDb.db);

    // The projected boolean is stale by construction…
    expect(await docField(listing.programId, 'has_trial')).toBe(true);
    // …but the customer-facing trial filter must not be: an expired trial
    // is not a trial (live evaluation, same discipline as visibility).
    expect(await searchIds({ q: 'trialwindow circuit', trial: true })).toEqual([]);
    // The un-filtered result stays visible with no trial badge (live
    // hydration already window-filters offer badges).
    const plain = await search({ q: 'trialwindow circuit' });
    const result = (plain.json().results as { id: string; offerBadges: string[] }[]).find(
      (row) => row.id === listing.programId,
    );
    expect(result).toBeDefined();
    expect(result!.offerBadges).toEqual([]);
  });

  it('a trial whose window OPENS by time passage starts matching without any refresh', async () => {
    const org = await makePublicOrg({ displayName: 'Trialopen Gym' });
    const listing = await makePublishedProgram(org, {
      titleEn: 'Trialopen Mobility Class',
      offers: [
        {
          kind: 'freeTrial',
          labelEn: 'Free trial soon',
          start: new Date(Date.now() + 3_600_000), // not yet open at refresh
        },
      ],
    });
    await rebuildAllSearchDocuments({ db: testDb.db });
    expect(await docField(listing.programId, 'has_trial')).toBe(false);
    expect(await searchIds({ q: 'trialopen mobility', trial: true })).toEqual([]);

    // Window opens with no mutation event.
    await sql`UPDATE offer SET effective_start = now() - interval '1 hour'
              WHERE program_id = ${listing.programId}`.execute(testDb.db);
    expect(await searchIds({ q: 'trialopen mobility', trial: true })).toEqual([
      listing.programId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Price-option mutation → projection dependency (task §8, explicitly
// required): the revision paths refresh projected pricing; direct paths are
// structurally confined to never-published listings.
// ---------------------------------------------------------------------------

describe('price-option mutations refresh projected pricing', () => {
  it('editing an option amount on a published listing routes through revision, and approval refreshes min_price_fils and band filters', async () => {
    const org = await makePublicOrg({ displayName: 'Optrev Amount Org' });
    const scope = ownerScope(org.orgId);
    const deps = { db: testDb.db };
    const actor = { userId: newId() };
    const listing = await makePublishedProgram(org, {
      titleEn: 'Optrevamount Strength Block',
      options: [{ kind: 'monthly', amountFils: 30000 }],
    });
    await rebuildAllSearchDocuments({ db: testDb.db });
    expect(await searchIds({ q: 'optrevamount', priceBand: '100-500' })).toEqual([
      listing.programId,
    ]);

    // DIRECT edit is structurally impossible on a published listing — the
    // service returns a revision, never an in-place mutation.
    const requested = await updatePriceOption(deps, scope, actor, {
      programId: listing.programId,
      optionId: listing.optionIds[0]!,
      expectedVersion: 1,
      patch: { amountFils: 90000 },
    });
    if (requested.kind !== 'revisionSubmitted') throw new Error(requested.kind);
    // Nothing changed before approval — live field AND projection.
    expect(await searchIds({ q: 'optrevamount', priceBand: '100-500' })).toEqual([
      listing.programId,
    ]);
    expect(Number(await docField(listing.programId, 'min_price_fils'))).toBe(30000);

    const started = await startRevisionReview(deps, { userId: ops.userId }, {
      programId: listing.programId,
      revisionId: requested.revisionId,
      expectedVersion: 1,
    });
    if (started.kind !== 'revisionReviewStarted') throw new Error(started.kind);
    const approved = await approveRevision(deps, { userId: ops.userId }, {
      programId: listing.programId,
      revisionId: requested.revisionId,
      expectedVersion: 2,
    });
    if (approved.kind !== 'revisionApproved') throw new Error(approved.kind);

    // Projection refreshed in the SAME transaction as the application:
    // filtering, sorting input, and the displayed derived price all agree.
    expect(Number(await docField(listing.programId, 'min_price_fils'))).toBe(90000);
    expect(await searchIds({ q: 'optrevamount', priceBand: '100-500' })).toEqual([]);
    expect(await searchIds({ q: 'optrevamount', priceBand: 'over-500' })).toEqual([
      listing.programId,
    ]);
    const detail = await app.inject({ method: 'GET', url: `/listings/${listing.programId}` });
    expect(detail.json().listing.fromPrice).toEqual({
      kind: 'from',
      amountFils: 90000,
      currency: 'AED',
    });
    // The option kept its stable id through the revision application.
    expect(detail.json().listing.priceOptions[0].id).toBe(listing.optionIds[0]);
  });

  it('adding an option to a published listing routes through an add-intent revision, and approval refreshes price_kinds and format filters', async () => {
    const org = await makePublicOrg({ displayName: 'Optrev Add Org' });
    const scope = ownerScope(org.orgId);
    const deps = { db: testDb.db };
    const actor = { userId: newId() };
    const listing = await makePublishedProgram(org, {
      titleEn: 'Optrevadd Conditioning Camp',
      options: [{ kind: 'monthly', amountFils: 60000 }],
    });
    await rebuildAllSearchDocuments({ db: testDb.db });
    expect(await searchIds({ q: 'optrevadd', formats: 'dropIn' })).toEqual([]);

    const requested = await addPriceOption(deps, scope, actor, {
      programId: listing.programId,
      option: { kind: 'dropIn', amountFils: 5000 },
    });
    if (requested.kind !== 'revisionSubmitted') throw new Error(requested.kind);
    expect((await docField(listing.programId, 'price_kinds')) as string[]).toEqual(['monthly']);

    const started = await startRevisionReview(deps, { userId: ops.userId }, {
      programId: listing.programId,
      revisionId: requested.revisionId,
      expectedVersion: 1,
    });
    if (started.kind !== 'revisionReviewStarted') throw new Error(started.kind);
    const approved = await approveRevision(deps, { userId: ops.userId }, {
      programId: listing.programId,
      revisionId: requested.revisionId,
      expectedVersion: 2,
    });
    if (approved.kind !== 'revisionApproved') throw new Error(approved.kind);

    expect(((await docField(listing.programId, 'price_kinds')) as string[]).sort()).toEqual([
      'dropIn',
      'monthly',
    ]);
    expect(Number(await docField(listing.programId, 'min_price_fils'))).toBe(5000);
    expect(await searchIds({ q: 'optrevadd', formats: 'dropIn' })).toEqual([listing.programId]);
    expect(await searchIds({ q: 'optrevadd', priceBand: 'under-100' })).toEqual([
      listing.programId,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Deep pagination (task §13): tied ordering keys per sort, cross-sort
// cursor rejection, float-score continuation.
// ---------------------------------------------------------------------------

describe('deterministic pagination under ties, per sort', () => {
  let org: { orgId: string; branchIds: string[] };
  let created: string[];

  beforeAll(async () => {
    org = await makePublicOrg({ displayName: 'Pagewalk Org' });
    created = [];
    for (let i = 0; i < 4; i += 1) {
      const listing = await makePublishedProgram(org, {
        titleEn: 'Pricewalk Studio Session', // identical titles ⇒ tied scores
        options: [{ kind: 'monthly', amountFils: 20000 }], // tied prices
      });
      created.push(listing.programId);
    }
    const free = await makePublishedProgram(org, {
      titleEn: 'Pricewalk Studio Session',
      options: [{ kind: 'free', amountFils: null }],
    });
    created.push(free.programId);
    // Tie the recency key too: identical published_at across all five.
    await sql`UPDATE program SET published_at = '2026-08-03T12:00:00Z'
              WHERE id = ANY(${created}::uuid[])`.execute(testDb.db);
    await rebuildAllSearchDocuments({ db: testDb.db });
  });

  async function walk(params: Record<string, string | number>): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    let rounds = 0;
    do {
      const page = await search({ ...params, limit: 2, ...(cursor === null ? {} : { cursor }) });
      expect(page.statusCode).toBe(200);
      const json = page.json();
      seen.push(...(json.results as { id: string }[]).map((row) => row.id));
      cursor = json.nextCursor;
      rounds += 1;
    } while (cursor !== null && rounds < 10);
    return seen;
  }

  it('relevance: fully tied scores and recency walk completely in stable id order (float keys round-trip exactly)', async () => {
    const single = await searchIds({ q: 'pricewalk studio', limit: 50 });
    expect(single).toEqual([...created].sort()); // all keys tied ⇒ id order
    expect(await walk({ q: 'pricewalk studio' })).toEqual(single);
  });

  it('price: the free listing leads, tied paid amounts break by id, walk is complete with no duplicates', async () => {
    const single = await searchIds({ q: 'pricewalk studio', sort: 'price', limit: 50 });
    expect(single[0]).toBe(created[4]); // free ⇒ 0
    expect(single.slice(1)).toEqual(created.slice(0, 4).sort()); // tied 200 AED ⇒ id order
    expect(await walk({ q: 'pricewalk studio', sort: 'price' })).toEqual(single);
  });

  it('newest: fully tied published_at walks completely in stable id order', async () => {
    const single = await searchIds({ q: 'pricewalk studio', sort: 'newest', limit: 50 });
    expect(single).toEqual([...created].sort());
    expect(await walk({ q: 'pricewalk studio', sort: 'newest' })).toEqual(single);
  });

  it('a cursor minted under one sort is refused under another', async () => {
    const first = await search({ q: 'pricewalk studio', limit: 2 });
    const cursor = first.json().nextCursor as string;
    expect(cursor).not.toBeNull();
    const reused = await search({ q: 'pricewalk studio', sort: 'price', limit: 2, cursor });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().code).toBe('invalidCursor');
    // (An empty terminal page is unreachable by construction: a cursor is
    // only minted when an extra row was proven to exist.)
  });
});

// ---------------------------------------------------------------------------
// Organization display-name → searchable text (event consumer path).
// ---------------------------------------------------------------------------

describe('provider display-name changes propagate to search text', () => {
  it('after the profile update event is consumed, the new storefront name is searchable and hydrated', async () => {
    const org = await makePublicOrg({ displayName: 'Oldnameprov Wellness' });
    const scope = ownerScope(org.orgId);
    const listing = await makePublishedProgram(org, { titleEn: 'Renametest Sauna Ritual' });
    await rebuildAllSearchDocuments({ db: testDb.db });
    await processSearchProjectionEvents({ db: testDb.db }, { limit: 1000 }); // drain backlog
    expect(await searchIds({ q: 'oldnameprov' })).toEqual([listing.programId]);

    const updated = await updatePublicProfile(
      { db: testDb.db },
      scope,
      { userId: newId() },
      { expectedVersion: 2, patch: { displayName: 'Newnameprov Wellness' } },
    );
    if (updated.kind !== 'profileUpdated') throw new Error(updated.kind);

    // Hydrated provider identity is live immediately…
    const beforeConsume = await search({ q: 'renametest sauna' });
    expect(beforeConsume.json().results[0].provider.displayName).toBe('Newnameprov Wellness');
    // …and the searchable TEXT catches up when the outbox event is consumed
    // (the documented §13 event-driven window).
    await processSearchProjectionEvents({ db: testDb.db }, { limit: 1000 });
    expect(await searchIds({ q: 'newnameprov' })).toEqual([listing.programId]);
    expect(await docField(listing.programId, 'display_name')).toBe('Newnameprov Wellness');
  });
});

// ---------------------------------------------------------------------------
// Three-surface visibility parity (task §10) with a stale document.
// ---------------------------------------------------------------------------

describe('visibility parity across detail, storefront listings, and search', () => {
  it('pause hides a listing on all three public surfaces even with a stale ACTIVE document; republish restores all three', async () => {
    const org = await makePublicOrg({ displayName: 'Paritywalk Org' });
    const listing = await makePublishedProgram(org, { titleEn: 'Paritywalk Ice Bath' });
    await rebuildAllSearchDocuments({ db: testDb.db });

    const surfaces = async () => ({
      detail: (await app.inject({ method: 'GET', url: `/listings/${listing.programId}` }))
        .statusCode,
      storefront: (
        (await app.inject({ method: 'GET', url: `/providers/${org.orgId}/listings` })).json()
          .listings as { id: string }[]
      ).some((row) => row.id === listing.programId),
      search: (await searchIds({ q: 'paritywalk ice' })).includes(listing.programId),
    });

    expect(await surfaces()).toEqual({ detail: 200, storefront: true, search: true });

    // Pause WITHOUT refreshing the projection: the document stays ACTIVE
    // (stale), yet every public surface hides the listing via the one
    // centralized predicate.
    await sql`UPDATE program SET listing_state = 'paused'
              WHERE id = ${listing.programId}`.execute(testDb.db);
    expect(await docField(listing.programId, 'active')).toBe(true); // deliberately stale
    expect(await surfaces()).toEqual({ detail: 404, storefront: false, search: false });

    await sql`UPDATE program SET listing_state = 'published'
              WHERE id = ${listing.programId}`.execute(testDb.db);
    expect(await surfaces()).toEqual({ detail: 200, storefront: true, search: true });
  });
});
