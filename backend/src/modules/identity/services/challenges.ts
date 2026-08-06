/**
 * Challenge bookkeeping (docs/26 §8.6, Amendment A1.1).
 *
 * Code/token generation and validation are the provider's; Himma records
 * only the bookkeeping needed for rate-limit anchoring, enumeration-safe
 * sequencing, and audit. No secret, code, or token material exists in any
 * row, audit payload, or log — structurally, there is nowhere to put one.
 * Route wiring (enumeration-safe responses, mail flows) is B2-4.
 */
import { appendAuditEvent } from '../../../db/audit';
import { withTransaction } from '../../../db/transaction';
import {
  completeChallengeCas,
  incrementChallengeAttempt,
  insertChallenge,
  type NewChallenge,
} from '../persistence/identity-repository';
import type { IdentityServiceDeps } from './account-status';

export type ChallengeAttemptResult =
  | { kind: 'recorded'; attemptCount: number }
  | { kind: 'challengeInvalid' };

export type ChallengeCompletionResult = { kind: 'completed' } | { kind: 'challengeInvalid' };

export async function recordChallengeRequested(
  deps: IdentityServiceDeps,
  challenge: NewChallenge,
): Promise<{ challengeId: string }> {
  return withTransaction(deps.db, async (trx) => {
    const challengeId = await insertChallenge(trx, challenge);
    await appendAuditEvent(trx, {
      actorType: challenge.userId !== undefined ? 'user' : 'system',
      ...(challenge.userId !== undefined ? { actorId: challenge.userId } : {}),
      action: 'auth.challenge_requested',
      entityType: 'auth_challenge',
      entityId: challengeId,
    });
    return { challengeId };
  });
}

export async function recordChallengeAttempt(
  deps: IdentityServiceDeps,
  challengeId: string,
): Promise<ChallengeAttemptResult> {
  return withTransaction(deps.db, async (trx) => {
    const attemptCount = await incrementChallengeAttempt(trx, challengeId);
    if (attemptCount === undefined) return { kind: 'challengeInvalid' };
    return { kind: 'recorded', attemptCount };
  });
}

export async function recordChallengeCompleted(
  deps: IdentityServiceDeps,
  challengeId: string,
): Promise<ChallengeCompletionResult> {
  return withTransaction(deps.db, async (trx) => {
    const completed = await completeChallengeCas(trx, challengeId);
    if (!completed) return { kind: 'challengeInvalid' };
    await appendAuditEvent(trx, {
      actorType: 'system',
      action: 'auth.challenge_completed',
      entityType: 'auth_challenge',
      entityId: challengeId,
    });
    return { kind: 'completed' };
  });
}
