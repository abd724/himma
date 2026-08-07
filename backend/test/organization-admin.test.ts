/**
 * S3-4 — Himma-admin organization lifecycle (docs/27 §10, §13.3; D-S3-3).
 * Real PostgreSQL + Fastify injection: operations-role authority, atomic
 * creation + founding Owner invitation, the full §5.1 admin lifecycle with
 * CAS + events, the production verification-evidence fail-close (no
 * bypass), suspension effects across the provider and public surfaces,
 * and admin/provider/customer separation.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp, type AdminProductionReadiness } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { createOrganization } from '../src/modules/provider/services/organization-admin';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/org-admin-pool';
const READY: AdminProductionReadiness = {
  cognitoConfigured: true,
  mfaProviderValidated: true,
  realPoolSmokeVerified: true,
  productionConfigApproved: true,
};

let testDb: TestDb;
let app: FastifyInstance;
let mail: CaptureMailSender;
let ctx: ProviderTestContext;
let opsBearer: string;
let opsUserId: string;

function identityOptions(verifier: FakeAccessTokenVerifier, mailSender: CaptureMailSender) {
  return {
    db: testDb.db,
    accessTokenVerifier: verifier,
    idTokenAdapter: new FakeAuthProviderAdapter(),
    mailSender,
    rateLimiterStore: new InMemoryRateLimiterStore(),
    staffInvitationConfig: parseStaffInvitationConfig('test', {}),
  };
}

async function makeOperationsAdmin(): Promise<{ userId: string; bearer: string }> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM bootstrap_seal`.execute(testDb.db);
  const seeded = Number(rows.rows[0]?.n) > 0;
  let adminA: string;
  let adminB: string;
  if (seeded) {
    const admins = await sql<{ user_id: string }>`
      SELECT user_id FROM admin_role_assignment
      WHERE role = 'access_admin' AND state = 'active' LIMIT 2`.execute(testDb.db);
    adminA = admins.rows[0]?.user_id as string;
    adminB = admins.rows[1]?.user_id as string;
  } else {
    ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  }
  const userId = await createUser(testDb.db);
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
  const { bearer } = await bearerForUser(ctx, userId);
  return { userId, bearer };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const verifier = new FakeAccessTokenVerifier();
  mail = new CaptureMailSender();
  app = buildApp({ identity: identityOptions(verifier, mail) });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  ({ userId: opsUserId, bearer: opsBearer } = await makeOperationsAdmin());
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function post(url: string, bearer: string | undefined, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    ...(bearer !== undefined ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    payload: payload as Record<string, unknown>,
  });
}

async function createOrgViaRoute(email: string): Promise<{ organizationId: string; invitationId: string }> {
  const response = await post('/admin/organizations', opsBearer, {
    legalName: 'Blue Wave Sports LLC',
    tradeName: 'Blue Wave',
    foundingOwnerEmail: email,
  });
  if (response.statusCode !== 200) throw new Error(response.body);
  return response.json();
}

async function setState(orgId: string, ...states: string[]): Promise<void> {
  for (const state of states) {
    await sql`UPDATE organization SET verification_state = ${state},
              suspended_at = ${state === 'suspended' ? new Date() : null}
              WHERE id = ${orgId}`.execute(testDb.db);
  }
}

async function orgVersion(orgId: string): Promise<number> {
  const row = await sql<{ version: number }>`
    SELECT version FROM organization WHERE id = ${orgId}`.execute(testDb.db);
  return row.rows[0]?.version as number;
}

describe('admin-created organization + founding Owner invitation (docs/27 §10)', () => {
  it('creates org, profile shell, and founding invitation atomically; digest-only storage; mail after commit; no placeholder user', async () => {
    const before = mail.captured.length;
    const { organizationId, invitationId } = await createOrgViaRoute('Founder.One@Example.com');

    const org = await sql<{ verification_state: string; origin: string; legal_name: string }>`
      SELECT verification_state, origin, legal_name FROM organization
      WHERE id = ${organizationId}`.execute(testDb.db);
    expect(org.rows[0]).toEqual({
      verification_state: 'draft',
      origin: 'admin_created',
      legal_name: 'Blue Wave Sports LLC',
    });
    const profile = await sql<{ display_name: string; published: boolean }>`
      SELECT display_name, published FROM organization_public_profile
      WHERE organization_id = ${organizationId}`.execute(testDb.db);
    expect(profile.rows[0]).toEqual({ display_name: 'Blue Wave', published: false });
    const invitation = await sql<{
      email: string;
      role: string;
      state: string;
      invited_by: string;
    }>`SELECT email, role, state, invited_by FROM staff_invitation
       WHERE id = ${invitationId}`.execute(testDb.db);
    expect(invitation.rows[0]).toEqual({
      email: 'founder.one@example.com',
      role: 'owner',
      state: 'sent',
      invited_by: opsUserId,
    });

    // Mail: exactly one, post-commit, carrying the only copy of the token.
    expect(mail.captured.length).toBe(before + 1);
    const token = /accept: (\S+)/.exec(mail.captured[mail.captured.length - 1]?.body ?? '')?.[1];
    expect(token).toBeDefined();
    for (const table of ['staff_invitation', 'audit_event', 'outbox_event', 'organization']) {
      const hits = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ${sql.raw(table)} t
        WHERE t::text LIKE ${'%' + (token as string) + '%'}`.execute(testDb.db);
      expect(Number(hits.rows[0]?.n)).toBe(0);
    }
    // No placeholder Himma user was created for the invited address.
    const invitee = await sql<{ n: string }>`
      SELECT count(*) AS n FROM auth_identity
      WHERE lower(email) = 'founder.one@example.com'`.execute(testDb.db);
    expect(Number(invitee.rows[0]?.n)).toBe(0);
    // Events: creation + invitation, both in the causal transaction.
    for (const [action, entity] of [
      ['org.created', organizationId],
      ['org.staff_invited', invitationId],
    ] as const) {
      const rows = await sql<{ n: string }>`
        SELECT count(*) AS n FROM audit_event
        WHERE action = ${action} AND entity_id = ${entity}`.execute(testDb.db);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    }
    const events = await sql<{ event_type: string }>`
      SELECT event_type FROM outbox_event
      WHERE aggregate_type = 'organization' AND aggregate_id = ${organizationId}
      ORDER BY sequence_no`.execute(testDb.db);
    expect(events.rows.map((r) => r.event_type)).toEqual([
      'organization.created',
      'staff.invited',
    ]);
  });

  it('only an operations admin may create: other admin roles, providers, and customers are refused', async () => {
    const body = {
      legalName: 'Refused LLC',
      tradeName: 'Refused',
      foundingOwnerEmail: 'refused@example.com',
    };
    // access_admin (a real admin, wrong role for §13.3) → forbidden.
    const admins = await sql<{ user_id: string }>`
      SELECT user_id FROM admin_role_assignment
      WHERE role = 'access_admin' AND state = 'active' LIMIT 1`.execute(testDb.db);
    const { bearer: accessAdminBearer } = await bearerForUser(
      ctx,
      admins.rows[0]?.user_id as string,
    );
    expect((await post('/admin/organizations', accessAdminBearer, body)).statusCode).toBe(403);

    // A provider Owner and a plain customer never reach the handler at all.
    const { orgId } = await createProviderOrg(testDb.db);
    const owner = await staffBearer(ctx, orgId, 'owner');
    expect((await post('/admin/organizations', owner.bearer, body)).statusCode).toBe(403);
    const customer = await createUser(testDb.db);
    const { bearer: customerBearer } = await bearerForUser(ctx, customer);
    expect((await post('/admin/organizations', customerBearer, body)).statusCode).toBe(403);
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM organization WHERE legal_name = 'Refused LLC'`.execute(testDb.db);
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it('a forced failure rolls back organization, profile, invitation, audit, and outbox together — and sends no mail', async () => {
    await sql`
      CREATE FUNCTION test_poison_founding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email = 'poison.founder@example.com' THEN
          RAISE EXCEPTION 'test-forced founding failure';
        END IF;
        RETURN NEW;
      END; $$`.execute(testDb.db);
    await sql`
      CREATE TRIGGER trg_test_poison_founding AFTER INSERT ON staff_invitation
      FOR EACH ROW EXECUTE FUNCTION test_poison_founding()`.execute(testDb.db);
    const mailBefore = mail.captured.length;
    try {
      const response = await post('/admin/organizations', opsBearer, {
        legalName: 'Atomic Rollback LLC',
        tradeName: 'Atomic',
        foundingOwnerEmail: 'poison.founder@example.com',
      });
      expect(response.statusCode).toBe(500); // sanitized internal error
      expect(response.json().code).toBe('internalError');
      expect(response.body).not.toMatch(/test-forced|trigger|staff_invitation/);
    } finally {
      await sql`DROP TRIGGER trg_test_poison_founding ON staff_invitation`.execute(testDb.db);
      await sql`DROP FUNCTION test_poison_founding()`.execute(testDb.db);
    }
    const org = await sql<{ n: string }>`
      SELECT count(*) AS n FROM organization WHERE legal_name = 'Atomic Rollback LLC'`.execute(
      testDb.db,
    );
    expect(Number(org.rows[0]?.n)).toBe(0);
    const invitation = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_invitation
      WHERE email = 'poison.founder@example.com'`.execute(testDb.db);
    expect(Number(invitation.rows[0]?.n)).toBe(0);
    expect(mail.captured.length).toBe(mailBefore);
  });

  it('a mail failure never rolls back the committed organization/invitation and is reported', async () => {
    const failing = { send: () => Promise.reject(new Error('smtp down')) };
    const result = await createOrganization(
      {
        db: testDb.db,
        mailSender: failing,
        invitationConfig: parseStaffInvitationConfig('test', {}),
        lifecycle: { nodeEnv: 'test', verificationEvidenceCapabilityReady: false },
      },
      { userId: opsUserId },
      {
        legalName: 'Undelivered LLC',
        tradeName: 'Undelivered',
        foundingOwnerEmail: 'undelivered.founder@example.com',
      },
    );
    if (result.kind !== 'organizationCreated') throw new Error(result.kind);
    expect(result.mailDelivery).toBe('failed');
    const rows = await sql<{ verification_state: string }>`
      SELECT verification_state FROM organization WHERE id = ${result.organizationId}`.execute(
      testDb.db,
    );
    expect(rows.rows[0]?.verification_state).toBe('draft');
  });
});

describe('organization lifecycle administration (§5.1 admin edges)', () => {
  it('walks review → verified → live → suspended → reinstated → offboarded with CAS, events, and terminal refusal', async () => {
    const { organizationId } = await createOrgViaRoute('lifecycle@example.com');
    await setState(organizationId, 'submitted');
    const base = `/admin/organizations/${organizationId}`;

    const steps: [string, string][] = [
      [`${base}/verification/start-review`, 'in_review'],
      [`${base}/verification/verify`, 'verified'],
      [`${base}/go-live`, 'live'],
      [`${base}/suspend`, 'suspended'],
      [`${base}/reinstate`, 'live'],
      [`${base}/suspend`, 'suspended'],
      [`${base}/offboard`, 'offboarded'],
    ];
    for (const [url, expectedState] of steps) {
      const version = await orgVersion(organizationId);
      const response = await post(url, opsBearer, { expectedVersion: version });
      expect(`${url} ${response.statusCode}`).toBe(`${url} 200`);
      expect(response.json().state).toBe(expectedState);
    }
    // Terminal: any further admin transition is a typed conflict.
    const afterOffboard = await post(`${base}/reinstate`, opsBearer, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(afterOffboard.statusCode).toBe(409);
    expect(afterOffboard.json().code).toBe('lifecycleConflict');

    const audits = await sql<{ action: string }>`
      SELECT action FROM audit_event
      WHERE entity_type = 'organization' AND entity_id = ${organizationId}
      ORDER BY occurred_at, id`.execute(testDb.db);
    expect(audits.rows.map((r) => r.action)).toEqual([
      'org.created',
      'org.review_started',
      'org.verified',
      'org.went_live',
      'org.suspended',
      'org.reinstated',
      'org.suspended',
      'org.offboarded',
    ]);
  });

  it('rejects invalid transitions and stale versions with sanitized typed outcomes', async () => {
    const { organizationId } = await createOrgViaRoute('invalid.moves@example.com');
    const base = `/admin/organizations/${organizationId}`;
    // draft → verify is not an admin edge.
    const wrongState = await post(`${base}/verification/verify`, opsBearer, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(wrongState.statusCode).toBe(409);
    expect(wrongState.json().code).toBe('lifecycleConflict');
    expect(wrongState.body).not.toMatch(/trigger|constraint|verification_state|pg_/i);

    await setState(organizationId, 'submitted');
    const stale = await post(`${base}/verification/start-review`, opsBearer, {
      expectedVersion: 999,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('staleVersion');

    // Unknown organization is a plain admin-side notFound.
    const ghost = await post(`/admin/organizations/${newId()}/suspend`, opsBearer, {
      expectedVersion: 1,
    });
    expect(ghost.statusCode).toBe(404);
  });

  it('rejection supports a safe reason code (outbox only) and re-submission stays possible via the provider path', async () => {
    const { organizationId } = await createOrgViaRoute('rejected.org@example.com');
    await setState(organizationId, 'submitted', 'in_review');
    const rejected = await post(
      `/admin/organizations/${organizationId}/verification/reject`,
      opsBearer,
      { expectedVersion: await orgVersion(organizationId), reasonCode: 'incomplete_documents' },
    );
    expect(rejected.statusCode).toBe(200);
    const event = await sql<{ payload: { reasonCode?: string } }>`
      SELECT payload FROM outbox_event
      WHERE event_type = 'organization.rejected' AND aggregate_id = ${organizationId}`.execute(
      testDb.db,
    );
    expect(event.rows[0]?.payload.reasonCode).toBe('incomplete_documents');
    // Free-text is schema-refused — reason codes only, never private notes.
    await setState(organizationId, 'submitted', 'in_review');
    const freeText = await post(
      `/admin/organizations/${organizationId}/verification/reject`,
      opsBearer,
      { expectedVersion: await orgVersion(organizationId), reasonCode: 'Sensitive private note!' },
    );
    expect(freeText.statusCode).toBe(422);
    // The S3-1 machine allows rejected → submitted (provider resubmission).
    await setState(organizationId, 'rejected');
    await setState(organizationId, 'submitted');
  });

  it('suspension bites the provider surface and the public storefront immediately; reinstatement restores; history survives', async () => {
    const { organizationId } = await createOrgViaRoute('suspend.flow@example.com');
    await sql`INSERT INTO branch (id, organization_id, label, area_label)
              VALUES (${newId()}, ${organizationId}, 'B', 'Area')`.execute(testDb.db);
    await sql`UPDATE organization_public_profile SET published = true
              WHERE organization_id = ${organizationId}`.execute(testDb.db);
    await setState(organizationId, 'submitted', 'in_review', 'verified', 'live');
    const owner = await staffBearer(ctx, organizationId, 'owner');
    const storefrontUrl = `/providers/${organizationId}`;
    expect((await app.inject({ method: 'GET', url: storefrontUrl })).statusCode).toBe(200);

    const suspended = await post(`/admin/organizations/${organizationId}/suspend`, opsBearer, {
      expectedVersion: await orgVersion(organizationId),
      reasonCode: 'safety_review',
    });
    expect(suspended.statusCode).toBe(200);
    // Provider mutation refused; provider read allowed; public read gone.
    const mutation = await app.inject({
      method: 'PATCH',
      url: `/provider/organizations/${organizationId}/profile`,
      headers: { authorization: `Bearer ${owner.bearer}` },
      payload: { expectedVersion: 2, displayName: 'While suspended' },
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().code).toBe('organizationSuspended');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/provider/organizations/${organizationId}`,
          headers: { authorization: `Bearer ${owner.bearer}` },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: storefrontUrl })).statusCode).toBe(404);

    const reinstated = await post(`/admin/organizations/${organizationId}/reinstate`, opsBearer, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(reinstated.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: storefrontUrl })).statusCode).toBe(200);
    // The historical suspension audit record is untouched by reinstatement.
    const suspensionAudits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'org.suspended' AND entity_id = ${organizationId}`.execute(testDb.db);
    expect(Number(suspensionAudits.rows[0]?.n)).toBe(1);
  });
});

describe('D-S3-3 verification-evidence production gate (no bypass)', () => {
  it('a production build cannot claim evidence readiness, and production verify/go-live fail closed with an audited typed refusal', async () => {
    // Claiming readiness in production refuses startup — Slice 3 contains
    // no evidence capability, so a true flag is a lie by construction.
    expect(() =>
      buildApp({
        identity: {
          ...identityOptions(new FakeAccessTokenVerifier(), new CaptureMailSender()),
          nodeEnv: 'production',
          adminReadiness: READY,
          verificationEvidenceCapabilityReady: true,
        },
      }),
    ).toThrow(/D-S3-3/);

    // A fully-activated production admin surface (identity capabilities
    // ready) still cannot verify or go-live: the evidence gate is
    // independent of admin roles and identity readiness.
    const productionVerifier = new FakeAccessTokenVerifier();
    const production = buildApp({
      identity: {
        ...identityOptions(productionVerifier, new CaptureMailSender()),
        nodeEnv: 'production',
        adminReadiness: READY,
      },
    });
    await production.ready();
    const productionCtx: ProviderTestContext = {
      db: testDb.db,
      verifier: productionVerifier,
      issuer: ISSUER,
    };
    const { bearer: productionOps } = await (async () => {
      const admins = await sql<{ user_id: string }>`
        SELECT user_id FROM admin_role_assignment
        WHERE role = 'operations' AND state = 'active' LIMIT 1`.execute(testDb.db);
      return bearerForUser(productionCtx, admins.rows[0]?.user_id as string);
    })();

    const { organizationId } = await createOrgViaRoute('production.gate@example.com');
    await setState(organizationId, 'submitted');
    const base = `/admin/organizations/${organizationId}`;
    const inject = (url: string, payload: unknown) =>
      production.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${productionOps}` },
        payload: payload as Record<string, unknown>,
      });

    // Ungated edges still work in production (start-review, reject).
    const review = await inject(`${base}/verification/start-review`, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(review.statusCode).toBe(200);

    const verify = await inject(`${base}/verification/verify`, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(verify.statusCode).toBe(503);
    expect(verify.json().code).toBe('verificationEvidenceUnavailable');
    const refusalAudit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'org.verification_gate_refused'
        AND entity_id = ${organizationId}`.execute(testDb.db);
    expect(Number(refusalAudit.rows[0]?.n)).toBe(1);
    // The organization did NOT move.
    const state = await sql<{ verification_state: string }>`
      SELECT verification_state FROM organization WHERE id = ${organizationId}`.execute(testDb.db);
    expect(state.rows[0]?.verification_state).toBe('in_review');

    // go-live is equally gated: drive to verified via the dev/test surface,
    // then attempt the production go-live.
    const devVerify = await post(`${base}/verification/verify`, opsBearer, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(devVerify.statusCode).toBe(200);
    const goLive = await inject(`${base}/go-live`, {
      expectedVersion: await orgVersion(organizationId),
    });
    expect(goLive.statusCode).toBe(503);
    expect(goLive.json().code).toBe('verificationEvidenceUnavailable');
    await production.close();
  });
});
