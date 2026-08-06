/**
 * S3-2 — staff-invitation application services (docs/27 §9, §14.5–6,
 * Amendment A1/D-S3-1). Real PostgreSQL, captured MailSender: issuance
 * authority + resend policy, the binding verified-email acceptance matrix
 * (unverified / display-name / subject-only / private-relay cases),
 * single-use + concurrency races, idempotent revoke/expiry with
 * exactly-once events, transaction atomicity, the post-commit mail
 * boundary, and raw-token hygiene across PostgreSQL, audit, and outbox.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
  CaptureMailSender,
  mailLogLine,
  type MailSender,
} from '../src/modules/identity/mail/mail-sender';
import { linkIdentity } from '../src/modules/identity/services/link-identity';
import {
  acceptStaffInvitation,
  digestStaffInvitationToken,
  expireDueStaffInvitations,
  issueStaffInvitation,
  revokeStaffInvitation,
  type StaffInvitationDeps,
} from '../src/modules/provider/services/staff-invitations';
import {
  DEV_TEST_INVITATION_PEPPER,
  parseStaffInvitationConfig,
} from '../src/modules/provider/staff-invitation-config';
import { bootstrapAccessAdmins, createIdentity, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let mail: CaptureMailSender;
let deps: StaffInvitationDeps;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  mail = new CaptureMailSender();
  deps = {
    db: testDb.db,
    mailSender: mail,
    invitationConfig: parseStaffInvitationConfig('test', {}),
  };
});

afterAll(async () => {
  await testDb.drop();
});

async function makeOrganization(state = 'live'): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO organization (id, legal_name, trade_name, verification_state, suspended_at)
    VALUES (${id}, 'Legal LLC', 'Trade', ${state},
            ${state === 'suspended' ? new Date() : null})`.execute(testDb.db);
  await sql`
    INSERT INTO organization_public_profile (organization_id, display_name, published)
    VALUES (${id}, 'Blue Wave Swimming', true)`.execute(testDb.db);
  return id;
}

async function makeBranch(organizationId: string, active = true): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO branch (id, organization_id, label, area_label, active)
    VALUES (${id}, ${organizationId}, 'Branch', 'Area', ${active})`.execute(testDb.db);
  return id;
}

/** Active Owner membership via direct insert (the founding path is S3-4). */
async function makeOwner(organizationId: string): Promise<string> {
  const userId = await createUser(testDb.db);
  await sql`
    INSERT INTO staff_membership (id, user_id, organization_id, role)
    VALUES (${newId()}, ${userId}, ${organizationId}, 'owner')`.execute(testDb.db);
  return userId;
}

/** Himma user holding an ACTIVE identity for the address (docs/26 §3 shape). */
async function makeUserWithEmail(
  email: string,
  options: { verified?: boolean; privateRelay?: boolean } = {},
): Promise<string> {
  const userId = await createUser(testDb.db);
  await createIdentity(testDb.db, userId, {
    provider: options.privateRelay === true ? 'apple' : 'email',
    email,
    emailVerified: options.verified ?? true,
    isPrivateRelay: options.privateRelay ?? false,
  });
  return userId;
}

function lastMailToken(): string {
  const body = mail.captured[mail.captured.length - 1]?.body ?? '';
  const match = /accept: (\S+)/.exec(body);
  if (match?.[1] === undefined) throw new Error('no invitation token in captured mail');
  return match[1];
}

async function issueTo(
  organizationId: string,
  ownerId: string,
  email: string,
  overrides: Partial<Parameters<typeof issueStaffInvitation>[2]> = {},
): Promise<{ invitationId: string; token: string }> {
  const result = await issueStaffInvitation(
    deps,
    { kind: 'owner', userId: ownerId },
    {
      organizationId,
      email,
      role: 'front_desk',
      branchScope: { kind: 'all' },
      ...overrides,
    },
  );
  if (result.kind !== 'invitationIssued') {
    throw new Error(`expected invitationIssued, got ${result.kind}`);
  }
  return { invitationId: result.invitationId, token: lastMailToken() };
}

