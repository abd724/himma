/**
 * MFA persistence (docs/26 §8.8; B2-6A schema) — B2-6B.
 *
 * All table access for mfa_method, recovery-code batches/codes,
 * mfa_challenge, and step_up_grant; every mutation runs inside the caller's
 * transaction. The B2-6A constraints and triggers (single active method,
 * activation-window refusal, write-once consumption, terminal immutability,
 * the mfa_enrolled mirror) remain the final authority — this layer can
 * never bypass them.
 *
 * Secret boundary (structural): NO function here accepts a TOTP secret, an
 * OTP value, a raw recovery code, provider tokens, or a pepper — inputs are
 * opaque ids, timestamps, and precomputed digests only.
 */
import { newId } from '../../../db/ids';
import type { Trx } from '../../../db/transaction';

export interface MfaMethodRow {
  id: string;
  user_id: string;
  kind: string;
  state: string;
  enrollment_expires_at: Date | null;
  confirmed_at: Date | null;
}

const METHOD_COLUMNS = [
  'id',
  'user_id',
  'kind',
  'state',
  'enrollment_expires_at',
  'confirmed_at',
] as const;

export async function findMethodForUpdate(
  trx: Trx,
  methodId: string,
): Promise<MfaMethodRow | undefined> {
  return trx
    .selectFrom('mfa_method')
    .select(METHOD_COLUMNS)
    .where('id', '=', methodId)
    .forUpdate()
    .executeTakeFirst();
}

export async function findActiveMethodForUpdate(
  trx: Trx,
  userId: string,
): Promise<MfaMethodRow | undefined> {
  return trx
    .selectFrom('mfa_method')
    .select(METHOD_COLUMNS)
    .where('user_id', '=', userId)
    .where('state', '=', 'active')
    .forUpdate()
    .executeTakeFirst();
}

export async function findPendingMethodForUpdate(
  trx: Trx,
  userId: string,
): Promise<MfaMethodRow | undefined> {
  return trx
    .selectFrom('mfa_method')
    .select(METHOD_COLUMNS)
    .where('user_id', '=', userId)
    .where('state', '=', 'pending')
    .forUpdate()
    .executeTakeFirst();
}

export async function insertPendingMethod(
  trx: Trx,
  input: { userId: string; expiresAt: Date },
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('mfa_method')
    .values({
      id,
      user_id: input.userId,
      kind: 'totp',
      state: 'pending',
      enrollment_expires_at: input.expiresAt,
    })
    .execute();
  return id;
}

/** pending → active with the enrollment window re-checked IN the statement
 *  (the B2-6A trigger is the backstop). False when stale/expired. */
