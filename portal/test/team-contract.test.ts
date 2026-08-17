import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createUnconfiguredTeamPort } from '../src/auth/unconfigured-adapter';
import {
  ORG_WIDE_ONLY_ROLES,
  PROVIDER_ROLES,
  PROVIDER_ROLE_LABELS,
} from '../src/provider-access/contract';
import {
  FIXTURE_INVITATIONS,
  createFixtureAuthRuntime,
  fixtureBranches,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';

const blueWave = fixtureOrganizations.blueWave.organizationId;
const noor = fixtureOrganizations.noor.organizationId;
const falcon = fixtureOrganizations.falcon.organizationId;
const coral = fixtureOrganizations.coral.organizationId;

type Runtime = ReturnType<typeof createFixtureAuthRuntime>;

function runtimeAs(email: string): Runtime {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession(email);
  return runtime;
}

async function staffOf(runtime: Runtime, orgId: string) {
  const outcome = await runtime.teamPort.loadStaff(orgId);
  if (outcome.kind !== 'loaded') {
    throw new Error(`expected loaded staff, got ${outcome.kind}`);
  }
  return outcome.staff;
}

describe('team port (fixture semantics, W2-6)', () => {
  test('the port exposes EXACTLY the four real staff operations — no role edit, resend, or delete', () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    expect(Object.keys(runtime.teamPort).sort()).toEqual([
      'issueInvitation',
      'loadStaff',
      'revokeInvitation',
      'revokeMembership',
    ]);
  });

  test('the provider role vocabulary is EXACTLY the seven approved roles with the canonical labels', () => {
    expect(PROVIDER_ROLES).toEqual([
      'owner',
      'org_manager',
      'branch_manager',
      'listings_editor',
      'coach',
      'front_desk',
      'finance',
    ]);
    expect(PROVIDER_ROLE_LABELS).toEqual({
      owner: 'Owner',
      org_manager: 'Organization Manager',
      branch_manager: 'Branch Manager',
      listings_editor: 'Listings Editor / Scheduler',
      coach: 'Coach / Instructor',
      front_desk: 'Front Desk / Booking Employee',
      finance: 'Finance',
    });
    expect(ORG_WIDE_ONLY_ROLES).toEqual(['owner', 'org_manager', 'finance']);
  });

  test('staff READ mirrors the exact registry: owner only — every other role is forbidden', async () => {
    expect((await runtimeAs('owner@bluewave.demo').teamPort.loadStaff(blueWave)).kind).toBe(
      'loaded',
    );
    // org_manager (docs/29 §7 shows ◐, but the SHIPPED registry is the
    // authority: staff.read is owner-only per docs/24 §1.3).
    expect((await runtimeAs('director@himma.demo').teamPort.loadStaff(blueWave)).kind).toBe(
      'forbidden',
    );
    expect((await runtimeAs('manager@bluewave.demo').teamPort.loadStaff(blueWave)).kind).toBe(
      'forbidden',
    );
    expect((await runtimeAs('flaky@bluewave.demo').teamPort.loadStaff(blueWave)).kind).toBe(
      'forbidden',
    );
    expect((await runtimeAs('assistant@coral.demo').teamPort.loadStaff(coral)).kind).toBe(
      'forbidden',
    );
    expect((await runtimeAs('frontdesk@bluewave.demo').teamPort.loadStaff(blueWave)).kind).toBe(
      'forbidden',
    );
    expect((await runtimeAs('finance@bluewave.demo').teamPort.loadStaff(blueWave)).kind).toBe(
      'forbidden',
    );
  });

  test('staff MANAGE mirrors the exact registry: every non-owner role is refused on each mutation', async () => {
    const nonOwners: Array<[string, string]> = [
      ['director@himma.demo', blueWave], // org_manager at Blue Wave
      ['manager@bluewave.demo', blueWave], // branch_manager
      ['flaky@bluewave.demo', blueWave], // listings_editor
      ['assistant@coral.demo', coral], // coach
      ['frontdesk@bluewave.demo', blueWave], // front_desk
      ['finance@bluewave.demo', blueWave], // finance
    ];
    for (const [email, orgId] of nonOwners) {
      const runtime = runtimeAs(email);
      expect(
        (
          await runtime.teamPort.issueInvitation(orgId, {
            email: 'someone@example.com',
            role: 'coach',
            branchScope: 'all',
          })
        ).kind,
      ).toBe('forbidden');
      expect((await runtime.teamPort.revokeInvitation(orgId, 'any-id')).kind).toBe('forbidden');
      expect((await runtime.teamPort.revokeMembership(orgId, 'any-id', 1)).kind).toBe('forbidden');
    }
  });

  test('the staff read returns memberships (incl. revoked history) and invitations as SEPARATE truths', async () => {
    const staff = await staffOf(runtimeAs('owner@bluewave.demo'), blueWave);
    expect(staff.memberships.some((row) => row.state === 'revoked')).toBe(true);
    expect(staff.memberships.some((row) => row.state === 'active')).toBe(true);
    const states = new Set(staff.invitations.map((row) => row.state));
    expect(states).toEqual(new Set(['sent', 'accepted', 'revoked', 'expired']));
    // An invitation never masquerades as a membership: no shared ids.
    const membershipIds = new Set(staff.memberships.map((row) => row.id));
    expect(staff.invitations.some((row) => membershipIds.has(row.id))).toBe(false);
  });

  test('no read payload ever carries a token, digest, or HR/auth field (task §31.34, §31.36)', async () => {
    const staff = await staffOf(runtimeAs('owner@bluewave.demo'), blueWave);
    const allRows = [...staff.memberships, ...staff.invitations] as unknown as Array<Record<string, unknown>>;
    const forbiddenKeys = [
      'token',
      'tokenDigest',
      'digest',
      'pepperVersion',
      'salary',
      'payroll',
      'leave',
      'timesheet',
      'contract',
      'cognitoSub',
      'issuer',
      'mfa',
    ];
    for (const row of allRows) {
      for (const key of forbiddenKeys) {
        expect(Object.keys(row)).not.toContain(key);
      }
    }
    const serialized = JSON.stringify(staff);
    expect(serialized).not.toContain('HIMMA-INVITE');
    expect(serialized).not.toContain('cognito');
  });

  test('an Owner issues a valid invitation: sent state, 7-day expiry, appears in the shared read', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const outcome = await runtime.teamPort.issueInvitation(blueWave, {
      email: 'New.Coach@Example.com ',
      role: 'coach',
      branchScope: [fixtureBranches.blueWaveBay],
    });
    expect(outcome.kind).toBe('invitationIssued');
    if (outcome.kind !== 'invitationIssued') {
      return;
    }
    expect(outcome.mailDelivery).toBe('delivered');
    const staff = await staffOf(runtime, blueWave);
    const created = staff.invitations.find((row) => row.id === outcome.invitationId);
    // Normalized like the backend: trimmed + lowercased.
    expect(created?.email).toBe('new.coach@example.com');
    expect(created?.state).toBe('sent');
    expect(created?.branchScopeKind).toBe('branches');
    expect(created?.branchIds).toEqual([fixtureBranches.blueWaveBay]);
  });

  test('issuing to an address with a still-sent invitation SUPERSEDES it (approved resend policy)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await staffOf(runtime, blueWave);
    const existing = before.invitations.find(
      (row) => row.email === 'newcoach@bluewave.demo' && row.state === 'sent',
    );
    expect(existing).toBeDefined();
    const outcome = await runtime.teamPort.issueInvitation(blueWave, {
      email: 'newcoach@bluewave.demo',
      role: 'front_desk',
      branchScope: 'all',
    });
    expect(outcome.kind).toBe('invitationIssued');
    const after = await staffOf(runtime, blueWave);
    expect(after.invitations.find((row) => row.id === existing?.id)?.state).toBe('revoked');
    expect(
      after.invitations.filter(
        (row) => row.email === 'newcoach@bluewave.demo' && row.state === 'sent',
      ),
    ).toHaveLength(1);
  });

  test('a failed mail delivery still creates the invitation (mailDelivery: failed, never a rollback)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.failNextInvitationMail(blueWave);
    const outcome = await runtime.teamPort.issueInvitation(blueWave, {
      email: 'unreachable@example.com',
      role: 'coach',
      branchScope: 'all',
    });
    expect(outcome.kind).toBe('invitationIssued');
    if (outcome.kind !== 'invitationIssued') {
      return;
    }
    expect(outcome.mailDelivery).toBe('failed');
    const staff = await staffOf(runtime, blueWave);
    expect(staff.invitations.some((row) => row.id === outcome.invitationId)).toBe(true);
  });

  test('branch-scope validation mirrors the backend exactly: org-wide-only roles, empty, foreign, and inactive scopes refused', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // Org-wide-only roles can never be branch-scoped.
    for (const role of ORG_WIDE_ONLY_ROLES) {
      expect(
        (
          await runtime.teamPort.issueInvitation(blueWave, {
            email: 'scope@example.com',
            role,
            branchScope: [fixtureBranches.blueWaveMarina],
          })
        ).kind,
      ).toBe('invalidBranchScope');
    }
    // Empty explicit selection is not a scope.
    expect(
      (
        await runtime.teamPort.issueInvitation(blueWave, {
          email: 'scope@example.com',
          role: 'coach',
          branchScope: [],
        })
      ).kind,
    ).toBe('invalidBranchScope');
    // Another organization's branch id never validates (and leaks nothing).
    expect(
      (
        await runtime.teamPort.issueInvitation(blueWave, {
          email: 'scope@example.com',
          role: 'coach',
          branchScope: [fixtureBranches.noorBarsha],
        })
      ).kind,
    ).toBe('invalidBranchScope');
    // A deactivated branch is not a valid grant target at issue time.
    expect(
      (
        await runtime.teamPort.issueInvitation(blueWave, {
          email: 'scope@example.com',
          role: 'coach',
          branchScope: [fixtureBranches.blueWaveSufouh],
        })
      ).kind,
    ).toBe('invalidBranchScope');
  });

  test("explicit 'all' is a DISTINCT scope kind from manually selecting every branch", async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const allOutcome = await runtime.teamPort.issueInvitation(blueWave, {
      email: 'allscope@example.com',
      role: 'coach',
      branchScope: 'all',
    });
    const listOutcome = await runtime.teamPort.issueInvitation(blueWave, {
      email: 'listscope@example.com',
      role: 'coach',
      branchScope: [fixtureBranches.blueWaveMarina, fixtureBranches.blueWaveBay],
    });
    expect(allOutcome.kind).toBe('invitationIssued');
    expect(listOutcome.kind).toBe('invitationIssued');
    const staff = await staffOf(runtime, blueWave);
    const allRow = staff.invitations.find((row) => row.email === 'allscope@example.com');
    const listRow = staff.invitations.find((row) => row.email === 'listscope@example.com');
    expect(allRow?.branchScopeKind).toBe('all');
    expect(allRow?.branchIds).toEqual([]);
    expect(listRow?.branchScopeKind).toBe('branches');
    expect(listRow?.branchIds).toHaveLength(2);
  });

  test('malformed email is a server-mirror validationError', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    for (const email of ['', 'no-at-sign', '@leading.at', 'two words@example.com']) {
      expect(
        (
          await runtime.teamPort.issueInvitation(blueWave, {
            email,
            role: 'coach',
            branchScope: 'all',
          })
        ).kind,
      ).toBe('validationError');
    }
  });

  test('every staff mutation is step-up gated: a lapsed window refuses with stepUpRequired and executes NOTHING', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await staffOf(runtime, blueWave);
    runtime.controls.expireStepUpWindow();

    expect(
      (
        await runtime.teamPort.issueInvitation(blueWave, {
          email: 'gated@example.com',
          role: 'coach',
          branchScope: 'all',
        })
      ).kind,
    ).toBe('stepUpRequired');
    const sentInvitation = before.invitations.find((row) => row.state === 'sent');
    expect(
      (await runtime.teamPort.revokeInvitation(blueWave, sentInvitation?.id ?? 'x')).kind,
    ).toBe('stepUpRequired');
    const coach = before.memberships.find(
      (row) => row.role === 'coach' && row.state === 'active',
    );
    expect(
      (await runtime.teamPort.revokeMembership(blueWave, coach?.id ?? 'x', coach?.version ?? 1))
        .kind,
    ).toBe('stepUpRequired');

    // Nothing executed while gated.
    const after = await staffOf(runtime, blueWave);
    expect(after).toEqual(before);

    // A fresh step-up grant re-opens the window and the SAME operation runs.
    await runtime.adapter.completeStepUpTotp('246810');
    expect(
      (
        await runtime.teamPort.issueInvitation(blueWave, {
          email: 'gated@example.com',
          role: 'coach',
          branchScope: 'all',
        })
      ).kind,
    ).toBe('invitationIssued');
  });

  test('reads are NEVER step-up gated', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.expireStepUpWindow();
    expect((await runtime.teamPort.loadStaff(blueWave)).kind).toBe('loaded');
  });

  test('revoking a sent invitation kills it; revoking again is idempotent; finalized rows conflict', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const sent = staff.invitations.find(
      (row) => row.email === 'newcoach@bluewave.demo' && row.state === 'sent',
    );
    expect((await runtime.teamPort.revokeInvitation(blueWave, sent?.id ?? 'x')).kind).toBe(
      'invitationRevoked',
    );
    // Idempotent second revoke — executes once, still the success shape.
    expect((await runtime.teamPort.revokeInvitation(blueWave, sent?.id ?? 'x')).kind).toBe(
      'invitationRevoked',
    );
    const accepted = staff.invitations.find((row) => row.state === 'accepted');
    const expired = staff.invitations.find((row) => row.state === 'expired');
    expect((await runtime.teamPort.revokeInvitation(blueWave, accepted?.id ?? 'x')).kind).toBe(
      'lifecycleConflict',
    );
    expect((await runtime.teamPort.revokeInvitation(blueWave, expired?.id ?? 'x')).kind).toBe(
      'lifecycleConflict',
    );
    expect((await runtime.teamPort.revokeInvitation(blueWave, 'unknown-id')).kind).toBe(
      'notFound',
    );
  });

  test('revoking an invitation NEVER touches an accepted membership (task §31.14)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await staffOf(runtime, blueWave);
    const sent = before.invitations.find((row) => row.state === 'sent');
    await runtime.teamPort.revokeInvitation(blueWave, sent?.id ?? 'x');
    const after = await staffOf(runtime, blueWave);
    expect(after.memberships).toEqual(before.memberships);
  });

  test('an overdue-but-still-sent invitation refuses acceptance by TIME but stays revocable', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const overdue = staff.invitations.find(
      (row) => row.state === 'sent' && new Date(row.expiresAt).getTime() <= Date.now(),
    );
    expect(overdue).toBeDefined();
    expect((await runtime.teamPort.revokeInvitation(blueWave, overdue?.id ?? 'x')).kind).toBe(
      'invitationRevoked',
    );
  });

  test('revoking a non-last Owner succeeds and preserves the row as history (never deleted)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const owners = staff.memberships.filter(
      (row) => row.role === 'owner' && row.state === 'active',
    );
    expect(owners.length).toBe(2);
    const target = owners[1];
    if (!target) {
      throw new Error('expected a second active owner in the fixture');
    }
    const outcome = await runtime.teamPort.revokeMembership(
      blueWave,
      target.id,
      target.version,
    );
    expect(outcome.kind).toBe('membershipRevoked');
    const after = await staffOf(runtime, blueWave);
    const revokedRow = after.memberships.find((row) => row.id === target.id);
    expect(revokedRow?.state).toBe('revoked');
    expect(revokedRow?.role).toBe('owner');
    // Idempotent repeat (task §31.31 — a duplicate mutation executes once).
    expect(
      (await runtime.teamPort.revokeMembership(blueWave, target.id, target.version + 1)).kind,
    ).toBe('membershipRevoked');
  });

  test('revoking the LAST active Owner is refused (lastOwnerProtected); pending owner invitations never count', async () => {
    // Noor has exactly one active owner; a pending owner invitation at
    // Coral proves invitations don't satisfy the invariant either.
    const runtime = runtimeAs('director@himma.demo');
    const noorStaff = await staffOf(runtime, noor);
    const soleOwner = noorStaff.memberships.find(
      (row) => row.role === 'owner' && row.state === 'active',
    );
    const outcome = await runtime.teamPort.revokeMembership(
      noor,
      soleOwner?.id ?? 'x',
      soleOwner?.version ?? 1,
    );
    expect(outcome.kind).toBe('lastOwnerProtected');
    // Nothing changed.
    const after = await staffOf(runtime, noor);
    expect(after.memberships.find((row) => row.id === soleOwner?.id)?.state).toBe('active');
  });

  test('the two-owner race resolves like the DB trigger: once the co-owner is gone, the survivor is protected', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const owners = staff.memberships.filter(
      (row) => row.role === 'owner' && row.state === 'active',
    );
    const [mine, coOwner] = owners;
    if (!mine || !coOwner) {
      throw new Error('expected two active owners in the fixture');
    }
    // Another owner's session revokes the co-owner while this list is stale.
    runtime.controls.simulateConcurrentStaffRevocation(blueWave, coOwner.id);
    // Attempting to revoke the remaining owner now hits the invariant.
    const outcome = await runtime.teamPort.revokeMembership(blueWave, mine.id, mine.version);
    expect(outcome.kind).toBe('lastOwnerProtected');
  });

  test('caller self-management mirrors the backend: self-revoke allowed with a co-owner, refused when last', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const own = staff.memberships.find(
      (row) => row.role === 'owner' && row.state === 'active' && row.createdAt === '2026-03-02T08:00:00.000Z',
    );
    // With a co-owner active, self-revocation is permitted…
    const outcome = await runtime.teamPort.revokeMembership(blueWave, own?.id ?? 'x', own?.version ?? 1);
    expect(outcome.kind).toBe('membershipRevoked');
    // …and the caller's own access disappears (provider-access coherence).
    const access = await runtime.accessPort.resolveAccess();
    expect(access.kind).toBe('resolved');
    if (access.kind === 'resolved') {
      expect(access.memberships.some((m) => m.organizationId === blueWave)).toBe(false);
    }
    // The staff read is now refused: the caller no longer has a membership.
    expect((await runtime.teamPort.loadStaff(blueWave)).kind).toBe('notFound');
  });

  test('role/scope CHANGE is the canonical revoke + NEW invitation — history is never mutated (task §31.15–17)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const before = await staffOf(runtime, blueWave);
    const coach = before.memberships.find(
      (row) => row.role === 'coach' && row.state === 'active',
    );
    expect(coach).toBeDefined();
    if (!coach) {
      return;
    }
    // Step 1 — revoke the current membership (CAS).
    expect((await runtime.teamPort.revokeMembership(blueWave, coach.id, coach.version)).kind).toBe(
      'membershipRevoked',
    );
    // Step 2 — issue the NEW invitation with the new role/scope.
    const invite = await runtime.teamPort.issueInvitation(blueWave, {
      email: 'aqua.coach@bluewave.example',
      role: 'branch_manager',
      branchScope: [fixtureBranches.blueWaveMarina],
    });
    expect(invite.kind).toBe('invitationIssued');
    const after = await staffOf(runtime, blueWave);
    const historical = after.memberships.find((row) => row.id === coach.id);
    // The historical row keeps its ORIGINAL role identity, revoked.
    expect(historical?.role).toBe('coach');
    expect(historical?.state).toBe('revoked');
    expect(historical?.branchIds).toEqual(coach.branchIds);
    // No new membership exists until the person accepts the invitation.
    expect(
      after.memberships.filter((row) => row.role === 'branch_manager' && row.state === 'active'),
    ).toHaveLength(1); // only the pre-existing branch manager
  });

  test('a stale expectedVersion never overwrites (staleVersion CAS refusal)', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const coach = staff.memberships.find(
      (row) => row.role === 'coach' && row.state === 'active',
    );
    runtime.controls.simulateConcurrentStaffChange(blueWave, coach?.id ?? 'x');
    const outcome = await runtime.teamPort.revokeMembership(
      blueWave,
      coach?.id ?? 'x',
      coach?.version ?? 1,
    );
    expect(outcome.kind).toBe('staleVersion');
    const after = await staffOf(runtime, blueWave);
    expect(after.memberships.find((row) => row.id === coach?.id)?.state).toBe('active');
  });

  test('a suspended organization still READS but refuses every staff mutation', async () => {
    const runtime = runtimeAs('director@himma.demo');
    // director is the falcon owner: read works while suspended…
    const staff = await staffOf(runtime, falcon);
    expect(staff.memberships.length).toBeGreaterThan(0);
    // …every mutation is refused with the canonical outcome.
    expect(
      (
        await runtime.teamPort.issueInvitation(falcon, {
          email: 'x@example.com',
          role: 'coach',
          branchScope: 'all',
        })
      ).kind,
    ).toBe('organizationSuspended');
    const sent = staff.invitations.find((row) => row.state === 'sent');
    expect((await runtime.teamPort.revokeInvitation(falcon, sent?.id ?? 'x')).kind).toBe(
      'organizationSuspended',
    );
    const member = staff.memberships.find((row) => row.state === 'active');
    expect(
      (await runtime.teamPort.revokeMembership(falcon, member?.id ?? 'x', member?.version ?? 1))
        .kind,
    ).toBe('organizationSuspended');
  });

  test('foreign organizations and unknown ids collapse into ONE not-found shape', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    // No membership at Noor: indistinguishable from an unknown org.
    expect((await runtime.teamPort.loadStaff(noor)).kind).toBe('notFound');
    expect(
      (await runtime.teamPort.loadStaff('0198a2f0-5b7a-7000-8000-000000000000')).kind,
    ).toBe('notFound');
    // A foreign membership id inside the caller's own org is notFound too.
    const noorRuntime = runtimeAs('director@himma.demo');
    const noorStaff = await staffOf(noorRuntime, noor);
    const foreignMembership = noorStaff.memberships[0];
    if (!foreignMembership) {
      throw new Error('expected a Noor membership in the fixture');
    }
    expect(
      (await runtime.teamPort.revokeMembership(blueWave, foreignMembership.id, 1)).kind,
    ).toBe('notFound');
  });

  test('accepting an invitation creates the membership row the Team read shows (shared fixture truth)', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newcoach@bluewave.demo');
    const accepted = await runtime.invitationPort.accept(FIXTURE_INVITATIONS.staff);
    expect(accepted.kind).toBe('invitationAccepted');
    if (accepted.kind !== 'invitationAccepted') {
      return;
    }
    runtime.seedSession('owner@bluewave.demo');
    const staff = await staffOf(runtime, blueWave);
    const newRow = staff.memberships.find((row) => row.id === accepted.membershipId);
    expect(newRow?.state).toBe('active');
    expect(newRow?.role).toBe('coach');
    // The consumed invitation is finalized, not duplicated or hidden.
    expect(
      staff.invitations.find((row) => row.email === 'newcoach@bluewave.demo' && row.state === 'accepted'),
    ).toBeDefined();
  });

  test('transient failures surface as unavailable and a retry succeeds', async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    runtime.controls.failNextStaffLoad(blueWave);
    expect((await runtime.teamPort.loadStaff(blueWave)).kind).toBe('unavailable');
    expect((await runtime.teamPort.loadStaff(blueWave)).kind).toBe('loaded');
    runtime.controls.failNextStaffMutation(blueWave);
    expect(
      (
        await runtime.teamPort.issueInvitation(blueWave, {
          email: 'retry@example.com',
          role: 'coach',
          branchScope: 'all',
        })
      ).kind,
    ).toBe('unavailable');
  });

  test('the unconfigured production default fails closed on every operation', async () => {
    const port = createUnconfiguredTeamPort();
    expect((await port.loadStaff(blueWave)).kind).toBe('unavailable');
    expect(
      (await port.issueInvitation(blueWave, { email: 'x@example.com', role: 'coach', branchScope: 'all' }))
        .kind,
    ).toBe('unavailable');
    expect((await port.revokeInvitation(blueWave, 'x')).kind).toBe('unavailable');
    expect((await port.revokeMembership(blueWave, 'x', 1)).kind).toBe('unavailable');
  });

  test('the Team feature makes NO network calls and derives NO authority from token claims (task §31.35, §31.37)', () => {
    const portalRoot = join(__dirname, '..');
    const grep = (pattern: string, paths: string) =>
      execSync(`grep -rniE "${pattern}" ${paths} || true`, {
        cwd: portalRoot,
        encoding: 'utf8',
      }).trim();
    // No fetch/XHR/axios anywhere in the Team seam or surfaces — fixtures
    // only until W2-12 replaces the adapter.
    expect(
      grep('\\bfetch\\(|XMLHttpRequest|axios|new WebSocket', 'src/team src/pages/team'),
    ).toBe('');
    // Business authority never comes from Cognito groups/claims: outside
    // documentation comments, no DOMAIN code line touches Cognito
    // vocabulary (capabilities arrive from the backend-shaped organization
    // view alone). W2-12A narrowing: the dedicated auth boundary — the live
    // Cognito adapter, its composition, and the env config — legitimately
    // names the provider now; every other module remains claims-free.
    const AUTH_BOUNDARY = ['src/auth/live/', 'src/app/auth-runtime.ts', 'src/api/env.ts'];
    const cognitoCodeLines = grep('cognito|custom:group', 'src')
      .split('\n')
      .filter(Boolean)
      .filter((line) => !/^\S+:\d+:\s*(\*|\/\/|\/\*)/.test(line))
      .filter((line) => !AUTH_BOUNDARY.some((boundary) => line.startsWith(boundary)));
    expect(cognitoCodeLines).toEqual([]);
  });

  test("the caller's own membership id in the org view matches the staff read row (the 'You' seam)", async () => {
    const runtime = runtimeAs('owner@bluewave.demo');
    const view = await runtime.profilePort.loadOrganizationView(blueWave);
    const staff = await staffOf(runtime, blueWave);
    if (view.kind !== 'loaded') {
      throw new Error('expected loaded view');
    }
    const ownRow = staff.memberships.find((row) => row.id === view.view.membership.id);
    expect(ownRow?.role).toBe('owner');
    expect(ownRow?.state).toBe('active');
  });
});