async function countAudit(action: string, entityId: string): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM audit_event
    WHERE action = ${action} AND entity_id = ${entityId}`.execute(testDb.db);
  return Number(rows.rows[0]?.n);
}

async function countOutbox(eventType: string, invitationOrMembershipId: string): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM outbox_event
    WHERE event_type = ${eventType}
      AND (payload->>'invitationId' = ${invitationOrMembershipId}
        OR payload->>'membershipId' = ${invitationOrMembershipId})`.execute(testDb.db);
  return Number(rows.rows[0]?.n);
}

/** Directly inserted invitation with a KNOWN raw token (test-only). */
async function insertRawInvitation(input: {
  organizationId: string;
  email: string;
  token: string;
  invitedBy: string;
  role?: string;
  scopeKind?: string;
  scopeIds?: string[];
  issuedAt?: Date;
  expiresAt?: Date;
}): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO staff_invitation (id, organization_id, email, role,
                                  branch_scope_kind, branch_scope_ids, invited_by,
                                  token_digest, pepper_version, issued_at, expires_at)
    VALUES (${id}, ${input.organizationId}, ${input.email}, ${input.role ?? 'coach'},
            ${input.scopeKind ?? 'all'},
            ${sql.raw(`ARRAY[${(input.scopeIds ?? []).map((b) => `'${b}'`).join(',')}]::uuid[]`)},
            ${input.invitedBy},
            ${digestStaffInvitationToken(DEV_TEST_INVITATION_PEPPER, input.token)}, 1,
            ${input.issuedAt ?? new Date()},
            ${input.expiresAt ?? new Date(Date.now() + 86_400_000)})`.execute(testDb.db);
  return id;
}

describe('issuing (docs/27 §9)', () => {
  it('an active Owner issues; only the digest is stored; audit and outbox carry ids, never the email', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { invitationId, token } = await issueTo(org, owner, 'Staff.One@Example.com');

    const row = await sql<{ email: string; token_digest: string; state: string }>`
      SELECT email, token_digest, state FROM staff_invitation
      WHERE id = ${invitationId}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({
      email: 'staff.one@example.com', // normalized at rest
      token_digest: digestStaffInvitationToken(DEV_TEST_INVITATION_PEPPER, token),
      state: 'sent',
    });
    expect(row.rows[0]?.token_digest).not.toBe(token);

    expect(await countAudit('org.staff_invited', invitationId)).toBe(1);
    expect(await countOutbox('staff.invited', invitationId)).toBe(1);
    const payloads = await sql<{ payload: unknown }>`
      SELECT payload FROM outbox_event
      WHERE payload->>'invitationId' = ${invitationId}`.execute(testDb.db);
    expect(JSON.stringify(payloads.rows)).not.toContain('example.com');
  });

  it('issuer authority is resolved fresh from PostgreSQL: non-owner staff, strangers, and suspended organizations refuse', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    void owner;
    const financeUser = await createUser(testDb.db);
    await sql`INSERT INTO staff_membership (id, user_id, organization_id, role)
              VALUES (${newId()}, ${financeUser}, ${org}, 'finance')`.execute(testDb.db);
    const stranger = await createUser(testDb.db);
    const input = {
      organizationId: org,
      email: 'x@example.com',
      role: 'coach' as const,
      branchScope: { kind: 'all' as const },
    };
    expect(
      (await issueStaffInvitation(deps, { kind: 'owner', userId: financeUser }, input)).kind,
    ).toBe('forbidden');
    expect(
      (await issueStaffInvitation(deps, { kind: 'owner', userId: stranger }, input)).kind,
    ).toBe('organizationNotFound');

    const suspended = await makeOrganization('suspended');
    const suspendedOwner = await makeOwner(suspended);
    expect(
      (
        await issueStaffInvitation(deps, { kind: 'owner', userId: suspendedOwner }, {
          ...input,
          organizationId: suspended,
        })
      ).kind,
    ).toBe('organizationSuspended');
  });

  it('the admin caller-context (future §13.3 founding invitation) requires an active operations role', async () => {
    const { adminA, adminB } = await bootstrapAccessAdmins(testDb.db);
    const org = await makeOrganization('draft'); // founding: org has no members yet
    const opsUser = await createUser(testDb.db);
    const otherAdmin = await createUser(testDb.db);
    await sql`INSERT INTO admin_role_assignment (id, user_id, role, state, requested_by, approved_by)
              VALUES (${newId()}, ${opsUser}, 'operations', 'active', ${adminA}, ${adminB})`.execute(
      testDb.db,
    );
    const input = {
      organizationId: org,
      email: 'founder@example.com',
      role: 'owner' as const,
      branchScope: { kind: 'all' as const },
    };
    expect(
      (await issueStaffInvitation(deps, { kind: 'admin', userId: otherAdmin }, input)).kind,
    ).toBe('forbidden');
    const issued = await issueStaffInvitation(deps, { kind: 'admin', userId: opsUser }, input);
    expect(issued.kind).toBe('invitationIssued');
  });

  it('branch scope must be active branches of THIS organization, and org-wide-only roles refuse scoping', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const foreignBranch = await makeBranch(await makeOrganization());
    const inactiveBranch = await makeBranch(org, false);
    const branch = await makeBranch(org);

    const attempt = async (
      role: 'front_desk' | 'finance',
      branchIds: string[],
    ): Promise<string> =>
      (
        await issueStaffInvitation(deps, { kind: 'owner', userId: owner }, {
          organizationId: org,
          email: 'scoped@example.com',
          role,
          branchScope: { kind: 'branches', branchIds },
        })
      ).kind;

    expect(await attempt('front_desk', [foreignBranch])).toBe('invalidBranchScope');
    expect(await attempt('front_desk', [branch, foreignBranch])).toBe('invalidBranchScope');
    expect(await attempt('front_desk', [inactiveBranch])).toBe('invalidBranchScope');
    expect(await attempt('front_desk', [])).toBe('invalidBranchScope');
    expect(await attempt('finance', [branch])).toBe('invalidBranchScope');
    expect(await attempt('front_desk', [branch])).toBe('invitationIssued');
  });

  it('re-issuing for the same address revokes the previous invitation (resend = new row, dead old token)', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const first = await issueTo(org, owner, 'resend@example.com');
    const second = await issueTo(org, owner, 'resend@example.com');
    const firstRow = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${first.invitationId}`.execute(testDb.db);
    expect(firstRow.rows[0]?.state).toBe('revoked');
    expect(await countAudit('org.invitation_revoked', first.invitationId)).toBe(1);
    expect(await countOutbox('staff.invitation_revoked', first.invitationId)).toBe(1);

    const accepter = await makeUserWithEmail('resend@example.com');
    expect(
      (await acceptStaffInvitation(deps, { userId: accepter }, { token: first.token })).kind,
    ).toBe('invitationInvalid');
    expect(
      (await acceptStaffInvitation(deps, { userId: accepter }, { token: second.token })).kind,
    ).toBe('invitationAccepted');
  });
});

describe('acceptance — D-S3-1 binding matrix', () => {
  it('a verified matching email accepts: membership, scope rows, audit, and outbox land in one transaction', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const branch = await makeBranch(org);
    const { invitationId, token } = await issueTo(org, owner, 'joiner@example.com', {
      role: 'branch_manager',
      branchScope: { kind: 'branches', branchIds: [branch] },
    });
    const joiner = await makeUserWithEmail('Joiner@example.com'); // matching is normalized

    const result = await acceptStaffInvitation(deps, { userId: joiner }, { token });
    if (result.kind !== 'invitationAccepted') throw new Error(result.kind);
    expect(result.organizationId).toBe(org);

    const membership = await sql<{
      role: string;
      state: string;
      branch_scope_kind: string;
      invited_by: string;
      invitation_id: string;
    }>`SELECT role, state, branch_scope_kind, invited_by, invitation_id
       FROM staff_membership WHERE id = ${result.membershipId}`.execute(testDb.db);
    expect(membership.rows[0]).toEqual({
      role: 'branch_manager',
      state: 'active',
      branch_scope_kind: 'branches',
      invited_by: owner,
      invitation_id: invitationId,
    });
    const scopes = await sql<{ branch_id: string }>`
      SELECT branch_id FROM staff_membership_branch
      WHERE membership_id = ${result.membershipId}`.execute(testDb.db);
    expect(scopes.rows.map((r) => r.branch_id)).toEqual([branch]);
    const invitation = await sql<{ state: string; accepted_by: string }>`
      SELECT state, accepted_by FROM staff_invitation WHERE id = ${invitationId}`.execute(
      testDb.db,
    );
    expect(invitation.rows[0]).toEqual({ state: 'accepted', accepted_by: joiner });
    expect(await countAudit('org.staff_joined', result.membershipId)).toBe(1);
    expect(await countOutbox('staff.joined', result.membershipId)).toBe(1);
  });

  it('supports invitees with no Himma account yet: the invitation waits until first login creates the user', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    // Nobody owns this address at issue time — and no placeholder User is created.
    const { token } = await issueTo(org, owner, 'future.user@example.com');
    const users = await sql<{ n: string }>`
      SELECT count(*) AS n FROM auth_identity
      WHERE lower(email) = 'future.user@example.com'`.execute(testDb.db);
    expect(Number(users.rows[0]?.n)).toBe(0);

    // Later: normal first login creates the canonical user with the
    // verified address; the same token now works.
    const newcomer = await makeUserWithEmail('future.user@example.com');
    expect(
      (await acceptStaffInvitation(deps, { userId: newcomer }, { token })).kind,
    ).toBe('invitationAccepted');
  });

  it('an UNVERIFIED matching email can never accept', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { invitationId, token } = await issueTo(org, owner, 'unverified@example.com');
    const user = await makeUserWithEmail('unverified@example.com', { verified: false });
    expect((await acceptStaffInvitation(deps, { userId: user }, { token })).kind).toBe(
      'invitationInvalid',
    );
    const state = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${invitationId}`.execute(testDb.db);
    expect(state.rows[0]?.state).toBe('sent'); // still valid for the right user
  });

  it('a wrong verified email fails with the same safe outcome; a matching display name is irrelevant', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { token } = await issueTo(org, owner, 'intended@example.com');

    const wrongEmail = await makeUserWithEmail('someone.else@example.com');
    const wrong = await acceptStaffInvitation(deps, { userId: wrongEmail }, { token });
    expect(wrong).toEqual({ kind: 'invitationInvalid' });

    // Display name equal to the invited address participates in NOTHING.
    const impersonator = await makeUserWithEmail('not.the.target@example.com');
    await sql`INSERT INTO customer_account (id, user_id, display_name)
              VALUES (${newId()}, ${impersonator}, ${'intended@example.com'})`.execute(testDb.db);
    const byName = await acceptStaffInvitation(deps, { userId: impersonator }, { token });
    expect(byName).toEqual({ kind: 'invitationInvalid' });
  });

  it('holding a session + the token (Cognito issuer/subject) without the verified email is insufficient', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { token } = await issueTo(org, owner, 'subject.only@example.com');
    // Authenticated user with a perfectly valid identity — but no email
    // attribute at all: issuer+subject alone must not satisfy D-S3-1.
    const userId = await createUser(testDb.db);
    await createIdentity(testDb.db, userId, { provider: 'google' });
    expect((await acceptStaffInvitation(deps, { userId }, { token })).kind).toBe(
      'invitationInvalid',
    );
  });

  it('Apple private relay: the relay address never matches; linking + verifying the invited address through the Slice-2 flow unlocks acceptance', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { token } = await issueTo(org, owner, 'coach.karim@example.com');
    const relayUser = await makeUserWithEmail('abc123@privaterelay.appleid.com', {
      privateRelay: true,
    });
    expect((await acceptStaffInvitation(deps, { userId: relayUser }, { token })).kind).toBe(
      'invitationInvalid',
    );

    // Existing Slice-2 identity-linking model — never an invitation-side merge.
    const linked = await linkIdentity({ db: testDb.db }, { userId: relayUser }, {
      evidence: {
        provider: 'email',
        issuer: 'https://cognito.test/pool-fixture',
        subject: `sub-${newId()}`,
        email: 'coach.karim@example.com',
        emailVerified: true,
        isPrivateRelay: false,
        assurance: 'single_factor',
      },
    });
    expect(linked.kind).toBe('identityLinked');
    expect((await acceptStaffInvitation(deps, { userId: relayUser }, { token })).kind).toBe(
      'invitationAccepted',
    );
  });

  it('expired (pre-sweep), revoked, consumed, and unknown tokens are byte-identical failures', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const user = await makeUserWithEmail('matrix@example.com');

    const overdue = await insertRawInvitation({
      organizationId: org,
      email: 'matrix@example.com',
      token: 'overdue-token',
      invitedBy: owner,
      issuedAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const expiredResult = await acceptStaffInvitation(
      deps,
      { userId: user },
      { token: 'overdue-token' },
    );

    const { invitationId: revokedId, token: revokedToken } = await issueTo(
      org,
      owner,
      'matrix@example.com',
    );
    await revokeStaffInvitation(deps, { kind: 'owner', userId: owner }, {
      organizationId: org,
      invitationId: revokedId,
    });
    const revokedResult = await acceptStaffInvitation(
      deps,
      { userId: user },
      { token: revokedToken },
    );

    const unknownResult = await acceptStaffInvitation(
      deps,
      { userId: user },
      { token: 'no-such-token' },
    );

    const { token: goodToken } = await issueTo(org, owner, 'matrix@example.com');
    expect((await acceptStaffInvitation(deps, { userId: user }, { token: goodToken })).kind).toBe(
      'invitationAccepted',
    );
    const consumedResult = await acceptStaffInvitation(
      deps,
      { userId: user },
      { token: goodToken },
    );

    const invalid = { kind: 'invitationInvalid' };
    expect(expiredResult).toEqual(invalid);
    expect(revokedResult).toEqual(invalid);
    expect(unknownResult).toEqual(invalid);
    expect(consumedResult).toEqual(invalid);
    // No membership appeared from any failure path.
    const memberships = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_membership
      WHERE user_id = ${user} AND organization_id = ${org}`.execute(testDb.db);
    expect(Number(memberships.rows[0]?.n)).toBe(1);
    void overdue;
  });

  it('concurrent acceptance of one token yields exactly one membership and one accepted invitation', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { invitationId, token } = await issueTo(org, owner, 'racer@example.com');
    const user = await makeUserWithEmail('racer@example.com');

    const results = await Promise.all([
      acceptStaffInvitation(deps, { userId: user }, { token }),
      acceptStaffInvitation(deps, { userId: user }, { token }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      'invitationAccepted',
      'invitationInvalid',
    ]);
    const memberships = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_membership
      WHERE user_id = ${user} AND organization_id = ${org} AND state = 'active'`.execute(
      testDb.db,
    );
    expect(Number(memberships.rows[0]?.n)).toBe(1);
    const winner = results.find((r) => r.kind === 'invitationAccepted');
    if (winner?.kind !== 'invitationAccepted') throw new Error('no acceptance winner');
    expect(await countAudit('org.staff_joined', winner.membershipId)).toBe(1);
    const accepted = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${invitationId}`.execute(testDb.db);
    expect(accepted.rows[0]?.state).toBe('accepted');
  });
});

describe('revocation and expiry (idempotent, exactly-once events)', () => {
  it('revoke is idempotent and never double-emits', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { invitationId } = await issueTo(org, owner, 'revokee@example.com');
    const first = await revokeStaffInvitation(deps, { kind: 'owner', userId: owner }, {
      organizationId: org,
      invitationId,
    });
    const second = await revokeStaffInvitation(deps, { kind: 'owner', userId: owner }, {
      organizationId: org,
      invitationId,
    });
    expect(first.kind).toBe('invitationRevoked');
    expect(second.kind).toBe('invitationRevoked');
    expect(await countAudit('org.invitation_revoked', invitationId)).toBe(1);
    expect(await countOutbox('staff.invitation_revoked', invitationId)).toBe(1);
    expect(
      (
        await revokeStaffInvitation(deps, { kind: 'owner', userId: owner }, {
          organizationId: org,
          invitationId: newId(),
        })
      ).kind,
    ).toBe('invitationNotFound');
  });

  it('the sweep finalizes overdue invitations exactly once, is idempotent, and is concurrency-safe', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const overdueA = await insertRawInvitation({
      organizationId: org,
      email: 'sweep.a@example.com',
      token: 'sweep-a',
      invitedBy: owner,
      issuedAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const overdueB = await insertRawInvitation({
      organizationId: org,
      email: 'sweep.b@example.com',
      token: 'sweep-b',
      invitedBy: owner,
      issuedAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const live = await issueTo(org, owner, 'sweep.live@example.com');

    const [sweep1, sweep2] = await Promise.all([
      expireDueStaffInvitations(deps),
      expireDueStaffInvitations(deps),
    ]);
    expect(sweep1.expiredCount + sweep2.expiredCount).toBe(2);
    const third = await expireDueStaffInvitations(deps);
    expect(third.expiredCount).toBe(0);

    for (const id of [overdueA, overdueB]) {
      const row = await sql<{ state: string; expired_at: Date | null }>`
        SELECT state, expired_at FROM staff_invitation WHERE id = ${id}`.execute(testDb.db);
      expect(row.rows[0]?.state).toBe('expired');
      expect(row.rows[0]?.expired_at).not.toBeNull();
      expect(await countAudit('org.invitation_expired', id)).toBe(1);
      expect(await countOutbox('staff.invitation_expired', id)).toBe(1);
    }
    const liveRow = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${live.invitationId}`.execute(testDb.db);
    expect(liveRow.rows[0]?.state).toBe('sent');
  });
});

