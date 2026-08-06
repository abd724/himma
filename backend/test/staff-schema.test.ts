/**
 * S3-2 — StaffMembership, branch scopes, and StaffInvitation schema
 * (docs/27 §5, §6, §9, §12). Real PostgreSQL: the §5.2 machine and
 * append-only membership history DB-enforced, the exact approved provider
 * role vocabulary, unambiguous org-wide vs branch scope, structural
 * cross-organization impossibility, last-active-owner protection under
 * concurrency, invitation lifecycle/token-digest constraints, and
 * himma_app least-privilege grants.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { PROVIDER_ROLES } from '../src/modules/provider/provider-roles';
import { createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function makeOrganization(state = 'draft'): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO organization (id, legal_name, trade_name, verification_state,
                              suspended_at, offboarded_at)
    VALUES (${id}, 'Legal LLC', 'Trade', ${state},
            ${state === 'suspended' ? new Date() : null},
            ${state === 'offboarded' ? new Date() : null})`.execute(testDb.db);
  return id;
}

async function makeBranch(organizationId: string): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO branch (id, organization_id, label, area_label)
    VALUES (${id}, ${organizationId}, 'Branch', 'Area')`.execute(testDb.db);
  return id;
}

interface MembershipOptions {
  role?: string;
  scopeKind?: string;
  scopeBranchIds?: string[];
  state?: string;
}

/** Inserts a membership (+ scope rows) in ONE transaction so the deferred
 *  scope-completeness trigger evaluates the finished shape at commit. */
async function makeMembership(
  userId: string,
  organizationId: string,
  options: MembershipOptions = {},
): Promise<string> {
  const id = newId();
  await withTransaction(testDb.db, async (trx) => {
    await sql`
      INSERT INTO staff_membership (id, user_id, organization_id, role,
                                    branch_scope_kind, state, revoked_at)
      VALUES (${id}, ${userId}, ${organizationId}, ${options.role ?? 'owner'},
              ${options.scopeKind ?? 'all'}, ${options.state ?? 'active'},
              ${options.state === 'revoked' ? new Date() : null})`.execute(trx);
    for (const branchId of options.scopeBranchIds ?? []) {
      await sql`
        INSERT INTO staff_membership_branch (membership_id, branch_id, organization_id)
        VALUES (${id}, ${branchId}, ${organizationId})`.execute(trx);
    }
  });
  return id;
}

async function revokeMembership(id: string): Promise<void> {
  await sql`
    UPDATE staff_membership SET state = 'revoked', revoked_at = now()
    WHERE id = ${id}`.execute(testDb.db);
}

