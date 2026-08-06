/**
 * One-time production bootstrap (docs/26 §7.5, §9.9, owner ruling D3) —
 * B2-5. CLI-only (scripts/db-bootstrap-admins.ts); there is NO HTTP path.
 *
 * Exactly once, ever: with zero existing admin assignments and no seal, the
 * elevated operator creates EXACTLY TWO cross-witnessed Access
 * Administrator assignments, their audit + outbox events, and the immutable
 * `bootstrap_seal` in ONE transaction. The 0003 deferred trigger validates
 * the cross-witnessed pair only inside the seal-writing transaction, so
 * this path is structurally unique; the seal's singleton PK +
 * forbid_mutation trigger + SELECT-only himma_app grant make it permanent.
 * The implementation carries no role parameter — no other role is creatable
 * here, and no universal super-admin can ever exist.
 *
 * Secret handling: the operator-supplied secret arrives via environment or
 * secure interactive input (never argv). The REVIEWED manifest binds it by
 * sha256 digest — validation happens before any transaction; the secret is
 * never persisted, logged, audited, or echoed. Operational procedure
 * (docs/26 D3): generate ≥32 chars of randomness into the approved secret
 * store at review time, record its digest in the manifest under review,
 * inject it as HIMMA_BOOTSTRAP_SECRET for the single execution, then
 * destroy the store entry — it authorizes exactly one action, ever.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { NodeEnv } from '../../../config/env';
import {
  countAssignments,
  insertAssignment,
} from '../persistence/admin-role-repository';
import type { IdentityServiceDeps } from '../services/account-status';

export const BOOTSTRAP_CONFIRMATION_PHRASE =
  'bootstrap himma production access administrators';
const MIN_SECRET_LENGTH = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BootstrapManifest {
  /** Exactly the two target users, reviewed and recorded before execution. */
  users: [string, string];
  /** sha256 hex digest of the bootstrap secret — binds secret to review. */
  secretDigest: string;
}

export interface BootstrapInput {
  nodeEnv: NodeEnv;
  manifest: BootstrapManifest;
  confirmationPhrase: string;
  secret: string;
  /** Safe operator identifier (ticket/operator ref) — recorded in the seal. */
  executedBy: string;
}

export type BootstrapResult =
  | { kind: 'bootstrapCompleted'; adminA: string; adminB: string; manifestDigest: string }
  | { kind: 'bootstrapAlreadySealed' }
  | { kind: 'invalidBootstrapManifest' }
  | { kind: 'invalidConfirmation' }
  | { kind: 'unsafeEnvironment' };

function digestsMatch(secret: string, expectedHexDigest: string): boolean {
  const actual = createHash('sha256').update(secret).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHexDigest, 'hex');
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function manifestDigest(manifest: BootstrapManifest): string {
  return createHash('sha256')
    .update(JSON.stringify({ users: manifest.users, secretDigest: manifest.secretDigest }))
    .digest('hex');
}

export async function runProductionBootstrap(
  deps: IdentityServiceDeps,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  // Every gate below runs BEFORE any transaction is opened.
  if (input.nodeEnv !== 'production') return { kind: 'unsafeEnvironment' };
  if (input.confirmationPhrase !== BOOTSTRAP_CONFIRMATION_PHRASE) {
    return { kind: 'invalidConfirmation' };
  }
  const { manifest } = input;
  if (
    !Array.isArray(manifest.users) ||
    manifest.users.length !== 2 ||
    manifest.users[0] === manifest.users[1] ||
    manifest.users.some((id) => !UUID_PATTERN.test(id)) ||
    typeof manifest.secretDigest !== 'string' ||
    input.secret.length < MIN_SECRET_LENGTH ||
    !digestsMatch(input.secret, manifest.secretDigest)
  ) {
    return { kind: 'invalidBootstrapManifest' };
  }
  if (input.executedBy.trim().length === 0) return { kind: 'invalidBootstrapManifest' };

  // Manifest target validation (still outside the bootstrap transaction):
  // both users exist, are active, and hold a verified active identity.
  const eligible = await withTransaction(deps.db, async (trx) => {
    for (const userId of manifest.users) {
      const row = await trx
        .selectFrom('app_user')
        .innerJoin('auth_identity', 'auth_identity.user_id', 'app_user.id')
        .select(['app_user.id'])
        .where('app_user.id', '=', userId)
        .where('app_user.status', '=', 'active')
        .where('auth_identity.status', '=', 'active')
        .where('auth_identity.email_verified', '=', true)
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return false;
    }
    return true;
  });
  if (!eligible) return { kind: 'invalidBootstrapManifest' };

  const [userA, userB] = manifest.users;
  const digest = manifestDigest(manifest);

  return withTransaction(deps.db, async (trx) => {
    // Serialize concurrent attempts; the loser re-reads a sealed state.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('himma_bootstrap', 42))`.execute(trx);
    const sealed = await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(trx);
    if (Number(sealed.rows[0]?.n) > 0 || (await countAssignments(trx)) > 0) {
      return { kind: 'bootstrapAlreadySealed' as const };
    }

    // Exactly two cross-witnessed Access Administrators (docs/26 §9.9) —
    // the ONLY role this code can insert.
    const assignmentA = await insertAssignment(trx, {
      targetUserId: userA,
      role: 'access_admin',
      state: 'active',
      requestedBy: userB,
      approvedBy: userA,
    });
    const assignmentB = await insertAssignment(trx, {
      targetUserId: userB,
      role: 'access_admin',
      state: 'active',
      requestedBy: userA,
      approvedBy: userB,
    });
    for (const [assignmentId, targetUserId] of [
      [assignmentA, userA],
      [assignmentB, userB],
    ] as const) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'auth.admin_role_approved',
        entityType: 'admin_role_assignment',
        entityId: assignmentId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: targetUserId,
        eventType: 'admin_role.approved',
        payload: { assignmentId },
      });
    }
    const seal = await sql<{ sealed_at: Date }>`
      INSERT INTO bootstrap_seal (manifest_digest, executed_by)
      VALUES (${digest}, ${input.executedBy})
      RETURNING sealed_at`.execute(trx);
    const sealedAt = seal.rows[0]?.sealed_at;
    if (sealedAt === undefined) throw new Error('bootstrap seal insert returned no row');
    await appendAuditEvent(trx, {
      actorType: 'system',
      action: 'auth.bootstrap_completed',
      entityType: 'bootstrap_seal',
      entityId: digest,
    });
    // Completion event, same transaction as the assignments and the seal.
    // The seal is a singleton keyed by its manifest digest — the digest IS
    // its safe identifier. Safe identifiers only: no secret, no manifest
    // contents, no emails (executedBy is the reviewed ticket/operator ref).
    await appendOutboxEvent(trx, {
      aggregateType: 'bootstrap_seal',
      aggregateId: digest,
      eventType: 'admin.bootstrap.completed',
      payload: {
        manifestDigest: digest,
        assignmentIds: [assignmentA, assignmentB],
        userIds: [userA, userB],
        sealedAt: sealedAt.toISOString(),
        executedBy: input.executedBy,
      },
    });
    return {
      kind: 'bootstrapCompleted' as const,
      adminA: userA,
      adminB: userB,
      manifestDigest: digest,
    };
  });
}