describe('transaction and hygiene guarantees', () => {
  it('acceptance rolls back membership, invitation, audit, and outbox together on a forced failure', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const foreignBranch = await makeBranch(await makeOrganization());
    // Poisoned scope injected below the service boundary: acceptance's scope
    // insert hits the composite FK and the WHOLE transaction must vanish.
    const invitationId = await insertRawInvitation({
      organizationId: org,
      email: 'atomic@example.com',
      token: 'atomic-token',
      invitedBy: owner,
      role: 'front_desk',
      scopeKind: 'branches',
      scopeIds: [foreignBranch],
    });
    const user = await makeUserWithEmail('atomic@example.com');
    await expect(
      acceptStaffInvitation(deps, { userId: user }, { token: 'atomic-token' }),
    ).rejects.toThrow();
    const invitation = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${invitationId}`.execute(testDb.db);
    expect(invitation.rows[0]?.state).toBe('sent'); // consumption rolled back
    const memberships = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_membership WHERE user_id = ${user}`.execute(testDb.db);
    expect(Number(memberships.rows[0]?.n)).toBe(0);
    const joinEvents = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'staff.joined' AND payload->>'invitationId' = ${invitationId}`.execute(
      testDb.db,
    );
    expect(Number(joinEvents.rows[0]?.n)).toBe(0);
  });

  it('issuance rollback leaves no usable invitation, no events, and sends no mail', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    await sql`
      CREATE FUNCTION test_poison_invitation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.email = 'poison@example.com' THEN
          RAISE EXCEPTION 'test-forced issuance failure';
        END IF;
        RETURN NEW;
      END; $$`.execute(testDb.db);
    await sql`
      CREATE TRIGGER trg_test_poison AFTER INSERT ON staff_invitation
      FOR EACH ROW EXECUTE FUNCTION test_poison_invitation()`.execute(testDb.db);
    const mailCountBefore = mail.captured.length;
    try {
      await expect(
        issueStaffInvitation(deps, { kind: 'owner', userId: owner }, {
          organizationId: org,
          email: 'poison@example.com',
          role: 'coach',
          branchScope: { kind: 'all' },
        }),
      ).rejects.toThrow(/test-forced issuance failure/);
    } finally {
      await sql`DROP TRIGGER trg_test_poison ON staff_invitation`.execute(testDb.db);
      await sql`DROP FUNCTION test_poison_invitation()`.execute(testDb.db);
    }
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_invitation WHERE email = 'poison@example.com'`.execute(
      testDb.db,
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
    expect(mail.captured.length).toBe(mailCountBefore); // mail only after commit
  });

  it('a mail failure never rolls back the committed invitation and is reported on the result', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const failingSender: MailSender = {
      send: () => Promise.reject(new Error('smtp down')),
    };
    const result = await issueStaffInvitation(
      { ...deps, mailSender: failingSender },
      { kind: 'owner', userId: owner },
      {
        organizationId: org,
        email: 'undelivered@example.com',
        role: 'coach',
        branchScope: { kind: 'all' },
      },
    );
    if (result.kind !== 'invitationIssued') throw new Error(result.kind);
    expect(result.mailDelivery).toBe('failed');
    const row = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${result.invitationId}`.execute(testDb.db);
    expect(row.rows[0]?.state).toBe('sent');
  });

  it('the raw token appears nowhere in PostgreSQL, audit, outbox — and never in the sanctioned mail log line', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { token } = await issueTo(org, owner, 'hygiene@example.com');
    expect(token.length).toBeGreaterThanOrEqual(43); // 256-bit base64url
    for (const table of ['staff_invitation', 'audit_event', 'outbox_event']) {
      const hits = await sql<{ n: string }>`
        SELECT count(*) AS n FROM ${sql.raw(table)} t
        WHERE t::text LIKE ${'%' + token + '%'}`.execute(testDb.db);
      expect(Number(hits.rows[0]?.n)).toBe(0);
    }
    const captured = mail.captured[mail.captured.length - 1];
    expect(captured?.body).toContain(token); // delivery channel only
    expect(mailLogLine(captured!)).not.toContain(token);
  });

  it('staff operations never touch public provider data', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const before = await sql<{ version: number; display_name: string }>`
      SELECT version, display_name FROM organization_public_profile
      WHERE organization_id = ${org}`.execute(testDb.db);
    const { invitationId, token } = await issueTo(org, owner, 'untouched@example.com');
    const user = await makeUserWithEmail('untouched@example.com');
    await acceptStaffInvitation(deps, { userId: user }, { token });
    await revokeStaffInvitation(deps, { kind: 'owner', userId: owner }, {
      organizationId: org,
      invitationId,
    });
    await expireDueStaffInvitations(deps);
    const after = await sql<{ version: number; display_name: string }>`
      SELECT version, display_name FROM organization_public_profile
      WHERE organization_id = ${org}`.execute(testDb.db);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('acceptance interacts safely with membership state', () => {
  it('an already-active member cannot double-join; the invitation stays sent and revocable', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { token: firstToken } = await issueTo(org, owner, 'double@example.com');
    const user = await makeUserWithEmail('double@example.com');
    expect(
      (await acceptStaffInvitation(deps, { userId: user }, { token: firstToken })).kind,
    ).toBe('invitationAccepted');

    const second = await issueTo(org, owner, 'double@example.com');
    expect(
      (await acceptStaffInvitation(deps, { userId: user }, { token: second.token })).kind,
    ).toBe('invitationInvalid');
    const state = await sql<{ state: string }>`
      SELECT state FROM staff_invitation WHERE id = ${second.invitationId}`.execute(testDb.db);
    expect(state.rows[0]?.state).toBe('sent');
    // After revocation of the membership (with a co-owner in place for the
    // guard), the pending invitation becomes acceptable again — a NEW row.
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE user_id = ${user} AND organization_id = ${org} AND state = 'active'`.execute(
      testDb.db,
    );
    const result = await acceptStaffInvitation(deps, { userId: user }, { token: second.token });
    expect(result.kind).toBe('invitationAccepted');
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_membership
      WHERE user_id = ${user} AND organization_id = ${org}`.execute(testDb.db);
    expect(Number(rows.rows[0]?.n)).toBe(2); // history row + new active row
  });

  it('acceptance refuses suspended organizations with the safe outcome and leaves the invitation pending', async () => {
    const org = await makeOrganization();
    const owner = await makeOwner(org);
    const { invitationId, token } = await issueTo(org, owner, 'paused@example.com');
    await sql`UPDATE organization SET verification_state = 'suspended', suspended_at = now()
              WHERE id = ${org}`.execute(testDb.db);
    const user = await makeUserWithEmail('paused@example.com');
    expect((await acceptStaffInvitation(deps, { userId: user }, { token })).kind).toBe(
      'invitationInvalid',
    );
    // Reinstatement makes the SAME pending invitation acceptable again.
    await sql`UPDATE organization SET verification_state = 'live', suspended_at = NULL
              WHERE id = ${org}`.execute(testDb.db);
    expect((await acceptStaffInvitation(deps, { userId: user }, { token })).kind).toBe(
      'invitationAccepted',
    );
    void invitationId;
  });
});
