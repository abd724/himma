/**
 * W6-1 — request correlation → audit_event.request_id (docs/37 §23; docs/36
 * IN-09/SE-05 request-id half): full HTTP journeys through the production
 * middleware/context (the same buildApp pipeline production composes) with
 * the certified deterministic verifier, proving the canonical
 * server-generated id reaches the audit rows of representative customer,
 * provider, and admin mutations — and that client hints can never become
 * audit ids.
 */
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { appendAuditEvent } from '../src/db/audit';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import {
  currentRequestId,
  currentRunId,
  isCanonicalCorrelationId,
  runWithOperationContext,
  runWithRequestContext,
} from '../src/observability/request-context';
import {
  bootstrapAccessAdmins,
  createAccount,
  createSelfParticipant,
  createUser,
} from './helpers/identity-fixtures';
import {
  bearerForUser,
  createProviderOrg,
  staffBearer,
  type ProviderTestContext,
} from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

const ISSUER = 'https://cognito.test/w6-correlation-pool';

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

async function auditRow(action: string, entityId?: string): Promise<{ request_id: string | null }> {
  let query = sql<{ request_id: string | null }>`
    SELECT request_id FROM audit_event WHERE action = ${action} ORDER BY occurred_at DESC LIMIT 1`;
  if (entityId !== undefined) {
    query = sql<{ request_id: string | null }>`
      SELECT request_id FROM audit_event WHERE action = ${action} AND entity_id = ${entityId}
      ORDER BY occurred_at DESC LIMIT 1`;
  }
  const result = await query.execute(testDb.db);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no audit row for ${action}`);
  return row;
}

describe('HTTP → domain mutation → audit_event.request_id (docs/37 §23)', () => {
  it('a customer mutation (participant create) carries the exact canonical id; a spoofed oversized hint changes nothing', async () => {
    const userId = await createUser(testDb.db);
    const accountId = await createAccount(testDb.db, userId);
    await createSelfParticipant(testDb.db, accountId);
    const { bearer } = await bearerForUser(ctx, userId, {
      enrolled: false,
      assurance: 'single_factor',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/customer/participants',
      headers: {
        authorization: `Bearer ${bearer}`,
        // An arbitrary oversized client value: recorded nowhere as an id.
        'x-request-id': `evil-${'x'.repeat(500)}`,
      },
      payload: { firstName: 'Correlated', dateOfBirth: '2018-03-01' },
    });
    expect(response.statusCode).toBe(201);
    const canonical = response.headers['x-request-id'] as string;
    expect(isCanonicalCorrelationId(canonical)).toBe(true);
    const participantId = (response.json() as { participant: { id: string } }).participant.id;
    const row = await auditRow('participant.created', participantId);
    expect(row.request_id).toBe(canonical);
  });

  it('a provider mutation (organization profile edit) carries its own distinct canonical id', async () => {
    const { orgId } = await createProviderOrg(testDb.db, { state: 'live' });
    const staff = await staffBearer(ctx, orgId, 'owner');
    const first = await app.inject({
      method: 'PATCH',
      url: `/provider/organizations/${orgId}/profile`,
      headers: { authorization: `Bearer ${staff.bearer}` },
      payload: { expectedVersion: 1, displayName: 'Correlated Provider' },
    });
    expect(first.statusCode).toBe(200);
    const providerRequestId = first.headers['x-request-id'] as string;
    expect(isCanonicalCorrelationId(providerRequestId)).toBe(true);
    const row = await auditRow('org.profile_updated', orgId);
    expect(row.request_id).toBe(providerRequestId);

    // Two separate requests get DISTINCT canonical ids.
    const second = await app.inject({
      method: 'PATCH',
      url: `/provider/organizations/${orgId}/profile`,
      headers: { authorization: `Bearer ${staff.bearer}` },
      payload: { expectedVersion: 2, displayName: 'Correlated Provider 2' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-request-id']).not.toBe(providerRequestId);
  });

  it('an admin mutation (organization creation by an operations admin) carries the canonical id', async () => {
    const { adminA, adminB } = await bootstrapAccessAdmins(testDb.db);
    const opsUserId = await createUser(testDb.db);
    await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
              VALUES (${newId()}, ${opsUserId}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
      testDb.db,
    );
    const { bearer } = await bearerForUser(ctx, opsUserId);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/organizations',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        legalName: 'Correlated Admin Org LLC',
        tradeName: 'Correlated',
        foundingOwnerEmail: 'owner@correlated.test',
      },
    });
    expect(response.statusCode).toBe(200);
    const canonical = response.headers['x-request-id'] as string;
    expect(isCanonicalCorrelationId(canonical)).toBe(true);
    const organizationId = (response.json() as { organizationId: string }).organizationId;
    const rows = await sql<{ request_id: string | null }>`
      SELECT request_id FROM audit_event WHERE entity_id = ${organizationId}
      ORDER BY occurred_at ASC`.execute(testDb.db);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.request_id).toBe(canonical);
    }
  });

  it('internal non-request work stays NULL, and an explicitly supplied id still wins', async () => {
    await appendAuditEvent(testDb.db, {
      actorType: 'system',
      action: 'w6.correlation_null_probe',
      entityType: 'w6',
      entityId: 'null-probe',
    });
    expect((await auditRow('w6.correlation_null_probe')).request_id).toBeNull();

    await appendAuditEvent(testDb.db, {
      actorType: 'system',
      action: 'w6.correlation_explicit_probe',
      entityType: 'w6',
      entityId: 'explicit-probe',
      requestId: 'job-run-fixture-1',
    });
    expect((await auditRow('w6.correlation_explicit_probe')).request_id).toBe('job-run-fixture-1');
  });

  it('background OPERATION context never masquerades as request context: run ids stay out of audit_event.request_id (W6-2 owner correction)', async () => {
    const runId = '99999999-8888-4777-8666-555555555555';
    await runWithOperationContext({ runId, operation: 'test-loop' }, async () => {
      // The run id is available to structured logging…
      expect(currentRunId()).toBe(runId);
      // …but is NOT request correlation.
      expect(currentRequestId()).toBeUndefined();
      await appendAuditEvent(testDb.db, {
        actorType: 'system',
        action: 'w6.background_probe',
        entityType: 'w6',
        entityId: 'background-probe',
      });
    });
    expect((await auditRow('w6.background_probe')).request_id).toBeNull();

    // A request-originated write nested inside a background operation keeps
    // its EXACT originating request id — never the run id.
    const originating = '12121212-3434-4565-8787-989898989898';
    await runWithOperationContext({ runId, operation: 'test-loop' }, () =>
      runWithRequestContext({ requestId: originating }, () =>
        appendAuditEvent(testDb.db, {
          actorType: 'system',
          action: 'w6.nested_origin_probe',
          entityType: 'w6',
          entityId: 'nested-origin-probe',
        }),
      ),
    );
    expect((await auditRow('w6.nested_origin_probe')).request_id).toBe(originating);
  });

  it('a VALID bounded client hint is still never adopted as the canonical id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/health',
      headers: { 'x-request-id': 'client-hint-123' },
    });
    expect(response.statusCode).toBe(200);
    const canonical = response.headers['x-request-id'] as string;
    expect(canonical).not.toBe('client-hint-123');
    expect(isCanonicalCorrelationId(canonical)).toBe(true);
  });
});
