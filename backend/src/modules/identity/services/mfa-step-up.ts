/**
 * TOTP step-up (docs/26 §3.10, §6) — B2-6B.
 *
 * Provider verification (Cognito) happens strictly OUTSIDE PostgreSQL
 * transactions; only a successful verification transactionally passes the
 * B2-6A challenge and creates ONE session-bound `step_up_grant`. Provider
 * verification alone grants no business permission — it produces Himma
 * step-up assurance, which additionally requires a LIVE session at every
 * resolution (a revoked/expired session makes every grant useless).
 *
 * Challenge handling enforces the B2-6A machine: user/session binding,
 * pending-only, expiry, monotonic attempts with a configured cap and the
 * normalized `tooManyAttempts` outcome, and single-use passing (the CAS
 * admits exactly one winner under concurrent replay).
 */
import { appendAuditEvent } from '../../../db/audit';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import {
  bumpChallengeAttempt,
  expireChallenge,
  failChallenge,
  findActiveMethodForUpdate,
  findChallengeForUpdate,
  findLiveGrant,
  insertStepUpChallenge,
  insertStepUpGrant,
  passChallenge,
} from '../persistence/mfa-repository';
import { findSessionById, type SessionRow } from '../persistence/session-repository';
import type { Trx } from '../../../db/transaction';
import type { MfaServiceDeps } from './mfa-enrollment';

function isLive(row: SessionRow | undefined, userId: string): row is SessionRow {
  return (
    row !== undefined &&
    row.user_id === userId &&
    row.revoked_at === null &&
    row.expires_at.getTime() > Date.now()
  );
}

export type BeginStepUpChallengeResult =
  | { kind: 'challengeStarted'; challengeId: string; expiresAt: Date }
  | { kind: 'sessionNotLive' }
  | { kind: 'notEligible' };

export async function beginStepUpChallenge(
  deps: MfaServiceDeps,
  input: { userId: string; sessionId: string },
): Promise<BeginStepUpChallengeResult> {
  return withTransaction(deps.db, async (trx) => {
    const session = await findSessionById(trx, input.sessionId);
    if (!isLive(session, input.userId)) return { kind: 'sessionNotLive' as const };
    if ((await findActiveMethodForUpdate(trx, input.userId)) === undefined) {
      return { kind: 'notEligible' as const };
    }
    const expiresAt = new Date(Date.now() + deps.mfaConfig.challengeTtlSeconds * 1000);
    const challengeId = await insertStepUpChallenge(trx, {
      userId: input.userId,
      sessionId: input.sessionId,
      expiresAt,
    });
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: input.userId,
      action: 'auth.mfa_challenge_requested',
      entityType: 'mfa_challenge',
      entityId: challengeId,
    });
    return { kind: 'challengeStarted' as const, challengeId, expiresAt };
  });
}

export type CompleteStepUpResult =
  | { kind: 'stepUpCompleted'; grantId: string; expiresAt: Date }
  | { kind: 'challengeInvalid' }
  | { kind: 'challengeExpired' }
  | { kind: 'tooManyAttempts' }
  | { kind: 'invalidCode' }
  | { kind: 'sessionNotLive' }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

async function auditChallenge(
  trx: Trx,
  userId: string,
  action: string,
  challengeId: string,
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: userId,
    action,
    entityType: 'mfa_challenge',
    entityId: challengeId,
  });
}

