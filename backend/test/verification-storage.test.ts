/**
 * W3-4 — private verification-evidence binary storage, end-to-end through
 * the REAL policy pipeline on real PostgreSQL with the deterministic fake
 * store behind the storage port.
 *
 * The acceptance matrix: authorized upload → trusted finalization →
 * `stored`; pending never ready; cross-org/capability/admin refusals;
 * clients cannot forge trusted facts; no binary and no URL in PostgreSQL
 * or any response; supersession history; interrupted-upload recovery;
 * unconfigured storage fail-closed; D-S3-3 untouched.
 */
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import {
  evaluateCaseReadiness,
  openVerificationCase,
  type VerificationCaseDeps,
} from '../src/modules/provider/services/verification-case';
import {
  createFakeEvidenceStore,
  type FakeEvidenceStore,
} from '../src/modules/provider/storage/fake-evidence-store';
import type { AdminRole } from '../src/modules/identity/persistence/admin-role-repository';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/evidence-storage-pool';
const PDF_BYTES = Buffer.from('%PDF-1.4 deterministic test document body');

let testDb: TestDb;
let app: FastifyInstance;
let store: FakeEvidenceStore;
let ctx: ProviderTestContext;
let adminA: string;
let adminB: string;
let ops: string;
let opsBearer: string;

function caseDeps(): VerificationCaseDeps {
  return {
    db: testDb.db,
    policyProvider: {
      currentPolicy: async () => ({
        policyVersion: 'storage-policy-v1',
        requirements: [
          { key: 'business_document', labelEn: 'Business document', required: true },
        ],
      }),
    },
  };
}

async function grantRole(userId: string, role: AdminRole): Promise<void> {
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    testDb.db,
  );
}

/** A submitted org with an OPEN case and its one requirement, plus an
 *  owner bearer for the provider surface. */
async function provisionedOrg(): Promise<{
  orgId: string;
  caseId: string;
  requirementId: string;
  ownerBearer: string;
}> {
  const { orgId } = await createProviderOrg(testDb.db, { state: 'submitted', branches: 1 });
  const opened = await openVerificationCase(caseDeps(), { userId: ops }, { organizationId: orgId });
  if (opened.kind !== 'caseOpened') throw new Error(opened.kind);
  const requirement = await testDb.db
    .selectFrom('verification_case_requirement')
    .select(['id'])
    .where('case_id', '=', opened.caseId)
    .executeTakeFirstOrThrow();
  const owner = await staffBearer(ctx, orgId, 'owner');
  return { orgId, caseId: opened.caseId, requirementId: requirement.id, ownerBearer: owner.bearer };
}

function providerPath(orgId: string, rest = ''): string {
  return `/provider/organizations/${orgId}/verification/evidence${rest}`;
}

async function registerViaHttp(
  bearer: string,
  orgId: string,
  caseId: string,
  requirementId: string,
  extras: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: providerPath(orgId),
    headers: { authorization: `Bearer ${bearer}` },
    payload: {
      caseId,
      requirementId,
      originalFilename: 'trade licence.pdf',
      declaredContentType: 'application/pdf',
      ...extras,
    },
  });
}

async function uploadViaHttp(
  bearer: string,
  orgId: string,
  evidenceId: string,
  body: Buffer = PDF_BYTES,
  contentType = 'application/pdf',
) {
  return app.inject({
    method: 'PUT',
    url: providerPath(orgId, `/${evidenceId}/content`),
    headers: { authorization: `Bearer ${bearer}`, 'content-type': contentType },
    payload: body,
  });
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
  const verifier = new FakeAccessTokenVerifier();
  store = createFakeEvidenceStore();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
      verificationEvidenceStorage: {
        store,
        // Small technical bound so the oversize proof stays cheap.
        upload: { maxBytes: 64_000 },
        // Deterministic TEST composition: content safety reported ready so
        // admin retrieval is exercised end-to-end. The default (and the
        // only production-representable value) is FALSE — see the
        // fail-closed suite below.
        contentSafetyReady: true,
      },
    },
  });
  await app.ready();
  ctx = { db: testDb.db, verifier, issuer: ISSUER };
  ops = await createUser(testDb.db);
  await grantRole(ops, 'operations');
  opsBearer = (await bearerForUser(ctx, ops)).bearer;
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('route policy declarations (config-gated surface — absent from the default inventory snapshot)', () => {
  it('provider evidence routes ride the provider policy with the owner-only capability; the admin download rides the admin baseline', () => {
    const evidenceRoutes = app.routePolicyInventory.filter((route) =>
      route.url.includes('/verification/evidence'),
    );
    const shapes = new Set(evidenceRoutes.map((route) => `${route.method} ${route.url} → ${route.policy}`));
    expect(shapes).toEqual(
      new Set([
        'POST /provider/organizations/:organizationId/verification/evidence → provider',
        'PUT /provider/organizations/:organizationId/verification/evidence/:evidenceId/content → provider',
        'GET /provider/organizations/:organizationId/verification/evidence/:evidenceId/content → provider',
        'HEAD /provider/organizations/:organizationId/verification/evidence/:evidenceId/content → provider',
        'GET /admin/verification/evidence/:evidenceId/content → admin',
        'HEAD /admin/verification/evidence/:evidenceId/content → admin',
      ]),
    );
  });
});

