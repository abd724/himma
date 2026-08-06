/**
 * B2-5 — administrative role-assignment services (docs/26 §7, §9.7).
 *
 * Himma PostgreSQL is the ONLY authority for admin roles. Real PostgreSQL
 * throughout; the qualified Access Administrators come from the test-side
 * bootstrap fixture (the §9.9 shape).
 */
import { firstLogin } from '../src/modules/identity/services/first-login';
import {
  approveRoleAssignment,
  denyRoleAssignment,
  listRoleAssignments,
  processExpiredAssignments,
  requestRoleAssignment,
  resolveAdminRoles,
  revokeRoleAssignment,
} from '../src/modules/identity/services/admin-roles';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { bootstrapAccessAdmins } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let adminA: string;
let adminB: string;
let counter = 0;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA, adminB } = await bootstrapAccessAdmins(testDb.db));
});

afterAll(async () => {
  await testDb.drop();
});

async function makeCustomer(): Promise<string> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: 'https://cognito.test/admin-services-pool',
    subject: `admin-svc-sub-${counter}`,
    email: `adminsvc${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return result.userId;
}

describe('administrative principal resolution', () => {
  it('resolves only active, unexpired database assignments — requested/denied/revoked/expired are ignored', async () => {
    const target = await makeCustomer();
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);

    // Requested (finance-capable) — not yet a role.
    const requested = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'finance' },
    );
    expect(requested.kind).toBe('roleRequested');
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);

    // Denied — still nothing.
    if (requested.kind !== 'roleRequested') return;
    const denied = await denyRoleAssignment(
      { db: testDb.db },
      { userId: adminB },
      { assignmentId: requested.assignmentId, expectedVersion: 1 },
    );
    expect(denied.kind).toBe('roleDenied');
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);

    // Non-finance role activates immediately on a single access_admin request.
    const activated = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'support' },
    );
    expect(activated.kind).toBe('roleActivated');
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual(['support']);

    // Revoked — role disappears on next resolution.
    if (activated.kind !== 'roleActivated') return;
    const revoked = await revokeRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { assignmentId: activated.assignmentId, expectedVersion: 1 },
    );
    expect(revoked.kind).toBe('roleRevoked');
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);
  });

  it('time-expired assignments resolve to no role even before the sweep, and the sweep finalizes them', async () => {
    const target = await makeCustomer();
    const activated = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      {
        targetUserId: target,
        role: 'operations',
        expiresAt: new Date(Date.now() + 50),
      },
    );
    expect(activated.kind).toBe('roleActivated');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);

    const swept = await processExpiredAssignments({ db: testDb.db });
    expect(swept.expiredCount).toBeGreaterThanOrEqual(1);
    const row = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state'])
      .where('user_id', '=', target)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('expired');
  });
});

describe('dual-control finance-capable grants', () => {
  it('activates with two distinct active Access Administrators and rejects self-approval', async () => {
    const target = await makeCustomer();
    const requested = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'finance' },
    );
    if (requested.kind !== 'roleRequested') throw new Error(requested.kind);

    const selfApproval = await approveRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { assignmentId: requested.assignmentId, expectedVersion: 1 },
    );
    expect(selfApproval.kind).toBe('selfApprovalForbidden');

    const approved = await approveRoleAssignment(
      { db: testDb.db },
      { userId: adminB },
      { assignmentId: requested.assignmentId, expectedVersion: 1 },
    );
    expect(approved.kind).toBe('roleActivated');
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual(['finance']);

    const again = await approveRoleAssignment(
      { db: testDb.db },
      { userId: adminB },
      { assignmentId: requested.assignmentId, expectedVersion: 2 },
    );
    expect(again.kind).toBe('assignmentAlreadyFinalized');
  });

  it('rejects requesters and approvers who are not active Access Administrators', async () => {
    const target = await makeCustomer();
    const outsider = await makeCustomer();
    const byOutsider = await requestRoleAssignment(
      { db: testDb.db },
      { userId: outsider },
      { targetUserId: target, role: 'finance' },
    );
    expect(byOutsider.kind).toBe('requesterNotQualified');

    const requested = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'finance' },
    );
    if (requested.kind !== 'roleRequested') throw new Error(requested.kind);
    const approvedByOutsider = await approveRoleAssignment(
      { db: testDb.db },
      { userId: outsider },
      { assignmentId: requested.assignmentId, expectedVersion: 1 },
    );
    expect(approvedByOutsider.kind).toBe('approverNotQualified');
  });

  it('enforces role incompatibilities through the service and database (auditor ∦ mutating, access_admin ∦ finance)', async () => {
    const target = await makeCustomer();
    const auditor = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'auditor' },
    );
    expect(auditor.kind).toBe('roleActivated');
    const conflicting = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'operations' },
    );
    expect(conflicting.kind).toBe('roleConflict');

    // access_admin ∦ finance surfaces at approval time too.
    const financeForAdmin = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: adminB, role: 'finance' },
    );
    expect(financeForAdmin.kind).toBe('roleConflict');
  });

  it('stale versions fail safely and concurrent approvals admit exactly one activation', async () => {
    const target = await makeCustomer();
    const requested = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'finance' },
    );
    if (requested.kind !== 'roleRequested') throw new Error(requested.kind);

    const stale = await approveRoleAssignment(
      { db: testDb.db },
      { userId: adminB },
      { assignmentId: requested.assignmentId, expectedVersion: 99 },
    );
    expect(stale.kind).toBe('staleVersion');

    const results = await Promise.all([
      approveRoleAssignment(
        { db: testDb.db },
        { userId: adminB },
        { assignmentId: requested.assignmentId, expectedVersion: 1 },
      ),
      approveRoleAssignment(
        { db: testDb.db },
        { userId: adminB },
        { assignmentId: requested.assignmentId, expectedVersion: 1 },
      ),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds.filter((k) => k === 'roleActivated')).toHaveLength(1);
    expect(['assignmentAlreadyFinalized', 'staleVersion']).toContain(
      kinds.find((k) => k !== 'roleActivated'),
    );
  });

  it('concurrent approval and Access-Administrator revocation cannot activate an invalid finance grant', async () => {
    // Third qualified admin C to act as approver, then race revocation of C
    // against C's approval of a finance request.
    const adminC = await makeCustomer();
    const grantC = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: adminC, role: 'access_admin' },
    );
    if (grantC.kind !== 'roleRequested') throw new Error(grantC.kind);
    const activatedC = await approveRoleAssignment(
      { db: testDb.db },
      { userId: adminB },
      { assignmentId: grantC.assignmentId, expectedVersion: 1 },
    );
    if (activatedC.kind !== 'roleActivated') throw new Error(activatedC.kind);

    const target = await makeCustomer();
    const requested = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'finance' },
    );
    if (requested.kind !== 'roleRequested') throw new Error(requested.kind);

    const [revokeC, approveByC] = await Promise.all([
      revokeRoleAssignment(
        { db: testDb.db },
        { userId: adminB },
        { assignmentId: grantC.assignmentId, expectedVersion: 2 },
      ),
      approveRoleAssignment(
        { db: testDb.db },
        { userId: adminC },
        { assignmentId: requested.assignmentId, expectedVersion: 1 },
      ),
    ]);

    // Every interleaving is safe: if C's approval won, C was still an
    // active access_admin at commit; if the revocation won first, the
    // approval is refused. Never an activated grant with a disqualified
    // approver at activation time.
    expect(revokeC.kind).toBe('roleRevoked');
    if (approveByC.kind === 'roleActivated') {
      expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual(['finance']);
    } else {
      expect(['approverNotQualified', 'staleVersion']).toContain(approveByC.kind);
      expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);
    }
  });
});

describe('listing and audit trail', () => {
  it('lists assignments for access administrators and auditors only', async () => {
    const customer = await makeCustomer();
    const denied = await listRoleAssignments({ db: testDb.db }, { userId: customer }, {});
    expect(denied.kind).toBe('forbidden');
    const listed = await listRoleAssignments({ db: testDb.db }, { userId: adminA }, {});
    expect(listed.kind).toBe('assignments');
    if (listed.kind === 'assignments') {
      expect(listed.assignments.length).toBeGreaterThan(0);
      for (const assignment of listed.assignments) {
        expect(assignment).not.toHaveProperty('email');
      }
    }
  });

  it('every lifecycle step wrote audit and outbox events with ids-only payloads', async () => {
    const audits = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('action', 'like', 'auth.admin_role%')
      .execute();
    const actions = new Set(audits.map((a) => a.action));
    for (const expected of [
      'auth.admin_role_requested',
      'auth.admin_role_approved',
      'auth.admin_role_denied',
      'auth.admin_role_revoked',
      'auth.admin_role_expired',
    ]) {
      expect(actions).toContain(expected);
    }
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type', 'payload'])
      .where('event_type', 'like', 'admin_role.%')
      .execute();
    expect(outbox.length).toBeGreaterThan(0);
    for (const event of outbox) {
      const payload = (
        typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload
      ) as Record<string, unknown>;
      for (const value of Object.values(payload)) {
        expect(String(value)).not.toContain('@');
      }
    }
  });
});