async function makeInvitation(
  organizationId: string,
  invitedBy: string,
  overrides: {
    email?: string;
    role?: string;
    scopeKind?: string;
    scopeIds?: string[];
    issuedAt?: Date;
    expiresAt?: Date;
    digest?: string;
  } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO staff_invitation (id, organization_id, email, role,
                                  branch_scope_kind, branch_scope_ids,
                                  invited_by, token_digest, pepper_version,
                                  issued_at, expires_at)
    VALUES (${id}, ${organizationId}, ${overrides.email ?? `invitee-${id}@example.com`},
            ${overrides.role ?? 'front_desk'},
            ${overrides.scopeKind ?? 'all'},
            ${sql.raw(`ARRAY[${(overrides.scopeIds ?? []).map((b) => `'${b}'`).join(',')}]::uuid[]`)},
            ${invitedBy}, ${overrides.digest ?? `digest-${id}`}, 1,
            ${overrides.issuedAt ?? new Date()},
            ${overrides.expiresAt ?? new Date(Date.now() + 86_400_000)})`.execute(testDb.db);
  return id;
}

describe('provider role vocabulary (docs/27 §6 — exactly the approved set)', () => {
  it('accepts each of the seven approved roles and nothing else', async () => {
    const org = await makeOrganization();
    const branch = await makeBranch(org);
    expect(PROVIDER_ROLES).toEqual([
      'owner',
      'org_manager',
      'branch_manager',
      'listings_editor',
      'coach',
      'front_desk',
      'finance',
    ]);
    for (const role of PROVIDER_ROLES) {
      const scoped = !['owner', 'org_manager', 'finance'].includes(role);
      const user = await createUser(testDb.db);
      await makeMembership(user, org, {
        role,
        ...(scoped ? { scopeKind: 'branches', scopeBranchIds: [branch] } : {}),
      });
    }
    for (const invented of ['admin', 'read_only', 'manager', 'staff']) {
      const user = await createUser(testDb.db);
      await expect(makeMembership(user, org, { role: invented })).rejects.toThrow(
        /ck_staff_membership_role/,
      );
    }
  });

  it('org-wide-only roles (owner, org_manager, finance) can never be branch-scoped', async () => {
    const org = await makeOrganization();
    const branch = await makeBranch(org);
    for (const role of ['owner', 'org_manager', 'finance']) {
      const user = await createUser(testDb.db);
      await expect(
        makeMembership(user, org, { role, scopeKind: 'branches', scopeBranchIds: [branch] }),
      ).rejects.toThrow(/ck_staff_membership_org_wide_roles/);
    }
  });
});

describe('membership invariants (docs/27 §5)', () => {
  it('admits at most one ACTIVE membership per user + organization; re-granting is a new row after revocation', async () => {
    const org = await makeOrganization();
    // A standing co-owner keeps the last-owner guard out of this test's way.
    await makeMembership(await createUser(testDb.db), org);
    const user = await createUser(testDb.db);
    const first = await makeMembership(user, org);
    await expect(makeMembership(user, org, { role: 'finance' })).rejects.toThrow(
      /uq_staff_membership_active/,
    );
    await revokeMembership(first);
    const second = await makeMembership(user, org, { role: 'finance' });
    // Both rows survive: the revoked row IS the history record.
    const rows = await sql<{ state: string; role: string }>`
      SELECT state, role FROM staff_membership
      WHERE user_id = ${user} AND organization_id = ${org}
      ORDER BY created_at`.execute(testDb.db);
    expect(rows.rows.map((r) => [r.role, r.state])).toEqual([
      ['owner', 'revoked'],
      ['finance', 'active'],
    ]);
    void second;
  });

  it('one user may hold active memberships in two different organizations', async () => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await createUser(testDb.db);
    await makeMembership(user, orgA);
    await makeMembership(user, orgB, { role: 'finance' });
  });

  it('membership identity (user, organization, role, scope kind, provenance) can never be rewritten', async () => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const user = await createUser(testDb.db);
    const otherUser = await createUser(testDb.db);
    const membership = await makeMembership(user, org);
    for (const mutation of [
      sql`UPDATE staff_membership SET user_id = ${otherUser} WHERE id = ${membership}`,
      sql`UPDATE staff_membership SET organization_id = ${other} WHERE id = ${membership}`,
      sql`UPDATE staff_membership SET role = 'finance' WHERE id = ${membership}`,
      sql`UPDATE staff_membership SET created_at = now() WHERE id = ${membership}`,
    ]) {
      await expect(mutation.execute(testDb.db)).rejects.toThrow(/immutable/);
    }
  });

  it('refuses invalid transitions and reinterpretation of revoked rows', async () => {
    const org = await makeOrganization();
    const user = await createUser(testDb.db);
    // A second owner keeps the last-owner guard out of this test's way.
    await makeMembership(await createUser(testDb.db), org);
    const membership = await makeMembership(user, org);
    // Unknown state refused by CHECK.
    await expect(
      sql`UPDATE staff_membership SET state = 'suspended' WHERE id = ${membership}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
    // Revocation timestamps are tied to the state.
    await expect(
      sql`UPDATE staff_membership SET state = 'revoked' WHERE id = ${membership}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_staff_membership_revoked/);
    await revokeMembership(membership);
    // Terminal: a revoked membership can never look active again.
    await expect(
      sql`UPDATE staff_membership SET state = 'active', revoked_at = NULL
          WHERE id = ${membership}`.execute(testDb.db),
    ).rejects.toThrow(/revoked and permanently immutable/);
    const active = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_membership
      WHERE user_id = ${user} AND organization_id = ${org} AND state = 'active'`.execute(
      testDb.db,
    );
    expect(Number(active.rows[0]?.n)).toBe(0);
  });
});

