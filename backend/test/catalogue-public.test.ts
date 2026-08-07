/**
 * Slice 4 — customer-public catalogue reads (docs/28 §5/§6/§10/§14/§16.1/§19;
 * docs/24 §5.3/§11). Real PostgreSQL + Fastify injection, no authentication:
 * the compound visibility predicate (published listing AND live org AND
 * published storefront AND ≥1 active branch) with byte-identical not-founds,
 * one-listing-per-Program (never per price option), the §14 derived
 * from-price boundary, active-only taxonomy reads, opaque cursor pagination,
 * privileged-bearer projection parity, and the structural public/private
 * locks that fail when a private column would enter a public projection.
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
import { PUBLIC_LISTING_SOURCES } from '../src/modules/catalogue/services/public-catalogue-read';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/catalogue-public-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;
let activityTypeId: string;
let categoryId: string;

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
    SELECT id FROM category WHERE slug = 'martial-arts'`.execute(testDb.db);
  categoryId = category.rows[0]!.id;
  activityTypeId = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${activityTypeId}, ${categoryId}, 'public-jiu-jitsu', 'Jiu-jitsu')`.execute(
    testDb.db,
  );
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

// ---------------------------------------------------------------------------
// Fixtures — direct SQL walking the REAL trigger-enforced machines; the read
// layer under test consumes authoritative database state only.
// ---------------------------------------------------------------------------

async function makePublicOrg(
  options: { displayName?: string; state?: string; published?: boolean; branches?: number } = {},
): Promise<{ orgId: string; branchIds: string[] }> {
  const org = await createProviderOrg(testDb.db, {
    state: options.state ?? 'live',
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    branches: options.branches ?? 2,
  });
  await sql`UPDATE organization_public_profile SET published = ${options.published ?? true}
            WHERE organization_id = ${org.orgId}`.execute(testDb.db);
  return org;
}

const STATE_WALKS: Record<string, string[]> = {
  draft: [],
  submitted: ['submitted'],
  in_review: ['submitted', 'in_review'],
  approved: ['submitted', 'in_review', 'approved'],
  changes_requested: ['submitted', 'in_review', 'changes_requested'],
  published: ['submitted', 'in_review', 'approved', 'published'],
  paused: ['submitted', 'in_review', 'approved', 'published', 'paused'],
  archived: ['submitted', 'in_review', 'approved', 'published', 'archived'],
};

interface OptionFixture {
  kind: string;
  amountFils?: number | null;
  sessionsCount?: number | null;
  labelEn?: string | null;
  sortHint?: number;
  state?: string;
}

interface OfferFixture {
  kind: string;
  labelEn: string;
  trialAmountFils?: number;
  state?: string;
  start?: Date | null;
  end?: Date | null;
}

async function makeProgram(
  org: { orgId: string; branchIds: string[] },
  fixture: {
    state?: string;
    titleEn?: string;
    titleAr?: string | null;
    branchIds?: string[];
    options?: OptionFixture[];
    media?: { altTextEn?: string | null; sortHint?: number; active?: boolean }[];
    offers?: OfferFixture[];
  } = {},
): Promise<{ programId: string; optionIds: string[] }> {
  const programId = newId();
  await sql`
    INSERT INTO program (id, organization_id, activity_type_id, title_en, title_ar,
                         description_en, setting, gender_eligibility)
    VALUES (${programId}, ${org.orgId}, ${activityTypeId},
            ${fixture.titleEn ?? 'Adult Beginner Jiu-Jitsu'}, ${fixture.titleAr ?? null},
            'A calm, technical fundamentals program.', 'indoor', 'mixed')`.execute(testDb.db);
  for (const branchId of fixture.branchIds ?? [org.branchIds[0]!]) {
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${programId}, ${branchId}, ${org.orgId})`.execute(testDb.db);
  }
  const optionIds: string[] = [];
  for (const option of fixture.options ?? [{ kind: 'monthly', amountFils: 60000 }]) {
    const optionId = newId();
    await sql`
      INSERT INTO program_price_option
        (id, program_id, organization_id, kind, amount_fils, sessions_count,
         label_en, sort_hint, state)
      VALUES (${optionId}, ${programId}, ${org.orgId}, ${option.kind},
              ${option.amountFils ?? null}, ${option.sessionsCount ?? null},
              ${option.labelEn ?? null}, ${option.sortHint ?? 0},
              ${option.state ?? 'active'})`.execute(testDb.db);
    optionIds.push(optionId);
  }
  for (const media of fixture.media ?? []) {
    await sql`
      INSERT INTO program_media (id, program_id, organization_id, media_ref,
                                 sort_hint, alt_text_en, active)
      VALUES (${newId()}, ${programId}, ${org.orgId}, ${newId()},
              ${media.sortHint ?? 0}, ${media.altTextEn ?? null},
              ${media.active ?? true})`.execute(testDb.db);
  }
  for (const offer of fixture.offers ?? []) {
    await sql`
      INSERT INTO offer (id, program_id, organization_id, kind, label_en,
                         trial_amount_fils, effective_start, effective_end, state)
      VALUES (${newId()}, ${programId}, ${org.orgId}, ${offer.kind}, ${offer.labelEn},
              ${offer.trialAmountFils ?? null}, ${offer.start ?? null}, ${offer.end ?? null},
              ${offer.state ?? 'active'})`.execute(testDb.db);
  }
  for (const state of STATE_WALKS[fixture.state ?? 'published'] ?? []) {
    await sql`
      UPDATE program SET listing_state = ${state},
        published_at = CASE WHEN ${state} = 'published' THEN now() ELSE published_at END,
        archived_at  = CASE WHEN ${state} = 'archived'  THEN now() ELSE archived_at  END
      WHERE id = ${programId}`.execute(testDb.db);
  }
  return { programId, optionIds };
}

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

function getListing(programId: string, bearer?: string) {
  return app.inject({
    method: 'GET',
    url: `/listings/${programId}`,
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });
}

function getStorefrontListings(orgId: string, query = '') {
  return app.inject({ method: 'GET', url: `/providers/${orgId}/listings${query}` });
}

/** Every serialized key in a public payload, recursively. */
function collectKeys(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

const PRIVATE_MARKERS =
  /legalName|legal_name|verificationState|verification_state|listingState|listing_state|sensitiveFields|sensitive_fields|revision|moderation|audit|outbox|cognito|token|payout|bank|commercial|staff|invitation|suspended|offboarded|publishedAt|published_at|archivedAt|archived_at|createdBy|submitted_by|decided_by/i;

const NO_FAKE_MARKETPLACE =
  /rating|reviewCount|review_count|popularity|availableToday|available_today|nextSession|next_session|capacity|bookedCount|booked_count|attendance|scheduleLabel|schedule_label|bookingStatus|paymentStatus|discountApplied/;

const LISTING_DETAIL_KEYS = [
  'activityType',
  'allAges',
  'branches',
  'category',
  'descriptionAr',
  'descriptionEn',
  'eligibilityNotes',
  'fromPrice',
  'genderEligibility',
  'id',
  'maxAge',
  'media',
  'minAge',
  'offers',
  'priceOptions',
  'provider',
  'setting',
  'skillLevel',
  'titleAr',
  'titleEn',
];

const LISTING_SUMMARY_KEYS = [
  'activityType',
  'allAges',
  'category',
  'fromPrice',
  'genderEligibility',
  'id',
  'maxAge',
  'media',
  'minAge',
  'offerBadges',
  'setting',
  'skillLevel',
  'titleAr',
  'titleEn',
];

// ---------------------------------------------------------------------------
// Visibility — the docs/28 §6 compound predicate, byte-identical not-founds.
// ---------------------------------------------------------------------------

describe('public listing visibility (docs/28 §6 predicate)', () => {
  it('serves an eligible published listing anonymously and hides every other lifecycle state byte-identically', async () => {
    const org = await makePublicOrg();
    const eligible = await makeProgram(org, { state: 'published' });
    const response = await getListing(eligible.programId);
    expect(response.statusCode).toBe(200);
    expect(response.json().listing.id).toBe(eligible.programId);

    const ghost = await getListing(newId());
    expect(ghost.statusCode).toBe(404);
    // Row existence is never enough: draft, submitted, in_review, approved
    // (approval alone never publishes — D-S4-2), changes_requested, paused,
    // and archived are all the SAME not-found as a nonexistent id.
    for (const state of [
      'draft',
      'submitted',
      'in_review',
      'approved',
      'changes_requested',
      'paused',
      'archived',
    ]) {
      const hidden = await makeProgram(org, { state });
      const hiddenResponse = await getListing(hidden.programId);
      expect(hiddenResponse.statusCode).toBe(404);
      expect(hiddenResponse.body).toBe(ghost.body);
    }
  });

  it('hides published listings of non-live, suspended, or storefront-unpublished providers', async () => {
    const ghostBody = (await getListing(newId())).body;

    // Verified-but-not-live organization.
    const notLive = await makePublicOrg({ state: 'verified' });
    const notLiveListing = await makeProgram(notLive, { state: 'published' });
    const notLiveResponse = await getListing(notLiveListing.programId);
    expect(notLiveResponse.statusCode).toBe(404);
    expect(notLiveResponse.body).toBe(ghostBody);

    // Unpublished storefront profile.
    const unpublished = await makePublicOrg({ published: false });
    const unpublishedListing = await makeProgram(unpublished, { state: 'published' });
    expect((await getListing(unpublishedListing.programId)).body).toBe(ghostBody);

    // Suspension bites immediately, reinstatement restores.
    const org = await makePublicOrg();
    const listing = await makeProgram(org, { state: 'published' });
    expect((await getListing(listing.programId)).statusCode).toBe(200);
    await sql`UPDATE organization SET verification_state = 'suspended', suspended_at = now()
              WHERE id = ${org.orgId}`.execute(testDb.db);
    const whileSuspended = await getListing(listing.programId);
    expect(whileSuspended.statusCode).toBe(404);
    expect(whileSuspended.body).toBe(ghostBody);
    await sql`UPDATE organization SET verification_state = 'live', suspended_at = NULL
              WHERE id = ${org.orgId}`.execute(testDb.db);
    expect((await getListing(listing.programId)).statusCode).toBe(200);
  });

  it('requires ≥1 active branch through an active association, live against current state', async () => {
    const org = await makePublicOrg({ branches: 1 });
    const listing = await makeProgram(org, { state: 'published' });
    expect((await getListing(listing.programId)).statusCode).toBe(200);

    // Association deactivated → hidden immediately.
    await sql`UPDATE program_branch SET active = false
              WHERE program_id = ${listing.programId}`.execute(testDb.db);
    expect((await getListing(listing.programId)).statusCode).toBe(404);
    await sql`UPDATE program_branch SET active = true
              WHERE program_id = ${listing.programId}`.execute(testDb.db);
    expect((await getListing(listing.programId)).statusCode).toBe(200);

    // Branch itself deactivated → hidden immediately.
    await sql`UPDATE branch SET active = false
              WHERE id = ${org.branchIds[0]!}`.execute(testDb.db);
    expect((await getListing(listing.programId)).statusCode).toBe(404);
    await sql`UPDATE branch SET active = true
              WHERE id = ${org.branchIds[0]!}`.execute(testDb.db);
    expect((await getListing(listing.programId)).statusCode).toBe(200);
  });

  it('storefront pause/unpublish and listing pause bite the public read with no lifecycle oracle', async () => {
    const org = await makePublicOrg();
    const listing = await makeProgram(org, { state: 'published' });
    const ghostBody = (await getListing(newId())).body;

    await sql`UPDATE organization_public_profile SET published = false
              WHERE organization_id = ${org.orgId}`.execute(testDb.db);
    const hidden = await getListing(listing.programId);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(ghostBody);
    await sql`UPDATE organization_public_profile SET published = true
              WHERE organization_id = ${org.orgId}`.execute(testDb.db);

    await sql`UPDATE program SET listing_state = 'paused'
              WHERE id = ${listing.programId}`.execute(testDb.db);
    const paused = await getListing(listing.programId);
    expect(paused.statusCode).toBe(404);
    expect(paused.body).toBe(ghostBody);
  });
});

// ---------------------------------------------------------------------------
// Projection — the §5/§14 customer-safe shape, nothing else.
// ---------------------------------------------------------------------------

describe('public listing detail projection (docs/28 §5/§14/§16.1)', () => {
  it('returns exactly the approved customer-facing shape with provider identity, active branches, ordered media, taxonomy, options, and current offers', async () => {
    const org = await makePublicOrg({ displayName: 'Desert Grapplers', branches: 2 });
    const now = Date.now();
    const listing = await makeProgram(org, {
      state: 'published',
      titleEn: 'Adult Beginner Jiu-Jitsu',
      titleAr: null,
      branchIds: org.branchIds,
      options: [
        { kind: 'monthly', amountFils: 60000, labelEn: 'Monthly', sortHint: 20 },
        { kind: 'term', amountFils: 150000, labelEn: '3 months', sortHint: 30 },
        { kind: 'package', amountFils: 90000, sessionsCount: 5, sortHint: 40 },
      ],
      media: [
        { altTextEn: 'Mat area', sortHint: 20 },
        { altTextEn: 'Front desk', sortHint: 10 },
        { altTextEn: 'Retired photo', sortHint: 0, active: false },
      ],
      offers: [
        { kind: 'paidTrial', labelEn: 'Trial class', trialAmountFils: 5000 },
        { kind: 'promo', labelEn: 'Ended promo', state: 'ended' },
        { kind: 'discount', labelEn: 'Past window', end: new Date(now - 86_400_000) },
        { kind: 'discount', labelEn: 'Future window', start: new Date(now + 86_400_000) },
      ],
    });

    const response = await getListing(listing.programId);
    expect(response.statusCode).toBe(200);
    const { listing: body } = response.json();

    expect(Object.keys(body).sort()).toEqual(LISTING_DETAIL_KEYS);
    expect(body.provider).toEqual({ id: org.orgId, displayName: 'Desert Grapplers' });
    expect(Object.keys(body.activityType).sort()).toEqual(['id', 'labelAr', 'labelEn', 'slug']);
    expect(body.activityType.slug).toBe('public-jiu-jitsu');
    expect(body.category.slug).toBe('martial-arts');
    expect(body.titleAr).toBeNull(); // Arabic NULL never suppresses the row

    // Branches: public branch shape only, both active branches.
    expect(body.branches).toHaveLength(2);
    for (const branch of body.branches) {
      expect(Object.keys(branch).sort()).toEqual([
        'addressLine',
        'areaLabel',
        'facilities',
        'geoPoint',
        'id',
        'label',
        'openingHours',
      ]);
    }

    // Media: ACTIVE references only, deterministic (sortHint) order.
    expect(body.media.map((m: { altTextEn: string }) => m.altTextEn)).toEqual([
      'Front desk',
      'Mat area',
    ]);
    for (const media of body.media) {
      expect(Object.keys(media).sort()).toEqual(['altTextAr', 'altTextEn', 'mediaRef']);
    }

    // Offers: only currently applicable (active + inside effective window).
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0].kind).toBe('paidTrial');
    expect(body.offers[0].trialAmountFils).toBe(5000);
    expect(Object.keys(body.offers[0]).sort()).toEqual([
      'currency',
      'id',
      'kind',
      'labelAr',
      'labelEn',
      'trialAmountFils',
    ]);

    // No snake_case leakage anywhere in the public payload.
    const keys = collectKeys(response.json(), new Set<string>());
    for (const key of keys) expect(key).not.toContain('_');
    // No private/provider/admin/lifecycle markers, no fake marketplace data.
    expect(response.body).not.toMatch(PRIVATE_MARKERS);
    expect(response.body).not.toMatch(NO_FAKE_MARKETPLACE);
    expect(response.body).not.toContain('"version"');
  });

  it('a privileged provider or admin bearer receives the identical public projection', async () => {
    const org = await makePublicOrg();
    const listing = await makeProgram(org, { state: 'published' });
    const anonymous = await getListing(listing.programId);
    expect(anonymous.statusCode).toBe(200);

    const owner = await staffBearer(ctx, org.orgId, 'owner');
    const ops = await makeAdmin('operations');
    const asOwner = await getListing(listing.programId, owner.bearer);
    const asAdmin = await getListing(listing.programId, ops.bearer);
    const withGarbage = await getListing(listing.programId, 'not-a-real-token');
    expect(asOwner.body).toBe(anonymous.body);
    expect(asAdmin.body).toBe(anonymous.body);
    expect(withGarbage.body).toBe(anonymous.body);
  });
});

