/**
 * Himma-managed recovery codes (docs/26 §5.9, §8.8 ★, §14.C) — B2-6B.
 *
 * Codes are generated in memory from Node's CSPRNG and returned to the
 * caller EXACTLY ONCE; PostgreSQL receives only HMAC-SHA-256 digests under
 * the configured pepper version (B2-6A batch metadata). No operation exists
 * anywhere that can return an original code again — the digest is one-way
 * and the pepper never leaves configuration.
 *
 * Verification failures collapse into ONE normalized outcome: a wrong code,
 * an already-consumed code, an unknown digest, and a superseded batch are
 * indistinguishable to the caller (docs/26 §11.2 enumeration posture).
 */
import { createHmac, randomInt } from 'node:crypto';

import { appendAuditEvent } from '../../../db/audit';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { findUser } from '../persistence/identity-repository';
import {
  consumeRecoveryCodeByDigest,
  findActiveBatch,
  findActiveMethodForUpdate,
  insertRecoveryBatch,
  insertRecoveryCodeDigests,
  insertStepUpGrant,
  supersedeBatch,
} from '../persistence/mfa-repository';
import { findSessionById, type SessionRow } from '../persistence/session-repository';
import { MfaConfigError } from './mfa-config';
import type { MfaServiceDeps } from './mfa-enrollment';

/** 30 unambiguous symbols (no 0/1/i/l/o/u); 28 symbols ≈ 137 bits ≥ 128. */
const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const RECOVERY_CODE_SYMBOLS = 28;
const RECOVERY_CODE_GROUP = 4;

/** Lenient entry: case and separators never matter, entropy is untouched. */
export function normalizeRecoveryCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function digestRecoveryCode(pepper: string, rawCode: string): string {
  return createHmac('sha256', pepper).update(normalizeRecoveryCode(rawCode)).digest('hex');
}

function generateRecoveryCode(): string {
  const symbols: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_SYMBOLS; i += 1) {
    // crypto.randomInt is CSPRNG-backed and rejection-sampled (no bias).
    symbols.push(RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)] as string);
  }
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += RECOVERY_CODE_GROUP) {
    groups.push(symbols.slice(i, i + RECOVERY_CODE_GROUP).join(''));
  }
  return groups.join('-');
}

function activePepper(deps: MfaServiceDeps): { version: number; pepper: string } {
  const version = deps.mfaConfig.activePepperVersion;
  const pepper = deps.mfaConfig.peppers.get(version);
  if (pepper === undefined) {
    throw new MfaConfigError(`No pepper configured for active version ${version}.`);
  }
  return { version, pepper };
}

export type GenerateRecoveryCodesResult =
  | { kind: 'recoveryCodesGenerated'; batchId: string; codes: string[] }
  | { kind: 'notEligible' };

export async function generateRecoveryCodes(
  deps: MfaServiceDeps,
  input: { userId: string },
): Promise<GenerateRecoveryCodesResult> {
  const { version, pepper } = activePepper(deps);

  // Generated before the transaction: pure in-memory CSPRNG work.
  const codes = new Set<string>();
  while (codes.size < deps.mfaConfig.recoveryCodeCount) codes.add(generateRecoveryCode());
  const rawCodes = [...codes];
  const digests = rawCodes.map((code) => digestRecoveryCode(pepper, code));

  const batchId = await withTransaction(deps.db, async (trx) => {
    const user = await findUser(trx, input.userId);
    if (user === undefined || user.status !== 'active') return undefined;
    if ((await findActiveMethodForUpdate(trx, input.userId)) === undefined) return undefined;

    // Regeneration: superseding the previous batch cascade-invalidates its
    // remaining codes (B2-6A trigger) in this same transaction.
    const previous = await findActiveBatch(trx, input.userId, { forUpdate: true });
    if (previous !== undefined) await supersedeBatch(trx, previous.id);

    const id = await insertRecoveryBatch(trx, {
      userId: input.userId,
      codeCount: deps.mfaConfig.recoveryCodeCount,
      pepperVersion: version,
    });
    await insertRecoveryCodeDigests(trx, { batchId: id, userId: input.userId, digests });
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: input.userId,
      action: 'auth.recovery_codes_generated',
      entityType: 'mfa_recovery_code_batch',
      entityId: id,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'app_user',
      aggregateId: input.userId,
      eventType: 'mfa.recovery_codes_generated',
      payload: {
        batchId: id,
        codeCount: deps.mfaConfig.recoveryCodeCount,
        ...(previous !== undefined ? { supersededBatchId: previous.id } : {}),
      },
    });
    return id;
  });
  if (batchId === undefined) return { kind: 'notEligible' };
  // The ONLY exposure of the raw codes, ever.
  return { kind: 'recoveryCodesGenerated', batchId, codes: rawCodes };
}

