/**
 * W2-12B domain contract tests (task §25–§27): the LIVE provider domain
 * ports — onboarding · profile/storefront · branches (+ the area read) ·
 * team · invitations — against the REAL backend (`buildApp` on real
 * PostgreSQL) through the REAL authenticated W2-12A transport (sign-in +
 * MFA over the deterministic fake Cognito boundary). Every route, policy,
 * capability check, CAS conflict, and DTO below is the real thing.
 */
import { sql } from 'kysely';

import { newId } from '../../backend/src/db/ids';
import { openVerificationCase } from '../../backend/src/modules/provider/services/verification-case';
import {
  beginVerificationReview,
  decideVerification,
} from '../../backend/src/modules/provider/services/verification-review';
import {
  bootstrapAccessAdmins,
  createIdentity,
  createUser,
} from '../../backend/test/helpers/identity-fixtures';
import {
  addMembership,
  createProviderOrg,
} from '../../backend/test/helpers/provider-fixtures';
import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { SessionInterrupt } from '../src/auth/adapter';
import type { ProviderRole } from '../src/provider-access/contract';
import {
  createLiveDomainPorts,
  type LiveDomainPorts,
} from '../src/services/live/live-domain-ports';
import {
  CONTRACT_CLIENT_ID,
  CONTRACT_ISSUER,
  createContractHarness,
  VALID_TOTP,
  type ContractHarness,
} from './support/backend-harness';

let harness: ContractHarness;

beforeAll(async () => {
  harness = await createContractHarness();
});

afterAll(async () => {
  await harness.close();
});

let userCounter = 500;

interface LiveSession {
  ports: LiveDomainPorts;
  accessPort: ReturnType<typeof createLiveAuthRuntime>['accessPort'];
  interrupts: SessionInterrupt[];
  userId: string;
  email: string;
}

async function provisionUser(options: { displayName?: string } = {}): Promise<{
  userId: string;
  email: string;
  password: string;
}> {
  userCounter += 1;
  const email = `domain-${userCounter}@contract.test`;
  const password = `pw-${userCounter}`;
  const subject = `domain-sub-${userCounter}`;
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
  harness.registerUser(email, {
    password,
    subject,
    email,
    displayName: options.displayName ?? `Domain ${userCounter}`,
    mfaConfigured: true,
  });
  return { userId, email, password };
}

/** MFA sign-in through the REAL live adapter; returns live domain ports
 *  bound to that session's transport. */
async function signedInPorts(user: { email: string; password: string; userId: string }): Promise<LiveSession> {
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: harness.apiBaseUrl,
    cognitoIssuer: CONTRACT_ISSUER,
    cognitoClientId: CONTRACT_CLIENT_ID,
    fetchImpl: harness.fetchImpl,
  });
  const interrupts: SessionInterrupt[] = [];
  runtime.adapter.subscribe((interrupt) => interrupts.push(interrupt));
  await runtime.adapter.signIn({ email: user.email, password: user.password });
  const signedIn = await runtime.adapter.completeMfaChallenge(VALID_TOTP);
  if (signedIn.kind !== 'signedIn') throw new Error(`sign-in failed: ${signedIn.kind}`);
  return {
    ports: createLiveDomainPorts(runtime.transport),
    accessPort: runtime.accessPort,
    interrupts,
    userId: user.userId,
    email: user.email,
  };
}

async function provisionOrgWithRole(
  role: ProviderRole,
  options: { state?: string; branches?: number; scoped?: boolean } = {},
): Promise<{ session: LiveSession; orgId: string; branchIds: string[] }> {
  const user = await provisionUser();
  const org = await createProviderOrg(harness.testDb.db, {
    state: options.state ?? 'live',
    branches: options.branches ?? 2,
    displayName: `Org for ${role} ${userCounter}`,
  });
  await addMembership(
    harness.testDb.db,
    user.userId,
    org.orgId,
    role,
    options.scoped === true ? [org.branchIds[0] as string] : undefined,
  );
  const session = await signedInPorts(user);
  return { session, orgId: org.orgId, branchIds: org.branchIds };
}

