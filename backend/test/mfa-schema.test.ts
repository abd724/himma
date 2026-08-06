/**
 * B2-6A — MFA, recovery-code, and step-up schema foundation (docs/26 §5.8,
 * §5.9, §8.8, Amendment A1.1). Schema-only: Cognito holds every TOTP secret;
 * Himma stores only the enrollment/assurance bookkeeping needed for business
 * enforcement, auditing, recovery, and session assurance.
 *
 * Real PostgreSQL throughout: lifecycle constraints, the trigger-maintained
 * `app_user.mfa_enrolled` mirror, single-use recovery-code consumption under
 * concurrency, batch regeneration invalidation, challenge/step-up binding,
 * structural absence of secret-bearing columns, and himma_app grants.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import {
  createIdentity,
  createSession,
  createUser,
} from './helpers/identity-fixtures';
import {
  findSecretColumnOffenders,
  MFA_SECRET_COLUMN_PATTERN,
} from './helpers/structural-secrets';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

const FUTURE = () => new Date(Date.now() + 3_600_000);
const PAST = () => new Date(Date.now() - 3_600_000);

async function insertMethod(
  userId: string,
  overrides: {
    state?: string;
    enrollmentExpiresAt?: Date | null;
    confirmedAt?: Date | null;
    endedAt?: Date | null;
    kind?: string;
    providerManaged?: boolean;
  } = {},
): Promise<string> {
  const id = newId();
  const state = overrides.state ?? 'pending';
  const enrollmentExpiresAt =
    overrides.enrollmentExpiresAt === undefined ? FUTURE() : overrides.enrollmentExpiresAt;
  await sql`
    INSERT INTO mfa_method (id, user_id, kind, provider_managed, state,
                            enrollment_expires_at, confirmed_at, ended_at)
    VALUES (${id}, ${userId}, ${overrides.kind ?? 'totp'},
            ${overrides.providerManaged ?? true}, ${state},
            ${enrollmentExpiresAt}, ${overrides.confirmedAt ?? null},
            ${overrides.endedAt ?? null})`.execute(testDb.db);
  return id;
}

async function activateMethod(methodId: string): Promise<void> {
  await sql`
    UPDATE mfa_method SET state = 'active', confirmed_at = now()
    WHERE id = ${methodId}`.execute(testDb.db);
}

async function insertBatch(
  userId: string,
  overrides: { state?: string; endedAt?: Date | null; codeCount?: number } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO mfa_recovery_code_batch (id, user_id, state, code_count,
                                         digest_scheme, pepper_version, ended_at)
    VALUES (${id}, ${userId}, ${overrides.state ?? 'active'},
            ${overrides.codeCount ?? 10}, 'hmac_sha256', 1,
            ${overrides.endedAt ?? null})`.execute(testDb.db);
  return id;
}

async function insertCode(
  batchId: string,
  userId: string,
  codeHash: string = `digest-${newId()}`,
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO mfa_recovery_code (id, batch_id, user_id, code_hash)
    VALUES (${id}, ${batchId}, ${userId}, ${codeHash})`.execute(testDb.db);
  return id;
}

async function insertChallenge(
  userId: string,
  overrides: {
    purpose?: string;
    state?: string;
    loginSessionId?: string | null;
    expiresAt?: Date;
    attemptCount?: number;
    passedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO mfa_challenge (id, user_id, login_session_id, purpose, state,
                               attempt_count, expires_at, passed_at)
    VALUES (${id}, ${userId}, ${overrides.loginSessionId ?? null},
            ${overrides.purpose ?? 'login'}, ${overrides.state ?? 'pending'},
            ${overrides.attemptCount ?? 0}, ${overrides.expiresAt ?? FUTURE()},
            ${overrides.passedAt ?? null})`.execute(testDb.db);
  return id;
}

async function mfaEnrolled(userId: string): Promise<boolean> {
  const row = await sql<{ mfa_enrolled: boolean }>`
    SELECT mfa_enrolled FROM app_user WHERE id = ${userId}`.execute(testDb.db);
  const value = row.rows[0]?.mfa_enrolled;
  if (value === undefined) throw new Error('missing user');
  return value;
}

describe('mfa_method lifecycle and constraints', () => {
  it('accepts a pending enrollment with an expiry and no confirmation', async () => {
    const user = await createUser(testDb.db);
    const id = await insertMethod(user);
    const row = await sql<{ state: string; enrollment_expires_at: Date }>`
      SELECT state, enrollment_expires_at FROM mfa_method WHERE id = ${id}`.execute(testDb.db);
    expect(row.rows[0]?.state).toBe('pending');
    expect(row.rows[0]?.enrollment_expires_at).toBeInstanceOf(Date);
  });

  it('rejects invalid state combinations', async () => {
    const user = await createUser(testDb.db);
    // Pending without an enrollment expiry.
    await expect(insertMethod(user, { enrollmentExpiresAt: null })).rejects.toThrow();
    // Pending already confirmed.
    await expect(insertMethod(user, { confirmedAt: new Date() })).rejects.toThrow();
    // Active without a confirmation timestamp.
    await expect(insertMethod(user, { state: 'active', confirmedAt: null })).rejects.toThrow();
    // Disabled without an ended timestamp.
    await expect(
      insertMethod(user, { state: 'disabled', endedAt: null }),
    ).rejects.toThrow();
    // Non-TOTP kinds and Himma-managed methods do not exist in this slice.
    await expect(insertMethod(user, { kind: 'sms' })).rejects.toThrow();
    await expect(insertMethod(user, { providerManaged: false })).rejects.toThrow();
  });

  it('allows at most one active TOTP method per user', async () => {
    const user = await createUser(testDb.db);
    const first = await insertMethod(user);
    await activateMethod(first);
    await expect(
      insertMethod(user, { state: 'active', confirmedAt: new Date(), enrollmentExpiresAt: FUTURE() }),
    ).rejects.toThrow();
  });

  it('refuses to activate a pending enrollment whose expiry has passed', async () => {
    const user = await createUser(testDb.db);
    const id = await insertMethod(user, { enrollmentExpiresAt: PAST() });
    await expect(activateMethod(id)).rejects.toThrow();
  });

  it('terminal methods are immutable and provider/kind/state metadata is transition-controlled', async () => {
    const user = await createUser(testDb.db);
    const id = await insertMethod(user);
    await activateMethod(id);
    // Immutable columns.
    const other = await createUser(testDb.db);
    await expect(
      sql`UPDATE mfa_method SET user_id = ${other} WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE mfa_method SET confirmed_at = now() WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
    // active → disabled is allowed; disabled is terminal.
    await sql`UPDATE mfa_method SET state = 'disabled', ended_at = now()
              WHERE id = ${id}`.execute(testDb.db);
    await expect(
      sql`UPDATE mfa_method SET state = 'active' WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('app_user.mfa_enrolled mirror', () => {
  it('follows only active methods: pending → false, active → true, disabled → false', async () => {
    const user = await createUser(testDb.db);
    expect(await mfaEnrolled(user)).toBe(false);
    const id = await insertMethod(user);
    expect(await mfaEnrolled(user)).toBe(false);
    await activateMethod(id);
    expect(await mfaEnrolled(user)).toBe(true);
    await sql`UPDATE mfa_method SET state = 'disabled', ended_at = now()
              WHERE id = ${id}`.execute(testDb.db);
    expect(await mfaEnrolled(user)).toBe(false);
  });

  it('superseding an active method drops the mirror until a replacement is confirmed', async () => {
    const user = await createUser(testDb.db);
    const first = await insertMethod(user);
    await activateMethod(first);
    expect(await mfaEnrolled(user)).toBe(true);
    await sql`UPDATE mfa_method SET state = 'superseded', ended_at = now()
              WHERE id = ${first}`.execute(testDb.db);
    expect(await mfaEnrolled(user)).toBe(false);
    const second = await insertMethod(user);
    await activateMethod(second);
    expect(await mfaEnrolled(user)).toBe(true);
  });

  it('cannot be set directly: the flag alone can never fabricate enrollment', async () => {
    const user = await createUser(testDb.db);
    await expect(
      sql`UPDATE app_user SET mfa_enrolled = true WHERE id = ${user}`.execute(testDb.db),
    ).rejects.toThrow();
    // Nor at insert time.
    await expect(
      sql`INSERT INTO app_user (id, mfa_enrolled) VALUES (${newId()}, true)`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('recovery-code batches', () => {
  it('allows exactly one active batch per user', async () => {
    const user = await createUser(testDb.db);
    await insertBatch(user);
    await expect(insertBatch(user)).rejects.toThrow();
  });

  it('rejects a batch without a positive code count', async () => {
    const user = await createUser(testDb.db);
    await expect(insertBatch(user, { codeCount: 0 })).rejects.toThrow();
  });

  it('regeneration (superseding the active batch) invalidates its remaining codes but not consumed ones', async () => {
    const user = await createUser(testDb.db);
    const batch = await insertBatch(user);
    const consumed = await insertCode(batch, user);
    const remaining = await insertCode(batch, user);
    await sql`UPDATE mfa_recovery_code SET consumed_at = now()
              WHERE id = ${consumed} AND consumed_at IS NULL`.execute(testDb.db);

    await sql`UPDATE mfa_recovery_code_batch SET state = 'superseded', ended_at = now()
              WHERE id = ${batch}`.execute(testDb.db);

    const rows = await sql<{ id: string; consumed_at: Date | null; invalidated_at: Date | null }>`
      SELECT id, consumed_at, invalidated_at FROM mfa_recovery_code
      WHERE batch_id = ${batch}`.execute(testDb.db);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(remaining)?.invalidated_at).toBeInstanceOf(Date);
    expect(byId.get(consumed)?.invalidated_at).toBeNull();
    expect(byId.get(consumed)?.consumed_at).toBeInstanceOf(Date);

    // The user can now receive a fresh active batch.
    await insertBatch(user);
  });

  it('batch identity and digest metadata are immutable; terminal batches cannot reactivate', async () => {
    const user = await createUser(testDb.db);
    const batch = await insertBatch(user);
    await expect(
      sql`UPDATE mfa_recovery_code_batch SET pepper_version = 2 WHERE id = ${batch}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
    await sql`UPDATE mfa_recovery_code_batch SET state = 'invalidated', ended_at = now()
              WHERE id = ${batch}`.execute(testDb.db);
    await expect(
      sql`UPDATE mfa_recovery_code_batch SET state = 'active', ended_at = NULL
          WHERE id = ${batch}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('recovery-code records', () => {
  it('rejects duplicate code digests and codes claiming a foreign batch', async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    const batchA = await insertBatch(userA);
    await insertCode(batchA, userA, 'digest-duplicate-proof');
    await expect(insertCode(batchA, userA, 'digest-duplicate-proof')).rejects.toThrow();
    // Ownership: a code cannot attach userB to userA's batch (composite FK).
    await expect(insertCode(batchA, userB)).rejects.toThrow();
  });

  it('a code is consumed exactly once (CAS)', async () => {
    const user = await createUser(testDb.db);
    const batch = await insertBatch(user);
    const code = await insertCode(batch, user);
    const first = await sql`
      UPDATE mfa_recovery_code SET consumed_at = now()
      WHERE id = ${code} AND consumed_at IS NULL AND invalidated_at IS NULL`.execute(testDb.db);
    expect(Number(first.numAffectedRows)).toBe(1);
    const second = await sql`
      UPDATE mfa_recovery_code SET consumed_at = now()
      WHERE id = ${code} AND consumed_at IS NULL AND invalidated_at IS NULL`.execute(testDb.db);
    expect(Number(second.numAffectedRows)).toBe(0);
  });

  it('concurrent consumption of one code admits exactly one winner', async () => {
    const user = await createUser(testDb.db);
    const batch = await insertBatch(user);
    const code = await insertCode(batch, user);
    const attempt = () =>
      withTransaction(testDb.db, async (trx) => {
        const result = await sql`
          UPDATE mfa_recovery_code SET consumed_at = now()
          WHERE id = ${code} AND consumed_at IS NULL AND invalidated_at IS NULL`.execute(trx);
        return Number(result.numAffectedRows);
      });
    const outcomes = await Promise.all([attempt(), attempt()]);
    expect(outcomes.sort()).toEqual([0, 1]);
  });

  it('consumed and invalidated codes cannot be restored, and digests cannot be rewritten', async () => {
    const user = await createUser(testDb.db);
    const batch = await insertBatch(user);
    const code = await insertCode(batch, user);
    await expect(
      sql`UPDATE mfa_recovery_code SET code_hash = 'digest-rewritten' WHERE id = ${code}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
    await sql`UPDATE mfa_recovery_code SET consumed_at = now()
              WHERE id = ${code} AND consumed_at IS NULL`.execute(testDb.db);
    // Un-consume, re-time, or consume-after-invalidate are all refused.
    await expect(
      sql`UPDATE mfa_recovery_code SET consumed_at = NULL WHERE id = ${code}`.execute(testDb.db),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE mfa_recovery_code SET consumed_at = now() WHERE id = ${code}`.execute(testDb.db),
    ).rejects.toThrow();

    const invalidated = await insertCode(batch, user);
    await sql`UPDATE mfa_recovery_code SET invalidated_at = now()
              WHERE id = ${invalidated}`.execute(testDb.db);
    await expect(
      sql`UPDATE mfa_recovery_code SET invalidated_at = NULL WHERE id = ${invalidated}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE mfa_recovery_code SET consumed_at = now() WHERE id = ${invalidated}`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
  });
});

describe('mfa_challenge bookkeeping', () => {
  it('a step-up challenge must be session-bound, and the session must belong to the user', async () => {
    const user = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity);
    await expect(insertChallenge(user, { purpose: 'step_up' })).rejects.toThrow();
    await insertChallenge(user, { purpose: 'step_up', loginSessionId: session.id });
    // Another user cannot bind a challenge to this session.
    const stranger = await createUser(testDb.db);
    await expect(
      insertChallenge(stranger, { purpose: 'step_up', loginSessionId: session.id }),
    ).rejects.toThrow();
  });

  it('an expired pending challenge cannot pass, and terminal challenges cannot be reused', async () => {
    const user = await createUser(testDb.db);
    const expired = await insertChallenge(user, { expiresAt: PAST() });
    await expect(
      sql`UPDATE mfa_challenge SET state = 'passed', passed_at = now()
          WHERE id = ${expired}`.execute(testDb.db),
    ).rejects.toThrow();

    const passed = await insertChallenge(user);
    await sql`UPDATE mfa_challenge SET state = 'passed', passed_at = now()
              WHERE id = ${passed}`.execute(testDb.db);
    // Passed is terminal: no reuse, no reset to pending, no second pass.
    await expect(
      sql`UPDATE mfa_challenge SET state = 'pending', passed_at = NULL
          WHERE id = ${passed}`.execute(testDb.db),
    ).rejects.toThrow();

    const invalidated = await insertChallenge(user);
    await sql`UPDATE mfa_challenge SET state = 'invalidated' WHERE id = ${invalidated}`.execute(
      testDb.db,
    );
    await expect(
      sql`UPDATE mfa_challenge SET state = 'passed', passed_at = now()
          WHERE id = ${invalidated}`.execute(testDb.db),
    ).rejects.toThrow();
  });

  it('attempt counts can never decrease', async () => {
    const user = await createUser(testDb.db);
    const id = await insertChallenge(user);
    await sql`UPDATE mfa_challenge SET attempt_count = 2 WHERE id = ${id}`.execute(testDb.db);
    await expect(
      sql`UPDATE mfa_challenge SET attempt_count = 1 WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('step_up_grant bookkeeping', () => {
  it('binds each grant to the owning user and login session with a bounded expiry', async () => {
    const user = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity);
    const id = newId();
    await sql`
      INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
      VALUES (${id}, ${user}, ${session.id}, 'totp', ${FUTURE()})`.execute(testDb.db);

    // Another user cannot claim a grant on this session (composite FK).
    const stranger = await createUser(testDb.db);
    await expect(
      sql`INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
          VALUES (${newId()}, ${stranger}, ${session.id}, 'totp', ${FUTURE()})`.execute(testDb.db),
    ).rejects.toThrow();
    // An unbounded or backwards expiry is refused.
    await expect(
      sql`INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
          VALUES (${newId()}, ${user}, ${session.id}, 'totp', ${PAST()})`.execute(testDb.db),
    ).rejects.toThrow();
  });

  it('grants are immutable except one-time invalidation', async () => {
    const user = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity);
    const id = newId();
    await sql`
      INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
      VALUES (${id}, ${user}, ${session.id}, 'recovery_code', ${FUTURE()})`.execute(testDb.db);
    await expect(
      sql`UPDATE step_up_grant SET expires_at = ${new Date(Date.now() + 86_400_000)}
          WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
    await sql`UPDATE step_up_grant SET invalidated_at = now() WHERE id = ${id}`.execute(testDb.db);
    await expect(
      sql`UPDATE step_up_grant SET invalidated_at = NULL WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow();
  });
});

describe('structural guarantees (no secret material, ever)', () => {
  it('the five B2-6A tables exist with exactly the reviewed columns on the sensitive ones', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(
      testDb.db,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const required of [
      'mfa_method',
      'mfa_recovery_code_batch',
      'mfa_recovery_code',
      'mfa_challenge',
      'step_up_grant',
    ]) {
      expect(names).toContain(required);
    }

    const methodColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mfa_method'`.execute(testDb.db);
    expect(methodColumns.rows.map((r) => r.column_name).sort()).toEqual([
      'confirmed_at',
      'created_at',
      'ended_at',
      'enrollment_expires_at',
      'id',
      'kind',
      'provider_managed',
      'state',
      'updated_at',
      'user_id',
      'version',
    ]);
    const codeColumns = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'mfa_recovery_code'`.execute(testDb.db);
    expect(codeColumns.rows.map((r) => r.column_name).sort()).toEqual([
      'batch_id',
      'code_hash',
      'consumed_at',
      'created_at',
      'id',
      'invalidated_at',
      'updated_at',
      'user_id',
      'version',
    ]);
  });

  it('no public column can hold TOTP secrets, raw codes, tokens, QR contents, or key material', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'`.execute(testDb.db);
    // Key-material names are explicit: `idempotency_key` (Slice 1) is a
    // request-deduplication key, not cryptographic key material. The ONLY
    // digest exemptions are the explicit table-qualified allowlist entries
    // (specifically reviewed one-way verifier columns) — a `_digest` or
    // `_hash` suffix by itself exempts nothing.
    const offenders = findSecretColumnOffenders(columns.rows, MFA_SECRET_COLUMN_PATTERN);
    expect(offenders).toEqual([]);
  });
});

describe('application role permissions on MFA tables', () => {
  it('himma_app can select/insert/update the five tables but never delete', async () => {
    const user = await createUser(testDb.db);
    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      const method = newId();
      await sql`
        INSERT INTO mfa_method (id, user_id, kind, state, enrollment_expires_at)
        VALUES (${method}, ${user}, 'totp', 'pending', ${FUTURE()})`.execute(trx);
      await sql`UPDATE mfa_method SET state = 'active', confirmed_at = now()
                WHERE id = ${method}`.execute(trx);
      await sql`SELECT count(*) FROM mfa_method`.execute(trx);
    });
    for (const table of [
      'mfa_method',
      'mfa_recovery_code_batch',
      'mfa_recovery_code',
      'mfa_challenge',
      'step_up_grant',
    ]) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(`DELETE FROM ${table}`).execute(trx);
        }),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
