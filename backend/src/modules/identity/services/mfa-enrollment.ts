/**
 * TOTP enrollment services (docs/26 §5.8, §13 B2-6, A1.1) — B2-6B.
 *
 * Cognito is authoritative for the TOTP secret and provider-side enrollment;
 * both provider calls happen strictly OUTSIDE PostgreSQL transactions
 * (docs/25 §4). Himma activates its mirrored `mfa_method` transactionally
 * ONLY after provider verification succeeds; the B2-6A triggers (activation
 * window, single active method, the `app_user.mfa_enrolled` mirror) remain
 * the final authority beneath every write here.
 *
 * Secret boundary: the shared secret exists only inside the ephemeral
 * `TotpEnrollmentMaterial` service result (for the future B2-6C route to
 * render as a QR). Nothing here logs, persists, audits, or embeds it —
 * audit/outbox payloads carry opaque ids only.
 */
import { appendAuditEvent } from '../../../db/audit';
import type { Db } from '../../../db/kysely';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { MfaProviderPort, TotpEnrollmentMaterial } from '../providers/mfa';
import {
  activatePendingMethod,
  findActiveMethodForUpdate,
  findMethodForUpdate,
  findPendingMethodForUpdate,
  insertPendingMethod,
  supersedeMethod,
} from '../persistence/mfa-repository';
import { findUser } from '../persistence/identity-repository';
import type { MfaConfig } from './mfa-config';

export interface MfaServiceDeps {
  db: Db;
  mfaProvider: MfaProviderPort;
  mfaConfig: MfaConfig;
}

export type BeginEnrollmentResult =
  | { kind: 'enrollmentStarted'; methodId: string; material: TotpEnrollmentMaterial }
  | { kind: 'notEligible' }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

export async function beginTotpEnrollment(
  deps: MfaServiceDeps,
  input: { userId: string; providerAccessToken: string },
): Promise<BeginEnrollmentResult> {
  const eligible = await withTransaction(deps.db, async (trx) => {
    const user = await findUser(trx, input.userId);
    return user !== undefined && user.status === 'active';
  });
  if (!eligible) return { kind: 'notEligible' };

  // Provider enrollment start — outside any transaction. Failure creates
  // no Himma state at all.
  const started = await deps.mfaProvider.beginTotpEnrollment({
    providerAccessToken: input.providerAccessToken,
  });
  if (started.kind !== 'enrollmentStarted') return { kind: started.kind };

  const methodId = await withTransaction(deps.db, async (trx) => {
    // Re-beginning replaces any stale pending enrollment (one pending per
    // user is a B2-6A unique); the old provider material becomes useless.
    const stale = await findPendingMethodForUpdate(trx, input.userId);
    if (stale !== undefined) {
      await supersedeMethod(trx, stale.id, 'pending');
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: input.userId,
        action: 'auth.mfa_method_superseded',
        entityType: 'mfa_method',
        entityId: stale.id,
      });
    }
    const id = await insertPendingMethod(trx, {
      userId: input.userId,
      expiresAt: new Date(Date.now() + deps.mfaConfig.enrollmentTtlSeconds * 1000),
    });
    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: input.userId,
      action: 'auth.mfa_enrollment_started',
      entityType: 'mfa_method',
      entityId: id,
    });
    return id;
  });
  return { kind: 'enrollmentStarted', methodId, material: started.material };
}

export type CompleteEnrollmentResult =
  | { kind: 'mfaEnrolled'; methodId: string; supersededMethodId?: string }
  | { kind: 'enrollmentInvalid' }
  | { kind: 'invalidCode' }
  | { kind: 'challengeExpired' }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

/** Aborts the activation transaction so every write in it rolls back. */
class ActivationAborted extends Error {}

export async function completeTotpEnrollment(
  deps: MfaServiceDeps,
  input: {
    userId: string;
    methodId: string;
    code: string;
    providerAccessToken: string;
  },
): Promise<CompleteEnrollmentResult> {
  // One normalized outcome for absent, foreign, non-pending, and expired
  // enrollments — nothing about other users' state is revealed.
  const pendingValid = await withTransaction(deps.db, async (trx) => {
    const row = await findMethodForUpdate(trx, input.methodId);
    return (
      row !== undefined &&
      row.user_id === input.userId &&
      row.state === 'pending' &&
      row.enrollment_expires_at !== null &&
      row.enrollment_expires_at.getTime() > Date.now()
    );
  });
  if (!pendingValid) return { kind: 'enrollmentInvalid' };

  // Provider verification — outside any transaction.
  const verified = await deps.mfaProvider.verifyTotpEnrollment({
    providerAccessToken: input.providerAccessToken,
    code: input.code,
  });
  if (verified.kind !== 'verificationSucceeded') {
    if (verified.kind === 'invalidCode' || verified.kind === 'challengeExpired') {
      await withTransaction(deps.db, async (trx) => {
        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: input.userId,
          action: 'auth.mfa_enrollment_failed',
          entityType: 'mfa_method',
          entityId: input.methodId,
        });
      });
    }
    return { kind: verified.kind };
  }

  // Activation — one transaction, only after provider success. The B2-6A
  // trigger set re-refuses expired activation beneath the CAS.
  try {
    return await withTransaction(deps.db, async (trx) => {
      const row = await findMethodForUpdate(trx, input.methodId);
      if (
        row === undefined ||
        row.user_id !== input.userId ||
        row.state !== 'pending' ||
        row.enrollment_expires_at === null ||
        row.enrollment_expires_at.getTime() <= Date.now()
      ) {
        throw new ActivationAborted();
      }

      // Replacement enrollment: the previous active method is superseded in
      // the same transaction (single-active unique requires this order).
      const active = await findActiveMethodForUpdate(trx, input.userId);
      let supersededMethodId: string | undefined;
      if (active !== undefined) {
        await supersedeMethod(trx, active.id, 'active');
        supersededMethodId = active.id;
        await appendAuditEvent(trx, {
          actorType: 'user',
          actorId: input.userId,
          action: 'auth.mfa_method_superseded',
          entityType: 'mfa_method',
          entityId: active.id,
        });
        await appendOutboxEvent(trx, {
          aggregateType: 'app_user',
          aggregateId: input.userId,
          eventType: 'mfa.method_superseded',
          payload: { methodId: active.id },
        });
      }

      if (!(await activatePendingMethod(trx, row.id))) throw new ActivationAborted();
      // The database maintains app_user.mfa_enrolled (B2-6A mirror trigger).
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: input.userId,
        action: 'auth.mfa_enrolled',
        entityType: 'mfa_method',
        entityId: row.id,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: input.userId,
        eventType: 'mfa.enrolled',
        payload: { methodId: row.id },
      });
      return {
        kind: 'mfaEnrolled' as const,
        methodId: row.id,
        ...(supersededMethodId !== undefined ? { supersededMethodId } : {}),
      };
    });
  } catch (error) {
    if (error instanceof ActivationAborted) return { kind: 'enrollmentInvalid' };
    throw error;
  }
}