describe('branch scopes (docs/27 §5 — structural single-organization binding)', () => {
  it('scope rows cannot cross organizations, whatever organization_id they claim', async () => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const branchB = await makeBranch(orgB);
    const user = await createUser(testDb.db);
    const branchA = await makeBranch(orgA);
    const membership = await makeMembership(user, orgA, {
      role: 'front_desk',
      scopeKind: 'branches',
      scopeBranchIds: [branchA],
    });
    // Claiming org A: the branch FK refuses (branch belongs to org B).
    await expect(
      sql`INSERT INTO staff_membership_branch (membership_id, branch_id, organization_id)
          VALUES (${membership}, ${branchB}, ${orgA})`.execute(testDb.db),
    ).rejects.toThrow(/fk_staff_membership_branch_branch/);
    // Claiming org B: the membership FK refuses (membership belongs to org A).
    await expect(
      sql`INSERT INTO staff_membership_branch (membership_id, branch_id, organization_id)
          VALUES (${membership}, ${branchB}, ${orgB})`.execute(testDb.db),
    ).rejects.toThrow(/fk_staff_membership_branch_membership/);
  });

  it('org-wide and branch-scoped access are unambiguous: no scope rows on "all", no empty set on "branches"', async () => {
    const org = await makeOrganization();
    const branch = await makeBranch(org);
    const user = await createUser(testDb.db);
    const orgWide = await makeMembership(user, org, { role: 'org_manager' });
    await expect(
      sql`INSERT INTO staff_membership_branch (membership_id, branch_id, organization_id)
          VALUES (${orgWide}, ${branch}, ${org})`.execute(testDb.db),
    ).rejects.toThrow(/organization-wide/);
    // 'branches' with an empty set is unrepresentable (deferred trigger at commit).
    await expect(
      makeMembership(await createUser(testDb.db), org, {
        role: 'front_desk',
        scopeKind: 'branches',
        scopeBranchIds: [],
      }),
    ).rejects.toThrow(/empty scope set is unrepresentable/);
  });

  it('scope rows are append-only and survive branch deactivation unchanged (no silent transfer)', async () => {
    const org = await makeOrganization();
    const branchA = await makeBranch(org);
    const branchB = await makeBranch(org);
    const user = await createUser(testDb.db);
    const membership = await makeMembership(user, org, {
      role: 'branch_manager',
      scopeKind: 'branches',
      scopeBranchIds: [branchA],
    });
    await expect(
      sql`UPDATE staff_membership_branch SET branch_id = ${branchB}
          WHERE membership_id = ${membership}`.execute(testDb.db),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM staff_membership_branch WHERE membership_id = ${membership}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/append-only/);
    await sql`UPDATE branch SET active = false WHERE id = ${branchA}`.execute(testDb.db);
    const rows = await sql<{ branch_id: string }>`
      SELECT branch_id FROM staff_membership_branch
      WHERE membership_id = ${membership}`.execute(testDb.db);
    expect(rows.rows.map((r) => r.branch_id)).toEqual([branchA]);
  });
});