// ---------------------------------------------------------------------------
// Price options and the §14 derived-price boundary (D-S4-1).
// ---------------------------------------------------------------------------

describe('price options under one listing (D-S4-1; docs/28 §14)', () => {
  it('one Program with several options stays ONE listing carrying active option summaries in deterministic order', async () => {
    const org = await makePublicOrg();
    const listing = await makeProgram(org, {
      state: 'published',
      options: [
        { kind: 'term', amountFils: 150000, labelEn: '3 months', sortHint: 30 },
        { kind: 'monthly', amountFils: 60000, labelEn: 'Monthly', sortHint: 10 },
        { kind: 'monthly', amountFils: 45000, labelEn: 'Archived legacy', sortHint: 5, state: 'archived' },
      ],
    });

    const detail = await getListing(listing.programId);
    const options = detail.json().listing.priceOptions;
    // Archived options are omitted; active ones keep (sortHint, id) order.
    expect(options.map((o: { labelEn: string }) => o.labelEn)).toEqual(['Monthly', '3 months']);
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual([
        'amountFils',
        'currency',
        'id',
        'kind',
        'labelAr',
        'labelEn',
        'sessionsCount',
      ]);
    }
    expect(options[0].id).toBe(listing.optionIds[1]);

    // The storefront collection shows ONE row for the multi-option listing.
    const storefront = await getStorefrontListings(org.orgId);
    const rows = storefront
      .json()
      .listings.filter((row: { id: string }) => row.id === listing.programId);
    expect(rows).toHaveLength(1);
  });

  it('derives fromPrice over ACTIVE options only and recomputes when the cheapest option is archived', async () => {
    const org = await makePublicOrg();
    const listing = await makeProgram(org, {
      state: 'published',
      options: [
        { kind: 'dropIn', amountFils: 8000, sortHint: 10 },
        { kind: 'monthly', amountFils: 60000, sortHint: 20 },
      ],
    });
    const before = await getListing(listing.programId);
    expect(before.json().listing.fromPrice).toEqual({
      kind: 'from',
      amountFils: 8000,
      currency: 'AED',
    });

    await sql`UPDATE program_price_option SET state = 'archived'
              WHERE id = ${listing.optionIds[0]!}`.execute(testDb.db);
    const after = await getListing(listing.programId);
    expect(after.json().listing.fromPrice).toEqual({
      kind: 'from',
      amountFils: 60000,
      currency: 'AED',
    });

    const free = await makeProgram(org, {
      state: 'published',
      options: [
        { kind: 'free', amountFils: null },
        { kind: 'monthly', amountFils: 30000 },
      ],
    });
    expect((await getListing(free.programId)).json().listing.fromPrice).toEqual({ kind: 'free' });
  });

  it('no authoritative Program.price exists — pricing is the option child, and Offer stays a distinct structure', async () => {
    const priceColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'program'
        AND column_name ILIKE '%price%'`.execute(testDb.db);
    expect(priceColumns.rows).toEqual([]);

    const org = await makePublicOrg();
    const listing = await makeProgram(org, {
      state: 'published',
      options: [{ kind: 'monthly', amountFils: 60000 }],
      offers: [{ kind: 'freeTrial', labelEn: 'Free trial class' }],
    });
    const body = (await getListing(listing.programId)).json().listing;
    // Offers and price options are separate public structures; the offer
    // never appears as a price option and no top-level `price` field exists.
    expect(body.priceOptions).toHaveLength(1);
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0].kind).toBe('freeTrial');
    expect(Object.keys(body)).not.toContain('price');
  });
});

// ---------------------------------------------------------------------------
// Storefront listings collection (docs/28 §19).
// ---------------------------------------------------------------------------

describe('public provider storefront listings (docs/28 §19)', () => {
  it('returns only the addressed storefront’s eligible listings with provider identity and summary rows', async () => {
    const orgA = await makePublicOrg({ displayName: 'Storefront A' });
    const orgB = await makePublicOrg({ displayName: 'Storefront B' });
    const visible = await makeProgram(orgA, { state: 'published', titleEn: 'A Published' });
    await makeProgram(orgA, { state: 'draft', titleEn: 'A Draft' });
    await makeProgram(orgA, { state: 'approved', titleEn: 'A Approved' });
    await makeProgram(orgA, { state: 'paused', titleEn: 'A Paused' });
    await makeProgram(orgA, { state: 'archived', titleEn: 'A Archived' });
    const foreign = await makeProgram(orgB, { state: 'published', titleEn: 'B Published' });

    const response = await getStorefrontListings(orgA.orgId);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.provider).toEqual({ id: orgA.orgId, displayName: 'Storefront A' });
    expect(body.listings.map((row: { id: string }) => row.id)).toEqual([visible.programId]);
    expect(body.nextCursor).toBeNull();
    expect(Object.keys(body.listings[0]).sort()).toEqual(LISTING_SUMMARY_KEYS);
    // No cross-provider leakage in either direction.
    expect(response.body).not.toContain(foreign.programId);
    expect(response.body).not.toContain('B Published');
    const otherSide = await getStorefrontListings(orgB.orgId);
    expect(otherSide.json().listings.map((row: { id: string }) => row.id)).toEqual([
      foreign.programId,
    ]);
    // Hidden titles never leak through the collection body.
    for (const hidden of ['A Draft', 'A Approved', 'A Paused', 'A Archived']) {
      expect(response.body).not.toContain(hidden);
    }
  });

  it('an ineligible or unknown storefront is the same not-found as the S3-4 storefront read', async () => {
    const ghost = await getStorefrontListings(newId());
    expect(ghost.statusCode).toBe(404);
    const suspended = await makePublicOrg({ state: 'suspended' });
    await makeProgram(suspended, { state: 'published' });
    const suspendedResponse = await getStorefrontListings(suspended.orgId);
    expect(suspendedResponse.statusCode).toBe(404);
    expect(suspendedResponse.body).toBe(ghost.body);
    const unpublished = await makePublicOrg({ published: false });
    expect((await getStorefrontListings(unpublished.orgId)).body).toBe(ghost.body);

    // A visible storefront with no eligible listings is an EMPTY page, not 404.
    const empty = await makePublicOrg();
    const emptyResponse = await getStorefrontListings(empty.orgId);
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json().listings).toEqual([]);
  });

  it('paginates deterministically with an opaque, stable cursor — no duplicate or missing rows', async () => {
    const org = await makePublicOrg({ displayName: 'Paginated Provider' });
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const listing = await makeProgram(org, { state: 'published', titleEn: `Listing ${i + 1}` });
      created.push(listing.programId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await getStorefrontListings(org.orgId, query);
      expect(page.statusCode).toBe(200);
      const json = page.json();
      expect(json.listings.length).toBeLessThanOrEqual(2);
      seen.push(...json.listings.map((row: { id: string }) => row.id));
      cursor = json.nextCursor;
      if (cursor !== null) {
        // Opaque: never a raw row id.
        expect(cursor).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
      }
      pages += 1;
    } while (cursor !== null && pages < 10);

    // Stable creation (UUIDv7) order, complete, no duplicates.
    expect(seen).toEqual(created);
  });

  it('rejects malformed cursors and out-of-range limits with typed public errors', async () => {
    const org = await makePublicOrg();
    const malformed = await getStorefrontListings(org.orgId, '?cursor=%2B%2B%2B%2B');
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().code).toBe('invalidCursor');

    const wrongPayload = await getStorefrontListings(
      org.orgId,
      `?cursor=${Buffer.from('not-a-listing-cursor').toString('base64url')}`,
    );
    expect(wrongPayload.statusCode).toBe(422);
    expect(wrongPayload.json().code).toBe('invalidCursor');

    const badLimit = await getStorefrontListings(org.orgId, '?limit=500');
    expect(badLimit.statusCode).toBe(422);
    expect(badLimit.json().code).toBe('validationError');
  });
});

// ---------------------------------------------------------------------------
// Public taxonomy reads (docs/28 §16.1; D-S4-3).
// ---------------------------------------------------------------------------

describe('public taxonomy reads (active-only, deterministic, launch rules)', () => {
  it('categories: canonical seeded rows in deterministic order, active only, Arabic optional, no admin metadata', async () => {
    const inactiveId = newId();
    await sql`INSERT INTO category (id, slug, label_en, sort_hint, active)
              VALUES (${inactiveId}, 'public-retired-cat', 'Retired', 900, false)`.execute(
      testDb.db,
    );
    const response = await app.inject({ method: 'GET', url: '/catalogue/categories' });
    expect(response.statusCode).toBe(200);
    const { categories } = response.json();
    // The docs/15 §3 eleven seeded categories lead in seed (sort_hint) order.
    expect(categories.slice(0, 11).map((c: { slug: string }) => c.slug)).toEqual([
      'fitness',
      'martial-arts',
      'swimming',
      'padel-racquet',
      'pilates-yoga',
      'team-outdoor',
      'wellness',
      'learning',
      'quran',
      'tech-stem',
      'arts-creativity',
    ]);
    expect(categories.map((c: { slug: string }) => c.slug)).not.toContain('public-retired-cat');
    for (const category of categories) {
      expect(Object.keys(category).sort()).toEqual(['id', 'imageRef', 'labelAr', 'labelEn', 'slug']);
      expect(category.labelEn).toBeTruthy(); // Arabic may be NULL, English never
    }
    expect(response.body).not.toContain('"version"');
    expect(response.body).not.toContain('sort_hint');
  });

  it('activity types: active rows under active categories only, with correct category relationships and no synonym/search metadata', async () => {
    const hiddenCategoryId = newId();
    await sql`INSERT INTO category (id, slug, label_en, sort_hint, active)
              VALUES (${hiddenCategoryId}, 'public-hidden-cat', 'Hidden', 901, false)`.execute(
      testDb.db,
    );
    const underHidden = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
              VALUES (${underHidden}, ${hiddenCategoryId}, 'public-orphan-type', 'Orphan')`.execute(
      testDb.db,
    );
    const inactiveType = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en, active)
              VALUES (${inactiveType}, ${categoryId}, 'public-retired-type', 'Retired', false)`.execute(
      testDb.db,
    );

    const response = await app.inject({ method: 'GET', url: '/catalogue/activity-types' });
    expect(response.statusCode).toBe(200);
    const { activityTypes } = response.json();
    const slugs = activityTypes.map((t: { slug: string }) => t.slug);
    expect(slugs).toContain('public-jiu-jitsu');
    expect(slugs).not.toContain('public-retired-type'); // inactive omitted
    expect(slugs).not.toContain('public-orphan-type'); // inactive parent omitted
    const jiuJitsu = activityTypes.find((t: { slug: string }) => t.slug === 'public-jiu-jitsu');
    expect(jiuJitsu.categoryId).toBe(categoryId); // relationship preserved
    for (const type of activityTypes) {
      expect(Object.keys(type).sort()).toEqual(['categoryId', 'id', 'labelAr', 'labelEn', 'slug']);
    }
    expect(response.body).not.toContain('synonym');
  });

  it('collections: published rows only with editorial fields, no preset/filter internals', async () => {
    await sql`INSERT INTO collection (id, title_en, state)
              VALUES (${newId()}, 'Public Draft Collection', 'draft')`.execute(testDb.db);
    await sql`INSERT INTO collection (id, title_en, state)
              VALUES (${newId()}, 'Public Archived Collection', 'archived')`.execute(testDb.db);

    const response = await app.inject({ method: 'GET', url: '/catalogue/collections' });
    expect(response.statusCode).toBe(200);
    const { collections } = response.json();
    const titles = collections.map((c: { titleEn: string }) => c.titleEn);
    expect(titles).toContain('Kids & Teens');
    expect(titles).toContain('Camps & seasonal');
    expect(titles).not.toContain('Public Draft Collection');
    expect(titles).not.toContain('Public Archived Collection');
    for (const collection of collections) {
      expect(Object.keys(collection).sort()).toEqual([
        'audience',
        'childFocused',
        'featured',
        'id',
        'imageRef',
        'seasonalLabel',
        'subtitleAr',
        'subtitleEn',
        'titleAr',
        'titleEn',
      ]);
    }
    // Collection resolution to results is the later search commit; the
    // preset booleans are server-side data and never a public contract.
    expect(response.body).not.toContain('preset');
  });

  it('areas: active canonical rows in deterministic order', async () => {
    const areaB = newId();
    const areaA = newId();
    await sql`INSERT INTO area (id, slug, label_en, city, sort_hint)
              VALUES (${areaB}, 'public-area-b', 'Khalifa City', 'Abu Dhabi', 20)`.execute(
      testDb.db,
    );
    await sql`INSERT INTO area (id, slug, label_en, sort_hint)
              VALUES (${areaA}, 'public-area-a', 'Al Nahyan', 10)`.execute(testDb.db);
    await sql`INSERT INTO area (id, slug, label_en, sort_hint, active)
              VALUES (${newId()}, 'public-area-x', 'Retired Area', 5, false)`.execute(testDb.db);

    const response = await app.inject({ method: 'GET', url: '/catalogue/areas' });
    expect(response.statusCode).toBe(200);
    const { areas } = response.json();
    expect(areas.map((a: { slug: string }) => a.slug)).toEqual(['public-area-a', 'public-area-b']);
    for (const area of areas) {
      expect(Object.keys(area).sort()).toEqual(['city', 'id', 'labelAr', 'labelEn', 'slug']);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural locks + route inventory.
// ---------------------------------------------------------------------------

describe('structural public/private separation and route inventory', () => {
  it('the public listing projection draws only from the closed column sources, and a new private column cannot leak', async () => {
    // The lock lists are part of the acceptance: widening them is a
    // reviewable diff here, never a silent query change.
    for (const [table, columns] of Object.entries(PUBLIC_LISTING_SOURCES)) {
      const rows = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}`.execute(testDb.db);
      const present = rows.rows.map((r) => r.column_name);
      for (const column of columns) {
        expect(present).toContain(column);
      }
    }

    const org = await makePublicOrg();
    const listing = await makeProgram(org, { state: 'published' });
    await sql`ALTER TABLE program ADD COLUMN internal_review_note text`.execute(testDb.db);
    try {
      await sql`UPDATE program SET internal_review_note = 'EXTREMELY-PRIVATE-NOTE'
                WHERE id = ${listing.programId}`.execute(testDb.db);
      const detail = await getListing(listing.programId);
      expect(detail.statusCode).toBe(200);
      expect(detail.body).not.toContain('EXTREMELY-PRIVATE-NOTE');
      const collection = await getStorefrontListings(org.orgId);
      expect(collection.body).not.toContain('EXTREMELY-PRIVATE-NOTE');
      expect((PUBLIC_LISTING_SOURCES.program as readonly string[])).not.toContain(
        'internal_review_note',
      );
    } finally {
      await sql`ALTER TABLE program DROP COLUMN internal_review_note`.execute(testDb.db);
    }
  });

  it('the inventory gains exactly the six public catalogue GET routes — no public mutation', () => {
    const publicCatalogue = app.routePolicyInventory.filter(
      (route) =>
        route.method !== 'HEAD' &&
        (route.url === '/listings/:programId' ||
          route.url === '/providers/:organizationId/listings' ||
          route.url.startsWith('/catalogue/')),
    );
    expect(publicCatalogue.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
      'GET /catalogue/activity-types',
      'GET /catalogue/areas',
      'GET /catalogue/categories',
      'GET /catalogue/collections',
      'GET /listings/:programId',
      'GET /providers/:organizationId/listings',
    ]);
    for (const route of publicCatalogue) {
      expect(route.policy).toBe('public');
    }
    // Public routes are reads only — no mutation rides the public policy.
    for (const route of app.routePolicyInventory.filter((r) => r.policy === 'public')) {
      expect(['GET', 'HEAD']).toContain(route.method);
    }
    // The search surface (GET /search) arrived with the owner-approved
    // search-foundation task and is locked by catalogue-search.test.ts.
  });

  it('the S3-4 public storefront contract is untouched by the listings composition', async () => {
    const org = await makePublicOrg({ displayName: 'Contract Stability' });
    await makeProgram(org, { state: 'published' });
    const storefront = await app.inject({ method: 'GET', url: `/providers/${org.orgId}` });
    expect(storefront.statusCode).toBe(200);
    const { provider } = storefront.json();
    // Exactly the S3-4 shape — composing listings adds NOTHING here.
    expect(Object.keys(provider).sort()).toEqual([
      'branches',
      'coverMediaRef',
      'descriptionAr',
      'descriptionEn',
      'displayName',
      'galleryMediaRefs',
      'id',
      'logoMediaRef',
      'publicEmail',
      'publicInstagram',
      'publicPhone',
      'publicWebsite',
      'verified',
    ]);
    expect(storefront.body).not.toContain('listings');
  });
});