export async function completeStepUpWithTotp(
  deps: MfaServiceDeps,
  input: {
    userId: string;
    sessionId: string;
    challengeId: string;
    code: string;
    providerAccessToken: string;
  },
): Promise<CompleteStepUpResult> {
  // 1. Bookkeeping pre-check (its own transaction): binding, state, expiry,
  //    and the attempt cap — finalizing the challenge where required.
  const cap = deps.mfaConfig.challengeAttemptCap;
  const pre = await withTransaction(deps.db, async (trx) => {
    const challenge = await findChallengeForUpdate(trx, input.challengeId);
    if (
      challenge === undefined ||
      challenge.user_id !== input.userId ||
      challenge.login_session_id !== input.sessionId ||
      challenge.purpose !== 'step_up' ||
      challenge.state !== 'pending'
    ) {
      return { kind: 'challengeInvalid' as const };
    }
    if (challenge.expires_at.getTime() <= Date.now()) {
      await expireChallenge(trx, challenge.id);
      await auditChallenge(trx, input.userId, 'auth.mfa_challenge_expired', challenge.id);
      return { kind: 'challengeExpired' as const };
    }
    if (challenge.attempt_count >= cap) {
      await failChallenge(trx, challenge.id);
      await auditChallenge(trx, input.userId, 'auth.mfa_challenge_failed', challenge.id);
      return { kind: 'tooManyAttempts' as const };
    }
    const session = await findSessionById(trx, input.sessionId);
    if (!isLive(session, input.userId)) return { kind: 'sessionNotLive' as const };
    return { kind: 'ok' as const };
  });
  if (pre.kind !== 'ok') return pre;

  // 2. Provider verification — outside any transaction; the code and token
  //    stay ephemeral and are never written anywhere.
  const verified = await deps.mfaProvider.verifyTotpChallenge({
    providerAccessToken: input.providerAccessToken,
    code: input.code,
  });

  // 3. Failure: monotonic attempt accounting; the cap finalizes the
  //    challenge with the normalized too-many-attempts outcome.
  if (verified.kind !== 'verificationSucceeded') {
    if (verified.kind === 'providerUnavailable' || verified.kind === 'invalidProviderState') {
      return { kind: verified.kind };
    }
    return withTransaction(deps.db, async (trx) => {
      const attempts = await bumpChallengeAttempt(trx, input.challengeId);
      await auditChallenge(trx, input.userId, 'auth.mfa_challenge_failed', input.challengeId);
      if (attempts !== undefined && attempts >= cap) {
        await failChallenge(trx, input.challengeId);
        return { kind: 'tooManyAttempts' as const };
      }
      return { kind: verified.kind };
    });
  }

  // 4. Success: one transaction — pass the challenge (single-use CAS; one
  //    winner under concurrent replay), then create the session-bound grant.
  return withTransaction(deps.db, async (trx) => {
    const session = await findSessionById(trx, input.sessionId);
    if (!isLive(session, input.userId)) return { kind: 'sessionNotLive' as const };
    if (!(await passChallenge(trx, input.challengeId))) {
      return { kind: 'challengeInvalid' as const };
    }
    const grantedAt = new Date();
    const expiresAt = new Date(grantedAt.getTime() + deps.mfaConfig.stepUpTtlSeconds * 1000);
    const grantId = await insertStepUpGrant(trx, {
      userId: input.userId,
      sessionId: input.sessionId,
      method: 'totp',
      grantedAt,
      expiresAt,
    });
    await auditChallenge(trx, input.userId, 'auth.mfa_challenge_passed', input.challengeId);
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: input.userId,
      action: 'auth.step_up_completed',
      entityType: 'step_up_grant',
      entityId: grantId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'app_user',
      aggregateId: input.userId,
      eventType: 'mfa.step_up_completed',
      payload: { grantId, challengeId: input.challengeId, sessionId: input.sessionId, method: 'totp' },
    });
    return { kind: 'stepUpCompleted' as const, grantId, expiresAt };
  });
}

/**
 * Session-assurance resolution for B2-6C principal building: TRUE only for
 * a LIVE session with an unexpired, uninvalidated grant. A database row
 * alone can never produce assurance for a dead session.
 */
export async function resolveStepUpAssurance(
  deps: MfaServiceDeps,
  input: { userId: string; sessionId: string },
): Promise<{ assured: boolean; grantId?: string }> {
  return withTransaction(deps.db, async (trx) => {
    const session = await findSessionById(trx, input.sessionId);
    if (!isLive(session, input.userId)) return { assured: false };
    const grant = await findLiveGrant(trx, { userId: input.userId, sessionId: input.sessionId });
    if (grant === undefined) return { assured: false };
    return { assured: true, grantId: grant.id };
  });
}