describe('last-active-owner protection (docs/27 §5)', () => {
  it('refuses revoking the final active owner; a co-owner makes one revocation legal again', async () => {
    const org = await makeOrganization('live');
    const soleOwner = await makeMembership(await createUser(testDb.db), org);
    await expect(revokeMembership(soleOwner)).rejects.toThrow(/last-owner protection/);
    const coOwner = await makeMembership(await createUser(testDb.db), org);
    await revokeMembership(soleOwner);
    await expect(revokeMembership(coOwner)).rejects.toThrow(/last-owner protection/);
    // Non-owner staff revocation is never blocked by the guard.
    const staff = await makeMembership(await createUser(testDb.db), org, { role: 'finance' });
    await revokeMembership(staff);
  });

  it('concurrent revocations of the last two owners leave exactly one active owner', async () => {
    const org = await makeOrganization('live');
    const ownerA = await makeMembership(await createUser(testDb.db), org);
    const ownerB = await makeMembership(await createUser(testDb.db), org);
    const results = await Promise.allSettled([
      revokeMembership(ownerA),
      revokeMembership(ownerB),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /last-owner protection/,
    );
    const remaining = await sql<{ n: string }>`
      SELECT count(*) AS n FROM staff_membership
      WHERE organization_id = ${org} AND role = 'owner' AND state = 'active'`.execute(
      testDb.db,
    );
    expect(Number(remaining.rows[0]?.n)).toBe(1);
  });

  it('controlled organization offboarding is the sanctioned exception', async () => {
    const org = await makeOrganization('live');
    const owner = await makeMembership(await createUser(testDb.db), org);
    await sql`UPDATE organization SET verification_state = 'offboarded', offboarded_at = now()
              WHERE id = ${org}`.execute(testDb.db);
    await revokeMembership(owner);
    const state = await sql<{ state: string }>`
      SELECT state FROM staff_membership WHERE id = ${owner}`.execute(testDb.db);
    expect(state.rows[0]?.state).toBe('revoked');
  });
});

describe('staff_invitation schema (docs/27 §9)', () => {
  it('normalizes and constrains the target, role, scope, and validity window', async () => {
    const org = await makeOrganization();
    const inviter = await createUser(testDb.db);
    await expect(
      makeInvitation(org, inviter, { email: 'Mixed.Case@Example.com' }),
    ).rejects.toThrow(/ck_staff_invitation_email_normalized/);
    await expect(makeInvitation(org, inviter, { role: 'superuser' })).rejects.toThrow(
      /ck_staff_invitation_role/,
    );
    await expect(
      makeInvitation(org, inviter, { role: 'owner', scopeKind: 'branches' }),
    ).rejects.toThrow(/ck_staff_invitation_org_wide/);
    // Scope-kind/ids ambiguity is unrepresentable in both directions.
    await expect(
      makeInvitation(org, inviter, { scopeKind: 'branches', scopeIds: [] }),
    ).rejects.toThrow(/ck_staff_invitation_scope_ids/);
    await expect(
      makeInvitation(org, inviter, { scopeKind: 'all', scopeIds: [newId()] }),
    ).rejects.toThrow(/ck_staff_invitation_scope_ids/);
    await expect(
      makeInvitation(org, inviter, {
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/ck_staff_invitation_window/);
  });

  it('token digests are unique and at most one live invitation exists per organization + address', async () => {
    const org = await makeOrganization();
    const inviter = await createUser(testDb.db);
    await makeInvitation(org, inviter, { email: 'a@example.com', digest: 'dup-digest' });
    await expect(
      makeInvitation(org, inviter, { email: 'b@example.com', digest: 'dup-digest' }),
    ).rejects.toThrow(/uq_staff_invitation_token_digest/);
    await expect(
      makeInvitation(org, inviter, { email: 'a@example.com' }),
    ).rejects.toThrow(/uq_staff_invitation_sent/);
    // After the live row leaves `sent`, a new invitation may exist.
    await sql`UPDATE staff_invitation SET state = 'revoked', revoked_at = now()
              WHERE organization_id = ${org} AND email = 'a@example.com'`.execute(testDb.db);
    await makeInvitation(org, inviter, { email: 'a@example.com' });
  });

  it('walks sent → accepted | revoked | expired and freezes terminal rows', async () => {
    const org = await makeOrganization();
    const inviter = await createUser(testDb.db);
    const accepter = await createUser(testDb.db);

    const accepted = await makeInvitation(org, inviter);
    await sql`UPDATE staff_invitation SET state = 'accepted', accepted_at = now(),
              accepted_by = ${accepter} WHERE id = ${accepted}`.execute(testDb.db);
    await expect(
      sql`UPDATE staff_invitation SET state = 'revoked', accepted_at = NULL,
          accepted_by = NULL, revoked_at = now() WHERE id = ${accepted}`.execute(testDb.db),
    ).rejects.toThrow(/permanently immutable/);

    const revoked = await makeInvitation(org, inviter);
    await sql`UPDATE staff_invitation SET state = 'revoked', revoked_at = now()
              WHERE id = ${revoked}`.execute(testDb.db);
    await expect(
      sql`UPDATE staff_invitation SET state = 'accepted', revoked_at = NULL,
          accepted_at = now(), accepted_by = ${accepter} WHERE id = ${revoked}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/permanently immutable/);

    // State-timestamp ties hold on the way in as well.
    const pending = await makeInvitation(org, inviter);
    await expect(
      sql`UPDATE staff_invitation SET state = 'accepted' WHERE id = ${pending}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow(/ck_staff_invitation_accepted/);
  });

  it('the target, token digest, and expiry are immutable after insert', async () => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const inviter = await createUser(testDb.db);
    const invitation = await makeInvitation(org, inviter);
    for (const mutation of [
      sql`UPDATE staff_invitation SET email = 'other@example.com' WHERE id = ${invitation}`,
      sql`UPDATE staff_invitation SET role = 'coach' WHERE id = ${invitation}`,
      sql`UPDATE staff_invitation SET token_digest = 'rewritten' WHERE id = ${invitation}`,
      sql`UPDATE staff_invitation SET organization_id = ${other} WHERE id = ${invitation}`,
      sql`UPDATE staff_invitation SET expires_at = now() + interval '30 days' WHERE id = ${invitation}`,
    ]) {
      await expect(mutation.execute(testDb.db)).rejects.toThrow(/immutable/);
    }
  });

  it('an overdue invitation can never become accepted, even before the sweep finalizes it', async () => {
    const org = await makeOrganization();
    const inviter = await createUser(testDb.db);
    const accepter = await createUser(testDb.db);
    const overdue = await makeInvitation(org, inviter, {
      issuedAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    await expect(
      sql`UPDATE staff_invitation SET state = 'accepted', accepted_at = now(),
          accepted_by = ${accepter} WHERE id = ${overdue}`.execute(testDb.db),
    ).rejects.toThrow(/cannot be accepted/);
    // The sweep's canonical transition remains legal.
    await sql`UPDATE staff_invitation SET state = 'expired', expired_at = now()
              WHERE id = ${overdue}`.execute(testDb.db);
  });

  it("a membership cannot cite another organization's invitation as provenance", async () => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const inviter = await createUser(testDb.db);
    const user = await createUser(testDb.db);
    const invitationB = await makeInvitation(orgB, inviter);
    await expect(
      sql`INSERT INTO staff_membership (id, user_id, organization_id, role, invitation_id)
          VALUES (${newId()}, ${user}, ${orgA}, 'owner', ${invitationB})`.execute(testDb.db),
    ).rejects.toThrow(/fk_staff_membership_invitation/);
  });
});

describe('application-role permissions (least privilege)', () => {
  it('himma_app can read/insert/update memberships and invitations but never delete, and scope rows are insert-only', async () => {
    const org = await makeOrganization();
    const branch = await makeBranch(org);
    const user = await createUser(testDb.db);
    const inviter = await createUser(testDb.db);
    await makeMembership(await createUser(testDb.db), org); // co-owner for the guard
    const membership = await makeMembership(user, org, {
      role: 'front_desk',
      scopeKind: 'branches',
      scopeBranchIds: [branch],
    });
    const invitation = await makeInvitation(org, inviter);

    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      await sql`SELECT count(*) FROM staff_membership`.execute(trx);
      await sql`SELECT count(*) FROM staff_membership_branch`.execute(trx);
      await sql`SELECT count(*) FROM staff_invitation`.execute(trx);
      await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
                WHERE id = ${membership}`.execute(trx);
      await sql`UPDATE staff_invitation SET state = 'revoked', revoked_at = now()
                WHERE id = ${invitation}`.execute(trx);
      // Roll back so later assertions see the original rows.
      throw new Error('rollback-probe');
    }).catch((error: Error) => {
      if (error.message !== 'rollback-probe') throw error;
    });

    for (const table of ['staff_membership', 'staff_membership_branch', 'staff_invitation']) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(`DELETE FROM ${table}`).execute(trx);
        }),
      ).rejects.toThrow(/permission denied|append-only/i);
    }
    await expect(
      withTransaction(testDb.db, async (trx) => {
        await sql`SET LOCAL ROLE himma_app`.execute(trx);
        await sql`UPDATE staff_membership_branch SET created_at = now()`.execute(trx);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