describe('organization view & profile (§25.1–6)', () => {
  test('an owner reads the REAL org view; a foreign organization is the safe not-found shape', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner');
    const view = await session.ports.profilePort.loadOrganizationView(orgId);
    expect(view).toMatchObject({
      kind: 'loaded',
      view: {
        organization: { id: orgId, verificationState: 'live' },
        membership: { role: 'owner', branchScope: 'all' },
      },
    });
    if (view.kind === 'loaded') {
      expect(view.view.branches).toHaveLength(2);
      expect(view.view.membership.capabilities).toContain('profile.edit');
    }

    const foreign = await createProviderOrg(harness.testDb.db, {
      displayName: 'Foreign Secret Org B',
    });
    await expect(
      session.ports.profilePort.loadOrganizationView(foreign.orgId),
    ).resolves.toEqual({ kind: 'notFound' });
  });

  test('authorized profile edit persists with CAS; a stale version is refused; storefront publication maps distinctly from live state', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner', { state: 'draft' });
    const before = await session.ports.profilePort.loadOrganizationView(orgId);
    if (before.kind !== 'loaded') throw new Error('view failed');
    const version = before.view.profile.version;

    const updated = await session.ports.profilePort.updateProfile(orgId, version, {
      descriptionEn: 'Real persisted description',
      published: true,
    });
    expect(updated).toMatchObject({ kind: 'profileUpdated' });

    // Persisted server-side, and publication ≠ organization live state.
    const after = await session.ports.profilePort.loadOrganizationView(orgId);
    if (after.kind !== 'loaded') throw new Error('view failed');
    expect(after.view.profile.descriptionEn).toBe('Real persisted description');
    expect(after.view.profile.published).toBe(true);
    expect(after.view.organization.verificationState).toBe('draft'); // NOT live

    // The consumed version is now stale — CAS refuses, nothing overwrites.
    await expect(
      session.ports.profilePort.updateProfile(orgId, version, { descriptionEn: 'clobber' }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    const unchanged = await session.ports.profilePort.loadOrganizationView(orgId);
    if (unchanged.kind !== 'loaded') throw new Error('view failed');
    expect(unchanged.view.profile.descriptionEn).toBe('Real persisted description');
  });

  test('a role without profile.edit is refused server-side (frontend controls merely reflect it)', async () => {
    const { session, orgId } = await provisionOrgWithRole('listings_editor');
    const view = await session.ports.profilePort.loadOrganizationView(orgId);
    if (view.kind !== 'loaded') throw new Error('view failed');
    expect(view.view.membership.capabilities).not.toContain('profile.edit');
    await expect(
      session.ports.profilePort.updateProfile(orgId, view.view.profile.version, {
        displayName: 'Escalated',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
  });

  test('W3-8: the REAL rejection decision surfaces as the provider-safe latestDecision on the org view and onboarding snapshot — nothing internal leaks, and resubmission stays certified', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner', { state: 'submitted' });

    // Before any round: null, never invented.
    const bare = await session.ports.profilePort.loadOrganizationView(orgId);
    if (bare.kind !== 'loaded') throw new Error(bare.kind);
    expect(bare.view.verification).toBeNull();

    // Drive the CERTIFIED W3-3/W3-5 review path service-side (an operations
    // admin; the test composition reports content safety ready — the only
    // state in which real decisions are mechanically possible).
    const { adminA, adminB } = await bootstrapAccessAdmins(harness.testDb.db);
    const opsUserId = await createUser(harness.testDb.db);
    await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
              VALUES (${newId()}, ${opsUserId}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
      harness.testDb.db,
    );
    const opsActor = { userId: opsUserId };
    const caseDeps = {
      db: harness.testDb.db,
      policyProvider: {
        currentPolicy: async () => ({
          policyVersion: 'domain-contract-v1',
          requirements: [
            { key: 'business_document', labelEn: 'Business document', required: true },
          ],
        }),
      },
    };
    const reviewDeps = {
      db: harness.testDb.db,
      lifecycle: { nodeEnv: 'test' as const, verificationEvidenceCapabilityReady: false },
      contentSafetyReady: true,
    };
    const opened = await openVerificationCase(caseDeps, opsActor, { organizationId: orgId });
    if (opened.kind !== 'caseOpened') throw new Error(opened.kind);
    const begun = await beginVerificationReview(reviewDeps, opsActor, {
      organizationId: orgId,
      caseId: opened.caseId,
      expectedCaseVersion: opened.version,
    });
    if (begun.kind !== 'reviewStarted') throw new Error(begun.kind);
    const decided = await decideVerification(reviewDeps, opsActor, {
      organizationId: orgId,
      caseId: opened.caseId,
      expectedCaseVersion: begun.caseVersion,
      outcome: 'rejected',
      reasonCode: 'expired_document',
      providerSafeMessage: 'Your trade licence has expired — upload a current one.',
      internalNote: 'Registry lookup failed twice. Escalated internally.',
    });
    if (decided.kind !== 'verificationDecided') throw new Error(decided.kind);

    // The provider org view: exactly the provider-safe layers.
    const rejected = await session.ports.profilePort.loadOrganizationView(orgId);
    if (rejected.kind !== 'loaded') throw new Error(rejected.kind);
    expect(rejected.view.organization.verificationState).toBe('rejected');
    expect(rejected.view.verification).toEqual({
      latestDecision: {
        outcome: 'rejected',
        reasonCode: 'expired_document',
        providerMessage: 'Your trade licence has expired — upload a current one.',
        decidedAt: expect.any(String),
      },
    });
    const serialized = JSON.stringify(rejected.view);
    expect(serialized).not.toContain('Escalated internally');
    expect(serialized).not.toContain(opsUserId); // reviewer identity
    expect(serialized).not.toContain('internalNote');

    // The onboarding snapshot carries the SAME projection...
    const snapshot = await session.ports.onboardingPort.loadSnapshot(orgId);
    if (snapshot.kind !== 'loaded') throw new Error(snapshot.kind);
    expect(snapshot.snapshot.verification?.latestDecision?.reasonCode).toBe('expired_document');

    // ...and the certified resubmission edge is unchanged, with the
    // historical decision staying truthfully visible.
    const resubmitted = await session.ports.onboardingPort.submitForVerification(
      orgId,
      snapshot.snapshot.organization.version,
    );
    expect(resubmitted.kind).toBe('organizationSubmitted');
    const after = await session.ports.onboardingPort.loadSnapshot(orgId);
    if (after.kind !== 'loaded') throw new Error(after.kind);
    expect(after.snapshot.organization.verificationState).toBe('submitted');
    expect(after.snapshot.verification?.latestDecision?.outcome).toBe('rejected');
  });

  test('onboarding snapshot composes from the same authoritative view and submission runs the real lifecycle edge', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner', { state: 'draft' });
    const snapshot = await session.ports.onboardingPort.loadSnapshot(orgId);
    expect(snapshot).toMatchObject({
      kind: 'loaded',
      snapshot: {
        organization: { verificationState: 'draft' },
        membership: { role: 'owner' },
        listingCount: 0, // the REAL count via the bounded walk (W2-12D)
      },
    });
    if (snapshot.kind !== 'loaded') throw new Error('snapshot failed');

    const submitted = await session.ports.onboardingPort.submitForVerification(
      orgId,
      snapshot.snapshot.organization.version,
    );
    expect(submitted).toMatchObject({ kind: 'organizationSubmitted' });
    expect(session.interrupts).toContainEqual({ kind: 'accessChanged' });

    const after = await session.ports.profilePort.loadOrganizationView(orgId);
    if (after.kind !== 'loaded') throw new Error('view failed');
    expect(after.view.organization.verificationState).toBe('submitted');
  });
});

describe('branches (§25.7–13) + the area dependency', () => {
  test('create → edit → deactivate runs the real routes; history stays readable; the areas read is the real taxonomy', async () => {
    const { session, orgId } = await provisionOrgWithRole('owner', { branches: 1 });

    const created = await session.ports.branchPort.createBranch(orgId, {
      label: 'Jumeirah family pool',
      areaLabel: 'Jumeirah',
      city: 'Dubai',
      facilities: ['parking', 'showers'],
    });
    expect(created).toMatchObject({
      kind: 'branchCreated',
      branch: { label: 'Jumeirah family pool', active: true, version: 1 },
    });
    if (created.kind !== 'branchCreated') throw new Error('create failed');
    const branchId = created.branch.id;

    const updated = await session.ports.branchPort.updateBranch(orgId, branchId, 1, {
      label: 'Jumeirah family pool — renamed',
    });
    expect(updated).toMatchObject({
      kind: 'branchUpdated',
      branch: { label: 'Jumeirah family pool — renamed' },
    });

    // Stale CAS on the branch refuses.
    await expect(
      session.ports.branchPort.updateBranch(orgId, branchId, 1, { label: 'stale write' }),
    ).resolves.toEqual({ kind: 'staleVersion' });

    const deactivated = await session.ports.branchPort.deactivateBranch(orgId, branchId, 2);
    expect(deactivated).toEqual({ kind: 'branchDeactivated' });

    // Deactivated ≠ deleted: the row remains readable history in the view.
    const view = await session.ports.profilePort.loadOrganizationView(orgId);
    if (view.kind !== 'loaded') throw new Error('view failed');
    const row = view.view.branches.find((branch) => branch.id === branchId);
    expect(row).toMatchObject({ active: false, label: 'Jumeirah family pool — renamed' });

    // The area picker's real public taxonomy read (empty until admin
    // seeds areas — the shape is the contract, not fixture vocabulary).
    const areas = await session.ports.areaPort.listAreas();
    expect(areas).toMatchObject({ kind: 'loaded' });
  });

  test('a foreign organization’s branch id mutates NOTHING and leaks NOTHING; a Branch Manager stays inside their assigned scope', async () => {
    const owner = await provisionOrgWithRole('owner');
    const foreign = await createProviderOrg(harness.testDb.db, { displayName: 'Foreign C' });
    await expect(
      owner.session.ports.branchPort.updateBranch(
        foreign.orgId,
        foreign.branchIds[0] as string,
        1,
        { label: 'hijack' },
      ),
    ).resolves.toEqual({ kind: 'notFound' });
    // Also a foreign branch id under the CALLER's own org path: not-found.
    await expect(
      owner.session.ports.branchPort.updateBranch(
        owner.orgId,
        foreign.branchIds[0] as string,
        1,
        { label: 'hijack' },
      ),
    ).resolves.toEqual({ kind: 'notFound' });

    const bm = await provisionOrgWithRole('branch_manager', { scoped: true });
    const [assigned, unassigned] = bm.branchIds;
    // Assigned ACTIVE branch: editable.
    await expect(
      bm.session.ports.branchPort.updateBranch(bm.orgId, assigned as string, 1, {
        label: 'BM renamed own branch',
      }),
    ).resolves.toMatchObject({ kind: 'branchUpdated' });
    // Unassigned branch of the SAME org: forbidden — scope cannot be
    // broadened by entering an id manually.
    await expect(
      bm.session.ports.branchPort.updateBranch(bm.orgId, unassigned as string, 1, {
        label: 'scope escape',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    // Branch creation needs branch.create (owner/org_manager) — refused.
    await expect(
      bm.session.ports.branchPort.createBranch(bm.orgId, {
        label: 'New',
        areaLabel: 'Area',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
  });
});

describe('team & invitations (§25.14–21)', () => {
  test('the owner-only staff read, real invitation issue → capture → acceptance by the invited verified email, and same-org isolation', async () => {
    const owner = await provisionOrgWithRole('owner');

    // Owner-only read: another role is refused (canonical registry).
    const editor = await provisionOrgWithRole('listings_editor');
    await expect(editor.session.ports.teamPort.loadStaff(editor.orgId)).resolves.toEqual({
      kind: 'forbidden',
    });
    // Cross-org staff read: not-found-shaped.
    await expect(owner.session.ports.teamPort.loadStaff(editor.orgId)).resolves.toEqual({
      kind: 'notFound',
    });

    // The invited person exists as a verified-email Himma identity.
    const invitee = await provisionUser({ displayName: 'Invited Coach' });
    const issued = await owner.session.ports.teamPort.issueInvitation(owner.orgId, {
      email: invitee.email,
      role: 'coach',
      branchScope: 'all',
    });
    expect(issued).toMatchObject({ kind: 'invitationIssued', mailDelivery: 'delivered' });

    // The invitation shows in the staff read; the token is NOT in any read.
    const staff = await owner.session.ports.teamPort.loadStaff(owner.orgId);
    if (staff.kind !== 'loaded') throw new Error('staff failed');
    const row = staff.staff.invitations.find((entry) => entry.email === invitee.email);
    expect(row).toMatchObject({ role: 'coach', state: 'sent' });
    expect(JSON.stringify(staff)).not.toMatch(/accept: /);

    // The token travels ONLY in the captured invitation mail.
    const mailBody = harness.mail.captured[harness.mail.captured.length - 1]?.body ?? '';
    const token = /accept: (\S+)/.exec(mailBody)?.[1];
    if (token === undefined) throw new Error('no invitation token captured');

    // The invited user signs in and accepts — access appears on the NEXT
    // authoritative /provider/me resolution (the interrupt drives it).
    const inviteeSession = await signedInPorts(invitee);
    await expect(inviteeSession.accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      memberships: [],
    });
    const accepted = await inviteeSession.ports.invitationPort.accept(token);
    expect(accepted).toMatchObject({ kind: 'invitationAccepted', organizationId: owner.orgId });
    expect(inviteeSession.interrupts).toContainEqual({ kind: 'accessChanged' });
    await expect(inviteeSession.accessPort.resolveAccess()).resolves.toMatchObject({
      kind: 'resolved',
      memberships: [expect.objectContaining({ organizationId: owner.orgId, role: 'coach' })],
    });

    // A consumed token refuses with the ONE canonical class.
    await expect(inviteeSession.ports.invitationPort.accept(token)).resolves.toEqual({
      kind: 'invitationInvalid',
    });
  });

  test('invalid role and invalid branch scope are refused server-side (no client payload can escalate)', async () => {
    const owner = await provisionOrgWithRole('owner');
    // A role outside the seven-role canon: schema refusal.
    await expect(
      owner.session.ports.teamPort.issueInvitation(owner.orgId, {
        email: 'escalate@contract.test',
        role: 'super_admin' as ProviderRole,
        branchScope: 'all',
      }),
    ).resolves.toEqual({ kind: 'validationError' });
    // A foreign branch id inside the scope: the real scope validation bites.
    const foreign = await createProviderOrg(harness.testDb.db, {});
    await expect(
      owner.session.ports.teamPort.issueInvitation(owner.orgId, {
        email: 'scoped@contract.test',
        role: 'branch_manager',
        branchScope: [foreign.branchIds[0] as string],
      }),
    ).resolves.toEqual({ kind: 'invalidBranchScope' });
    // An org-wide-only role with a branch scope: refused the same way.
    const ownBranch = (await owner.session.ports.profilePort.loadOrganizationView(owner.orgId));
    if (ownBranch.kind !== 'loaded') throw new Error('view failed');
    await expect(
      owner.session.ports.teamPort.issueInvitation(owner.orgId, {
        email: 'scoped-owner@contract.test',
        role: 'owner',
        branchScope: [ownBranch.view.branches[0]?.id as string],
      }),
    ).resolves.toEqual({ kind: 'invalidBranchScope' });
  });

  test('membership revocation persists (history preserved), the last active owner is database-protected, and revocations are CAS-guarded', async () => {
    const owner = await provisionOrgWithRole('owner');
    const colleague = await provisionUser();
    const membershipId = await addMembership(
      harness.testDb.db,
      colleague.userId,
      owner.orgId,
      'front_desk',
    );

    // Stale CAS refuses first.
    await expect(
      owner.session.ports.teamPort.revokeMembership(owner.orgId, membershipId, 99),
    ).resolves.toEqual({ kind: 'staleVersion' });

    const revoked = await owner.session.ports.teamPort.revokeMembership(
      owner.orgId,
      membershipId,
      1,
    );
    expect(revoked).toEqual({ kind: 'membershipRevoked' });
    const staff = await owner.session.ports.teamPort.loadStaff(owner.orgId);
    if (staff.kind !== 'loaded') throw new Error('staff failed');
    expect(
      staff.staff.memberships.find((entry) => entry.id === membershipId),
    ).toMatchObject({ state: 'revoked' });

    // The caller's own seat is the LAST active owner — the invariant bites.
    const ownRow = staff.staff.memberships.find(
      (entry) => entry.userId === owner.session.userId && entry.state === 'active',
    );
    if (ownRow === undefined) throw new Error('own membership missing');
    await expect(
      owner.session.ports.teamPort.revokeMembership(owner.orgId, ownRow.id, ownRow.version),
    ).resolves.toEqual({ kind: 'lastOwnerProtected' });
  });
});

describe('access refresh composition (§26): a real staff mutation changes effective access end-to-end', () => {
  test('owner revokes a colleague’s seat → the colleague’s next authoritative resolution loses the organization', async () => {
    const owner = await provisionOrgWithRole('owner');
    const colleague = await provisionUser();
    const membershipId = await addMembership(
      harness.testDb.db,
      colleague.userId,
      owner.orgId,
      'listings_editor',
    );

    const colleagueSession = await signedInPorts(colleague);
    await expect(colleagueSession.accessPort.resolveAccess()).resolves.toMatchObject({
      kind: 'resolved',
      memberships: [expect.objectContaining({ organizationId: owner.orgId })],
    });

    const revoked = await owner.session.ports.teamPort.revokeMembership(
      owner.orgId,
      membershipId,
      1,
    );
    expect(revoked).toEqual({ kind: 'membershipRevoked' });
    // The mutating session re-resolves its OWN access authoritatively (the
    // seat could have been its own) — the interrupt fired.
    expect(owner.session.interrupts).toContainEqual({ kind: 'accessChanged' });

    // The affected user's next authoritative resolution loses the org —
    // and the domain read refuses too (server-side, not client courtesy).
    await expect(colleagueSession.accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      memberships: [],
    });
    await expect(
      colleagueSession.ports.profilePort.loadOrganizationView(owner.orgId),
    ).resolves.toEqual({ kind: 'notFound' });
  });
});
