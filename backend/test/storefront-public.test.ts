/**
 * S3-4 — customer-public provider storefront read (docs/27 §3, §13.1,
 * §14.9). Real PostgreSQL + Fastify injection, no authentication: the
 * effective-visibility rule (live AND published) with indistinguishable
 * not-founds, active-branch filtering, the exact public projection shape,
 * and the structural public/private lock that fails when an unapproved
 * private column would enter the projection.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { PUBLIC_STOREFRONT_SOURCES } from '../src/modules/provider/services/storefront-read';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: new FakeAccessTokenVerifier(),
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

async function makeStorefrontOrg(options: {
  state: string;
  published: boolean;
  activeBranches?: number;
  inactiveBranches?: number;
}): Promise<{ orgId: string; activeBranchIds: string[] }> {
  const orgId = newId();
  await sql`
    INSERT INTO organization (id, legal_name, trade_name, verification_state,
                              suspended_at, offboarded_at)
    VALUES (${orgId}, 'Very Private Legal Name LLC', 'Trade', ${options.state},
            ${options.state === 'suspended' ? new Date() : null},
            ${options.state === 'offboarded' ? new Date() : null})`.execute(testDb.db);
  await sql`
    INSERT INTO organization_public_profile
      (organization_id, display_name, description_en, public_phone, published)
    VALUES (${orgId}, 'Blue Wave Swimming', 'Swim school for all ages',
            '+971-4-000-0000', ${options.published})`.execute(testDb.db);
  const activeBranchIds: string[] = [];
  for (let i = 0; i < (options.activeBranches ?? 2); i += 1) {
    const id = newId();
    await sql`
      INSERT INTO branch (id, organization_id, label, area_label, address_line,
                          geo_point, facilities)
      VALUES (${id}, ${orgId}, ${`Public Branch ${i + 1}`}, 'Khalifa City',
              'Street 12', '(54.4,24.4)',
              ${sql.raw(`ARRAY['Parking']::text[]`)})`.execute(testDb.db);
    activeBranchIds.push(id);
  }
  for (let i = 0; i < (options.inactiveBranches ?? 0); i += 1) {
    await sql`
      INSERT INTO branch (id, organization_id, label, area_label, active)
      VALUES (${newId()}, ${orgId}, ${`Hidden Branch ${i + 1}`}, 'Area', false)`.execute(
      testDb.db,
    );
  }
  return { orgId, activeBranchIds };
}

function fetchStorefront(orgId: string) {
  return app.inject({ method: 'GET', url: `/providers/${orgId}` });
}

describe('effective public visibility (Amendment A1: live AND published)', () => {
  it('serves a live + published provider and nothing else — every ineligible state is a byte-identical not-found', async () => {
    const eligible = await makeStorefrontOrg({ state: 'live', published: true });
    expect((await fetchStorefront(eligible.orgId)).statusCode).toBe(200);

    const ineligible: string[] = [];
    for (const state of [
      'draft',
      'submitted',
      'in_review',
      'verified',
      'rejected',
      'suspended',
      'offboarded',
    ]) {
      const { orgId } = await makeStorefrontOrg({ state, published: true });
      ineligible.push(orgId);
    }
    const unpublished = await makeStorefrontOrg({ state: 'live', published: false });
    ineligible.push(unpublished.orgId);

    const ghost = await fetchStorefront(newId()); // nonexistent baseline
    expect(ghost.statusCode).toBe(404);
    for (const orgId of ineligible) {
      const response = await fetchStorefront(orgId);
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(ghost.body); // no visibility oracle
    }
  });

  it('requires no authentication of any kind and rejects malformed ids safely', async () => {
    const { orgId } = await makeStorefrontOrg({ state: 'live', published: true });
    const anonymous = await fetchStorefront(orgId);
    expect(anonymous.statusCode).toBe(200);
    // A garbage bearer is irrelevant on the public policy.
    const withGarbageBearer = await app.inject({
      method: 'GET',
      url: `/providers/${orgId}`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(withGarbageBearer.statusCode).toBe(200);

    const malformed = await app.inject({ method: 'GET', url: '/providers/not-a-uuid' });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().code).toBe('validationError');
    // Public responses are not marked no-store (conservative default: no
    // invented cache contract), and carry the nosniff hardening header.
    expect(anonymous.headers['cache-control']).toBeUndefined();
    expect(anonymous.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('public projection (docs/27 §13.1 contract)', () => {
  it('returns exactly the approved customer-safe shape with active branches in stable creation order', async () => {
    const { orgId, activeBranchIds } = await makeStorefrontOrg({
      state: 'live',
      published: true,
      activeBranches: 2,
      inactiveBranches: 2,
    });
    const response = await fetchStorefront(orgId);
    expect(response.statusCode).toBe(200);
    const { provider } = response.json();

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
    expect(provider.id).toBe(orgId);
    expect(provider.displayName).toBe('Blue Wave Swimming');
    expect(provider.verified).toBe(true); // derived from liveness, not stored
    expect(provider.publicPhone).toBe('+971-4-000-0000');

    // Only ACTIVE branches, creation-ordered, and only public fields.
    expect(provider.branches.map((b: { id: string }) => b.id)).toEqual(activeBranchIds);
    for (const branch of provider.branches) {
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
    // Inactive branches do not leak through content or counts.
    expect(response.body).not.toContain('Hidden Branch');
    expect(provider.branches).toHaveLength(2);
  });

  it('never carries private organization, staff, invitation, or security data', async () => {
    const { orgId } = await makeStorefrontOrg({ state: 'live', published: true });
    // Give the org staff + a pending invitation so a leak would have data.
    const userId = newId();
    await sql`INSERT INTO app_user (id) VALUES (${userId})`.execute(testDb.db);
    await sql`INSERT INTO staff_membership (id, user_id, organization_id, role)
              VALUES (${newId()}, ${userId}, ${orgId}, 'owner')`.execute(testDb.db);
    await sql`INSERT INTO staff_invitation (id, organization_id, email, role, invited_by,
                                            token_digest, pepper_version, expires_at)
              VALUES (${newId()}, ${orgId}, 'secret.invitee@example.com', 'coach', ${userId},
                      'digest-value', 1, now() + interval '1 day')`.execute(testDb.db);

    const response = await fetchStorefront(orgId);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('Very Private Legal Name');
    expect(response.body).not.toContain('secret.invitee');
    expect(response.body).not.toContain('digest-value');
    expect(response.body).not.toMatch(
      /legalName|legal_name|commercialTerms|commercial_terms|staff|invitation|verification_state|verificationState|suspended|audit|cognito|token|payout|bank/i,
    );
  });

  it('structural lock: the projection may draw only from the approved column sources, and a new private column cannot leak', async () => {
    // The closed source lists themselves are part of the acceptance: any
    // widening is a reviewable diff HERE, not a silent query change.
    expect(PUBLIC_STOREFRONT_SOURCES.organization).toEqual(['id', 'verification_state']);
    expect(PUBLIC_STOREFRONT_SOURCES.organization_public_profile).toEqual([
      'organization_id',
      'display_name',
      'description_en',
      'description_ar',
      'logo_media_ref',
      'cover_media_ref',
      'gallery_media_refs',
      'public_phone',
      'public_email',
      'public_website',
      'public_instagram',
      'published',
    ]);
    expect(PUBLIC_STOREFRONT_SOURCES.branch).toEqual([
      'id',
      'organization_id',
      'label',
      'address_line',
      'area_label',
      'geo_point',
      'opening_hours',
      'facilities',
      'active',
    ]);
    // Every declared source column really exists (a rename cannot leave a
    // stale lock behind).
    for (const [table, columns] of Object.entries(PUBLIC_STOREFRONT_SOURCES)) {
      const rows = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}`.execute(testDb.db);
      const present = rows.rows.map((r) => r.column_name);
      for (const column of columns) {
        expect(present).toContain(column);
      }
    }

    // Simulate a future migration adding a PRIVATE column to a public-read
    // source table: the explicit projection must not pick it up.
    const { orgId } = await makeStorefrontOrg({ state: 'live', published: true });
    await sql`ALTER TABLE organization_public_profile
              ADD COLUMN internal_review_note text`.execute(testDb.db);
    try {
      await sql`UPDATE organization_public_profile
                SET internal_review_note = 'EXTREMELY-PRIVATE-NOTE'
                WHERE organization_id = ${orgId}`.execute(testDb.db);
      const response = await fetchStorefront(orgId);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('EXTREMELY-PRIVATE-NOTE');
      expect(response.body).not.toContain('internal_review_note');
      // And the lock list itself still refuses the new column by not
      // containing it — extending the projection is an explicit edit.
      expect(
        (PUBLIC_STOREFRONT_SOURCES.organization_public_profile as readonly string[]),
      ).not.toContain('internal_review_note');
    } finally {
      await sql`ALTER TABLE organization_public_profile
                DROP COLUMN internal_review_note`.execute(testDb.db);
    }
  });
});
