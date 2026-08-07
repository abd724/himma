/**
 * S3-5 — bounded Slice-3 hardening closeout (docs/27 §7.8, §16 row S3-5).
 *
 * Adds the negative proofs the S3-1…S3-4 suites did not yet pin down:
 * foreign identifiers inside the step-up staff-management routes, step-up
 * assurance never leaking authority across organizations, and the
 * app-role's inability to bypass triggers or history protections at the
 * DDL/privilege level. Everything else in the closeout checklist is
 * covered by the existing suites, which this commit re-certifies.
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
import { withTransaction } from '../src/db/transaction';
import { createUser } from './helpers/identity-fixtures';
import {
  addMembership,
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/slice3-hardening-pool';
let testDb: TestDb;
let app: FastifyInstance;
let ctx: ProviderTestContext;

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
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function post(url: string, bearer: string, payload?: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe('step-up staff routes: foreign identifiers inside own-org addressing', () => {
  it("revoking another organization's membership or invitation id through A's own addressing is byte-identical to a nonexistent id", async () => {
    const orgA = await createProviderOrg(testDb.db);
    const orgB = await createProviderOrg(testDb.db);
    const ownerA = await staffBearer(ctx, orgA.orgId, 'owner');
    const memberB = await staffBearer(ctx, orgB.orgId, 'front_desk');
    const invitationB = newId();
    await sql`
      INSERT INTO staff_invitation (id, organization_id, email, role, invited_by,
                                    token_digest, pepper_version, expires_at)
      VALUES (${invitationB}, ${orgB.orgId}, 'b.staff@example.com', 'coach',
              ${memberB.userId}, ${'hardening-digest-' + invitationB}, 1,
              now() + interval '1 day')`.execute(testDb.db);

    const membershipUrl = (id: string) =>
      `/provider/organizations/${orgA.orgId}/staff/memberships/${id}/revoke`;
    const foreignMembership = await post(membershipUrl(memberB.membershipId), ownerA.bearer, {
      expectedVersion: 1,
    });
    const ghostMembership = await post(membershipUrl(newId()), ownerA.bearer, {
      expectedVersion: 1,
    });
    expect(foreignMembership.statusCode).toBe(404);
    expect(foreignMembership.body).toBe(ghostMembership.body);

    const invitationUrl = (id: string) =>
      `/provider/organizations/${orgA.orgId}/staff/invitations/${id}/revoke`;
    const foreignInvitation = await post(invitationUrl(invitationB), ownerA.bearer);
    const ghostInvitation = await post(invitationUrl(newId()), ownerA.bearer);
    expect(foreignInvitation.statusCode).toBe(404);
    expect(foreignInvitation.body).toBe(ghostInvitation.body);

    // Nothing in organization B moved.
    const untouched = await sql<{ m: string; i: string }>`
      SELECT
        (SELECT state FROM staff_membership WHERE id = ${memberB.membershipId}) AS m,
        (SELECT state FROM staff_invitation WHERE id = ${invitationB}) AS i`.execute(testDb.db);
    expect(untouched.rows[0]).toEqual({ m: 'active', i: 'sent' });
  });
});

describe('step-up assurance never leaks authority across organizations', () => {
  it('a fully step-up-assured Owner of A remains capability-refused in B — assurance composes with, never replaces, per-org authority', async () => {
    const orgA = await createProviderOrg(testDb.db);
    const orgB = await createProviderOrg(testDb.db);
    await staffBearer(ctx, orgB.orgId, 'owner'); // B's real owner
    const userId = await createUser(testDb.db);
    await addMembership(testDb.db, userId, orgA.orgId, 'owner');
    await addMembership(testDb.db, userId, orgB.orgId, 'coach');
    // Fresh MFA login = full step-up assurance for BOTH requests.
    const { bearer } = await bearerForUser(ctx, userId);

    const inviteBody = { email: 'leak.probe@example.com', role: 'coach', branchScope: { kind: 'all' } };
    const inOwnOrg = await post(
      `/provider/organizations/${orgA.orgId}/staff/invitations`,
      bearer,
      inviteBody,
    );
    expect(inOwnOrg.statusCode).toBe(200);
    const inOtherOrg = await post(
      `/provider/organizations/${orgB.orgId}/staff/invitations`,
      bearer,
      inviteBody,
    );
    expect(inOtherOrg.statusCode).toBe(403); // right org, insufficient role
    expect(inOtherOrg.json().code).toBe('forbidden');
    const invitations = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_invitation
      WHERE organization_id = ${orgB.orgId} AND email = 'leak.probe@example.com'`.execute(
      testDb.db,
    );
    expect(Number(invitations.rows[0]?.n)).toBe(0);
  });
});

describe('app-role privilege closeout (docs/27 §9: himma_app stays least-privilege)', () => {
  const SLICE3_TABLES = [
    'organization',
    'organization_public_profile',
    'branch',
    'staff_membership',
    'staff_membership_branch',
    'staff_invitation',
  ];

  it('DELETE is denied on every Slice-3 table and on the audit/outbox history', async () => {
    for (const table of [...SLICE3_TABLES, 'audit_event', 'outbox_event']) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(`DELETE FROM ${table}`).execute(trx);
        }),
      ).rejects.toThrow(/permission denied|append-only/i);
    }
  });

  it('the app role cannot bypass lifecycle/history triggers through DDL', async () => {
    // Only the table owner may disable triggers or alter tables — the app
    // role's UPDATE grants can never sidestep the state machines.
    for (const statement of [
      'ALTER TABLE staff_membership DISABLE TRIGGER trg_staff_membership_transition',
      'ALTER TABLE organization DISABLE TRIGGER trg_organization_transition',
      'ALTER TABLE staff_invitation DISABLE TRIGGER trg_staff_invitation_transition',
      'DROP TRIGGER trg_staff_membership_last_owner ON staff_membership',
      'ALTER TABLE staff_invitation DROP COLUMN token_digest',
      'ALTER TABLE staff_membership_branch ADD COLUMN backdoor text',
    ]) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(statement).execute(trx);
        }),
      ).rejects.toThrow(/must be owner|permission denied/i);
    }
  });

  it('grants on Slice-3 tables are exactly select/insert/update (select/insert only for scope rows)', async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app'
        AND table_name IN ('organization', 'organization_public_profile', 'branch',
                           'staff_membership', 'staff_membership_branch', 'staff_invitation')
      ORDER BY table_name, privilege_type`.execute(testDb.db);
    const byTable = new Map<string, string[]>();
    for (const row of rows.rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(row.privilege_type);
      byTable.set(row.table_name, list);
    }
    for (const table of SLICE3_TABLES) {
      expect(byTable.get(table)).toEqual(
        table === 'staff_membership_branch'
          ? ['INSERT', 'SELECT']
          : ['INSERT', 'SELECT', 'UPDATE'],
      );
    }
  });
});
