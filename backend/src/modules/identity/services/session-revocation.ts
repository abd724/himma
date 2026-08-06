/**
 * Logout and forced revocation (docs/26 §4.5–4.6, §9.6, §9.8 revocation
 * leg) — B2-3.
 *
 * Local revocation is authoritative: the database transaction revokes the
 * session set with reason and actor, bumps versions (row triggers), and
 * writes audit (+ outbox for set-wide revocation) atomically. Any provider
 * network call happens strictly AFTER commit through the
 * `ProviderSessionRevoker` port; its typed delivery status is returned for
 * later retry processing, and a delivery failure NEVER reactivates the
 * locally revoked session.
 *
 * Race rules (documented + tested):
 * - Concurrent logouts of one session are idempotent — the loser sees the
 *   revoked row (FOR UPDATE) and reports `alreadyRevoked`.
 * - Revoke-all is a point-in-time operation: it revokes every session
 *   committed at its statement snapshot; an establishment committing after
 *   it represents a NEW provider login (fresh origin_jti) and survives —
 *   revoke-all is not a ban on future logins. Re-presenting an OLD token
 *   cannot resurrect anything: a revoked origin_jti is permanently retired
 *   (see sessions.ts).
 */
import { appendAuditEvent } from '../../../db/audit';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { findActiveIdentityProviderRef } from '../persistence/identity-repository';
import {
  findSessionByIdForUpdate,
  revokeAllLiveSessions,
  revokeSessionCas,
  revokeSessionIfLive,
  type SessionRow,
} from '../persistence/session-repository';
import type {
  ProviderRevocationDelivery,
  ProviderRevocationTarget,
  ProviderSessionRevoker,
} from '../providers/revocation';

export interface RevocationDeps {
  db: Db;
  /** Optional post-commit provider follow-up; absent → attempted: false. */
  providerRevoker?: ProviderSessionRevoker;
}

export type ForcedRevocationReason =
  | 'account_locked'
  | 'account_suspended'
  | 'account_deleted'
  | 'security';

export type LogoutSessionResult =
  | { kind: 'loggedOut'; providerRevocation: ProviderRevocationDelivery }
  | { kind: 'alreadyRevoked' }
  | { kind: 'sessionNotFound' }
  | { kind: 'staleVersion' };

export type LogoutAllResult = {
  kind: 'loggedOutAll';
  revokedCount: number;
  providerRevocation: ProviderRevocationDelivery;
};

export type ForcedRevocationResult = {
  kind: 'sessionsRevoked';
  revokedCount: number;
  providerRevocation: ProviderRevocationDelivery;
};

/**
 * Post-commit provider follow-up. Never throws; never carries the outcome
 * back into session state. Failures are audit-evented (ids only) so retry
 * processing can find them.
 */
async function revokeAtProvider(
  deps: RevocationDeps,
  target: ProviderRevocationTarget,
  auditEntityId: string,
): Promise<ProviderRevocationDelivery> {
  if (deps.providerRevoker === undefined) return { attempted: false };
  try {
    const outcome = await deps.providerRevoker.revokeProviderSessions(target);
    if (!outcome.delivered) {
      await appendAuditEvent(deps.db, {
        actorType: 'system',
        action: 'auth.provider_revocation_failed',
        entityType: target.scope === 'session' ? 'login_session' : 'app_user',
        entityId: auditEntityId,
      });
    }
    return { attempted: true, ...outcome };
  } catch {
    await appendAuditEvent(deps.db, {
      actorType: 'system',
      action: 'auth.provider_revocation_failed',
      entityType: target.scope === 'session' ? 'login_session' : 'app_user',
      entityId: auditEntityId,
    });
    return { attempted: true, delivered: false, reason: 'providerUnavailable' };
  }
}

async function auditSessionRevocation(
  trx: Trx,
  sessionId: string,
  actorId: string | undefined,
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: actorId !== undefined ? 'user' : 'system',
    ...(actorId !== undefined ? { actorId } : {}),
    action: 'auth.session_revoked',
    entityType: 'login_session',
    entityId: sessionId,
  });
}

/**
 * Current-device or selected owned-device logout. `expectedVersion` is
 * supplied for inventory-selected sessions (stale-mutation protection);
 * current-device logout omits it. Ownership is enforced: another user's
 * session is not-found-shaped.
 */
