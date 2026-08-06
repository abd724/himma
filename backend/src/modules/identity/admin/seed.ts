/**
 * Development/test admin seeding (docs/26 D3 — the SEPARATE mechanism) —
 * B2-5.
 *
 * Never the production path: refuses production, never creates or consumes
 * the bootstrap seal, never calls the production bootstrap implementation.
 * Deterministic and repeatable: the two seed Access Administrators are
 * identified by fixed provider subjects; re-running converges on the same
 * rows.
 *
 * Because the 0003 finance-approver trigger only accepts a first
 * cross-witnessed access_admin pair inside the one seal-writing
 * transaction (by design), seeding — which must NOT write a seal —
 * suspends exactly that one constraint trigger inside its own elevated
 * transaction while inserting the seed pair, then re-enables it. This is a
 * dev/test-elevated DDL operation the application role cannot perform; the
 * constraint machinery stays fully active for everything that follows
 * (tested: a sealless conspiracy pair is still refused after seeding).
 */
import { sql } from 'kysely';

import type { NodeEnv } from '../../../config/env';
import { withTransaction } from '../../../db/transaction';
import {
  findIdentityByIssuerSubject,
  insertAccountWithSelfParticipant,
  insertIdentity,
  insertUser,
} from '../persistence/identity-repository';
import { listActiveRoles, insertAssignment, countAssignments } from '../persistence/admin-role-repository';
import type { IdentityServiceDeps } from '../services/account-status';

export const SEED_ISSUER = 'https://seed.himma.invalid/local';
const SEED_SUBJECTS = ['seed-access-admin-1', 'seed-access-admin-2'] as const;

export type SeedResult =
  | { kind: 'seeded'; adminA: string; adminB: string }
  | { kind: 'unsafeEnvironment' }
  | { kind: 'refusedExistingState' };

export async function seedDevelopmentAdmins(
  deps: IdentityServiceDeps,
  input: { nodeEnv: NodeEnv },
): Promise<SeedResult> {
  if (input.nodeEnv === 'production') return { kind: 'unsafeEnvironment' };

  return withTransaction(deps.db, async (trx) => {
    // Never operate on a database that was production-bootstrapped, and
    // never mix with independently created assignments.
    const sealed = await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(trx);
    if (Number(sealed.rows[0]?.n) > 0) return { kind: 'refusedExistingState' as const };

    // Repeatability: converge on already-seeded identities.
    const existing = await Promise.all(
      SEED_SUBJECTS.map((subject) => findIdentityByIssuerSubject(trx, SEED_ISSUER, subject)),
    );
    if (existing.every((row) => row !== undefined)) {
      const [a, b] = existing;
      const rolesA = await listActiveRoles(trx, (a as { user_id: string }).user_id);
      const rolesB = await listActiveRoles(trx, (b as { user_id: string }).user_id);
      if (rolesA.includes('access_admin') && rolesB.includes('access_admin')) {
        return {
          kind: 'seeded' as const,
          adminA: (a as { user_id: string }).user_id,
          adminB: (b as { user_id: string }).user_id,
        };
      }
      return { kind: 'refusedExistingState' as const };
    }
    if (existing.some((row) => row !== undefined) || (await countAssignments(trx)) > 0) {
      return { kind: 'refusedExistingState' as const };
    }

    const userIds: string[] = [];
    for (const [index, subject] of SEED_SUBJECTS.entries()) {
      const userId = await insertUser(trx);
      await insertIdentity(trx, userId, {
        provider: 'email',
        issuer: SEED_ISSUER,
        subject,
        email: `seed-admin-${index + 1}@himma.invalid`,
        emailVerified: true,
        isPrivateRelay: false,
        assurance: 'single_factor',
      });
      await insertAccountWithSelfParticipant(trx, {
        userId,
        displayName: `Seed Access Administrator ${index + 1}`,
      });
      userIds.push(userId);
    }
    const [adminA, adminB] = userIds as [string, string];

    // Dev/test-elevated: suspend ONLY the finance-approver constraint
    // trigger for the seed pair, inside this transaction, then restore it.
    await sql`ALTER TABLE admin_role_assignment
              DISABLE TRIGGER trg_admin_role_assignment_finance_controls`.execute(trx);
    await insertAssignment(trx, {
      targetUserId: adminA,
      role: 'access_admin',
      state: 'active',
      requestedBy: adminB,
      approvedBy: adminA,
    });
    await insertAssignment(trx, {
      targetUserId: adminB,
      role: 'access_admin',
      state: 'active',
      requestedBy: adminA,
      approvedBy: adminB,
    });
    await sql`ALTER TABLE admin_role_assignment
              ENABLE TRIGGER trg_admin_role_assignment_finance_controls`.execute(trx);

    return { kind: 'seeded' as const, adminA, adminB };
  });
}