export async function activatePendingMethod(trx: Trx, methodId: string): Promise<boolean> {
  const result = await trx
    .updateTable('mfa_method')
    .set({ state: 'active', confirmed_at: new Date() })
    .where('id', '=', methodId)
    .where('state', '=', 'pending')
    .where('enrollment_expires_at', '>', new Date())
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function supersedeMethod(
  trx: Trx,
  methodId: string,
  fromState: 'pending' | 'active',
): Promise<boolean> {
  const result = await trx
    .updateTable('mfa_method')
    .set({ state: 'superseded', ended_at: new Date() })
    .where('id', '=', methodId)
    .where('state', '=', fromState)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export interface RecoveryBatchRow {
  id: string;
  user_id: string;
  state: string;
  pepper_version: number;
}

export async function findActiveBatch(
  trx: Trx,
  userId: string,
  options: { forUpdate?: boolean } = {},
): Promise<RecoveryBatchRow | undefined> {
  let query = trx
    .selectFrom('mfa_recovery_code_batch')
    .select(['id', 'user_id', 'state', 'pepper_version'])
    .where('user_id', '=', userId)
    .where('state', '=', 'active');
  if (options.forUpdate === true) query = query.forUpdate();
  return query.executeTakeFirst();
}

export async function supersedeBatch(trx: Trx, batchId: string): Promise<boolean> {
  const result = await trx
    .updateTable('mfa_recovery_code_batch')
    .set({ state: 'superseded', ended_at: new Date() })
    .where('id', '=', batchId)
    .where('state', '=', 'active')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function insertRecoveryBatch(
  trx: Trx,
  input: { userId: string; codeCount: number; pepperVersion: number },
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('mfa_recovery_code_batch')
    .values({
      id,
      user_id: input.userId,
      state: 'active',
      code_count: input.codeCount,
      digest_scheme: 'hmac_sha256',
      pepper_version: input.pepperVersion,
    })
    .execute();
  return id;
}

/** Digests only — raw recovery codes never reach this layer. */
export async function insertRecoveryCodeDigests(
  trx: Trx,
  input: { batchId: string; userId: string; digests: string[] },
): Promise<void> {
  await trx
    .insertInto('mfa_recovery_code')
    .values(
      input.digests.map((digest) => ({
        id: newId(),
        batch_id: input.batchId,
        user_id: input.userId,
        code_hash: digest,
      })),
    )
    .execute();
}

/** CAS single-use consumption; concurrency admits exactly one winner. */
export async function consumeRecoveryCodeByDigest(
  trx: Trx,
  input: { userId: string; batchId: string; digest: string },
): Promise<{ id: string } | undefined> {
  const rows = await trx
    .updateTable('mfa_recovery_code')
    .set({ consumed_at: new Date() })
    .where('user_id', '=', input.userId)
    .where('batch_id', '=', input.batchId)
    .where('code_hash', '=', input.digest)
    .where('consumed_at', 'is', null)
    .where('invalidated_at', 'is', null)
    .returning('id')
    .execute();
  return rows[0];
}

export interface MfaChallengeRow {
  id: string;
  user_id: string;
  login_session_id: string | null;
  purpose: string;
  state: string;
  attempt_count: number;
  expires_at: Date;
}

export async function insertStepUpChallenge(
  trx: Trx,
  input: { userId: string; sessionId: string; expiresAt: Date },
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('mfa_challenge')
    .values({
      id,
      user_id: input.userId,
      login_session_id: input.sessionId,
      purpose: 'step_up',
      state: 'pending',
      expires_at: input.expiresAt,
    })
    .execute();
  return id;
}

export async function findChallengeForUpdate(
  trx: Trx,
  challengeId: string,
): Promise<MfaChallengeRow | undefined> {
  return trx
    .selectFrom('mfa_challenge')
    .select([
      'id',
      'user_id',
      'login_session_id',
      'purpose',
      'state',
      'attempt_count',
      'expires_at',
    ])
    .where('id', '=', challengeId)
    .forUpdate()
    .executeTakeFirst();
}

/** pending → passed with the expiry re-checked IN the statement; the CAS
 *  admits exactly one winner under concurrent replay. */
export async function passChallenge(trx: Trx, challengeId: string): Promise<boolean> {
  const result = await trx
    .updateTable('mfa_challenge')
    .set({ state: 'passed', passed_at: new Date() })
    .where('id', '=', challengeId)
    .where('state', '=', 'pending')
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function failChallenge(trx: Trx, challengeId: string): Promise<boolean> {
  const result = await trx
    .updateTable('mfa_challenge')
    .set({ state: 'failed' })
    .where('id', '=', challengeId)
    .where('state', '=', 'pending')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function expireChallenge(trx: Trx, challengeId: string): Promise<boolean> {
  const result = await trx
    .updateTable('mfa_challenge')
    .set({ state: 'expired' })
    .where('id', '=', challengeId)
    .where('state', '=', 'pending')
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** Monotonic attempt bump while pending; undefined when not pending. */
export async function bumpChallengeAttempt(
  trx: Trx,
  challengeId: string,
): Promise<number | undefined> {
  const rows = await trx
    .updateTable('mfa_challenge')
    .set((eb) => ({ attempt_count: eb('attempt_count', '+', 1) }))
    .where('id', '=', challengeId)
    .where('state', '=', 'pending')
    .returning('attempt_count')
    .execute();
  return rows[0]?.attempt_count;
}

/** granted_at and expires_at come from ONE caller clock so the assurance
 *  window is exactly the configured max-age (docs/26 §14.C). */
export async function insertStepUpGrant(
  trx: Trx,
  input: {
    userId: string;
    sessionId: string;
    method: 'totp' | 'recovery_code' | 'password' | 'oidc';
    grantedAt: Date;
    expiresAt: Date;
  },
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('step_up_grant')
    .values({
      id,
      user_id: input.userId,
      login_session_id: input.sessionId,
      method: input.method,
      granted_at: input.grantedAt,
      expires_at: input.expiresAt,
    })
    .execute();
  return id;
}

export async function findLiveGrant(
  trx: Trx,
  input: { userId: string; sessionId: string },
): Promise<{ id: string } | undefined> {
  return trx
    .selectFrom('step_up_grant')
    .select(['id'])
    .where('user_id', '=', input.userId)
    .where('login_session_id', '=', input.sessionId)
    .where('expires_at', '>', new Date())
    .where('invalidated_at', 'is', null)
    .orderBy('expires_at', 'desc')
    .limit(1)
    .executeTakeFirst();
}