export type ConsumeRecoveryCodeResult =
  | {
      kind: 'recoveryCodeAccepted';
      codeId: string;
      stepUpGrantId?: string;
      stepUpGrantExpiresAt?: Date;
    }
  | { kind: 'recoveryCodeRejected' }
  | { kind: 'sessionNotLive' };

function sessionIsLive(row: SessionRow | undefined, userId: string): row is SessionRow {
  return (
    row !== undefined &&
    row.user_id === userId &&
    row.revoked_at === null &&
    row.expires_at.getTime() > Date.now()
  );
}

/**
 * Verifies and consumes one recovery code atomically. With `session`, the
 * approved MFA step-up grant is created in the SAME transaction, bound to
 * that live session (docs/26 §3.10).
 */
export async function consumeRecoveryCode(
  deps: MfaServiceDeps,
  input: { userId: string; code: string; session?: { sessionId: string } },
): Promise<ConsumeRecoveryCodeResult> {
  return withTransaction(deps.db, async (trx) => {
    let session: SessionRow | undefined;
    if (input.session !== undefined) {
      session = await findSessionById(trx, input.session.sessionId);
      if (!sessionIsLive(session, input.userId)) return { kind: 'sessionNotLive' as const };
    }

    const rejected = async () => {
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: input.userId,
        action: 'auth.recovery_code_rejected',
        entityType: 'app_user',
        entityId: input.userId,
      });
      return { kind: 'recoveryCodeRejected' as const };
    };

    const batch = await findActiveBatch(trx, input.userId);
    if (batch === undefined) return rejected();
    const pepper = deps.mfaConfig.peppers.get(batch.pepper_version);
    if (pepper === undefined) {
      // Loud misconfiguration — never a silent "invalid code".
      throw new MfaConfigError(`No pepper configured for batch version ${batch.pepper_version}.`);
    }
    const consumed = await consumeRecoveryCodeByDigest(trx, {
      userId: input.userId,
      batchId: batch.id,
      digest: digestRecoveryCode(pepper, input.code),
    });
    if (consumed === undefined) return rejected();

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: input.userId,
      action: 'auth.recovery_code_used',
      entityType: 'mfa_recovery_code',
      entityId: consumed.id,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'app_user',
      aggregateId: input.userId,
      eventType: 'mfa.recovery_code_used',
      payload: { codeId: consumed.id, batchId: batch.id },
    });

    let stepUpGrantId: string | undefined;
    let stepUpGrantExpiresAt: Date | undefined;
    if (session !== undefined) {
      const grantedAt = new Date();
      stepUpGrantExpiresAt = new Date(
        grantedAt.getTime() + deps.mfaConfig.stepUpTtlSeconds * 1000,
      );
      stepUpGrantId = await insertStepUpGrant(trx, {
        userId: input.userId,
        sessionId: session.id,
        method: 'recovery_code',
        grantedAt,
        expiresAt: stepUpGrantExpiresAt,
      });
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: input.userId,
        action: 'auth.step_up_completed',
        entityType: 'step_up_grant',
        entityId: stepUpGrantId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: input.userId,
        eventType: 'mfa.step_up_completed',
        payload: { grantId: stepUpGrantId, sessionId: session.id, method: 'recovery_code' },
      });
    }
    return {
      kind: 'recoveryCodeAccepted' as const,
      codeId: consumed.id,
      ...(stepUpGrantId !== undefined ? { stepUpGrantId } : {}),
      ...(stepUpGrantExpiresAt !== undefined ? { stepUpGrantExpiresAt } : {}),
    };
  });
}
