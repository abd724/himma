/**
 * B2-6B — Himma-managed recovery codes (docs/26 §5.9, §8.8 ★, §14.C) on real
 * PostgreSQL. High-entropy codes are generated in memory and returned exactly
 * once; PostgreSQL receives only HMAC-SHA-256 digests under the configured
 * pepper version; the pepper value never leaves configuration; production
 * fails closed without it; consumption is single-use under concurrency with
 * one normalized failure outcome.
 */
import { createHmac } from 'node:crypto';
import { sql } from 'kysely';

import {
  DEV_TEST_PEPPER,
  MfaConfigError,
  parseMfaConfig,
} from '../src/modules/identity/services/mfa-config';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from '../src/modules/identity/services/mfa-recovery-codes';
import type { MfaServiceDeps } from '../src/modules/identity/services/mfa-enrollment';
import { FakeMfaProvider } from '../src/modules/identity/providers/fake/fake-mfa-provider';
import { sweepDatabaseForValues } from './helpers/db-sweep';
import { createIdentity, createSession, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let deps: MfaServiceDeps;

const CONFIG = () => parseMfaConfig('test', { HIMMA_MFA_RECOVERY_CODE_COUNT: '4' });

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

beforeEach(() => {
  deps = { db: testDb.db, mfaProvider: new FakeMfaProvider(), mfaConfig: CONFIG() };
});

afterAll(async () => {
  await testDb.drop();
});

async function makeEnrolledUser(): Promise<string> {
  const user = await createUser(testDb.db);
  await sql`
    INSERT INTO mfa_method (id, user_id, kind, state, confirmed_at)
    VALUES (gen_random_uuid(), ${user}, 'totp', 'active', now())`.execute(testDb.db);
  return user;
}

async function generate(user: string): Promise<{ batchId: string; codes: string[] }> {
  const result = await generateRecoveryCodes(deps, { userId: user });
  if (result.kind !== 'recoveryCodesGenerated') throw new Error(result.kind);
  return { batchId: result.batchId, codes: result.codes };
}

describe('recovery-code generation', () => {
  it('generates the configured number of high-entropy, human-enterable codes', async () => {
    const user = await makeEnrolledUser();
    const { codes } = await generate(user);
    expect(codes).toHaveLength(4);
    expect(new Set(codes).size).toBe(4);
    for (const code of codes) {
      // 7 groups of 4 from a 30-symbol unambiguous alphabet — 28 symbols,
      // ≈137 bits of entropy (≥128 required). No 0/1/i/l/o/u.
      expect(code).toMatch(/^([a-hj-km-np-tv-z2-9]{4}-){6}[a-hj-km-np-tv-z2-9]{4}$/);
    }
  });

  it('persists only HMAC-SHA-256 digests under the configured pepper version — raw codes are unrecoverable', async () => {
    const user = await makeEnrolledUser();
    const { batchId, codes } = await generate(user);

    const batch = await sql<{ digest_scheme: string; pepper_version: number; code_count: number }>`
      SELECT digest_scheme, pepper_version, code_count FROM mfa_recovery_code_batch
      WHERE id = ${batchId}`.execute(testDb.db);
    expect(batch.rows[0]).toEqual({
      digest_scheme: 'hmac_sha256',
      pepper_version: CONFIG().activePepperVersion,
      code_count: 4,
    });

    const stored = await sql<{ code_hash: string }>`
      SELECT code_hash FROM mfa_recovery_code WHERE batch_id = ${batchId}`.execute(testDb.db);
    expect(stored.rows).toHaveLength(4);
    const expectedDigests = codes
      .map((code) =>
        createHmac('sha256', DEV_TEST_PEPPER).update(normalizeRecoveryCode(code)).digest('hex'),
      )
      .sort();
    expect(stored.rows.map((r) => r.code_hash).sort()).toEqual(expectedDigests);

    // Raw and normalized code forms appear nowhere in the database.
    const rawForms = codes.flatMap((code) => [code, normalizeRecoveryCode(code)]);
    expect(await sweepDatabaseForValues(testDb.db, rawForms)).toEqual([]);
  });

  it('requires an active MFA method', async () => {
    const user = await createUser(testDb.db);
    expect((await generateRecoveryCodes(deps, { userId: user })).kind).toBe('notEligible');
  });

  it('regeneration supersedes the previous active batch and invalidates its remaining codes atomically', async () => {
    const user = await makeEnrolledUser();
    const first = await generate(user);
    const consumed = await consumeRecoveryCode(deps, { userId: user, code: first.codes[0]! });
    expect(consumed.kind).toBe('recoveryCodeAccepted');

    const second = await generate(user);
    expect(second.batchId).not.toBe(first.batchId);
    const firstBatch = await sql<{ state: string }>`
      SELECT state FROM mfa_recovery_code_batch WHERE id = ${first.batchId}`.execute(testDb.db);
    expect(firstBatch.rows[0]?.state).toBe('superseded');
    const oldCodes = await sql<{ consumed: string; invalidated: string; open: string }>`
      SELECT count(*) FILTER (WHERE consumed_at IS NOT NULL) AS consumed,
             count(*) FILTER (WHERE invalidated_at IS NOT NULL) AS invalidated,
             count(*) FILTER (WHERE consumed_at IS NULL AND invalidated_at IS NULL) AS open
      FROM mfa_recovery_code WHERE batch_id = ${first.batchId}`.execute(testDb.db);
    expect(Number(oldCodes.rows[0]?.consumed)).toBe(1);
    expect(Number(oldCodes.rows[0]?.invalidated)).toBe(3);
    expect(Number(oldCodes.rows[0]?.open)).toBe(0);

    // A code from the superseded batch now fails with the normalized outcome.
    expect(
      (await consumeRecoveryCode(deps, { userId: user, code: first.codes[1]! })).kind,
    ).toBe('recoveryCodeRejected');
  });
});

describe('recovery-code consumption', () => {
  it('accepts a valid code once (with lenient entry formatting), then rejects it', async () => {
    const user = await makeEnrolledUser();
    const { codes } = await generate(user);
    const entered = codes[0]!.toUpperCase().replace(/-/g, ' ');
    const first = await consumeRecoveryCode(deps, { userId: user, code: entered });
    expect(first.kind).toBe('recoveryCodeAccepted');
    const second = await consumeRecoveryCode(deps, { userId: user, code: codes[0]! });
    expect(second.kind).toBe('recoveryCodeRejected');
  });

  it('wrong, consumed, and foreign codes all produce ONE indistinguishable outcome', async () => {
    const user = await makeEnrolledUser();
    const other = await makeEnrolledUser();
    const { codes } = await generate(user);
    const otherCodes = await generate(other);
    const outcomes = await Promise.all([
      consumeRecoveryCode(deps, { userId: user, code: 'zzzz-zzzz-zzzz-zzzz-zzzz-zzzz-zzzz' }),
      consumeRecoveryCode(deps, { userId: user, code: otherCodes.codes[0]! }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ kind: 'recoveryCodeRejected' });
    }
    // The user's own codes were untouched by those failures.
    const untouched = await consumeRecoveryCode(deps, { userId: user, code: codes[0]! });
    expect(untouched.kind).toBe('recoveryCodeAccepted');
  });

  it('concurrent presentation of one code yields exactly one successful consumer', async () => {
    const user = await makeEnrolledUser();
    const { codes } = await generate(user);
    const results = await Promise.all([
      consumeRecoveryCode(deps, { userId: user, code: codes[0]! }),
      consumeRecoveryCode(deps, { userId: user, code: codes[0]! }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      'recoveryCodeAccepted',
      'recoveryCodeRejected',
    ]);
  });

  it('creates the session-bound step-up grant in the same transaction when requested', async () => {
    const user = await makeEnrolledUser();
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity);
    const { codes } = await generate(user);
    const result = await consumeRecoveryCode(deps, {
      userId: user,
      code: codes[0]!,
      session: { sessionId: session.id },
    });
    expect(result.kind).toBe('recoveryCodeAccepted');
    if (result.kind !== 'recoveryCodeAccepted') return;
    expect(result.stepUpGrantId).toBeDefined();
    const grant = await sql<{ user_id: string; login_session_id: string; method: string }>`
      SELECT user_id, login_session_id, method FROM step_up_grant
      WHERE id = ${result.stepUpGrantId!}`.execute(testDb.db);
    expect(grant.rows[0]).toEqual({
      user_id: user,
      login_session_id: session.id,
      method: 'recovery_code',
    });
    const audit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'auth.step_up_completed' AND entity_id = ${result.stepUpGrantId!}`.execute(
      testDb.db,
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('a revoked session cannot receive a grant, and the code is not burned', async () => {
    const user = await makeEnrolledUser();
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity);
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'test'
              WHERE id = ${session.id}`.execute(testDb.db);
    const { codes } = await generate(user);
    const result = await consumeRecoveryCode(deps, {
      userId: user,
      code: codes[0]!,
      session: { sessionId: session.id },
    });
    expect(result.kind).toBe('sessionNotLive');
    const retry = await consumeRecoveryCode(deps, { userId: user, code: codes[0]! });
    expect(retry.kind).toBe('recoveryCodeAccepted');
  });

  it('audit/outbox payloads carry safe ids only — no raw code, digest, or pepper', async () => {
    const user = await makeEnrolledUser();
    const { batchId, codes } = await generate(user);
    await consumeRecoveryCode(deps, { userId: user, code: codes[0]! });
    const digests = await sql<{ code_hash: string }>`
      SELECT code_hash FROM mfa_recovery_code WHERE batch_id = ${batchId}`.execute(testDb.db);
    const sensitive = [
      ...codes,
      ...codes.map(normalizeRecoveryCode),
      ...digests.rows.map((r) => r.code_hash),
      DEV_TEST_PEPPER,
    ];
    for (const table of ['audit_event', 'outbox_event']) {
      for (const value of sensitive) {
        const hit = await sql<{ found: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM ${sql.raw(table)} t WHERE to_jsonb(t)::text ILIKE ${'%' + value + '%'}
          ) AS found`.execute(testDb.db);
        expect(hit.rows[0]?.found).toBe(false);
      }
    }
    const used = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'mfa.recovery_code_used' AND aggregate_id = ${user}`.execute(testDb.db);
    expect(Number(used.rows[0]?.n)).toBe(1);
  });
});

describe('pepper configuration boundary', () => {
  it('production fails closed without a real pepper', () => {
    expect(() => parseMfaConfig('production', {})).toThrow(MfaConfigError);
    expect(() =>
      parseMfaConfig('production', { HIMMA_MFA_RECOVERY_PEPPER: 'too-short' }),
    ).toThrow(MfaConfigError);
    expect(() =>
      parseMfaConfig('production', { HIMMA_MFA_RECOVERY_PEPPER: DEV_TEST_PEPPER }),
    ).toThrow(MfaConfigError);
    const ok = parseMfaConfig('production', {
      HIMMA_MFA_RECOVERY_PEPPER: 'a'.repeat(48),
      HIMMA_MFA_RECOVERY_PEPPER_VERSION: '2',
    });
    expect(ok.activePepperVersion).toBe(2);
    expect(ok.peppers.get(2)).toBe('a'.repeat(48));
  });

  it('development/test default to the deterministic non-production pepper', () => {
    const config = parseMfaConfig('test', {});
    expect(config.peppers.get(config.activePepperVersion)).toBe(DEV_TEST_PEPPER);
    expect(config.recoveryCodeCount).toBe(10);
  });
});