describe('the complete storage lifecycle', () => {
  it('authorized initiation → pending (never ready) → private write → trusted finalization → stored → authorized download', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();

    // 1–2. Owner registers the intent.
    const registered = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    expect(registered.statusCode).toBe(200);
    const { evidenceId } = registered.json() as { evidenceId: string };
    // No trusted fact and no locator appears in ANY response.
    for (const leak of ['storage', 'sha256', 'digest', 'url', 'byteSize']) {
      expect(registered.body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    // Pending never satisfies readiness.
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toMatchObject({
      kind: 'missingRequirements',
    });

    // 3–6. Binary write through the proxied route; the backend computes
    // the trusted facts and finalizes through the W3-3 boundary.
    const uploaded = await uploadViaHttp(ownerBearer, orgId, evidenceId);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual({ status: 'evidenceStored', version: 2 });
    const row = await testDb.db
      .selectFrom('verification_evidence')
      .selectAll()
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('stored');
    expect(Number(row.byte_size)).toBe(PDF_BYTES.byteLength);
    expect(row.sha256_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.storage_ref).toBe(`verification/${orgId}/${caseId}/${evidenceId}`);
    // PostgreSQL holds METADATA only; the bytes live in the store.
    expect(store.objectCount()).toBeGreaterThan(0);
    expect(store.rawObject(row.storage_ref!)?.body.equals(PDF_BYTES)).toBe(true);
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toEqual({ kind: 'ready' });

    // 7. Authorized provider download — bytes, declared type, safe headers.
    const downloaded = await app.inject({
      method: 'GET',
      url: providerPath(orgId, `/${evidenceId}/content`),
      headers: { authorization: `Bearer ${ownerBearer}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.equals(PDF_BYTES)).toBe(true);
    expect(downloaded.headers['content-type']).toBe('application/pdf');
    expect(downloaded.headers['content-disposition']).toBe(
      'attachment; filename="trade licence.pdf"',
    );
    expect(JSON.stringify(downloaded.headers)).not.toContain('verification/');
    // Sensitive access is audited.
    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', '=', evidenceId)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('org.verification_evidence_accessed');

    // Internal operations download works through the admin surface (this
    // test composition reports content safety ready) — with attachment
    // semantics and nosniff on every permitted download.
    const adminDownload = await app.inject({
      method: 'GET',
      url: `/admin/verification/evidence/${evidenceId}/content`,
      headers: { authorization: `Bearer ${opsBearer}` },
    });
    expect(adminDownload.statusCode).toBe(200);
    expect(adminDownload.rawPayload.equals(PDF_BYTES)).toBe(true);
    expect(adminDownload.headers['content-disposition']).toMatch(/^attachment; filename=/);
    expect(adminDownload.headers['x-content-type-options']).toBe('nosniff');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');

    // No evidence-related outbox event carries anything (none exist).
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', orgId)
      .execute();
    for (const event of outbox) {
      expect(event.event_type).not.toContain('evidence');
      const payload = JSON.stringify(event.payload).toLowerCase();
      expect(payload).not.toContain('storage_ref');
      expect(payload).not.toContain('verification/'); // the key shape
      expect(payload).not.toContain('sha256');
      expect(payload).not.toContain(row.sha256_digest!);
    }
  });

  it('a client cannot forge trusted facts: extra fields are stripped, no finalize route exists, and the digest is computed from the real bytes', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
    const registered = await registerViaHttp(ownerBearer, orgId, caseId, requirementId, {
      state: 'stored',
      byteSize: 1,
      sha256Digest: 'f'.repeat(64),
      storageRef: 'https://evil.example/doc.pdf',
    });
    expect(registered.statusCode).toBe(200);
    const { evidenceId } = registered.json() as { evidenceId: string };
    const row = await testDb.db
      .selectFrom('verification_evidence')
      .selectAll()
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('pending_upload');
    expect(row.byte_size).toBeNull();
    expect(row.sha256_digest).toBeNull();
    expect(row.storage_ref).toBeNull();

    // No HTTP route can reach the trusted finalization boundary directly.
    const finalizeShaped = app.routePolicyInventory.filter((route) =>
      /finaliz|stored|complete/i.test(route.url),
    );
    expect(finalizeShaped).toEqual([]);

    // The stored digest comes from the actual bytes, not any claim.
    await uploadViaHttp(ownerBearer, orgId, evidenceId);
    const stored = await testDb.db
      .selectFrom('verification_evidence')
      .select(['sha256_digest'])
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    expect(stored.sha256_digest).not.toBe('f'.repeat(64));
  });
});

describe('authorization boundaries', () => {
  it('the capability is owner-only: an org_manager is refused the evidence surface', async () => {
    const { orgId, caseId, requirementId } = await provisionedOrg();
    const manager = await staffBearer(ctx, orgId, 'org_manager');
    const response = await registerViaHttp(manager.bearer, orgId, caseId, requirementId);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  it('cross-organization access fails closed at every step — route scope, case scope, evidence scope, download', async () => {
    const a = await provisionedOrg();
    const b = await provisionedOrg();
    const registered = await registerViaHttp(a.ownerBearer, a.orgId, a.caseId, a.requirementId);
    const { evidenceId } = registered.json() as { evidenceId: string };
    await uploadViaHttp(a.ownerBearer, a.orgId, evidenceId);

    // Org B's owner on org A's route: membership resolution → not-found.
    expect(
      (await registerViaHttp(b.ownerBearer, a.orgId, a.caseId, a.requirementId)).statusCode,
    ).toBe(404);
    // Org B's owner citing org A's case through B's OWN route: not-found.
    expect(
      (await registerViaHttp(b.ownerBearer, b.orgId, a.caseId, a.requirementId)).statusCode,
    ).toBe(404);
    // Upload/download of org A's evidence through org B's route: not-found.
    expect((await uploadViaHttp(b.ownerBearer, b.orgId, evidenceId)).statusCode).toBe(404);
    const theft = await app.inject({
      method: 'GET',
      url: providerPath(b.orgId, `/${evidenceId}/content`),
      headers: { authorization: `Bearer ${b.ownerBearer}` },
    });
    expect(theft.statusCode).toBe(404);
  });

  it('admin downloads require the operations role: auditor and customer identities are refused', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
    const registered = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    const { evidenceId } = registered.json() as { evidenceId: string };
    await uploadViaHttp(ownerBearer, orgId, evidenceId);

    const auditor = await createUser(testDb.db);
    await grantRole(auditor, 'auditor');
    const auditorBearer = (await bearerForUser(ctx, auditor)).bearer;
    const refused = await app.inject({
      method: 'GET',
      url: `/admin/verification/evidence/${evidenceId}/content`,
      headers: { authorization: `Bearer ${auditorBearer}` },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('forbidden');

    const customer = await createUser(testDb.db);
    const customerBearer = (await bearerForUser(ctx, customer)).bearer;
    const customerRefused = await app.inject({
      method: 'GET',
      url: `/admin/verification/evidence/${evidenceId}/content`,
      headers: { authorization: `Bearer ${customerBearer}` },
    });
    expect(customerRefused.statusCode).toBe(403);
  });
});

describe('upload validation boundaries', () => {
  it('disallowed declared types, mismatched request types, non-buffer bodies, and oversize payloads are all refused', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
    // Declared type outside the configured allowlist.
    const zip = await registerViaHttp(ownerBearer, orgId, caseId, requirementId, {
      declaredContentType: 'application/zip',
    });
    expect(zip.statusCode).toBe(422);
    expect(zip.json().code).toBe('invalidEvidenceMetadata');

    const registered = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    const { evidenceId } = registered.json() as { evidenceId: string };
    // Request content type must match the DECLARED type.
    const mismatched = await uploadViaHttp(ownerBearer, orgId, evidenceId, PDF_BYTES, 'image/png');
    expect(mismatched.statusCode).toBe(422);
    // A text body (string-parsed) is not an acceptable binary payload.
    const textual = await app.inject({
      method: 'PUT',
      url: providerPath(orgId, `/${evidenceId}/content`),
      headers: { authorization: `Bearer ${ownerBearer}`, 'content-type': 'text/plain' },
      payload: 'plain text pretending to be a document',
    });
    expect(textual.statusCode).toBe(422);
    // Oversize payload: refused by the route body limit; still pending.
    const oversize = await uploadViaHttp(
      ownerBearer,
      orgId,
      evidenceId,
      Buffer.alloc(65_000, 1),
    );
    expect(oversize.statusCode).toBe(413);
    const row = await testDb.db
      .selectFrom('verification_evidence')
      .select(['state'])
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('pending_upload');
  });
});

describe('supersession and history', () => {
  it('replacement keeps history; a superseded document cannot be re-uploaded, is invisible to the provider, and stays retrievable for operations', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
    const first = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    const firstId = (first.json() as { evidenceId: string }).evidenceId;
    await uploadViaHttp(ownerBearer, orgId, firstId);

    const second = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    const body = second.json() as { evidenceId: string; supersededEvidenceId?: string };
    expect(body.supersededEvidenceId).toBe(firstId);

    // The superseded record is terminal: no re-upload can revive it.
    expect((await uploadViaHttp(ownerBearer, orgId, firstId)).statusCode).toBe(409);
    // The provider sees only CURRENT stored documents.
    const providerGet = await app.inject({
      method: 'GET',
      url: providerPath(orgId, `/${firstId}/content`),
      headers: { authorization: `Bearer ${ownerBearer}` },
    });
    expect(providerGet.statusCode).toBe(404);
    // Operations may still retrieve the auditable history.
    const opsGet = await app.inject({
      method: 'GET',
      url: `/admin/verification/evidence/${firstId}/content`,
      headers: { authorization: `Bearer ${opsBearer}` },
    });
    expect(opsGet.statusCode).toBe(200);
    expect(opsGet.rawPayload.equals(PDF_BYTES)).toBe(true);
    // Readiness follows the CURRENT (pending) submission — not history.
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toMatchObject({
      kind: 'missingRequirements',
    });
  });
});

describe('failure and recovery (never a false `stored`)', () => {
  it('a failed write and a failure BETWEEN write and finalization both leave pending evidence, and the upload is recoverable', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
    const registered = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    const { evidenceId } = registered.json() as { evidenceId: string };

    // Infrastructure failure during the write.
    store.failNextPut();
    const failedPut = await uploadViaHttp(ownerBearer, orgId, evidenceId);
    expect(failedPut.statusCode).toBe(503);
    expect(failedPut.json().code).toBe('storageUnavailable');

    // Failure AFTER the binary write, BEFORE finalization (the orphaned-
    // object window): still pending, still not ready, object inert.
    store.failNextHead();
    const failedVerify = await uploadViaHttp(ownerBearer, orgId, evidenceId);
    expect(failedVerify.statusCode).toBe(503);
    const row = await testDb.db
      .selectFrom('verification_evidence')
      .select(['state', 'storage_ref'])
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('pending_upload');
    expect(row.storage_ref).toBeNull();
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toMatchObject({
      kind: 'missingRequirements',
    });
    // The orphaned object is unreachable: downloads key off the ROW state.
    const download = await app.inject({
      method: 'GET',
      url: providerPath(orgId, `/${evidenceId}/content`),
      headers: { authorization: `Bearer ${ownerBearer}` },
    });
    expect(download.statusCode).toBe(404);

    // Recovery: the retry overwrites ONLY its own key and completes.
    const retried = await uploadViaHttp(ownerBearer, orgId, evidenceId);
    expect(retried.statusCode).toBe(200);
    await expect(evaluateCaseReadiness(testDb.db, caseId)).resolves.toEqual({ kind: 'ready' });
  });
});

describe('content-safety fail-close (W3-4 owner correction)', () => {
  /** The LIVE-shaped composition: storage configured, content safety NOT
   *  ready (the default — and the only value production can represent). */
  async function guardedApp(): Promise<FastifyInstance> {
    const guarded = buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: ctx.verifier,
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
        staffInvitationConfig: parseStaffInvitationConfig('test', {}),
        verificationEvidenceStorage: { store, upload: { maxBytes: 64_000 } },
      },
    });
    await guarded.ready();
    return guarded;
  }

  it('an AUTHORIZED operations admin is refused uploaded bytes with the typed safety condition — BEFORE any object-store read — while the provider owner still retrieves their own document', async () => {
    const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
    const registered = await registerViaHttp(ownerBearer, orgId, caseId, requirementId);
    const { evidenceId } = registered.json() as { evidenceId: string };
    await uploadViaHttp(ownerBearer, orgId, evidenceId);

    const guarded = await guardedApp();
    const getSpy = jest.spyOn(store, 'getObject');
    try {
      getSpy.mockClear();
      const refused = await guarded.inject({
        method: 'GET',
        url: `/admin/verification/evidence/${evidenceId}/content`,
        headers: { authorization: `Bearer ${opsBearer}` },
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().code).toBe('verificationEvidenceSafetyUnavailable');
      // The refusal happened BEFORE the object store was touched.
      expect(getSpy).not.toHaveBeenCalled();
      // A distinct typed condition — never disguised as storage or auth
      // failure — and nothing internal leaks in the refusal.
      const body = refused.body.toLowerCase();
      for (const leak of ['storage_ref', 'verification/', 'sha256', 'digest', 'key', 'bucket']) {
        expect(body).not.toContain(leak);
      }

      // Authorization still comes FIRST: an unauthorized admin role gets
      // the same forbidden as before and learns nothing about safety or
      // storage state; a nonexistent id for a non-operations caller too.
      const auditor = await createUser(testDb.db);
      await grantRole(auditor, 'auditor');
      const auditorBearer = (await bearerForUser(ctx, auditor)).bearer;
      const auditorRefused = await guarded.inject({
        method: 'GET',
        url: `/admin/verification/evidence/${evidenceId}/content`,
        headers: { authorization: `Bearer ${auditorBearer}` },
      });
      expect(auditorRefused.statusCode).toBe(403);
      expect(auditorRefused.json().code).toBe('forbidden');

      // Cross-org provider behavior is unchanged (not-found shape).
      const other = await provisionedOrg();
      const crossOrg = await guarded.inject({
        method: 'GET',
        url: providerPath(other.orgId, `/${evidenceId}/content`),
        headers: { authorization: `Bearer ${other.ownerBearer}` },
      });
      expect(crossOrg.statusCode).toBe(404);

      // The provider OWNER's retrieval of their OWN document is outside
      // the gate: still served, still attachment + nosniff.
      const ownerDownload = await guarded.inject({
        method: 'GET',
        url: providerPath(orgId, `/${evidenceId}/content`),
        headers: { authorization: `Bearer ${ownerBearer}` },
      });
      expect(ownerDownload.statusCode).toBe(200);
      expect(ownerDownload.rawPayload.equals(PDF_BYTES)).toBe(true);
      expect(ownerDownload.headers['content-disposition']).toMatch(/^attachment; filename=/);
      expect(ownerDownload.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      getSpy.mockRestore();
      await guarded.close();
    }
  });

  it('production cannot claim content-safety readiness: this build has no scanning capability, so the claim refuses startup (no operator bypass exists)', () => {
    expect(() =>
      buildApp({
        identity: {
          db: testDb.db,
          accessTokenVerifier: ctx.verifier,
          idTokenAdapter: new FakeAuthProviderAdapter(),
          mailSender: new CaptureMailSender(),
          rateLimiterStore: new InMemoryRateLimiterStore(),
          staffInvitationConfig: parseStaffInvitationConfig('test', {}),
          nodeEnv: 'production',
          verificationEvidenceStorage: { store, contentSafetyReady: true },
        },
      }),
    ).toThrow(/contentSafetyReady cannot be true/);
  });
});

describe('unconfigured storage fails closed', () => {
  it('without configured storage the ENTIRE evidence surface is absent (404) — nothing can accept, serve, or store documents', async () => {
    const bare = buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: ctx.verifier,
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
        staffInvitationConfig: parseStaffInvitationConfig('test', {}),
      },
    });
    await bare.ready();
    try {
      const evidenceRoutes = bare.routePolicyInventory.filter((route) =>
        route.url.includes('/verification/evidence'),
      );
      expect(evidenceRoutes).toEqual([]);
      const { orgId, caseId, requirementId, ownerBearer } = await provisionedOrg();
      const response = await bare.inject({
        method: 'POST',
        url: providerPath(orgId),
        headers: { authorization: `Bearer ${ownerBearer}` },
        payload: {
          caseId,
          requirementId,
          originalFilename: 'x.pdf',
          declaredContentType: 'application/pdf',
        },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