export async function logoutSession(
  deps: RevocationDeps,
  ctx: { userId: string },
  input: { sessionId: string; expectedVersion?: number; ephemeralToken?: string },
): Promise<LogoutSessionResult> {
  const outcome = await withTransaction(deps.db, async (trx) => {
    const row = await findSessionByIdForUpdate(trx, input.sessionId);
    if (row === undefined || row.user_id !== ctx.userId) {
      return { kind: 'sessionNotFound' as const };
    }
    if (row.revoked_at !== null) return { kind: 'alreadyRevoked' as const };
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      return { kind: 'staleVersion' as const };
    }
    const revoked =
      input.expectedVersion !== undefined
        ? await revokeSessionCas(trx, row.id, input.expectedVersion, 'logout')
        : await revokeSessionIfLive(trx, row.id, 'logout');
    if (!revoked) return { kind: 'staleVersion' as const };
    await auditSessionRevocation(trx, row.id, ctx.userId);
    return { kind: 'loggedOut' as const, row };
  });

  if (outcome.kind !== 'loggedOut') return outcome;
  const row: SessionRow = outcome.row;
  const providerRevocation = await revokeAtProvider(
    deps,
    {
      scope: 'session',
      issuer: row.provider_issuer,
      subject: row.provider_subject,
      originJti: row.origin_jti,
      ...(input.ephemeralToken !== undefined ? { ephemeralToken: input.ephemeralToken } : {}),
    },
    row.id,
  );
  return { kind: 'loggedOut', providerRevocation };
}

/** All-device logout for the authenticated user (docs/26 §9.6). */
export async function logoutAllSessions(
  deps: RevocationDeps,
  ctx: { userId: string },
): Promise<LogoutAllResult> {
  const revoked = await withTransaction(deps.db, async (trx) => {
    const sessionIds = await revokeAllLiveSessions(trx, ctx.userId, 'logout_all');
    for (const sessionId of sessionIds) {
      await auditSessionRevocation(trx, sessionId, ctx.userId);
    }
    if (sessionIds.length > 0) {
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: ctx.userId,
        eventType: 'session.revoked_all',
        payload: {},
      });
    }
    return sessionIds;
  });

  const providerRevocation =
    revoked.length > 0
      ? await revokeAtProvider(
          deps,
          { scope: 'allSessions', ...(await targetFor(deps.db, ctx.userId)) },
          ctx.userId,
        )
      : ({ attempted: false } as ProviderRevocationDelivery);
  return { kind: 'loggedOutAll', revokedCount: revoked.length, providerRevocation };
}

/** Provider identifiers for user-scoped revocation (latest identity). */
async function targetFor(
  db: Db,
  userId: string,
): Promise<{ issuer: string; subject: string }> {
  const row = await findActiveIdentityProviderRef(db, userId);
  return { issuer: row?.issuer ?? '', subject: row?.subject ?? '' };
}

/**
 * Forced local revocation for account lock/suspension/deletion or a
 * security response (docs/26 §9.8 revocation leg). Composable: account
 * status flows call this in their own transaction sequence later; alone it
 * guarantees immediate liveness denial for every session of the user.
 */
export async function forceRevokeUserSessions(
  deps: RevocationDeps,
  input: { userId: string; reason: ForcedRevocationReason; actorId?: string },
): Promise<ForcedRevocationResult> {
  const revoked = await withTransaction(deps.db, async (trx) => {
    const sessionIds = await revokeAllLiveSessions(trx, input.userId, input.reason);
    for (const sessionId of sessionIds) {
      await auditSessionRevocation(trx, sessionId, input.actorId);
    }
    if (sessionIds.length > 0) {
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: input.userId,
        eventType: 'session.revoked_all',
        payload: {},
      });
    }
    return sessionIds;
  });

  const providerRevocation =
    revoked.length > 0
      ? await revokeAtProvider(
          deps,
          { scope: 'allSessions', ...(await targetFor(deps.db, input.userId)) },
          input.userId,
        )
      : ({ attempted: false } as ProviderRevocationDelivery);
  return { kind: 'sessionsRevoked', revokedCount: revoked.length, providerRevocation };
}
