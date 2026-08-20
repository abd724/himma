/**
 * W3-9 Admin ↔ backend CONTRACT journeys: the LIVE roles and audit ports
 * against the REAL backend (buildApp + real PostgreSQL + fake Cognito).
 * The full dual-control role lifecycle runs through the live admin
 * transport — request → the requester's own approval REFUSED by the
 * database trigger (dualControlViolation) → a second access administrator
 * approves → active → revoke — and the audit explorer reads the REAL
 * append-only consequences of those very actions, with the bounded
 * projection and the role gates (auditor + operations read; access_admin
 * is refused despite being a real admin).
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import {
  bootstrapAccessAdmins,
  createIdentity,
  createUser,
} from '../../backend/test/helpers/identity-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveRolesPort } from '../src/services/live/live-roles-port';
import { createLiveAuditPort } from '../src/services/live/live-audit-port';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from '../../portal/test-contract/support/backend-harness';

let harness: ContractHarness;
let adminA: string;
let adminB: string;
let userCounter = 0;

async function provisionAdmin(
  role: 'operations' | 'access_admin' | 'auditor',
): Promise<{ email: string; password: string; userId: string }> {
  userCounter += 1;
  const email = `roles-admin-${userCounter}@contract.test`;
  const password = `pw-roles-${userCounter}`;
  const subject = `roles-contract-sub-${userCounter}`;
  const userId = await createUser(harness.testDb.db);
  await createIdentity(harness.testDb.db, userId, {
    provider: 'email',
    issuer: CONTRACT_ISSUER,
    subject,
    email,
    emailVerified: true,
  });
  await harness.testDb.db
    .insertInto('mfa_method')
    .values({ id: newId(), user_id: userId, kind: 'totp', state: 'active', confirmed_at: new Date() })
    .execute();
  await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
            VALUES (${newId()}, ${userId}, ${role}, 'active', ${adminA}, ${adminB})`.execute(
    harness.testDb.db,
  );
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: `Roles Admin ${userCounter}`,
    mfaConfigured: true,
  });
  return { email, password, userId };
}

async function signedInPorts(credentials: { email: string; password: string }) {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  await runtime.adapter.signIn(credentials);
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  expect(signedIn).toMatchObject({ kind: 'signedIn', assurance: 'mfa' });
  return {
    rolesPort: createLiveRolesPort(runtime.transport),
    auditPort: createLiveAuditPort(runtime.transport),
  };
}

beforeAll(async () => {
  harness = await createContractHarness();
  ({ adminA, adminB } = await bootstrapAccessAdmins(harness.testDb.db));
});

afterAll(async () => {
  await harness.close();
});

describe('the real W3-9 journeys through the live admin transport', () => {
  test('dual-control role lifecycle: request → own approval REFUSED → second admin approves → active → revoke; the audit explorer reads the real consequences', async () => {
    const requester = await provisionAdmin('access_admin');
    const approver = await provisionAdmin('access_admin');
    const requesterPorts = await signedInPorts(requester);
    const approverPorts = await signedInPorts(approver);
    const targetUserId = await createUser(harness.testDb.db);

    // Finance-capable roles (finance, access_admin) are the DUAL-CONTROL
    // set — a request rests at `requested` until a second administrator
    // decides (other roles activate immediately, certified B2-5 truth).
    await expect(
      requesterPorts.rolesPort.requestRole({ targetUserId, role: 'finance' }),
    ).resolves.toEqual({ kind: 'completed' });
    const pending = await requesterPorts.rolesPort.listAssignments({ userId: targetUserId });
    if (pending.kind !== 'loaded') throw new Error(pending.kind);
    const assignment = pending.assignments.find((entry) => entry.state === 'requested')!;
    expect(assignment.role).toBe('finance');
    expect(assignment.requestedBy).toBe(requester.userId);

    // DUAL CONTROL: the requester's own approval is the DATABASE's refusal.
    await expect(
      requesterPorts.rolesPort.approveRequest(assignment.id, {
        expectedVersion: assignment.version,
      }),
    ).resolves.toEqual({ kind: 'dualControlViolation' });
    // A stale CAS from the legitimate approver refuses without change.
    await expect(
      approverPorts.rolesPort.approveRequest(assignment.id, { expectedVersion: 99 }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    await expect(
      approverPorts.rolesPort.approveRequest(assignment.id, {
        expectedVersion: assignment.version,
      }),
    ).resolves.toEqual({ kind: 'completed' });

    const active = await approverPorts.rolesPort.listAssignments({ userId: targetUserId });
    if (active.kind !== 'loaded') throw new Error(active.kind);
    const activated = active.assignments.find((entry) => entry.id === assignment.id)!;
    expect(activated.state).toBe('active');
    expect(activated.approvedBy).toBe(approver.userId);

    await expect(
      approverPorts.rolesPort.revokeAssignment(assignment.id, {
        expectedVersion: activated.version,
      }),
    ).resolves.toEqual({ kind: 'completed' });

    // The audit explorer reads the REAL trail of exactly these actions.
    const auditor = await provisionAdmin('auditor');
    const auditorPorts = await signedInPorts(auditor);
    const events = await auditorPorts.auditPort.listEvents({
      entityType: 'admin_role_assignment',
      entityId: assignment.id,
    });
    if (events.kind !== 'loaded') throw new Error(events.kind);
    const actions = events.events.map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.admin_role_requested',
        'auth.admin_role_approved',
        'auth.admin_role_revoked',
      ]),
    );
    // Bounded projection: nothing internal serializes.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('digest');
    expect(serialized).not.toContain('principal_context');
    expect(serialized).not.toContain('request_id');
  });

  test('audit read authority per docs/31 §8: operations reads; access_admin is refused despite being a real admin; auditor reads role assignments read-only', async () => {
    const operations = await provisionAdmin('operations');
    const accessAdmin = await provisionAdmin('access_admin');
    const auditor = await provisionAdmin('auditor');

    const operationsPorts = await signedInPorts(operations);
    await expect(operationsPorts.auditPort.listEvents({ limit: 5 })).resolves.toMatchObject({
      kind: 'loaded',
    });

    const accessPorts = await signedInPorts(accessAdmin);
    await expect(accessPorts.auditPort.listEvents({})).resolves.toEqual({ kind: 'forbidden' });

    // The auditor reads assignments but cannot mutate them (service gate).
    const auditorPorts = await signedInPorts(auditor);
    await expect(auditorPorts.rolesPort.listAssignments({})).resolves.toMatchObject({
      kind: 'loaded',
    });
    await expect(
      auditorPorts.rolesPort.requestRole({ targetUserId: newId(), role: 'support' }),
    ).resolves.toEqual({ kind: 'forbidden' });
    // Operations cannot read role assignments at all (roles.view gate).
    await expect(operationsPorts.rolesPort.listAssignments({})).resolves.toEqual({
      kind: 'forbidden',
    });
  });
});
