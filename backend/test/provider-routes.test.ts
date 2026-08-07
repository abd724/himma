/**
 * S3-3 — provider-private management routes (docs/27 §13.2; §14.3–4, §14.8).
 * Real PostgreSQL + Fastify injection with fully MFA-assured principals:
 * the role × route capability matrix, organization isolation, branch-scope
 * enforcement, staff-management authorization (last-owner, history,
 * escalation), profile/branch/submit flows with CAS, invitation flows over
 * HTTP, projection safety, response hygiene, and rate limits.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { PROVIDER_ROLES, type ProviderRole } from '../src/modules/provider/provider-roles';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/provider-routes-pool';
let testDb: TestDb;
let app: FastifyInstance;
let mail: CaptureMailSender;
let ctx: ProviderTestContext;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  mail = new CaptureMailSender();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: mail,
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

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, bearer: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

function tokenFromLastMail(): string {
  const body = mail.captured[mail.captured.length - 1]?.body ?? '';
  const match = /accept: (\S+)/.exec(body);
  if (match?.[1] === undefined) throw new Error('no invitation token captured');
  return match[1];
}

describe('role × route capability matrix (docs/27 §6/§14.8 — exact active set, nothing more)', () => {
  it('each role receives exactly its approved Slice-3 reach on every provider route', async () => {
    const { orgId, branchIds } = await createProviderOrg(testDb.db);
    const b1 = branchIds[0] as string;
    // A standing owner keeps the org valid; matrix probes use per-role users.
    await staffBearer(ctx, orgId, 'owner');

    const expectations: Record<
      ProviderRole,
      { view: number; profile: number; branchCreate: number; branchEdit: number; deactivate: number; staffRead: number; invite: number; submit: number }
    > = {
      owner: { view: 200, profile: 200, branchCreate: 200, branchEdit: 200, deactivate: 200, staffRead: 200, invite: 200, submit: 409 },
      org_manager: { view: 200, profile: 200, branchCreate: 200, branchEdit: 200, deactivate: 200, staffRead: 403, invite: 403, submit: 403 },
      branch_manager: { view: 200, profile: 403, branchCreate: 403, branchEdit: 200, deactivate: 403, staffRead: 403, invite: 403, submit: 403 },
      listings_editor: { view: 200, profile: 403, branchCreate: 403, branchEdit: 403, deactivate: 403, staffRead: 403, invite: 403, submit: 403 },
      coach: { view: 200, profile: 403, branchCreate: 403, branchEdit: 403, deactivate: 403, staffRead: 403, invite: 403, submit: 403 },
      front_desk: { view: 200, profile: 403, branchCreate: 403, branchEdit: 403, deactivate: 403, staffRead: 403, invite: 403, submit: 403 },
      finance: { view: 200, profile: 403, branchCreate: 403, branchEdit: 403, deactivate: 403, staffRead: 403, invite: 403, submit: 403 },
    };

    for (const role of PROVIDER_ROLES) {
      const scoped = ['branch_manager', 'listings_editor', 'coach', 'front_desk'].includes(role);
      const staff = await staffBearer(ctx, orgId, role, {
        ...(scoped ? { scopeBranchIds: [b1] } : {}),
      });
      const expected = expectations[role];
      const base = `/provider/organizations/${orgId}`;

      const view = await inject('GET', base, staff.bearer);
      expect(`${role} view ${view.statusCode}`).toBe(`${role} view ${expected.view}`);

      const profileVersion = await sql<{ version: number }>`
        SELECT version FROM organization_public_profile
        WHERE organization_id = ${orgId}`.execute(testDb.db);
      const profile = await inject('PATCH', `${base}/profile`, staff.bearer, {
        expectedVersion: profileVersion.rows[0]?.version,
        descriptionEn: `Edited by ${role}`,
      });
      expect(`${role} profile ${profile.statusCode}`).toBe(`${role} profile ${expected.profile}`);

      const branchCreate = await inject('POST', `${base}/branches`, staff.bearer, {
        label: `Branch by ${role}`,
        areaLabel: 'Area',
      });
      expect(`${role} branchCreate ${branchCreate.statusCode}`).toBe(
        `${role} branchCreate ${expected.branchCreate}`,
      );

      const branchVersion = await sql<{ version: number }>`
        SELECT version FROM branch WHERE id = ${b1}`.execute(testDb.db);
      const branchEdit = await inject('PATCH', `${base}/branches/${b1}`, staff.bearer, {
        expectedVersion: branchVersion.rows[0]?.version,
        label: `Edited by ${role}`,
      });
      expect(`${role} branchEdit ${branchEdit.statusCode}`).toBe(
        `${role} branchEdit ${expected.branchEdit}`,
      );

      // Deactivation probes a per-role scratch branch (owner-created) so a
      // 200 never breaks later rows of the matrix.
      let deactivateStatus: number;
      if (expected.deactivate === 200) {
        const scratch = newId();
        await sql`INSERT INTO branch (id, organization_id, label, area_label)
                  VALUES (${scratch}, ${orgId}, 'Scratch', 'Area')`.execute(testDb.db);
        deactivateStatus = (
          await inject('POST', `${base}/branches/${scratch}/deactivate`, staff.bearer, {
            expectedVersion: 1,
          })
        ).statusCode;
      } else {
        deactivateStatus = (
          await inject('POST', `${base}/branches/${b1}/deactivate`, staff.bearer, {
            expectedVersion: 1,
          })
        ).statusCode;
      }
      expect(`${role} deactivate ${deactivateStatus}`).toBe(
        `${role} deactivate ${expected.deactivate}`,
      );

      const staffRead = await inject('GET', `${base}/staff`, staff.bearer);
      expect(`${role} staffRead ${staffRead.statusCode}`).toBe(
        `${role} staffRead ${expected.staffRead}`,
      );

      const invite = await inject('POST', `${base}/staff/invitations`, staff.bearer, {
        email: `matrix-${role}@example.com`,
        role: 'coach',
        branchScope: { kind: 'branches', branchIds: [b1] },
      });
      expect(`${role} invite ${invite.statusCode}`).toBe(`${role} invite ${expected.invite}`);

      // submit: the org is 'live', so even the owner hits the lifecycle
      // conflict (409) — everyone else fails the capability first (403).
      const submit = await inject('POST', `${base}/submit`, staff.bearer, {
        expectedVersion: 1,
      });
      expect(`${role} submit ${submit.statusCode}`).toBe(`${role} submit ${expected.submit}`);
    }
  });

  it('the private view is capability-shaped: owner sees legal+commercial, managers legal only, coach neither', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const manager = await staffBearer(ctx, orgId, 'org_manager');
    const coach = await staffBearer(ctx, orgId, 'coach');

    const ownerView = (await inject('GET', `/provider/organizations/${orgId}`, owner.bearer)).json();
    expect(typeof ownerView.organization.legalName).toBe('string');
    expect('commercialTermsRef' in ownerView.organization).toBe(true);

    const managerView = (
      await inject('GET', `/provider/organizations/${orgId}`, manager.bearer)
    ).json();
    expect(typeof managerView.organization.legalName).toBe('string');
    expect('commercialTermsRef' in managerView.organization).toBe(false);

    const coachView = (await inject('GET', `/provider/organizations/${orgId}`, coach.bearer)).json();
    expect('legalName' in coachView.organization).toBe(false);
    expect('commercialTermsRef' in coachView.organization).toBe(false);
    expect(coachView.membership.role).toBe('coach');
    // The rest of the coach view is org-public-shaped data + own membership.
    expect(coachView.profile.displayName).toBeDefined();
  });
});

describe('organization isolation (docs/27 §14.3)', () => {
  it('Provider A can neither read, mutate, nor enumerate Provider B — every probe is byte-identical not-found', async () => {
    const orgA = await createProviderOrg(testDb.db);
    const orgB = await createProviderOrg(testDb.db);
    const ownerA = await staffBearer(ctx, orgA.orgId, 'owner');
    const ghost = newId();

    const probes: ['GET' | 'POST' | 'PATCH', (id: string) => string, unknown?][] = [
      ['GET', (id) => `/provider/organizations/${id}`],
      ['GET', (id) => `/provider/organizations/${id}/staff`],
      ['PATCH', (id) => `/provider/organizations/${id}/profile`, { expectedVersion: 1, displayName: 'X' }],
      ['POST', (id) => `/provider/organizations/${id}/branches`, { label: 'X', areaLabel: 'Y' }],
      [
        'POST',
        (id) => `/provider/organizations/${id}/staff/invitations`,
        { email: 'x@example.com', role: 'coach', branchScope: { kind: 'all' } },
      ],
    ];
    for (const [method, urlOf, payload] of probes) {
      const real = await inject(method, urlOf(orgB.orgId), ownerA.bearer, payload);
      const unreal = await inject(method, urlOf(ghost), ownerA.bearer, payload);
      expect(real.statusCode).toBe(404);
      expect(real.body).toBe(unreal.body); // no existence oracle
    }
    // Provider B's data is untouched.
    const profileB = await sql<{ display_name: string }>`
      SELECT display_name FROM organization_public_profile
      WHERE organization_id = ${orgB.orgId}`.execute(testDb.db);
    expect(profileB.rows[0]?.display_name).not.toBe('X');
  });

  it("cross-organization branch ids never bypass organization checks — A's owner editing B's branch inside A's addressing is not-found", async () => {
    const orgA = await createProviderOrg(testDb.db);
    const orgB = await createProviderOrg(testDb.db);
    const ownerA = await staffBearer(ctx, orgA.orgId, 'owner');
    const foreignBranch = orgB.branchIds[0] as string;

    const edit = await inject(
      'PATCH',
      `/provider/organizations/${orgA.orgId}/branches/${foreignBranch}`,
      ownerA.bearer,
      { expectedVersion: 1, label: 'Hijack' },
    );
    expect(edit.statusCode).toBe(404);
    const deactivate = await inject(
      'POST',
      `/provider/organizations/${orgA.orgId}/branches/${foreignBranch}/deactivate`,
      ownerA.bearer,
      { expectedVersion: 1 },
    );
    expect(deactivate.statusCode).toBe(404);
    // Inviting with a foreign branch in scope is a typed scope refusal, not
    // a grant and not an information leak beyond "not yours".
    const invite = await inject(
      'POST',
      `/provider/organizations/${orgA.orgId}/staff/invitations`,
      ownerA.bearer,
      { email: 'scope@example.com', role: 'coach', branchScope: { kind: 'branches', branchIds: [foreignBranch] } },
    );
    expect(invite.statusCode).toBe(422);
    expect(invite.json().code).toBe('invalidBranchScope');
    const branchB = await sql<{ label: string; active: boolean }>`
      SELECT label, active FROM branch WHERE id = ${foreignBranch}`.execute(testDb.db);
    expect(branchB.rows[0]).toEqual({ label: 'Branch 1', active: true });
  });
});

describe('branch-scoped authorization (docs/27 §14.4)', () => {
  it('a branch-scoped manager acts only on assigned ACTIVE branches; deactivation removes reach without granting anything else', async () => {
    const { orgId, branchIds } = await createProviderOrg(testDb.db);
    const [b1, b2] = branchIds as [string, string];
    const owner = await staffBearer(ctx, orgId, 'owner');
    const manager = await staffBearer(ctx, orgId, 'branch_manager', { scopeBranchIds: [b1] });
    const base = `/provider/organizations/${orgId}`;

    // Assigned branch: allowed. Unassigned: forbidden (right org, wrong scope).
    expect(
      (
        await inject('PATCH', `${base}/branches/${b1}`, manager.bearer, {
          expectedVersion: 1,
          label: 'Scoped edit',
        })
      ).statusCode,
    ).toBe(200);
    const unassigned = await inject('PATCH', `${base}/branches/${b2}`, manager.bearer, {
      expectedVersion: 1,
      label: 'Cross-branch',
    });
    expect(unassigned.statusCode).toBe(403);

    // Owner deactivates the assigned branch: the manager's reach is gone —
    // b1 (now inactive) refuses, and b2 does NOT become editable.
    expect(
      (
        await inject('POST', `${base}/branches/${b1}/deactivate`, owner.bearer, {
          expectedVersion: 2,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject('PATCH', `${base}/branches/${b1}`, manager.bearer, {
          expectedVersion: 3,
          label: 'After deactivation',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject('PATCH', `${base}/branches/${b2}`, manager.bearer, {
          expectedVersion: 1,
          label: 'Still cross-branch',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('staff management over HTTP (docs/27 §14.5/§14.8)', () => {
  it('last-owner protection holds through the HTTP path; a co-owner makes revocation legal; history rows survive', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const base = `/provider/organizations/${orgId}/staff/memberships`;

    const selfRevoke = await inject('POST', `${base}/${owner.membershipId}/revoke`, owner.bearer, {
      expectedVersion: 1,
    });
    expect(selfRevoke.statusCode).toBe(409);
    expect(selfRevoke.json().code).toBe('lastOwnerProtected');
    // The refusal leaks no database internals.
    expect(selfRevoke.body).not.toMatch(/trigger|constraint|staff_membership|pg_|SQL/i);

    const coOwner = await staffBearer(ctx, orgId, 'owner');
    expect(
      (
        await inject('POST', `${base}/${coOwner.membershipId}/revoke`, owner.bearer, {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    // Idempotent repeat; and the revoked row remains as immutable history.
    expect(
      (
        await inject('POST', `${base}/${coOwner.membershipId}/revoke`, owner.bearer, {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    const staffList = (
      await inject('GET', `/provider/organizations/${orgId}/staff`, owner.bearer)
    ).json();
    const historyRow = staffList.memberships.find(
      (m: { id: string }) => m.id === coOwner.membershipId,
    );
    expect(historyRow.state).toBe('revoked');
    expect(historyRow.role).toBe('owner');
  });

  it('role/scope replacement is revoke-old + invite-new: immutable history, exactly one active row per user', async () => {
    const { orgId, branchIds } = await createProviderOrg(testDb.db);
    const b1 = branchIds[0] as string;
    const owner = await staffBearer(ctx, orgId, 'owner');
    const base = `/provider/organizations/${orgId}`;

    // Invite as front_desk scoped to b1; accept; then "change role" the
    // approved way — revoke and re-invite as branch_manager.
    const issue = await inject('POST', `${base}/staff/invitations`, owner.bearer, {
      email: 'replace.role@example.com',
      role: 'front_desk',
      branchScope: { kind: 'branches', branchIds: [b1] },
    });
    expect(issue.statusCode).toBe(200);
    const invitee = await createUser(testDb.db);
    const inviteeBearer = await bearerForUser(ctx, invitee, {
      email: 'replace.role@example.com',
      emailVerified: true,
    });
    const accept = await app.inject({
      method: 'POST',
      url: '/provider/invitations/accept',
      headers: { authorization: `Bearer ${inviteeBearer.bearer}` },
      payload: { token: tokenFromLastMail() },
    });
    expect(accept.statusCode).toBe(200);
    const firstMembershipId = accept.json().membershipId;

    expect(
      (
        await inject('POST', `${base}/staff/memberships/${firstMembershipId}/revoke`, owner.bearer, {
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    const reIssue = await inject('POST', `${base}/staff/invitations`, owner.bearer, {
      email: 'replace.role@example.com',
      role: 'branch_manager',
      branchScope: { kind: 'branches', branchIds: [b1] },
    });
    expect(reIssue.statusCode).toBe(200);
    const reAccept = await app.inject({
      method: 'POST',
      url: '/provider/invitations/accept',
      headers: { authorization: `Bearer ${inviteeBearer.bearer}` },
      payload: { token: tokenFromLastMail() },
    });
    expect(reAccept.statusCode).toBe(200);

    const rows = await sql<{ id: string; role: string; state: string }>`
      SELECT id, role, state FROM staff_membership
      WHERE user_id = ${invitee} AND organization_id = ${orgId}
      ORDER BY created_at`.execute(testDb.db);
    expect(rows.rows.map((r) => [r.role, r.state])).toEqual([
      ['front_desk', 'revoked'],
      ['branch_manager', 'active'],
    ]);
  });

  it('invitation revoke over HTTP is idempotent; accepting a revoked token is invitationInvalid', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const base = `/provider/organizations/${orgId}`;
    const issue = await inject('POST', `${base}/staff/invitations`, owner.bearer, {
      email: 'revoke.me@example.com',
      role: 'coach',
      branchScope: { kind: 'all' },
    });
    const invitationId = issue.json().invitationId;
    const token = tokenFromLastMail();

    const first = await inject(
      'POST',
      `${base}/staff/invitations/${invitationId}/revoke`,
      owner.bearer,
    );
    const second = await inject(
      'POST',
      `${base}/staff/invitations/${invitationId}/revoke`,
      owner.bearer,
    );
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const invitee = await createUser(testDb.db);
    const inviteeBearer = await bearerForUser(ctx, invitee, {
      email: 'revoke.me@example.com',
      emailVerified: true,
    });
    const accept = await app.inject({
      method: 'POST',
      url: '/provider/invitations/accept',
      headers: { authorization: `Bearer ${inviteeBearer.bearer}` },
      payload: { token },
    });
    expect(accept.statusCode).toBe(400);
    expect(accept.json().code).toBe('invitationInvalid');
  });
});

describe('profile, branch, and submission flows (CAS + events)', () => {
  it('profile edit bumps the version, publishes with its own audit vocabulary, and repeats are staleVersion', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const url = `/provider/organizations/${orgId}/profile`;

    const first = await inject('PATCH', url, owner.bearer, {
      expectedVersion: 1,
      descriptionEn: 'A great academy',
      published: true,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(2);
    const stale = await inject('PATCH', url, owner.bearer, {
      expectedVersion: 1,
      descriptionEn: 'Stale write',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    const audits = await sql<{ action: string }>`
      SELECT action FROM audit_event
      WHERE entity_type = 'organization_public_profile' AND entity_id = ${orgId}
      ORDER BY occurred_at, id`.execute(testDb.db);
    expect(audits.rows.map((r) => r.action)).toEqual([
      'org.profile_updated',
      'org.profile_published',
    ]);
  });

  it('submission: incomplete draft refuses; complete draft submits; wrong lifecycle state conflicts', async () => {
    const incomplete = await createProviderOrg(testDb.db, { state: 'draft', branches: 0 });
    const ownerA = await staffBearer(ctx, incomplete.orgId, 'owner');
    const refused = await inject(
      'POST',
      `/provider/organizations/${incomplete.orgId}/submit`,
      ownerA.bearer,
      { expectedVersion: 1 },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('organizationIncomplete');

    const ready = await createProviderOrg(testDb.db, { state: 'draft' });
    const ownerB = await staffBearer(ctx, ready.orgId, 'owner');
    const submitted = await inject(
      'POST',
      `/provider/organizations/${ready.orgId}/submit`,
      ownerB.bearer,
      { expectedVersion: 1 },
    );
    expect(submitted.statusCode).toBe(200);
    const state = await sql<{ verification_state: string }>`
      SELECT verification_state FROM organization WHERE id = ${ready.orgId}`.execute(testDb.db);
    expect(state.rows[0]?.verification_state).toBe('submitted');

    const again = await inject(
      'POST',
      `/provider/organizations/${ready.orgId}/submit`,
      ownerB.bearer,
      { expectedVersion: 2 },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('lifecycleConflict');
  });

  it('branch create/edit round-trip returns the typed view and rejects malformed input', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const base = `/provider/organizations/${orgId}/branches`;

    const created = await inject('POST', base, owner.bearer, {
      label: 'Khalifa Park',
      areaLabel: 'Khalifa City',
      addressLine: 'Street 12',
      geoPoint: { longitude: 54.4, latitude: 24.4 },
      facilities: ['Parking'],
    });
    expect(created.statusCode).toBe(200);
    const branch = created.json().branch;
    expect(branch.label).toBe('Khalifa Park');
    expect(branch.geoPoint).toEqual({ longitude: 54.4, latitude: 24.4 });

    // Malformed input is schema-rejected, typed, with no internals.
    const badGeo = await inject('POST', base, owner.bearer, {
      label: 'Bad',
      areaLabel: 'Area',
      geoPoint: { longitude: 500, latitude: 24 },
    });
    expect(badGeo.statusCode).toBe(422);
    expect(badGeo.json().code).toBe('validationError');
    const noLabel = await inject('POST', base, owner.bearer, { areaLabel: 'Area' });
    expect(noLabel.statusCode).toBe(422);
  });
});

describe('response hygiene and rate limiting', () => {
  it('provider responses are no-store, never carry the raw invitation token, and /provider/me lists memberships per organization', async () => {
    const { orgId, branchIds } = await createProviderOrg(testDb.db, {
      displayName: 'Hygiene Provider',
    });
    const owner = await staffBearer(ctx, orgId, 'owner');
    const view = await inject('GET', `/provider/organizations/${orgId}`, owner.bearer);
    expect(view.headers['cache-control']).toBe('no-store');

    const issue = await inject(
      'POST',
      `/provider/organizations/${orgId}/staff/invitations`,
      owner.bearer,
      { email: 'hygiene@example.com', role: 'front_desk', branchScope: { kind: 'branches', branchIds: [branchIds[0] as string] } },
    );
    expect(issue.statusCode).toBe(200);
    const token = tokenFromLastMail();
    expect(issue.body).not.toContain(token); // digest boundary holds over HTTP
    const staffList = await inject('GET', `/provider/organizations/${orgId}/staff`, owner.bearer);
    expect(staffList.body).not.toContain(token);

    const me = await inject('GET', '/provider/me', owner.bearer);
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships).toEqual([
      {
        organizationId: orgId,
        displayName: 'Hygiene Provider',
        role: 'owner',
        branchScope: 'all',
        organizationState: 'live',
      },
    ]);
  });

  it('invitation issuance rate-limits per issuer+organization with retry-after', async () => {
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    const url = `/provider/organizations/${orgId}/staff/invitations`;
    let limited: number | undefined;
    for (let i = 0; i < 11; i += 1) {
      const response = await inject('POST', url, owner.bearer, {
        email: `burst${i}@example.com`,
        role: 'coach',
        branchScope: { kind: 'all' },
      });
      if (response.statusCode === 429) {
        limited = i;
        expect(response.headers['retry-after']).toBeDefined();
        break;
      }
      expect(response.statusCode).toBe(200);
    }
    expect(limited).toBe(10);
  });
});
