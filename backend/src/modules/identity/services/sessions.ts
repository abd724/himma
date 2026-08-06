/**
 * Login-session establishment and inventory (docs/26 §4.4, §9.1 session
 * leg) — B2-3.
 *
 * A Himma `login_session` is the session-of-record for one provider session
 * (issuer + subject + origin_jti). It is created only after access-token
 * evidence was verified OUTSIDE any transaction (docs/25 §4) and the
 * identity, user, and account are active. One provider session maps to at
 * most one Himma session EVER: repeated establishment converges on the live
 * row, and a revoked row permanently retires its origin_jti — logout cannot
 * be undone by re-presenting an old token (a fresh provider login carries a
 * fresh origin_jti). Only normalized metadata is stored; never tokens.
 */
import { createHash } from 'node:crypto';

import { appendAuditEvent } from '../../../db/audit';
import { isDbError } from '../../../db/errors';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { findIdentityByIssuerSubject, findUser, findAccountByUser } from '../persistence/identity-repository';
import {
  findSessionsByOriginJti,
  insertSession,
  listLiveSessionsByUser,
  touchSessionLastSeen,
  type ClientKind,
  type SessionRow,
} from '../persistence/session-repository';
import {
  validateAccessTokenEvidence,
  type AccessTokenEvidence,
} from '../providers/access-token';
import { classifyAccountState, type IdentityServiceDeps } from './account-status';

export type EstablishSessionResult =
  | {
      kind: 'sessionEstablished';
      sessionId: string;
      userId: string;
      identityId: string;
      accountId?: string;
      created: boolean;
    }
  | { kind: 'identityNotFound' }
  | { kind: 'identityEnded' }
  | { kind: 'sessionRevoked' }
  | { kind: 'accountLocked' }
  | { kind: 'accountDeleted' }
  | { kind: 'accountSuspended' }
  | { kind: 'invalidAccessToken' };

export interface SessionClientMetadata {
  clientKind?: ClientKind;
  deviceLabel?: string;
  /** Raw request address — digested before persistence, never stored raw. */
  ipAddress?: string;
}

/** IP minimization (docs/26 §8.4): a one-way digest, never the raw address. */
export function digestIp(ipAddress: string): string {
  return createHash('sha256').update(ipAddress).digest('hex');
}

interface ResolvedPrincipalRows {
  identityId: string;
  userId: string;
  accountId?: string;
}

type PrincipalGate =
  | { kind: 'ok'; rows: ResolvedPrincipalRows }
  | {
      kind:
        | 'identityNotFound'
        | 'identityEnded'
        | 'accountLocked'
        | 'accountDeleted'
        | 'accountSuspended';
    };

/** Shared gate: evidence → active identity + active user/account rows. */
export async function resolveActivePrincipal(
  trx: Trx,
  evidence: AccessTokenEvidence,
): Promise<PrincipalGate> {
  const identity = await findIdentityByIssuerSubject(trx, evidence.issuer, evidence.subject);
  if (identity === undefined) return { kind: 'identityNotFound' };
  if (identity.status !== 'active') return { kind: 'identityEnded' };
  const user = await findUser(trx, identity.user_id);
  const account = user === undefined ? undefined : await findAccountByUser(trx, user.id);
  const state = classifyAccountState(user?.status, account);
  if (state.kind !== 'active') return { kind: state.kind };
  return {
    kind: 'ok',
    rows: {
      identityId: identity.id,
      userId: identity.user_id,
      ...(state.accountId !== undefined ? { accountId: state.accountId } : {}),
    },
  };
}

async function attemptEstablish(
  trx: Trx,
  evidence: AccessTokenEvidence,
  client: SessionClientMetadata,
): Promise<EstablishSessionResult> {
  const gate = await resolveActivePrincipal(trx, evidence);
  if (gate.kind !== 'ok') return { kind: gate.kind };
  const { identityId, userId, accountId } = gate.rows;

  const existing = await findSessionsByOriginJti(trx, evidence.originJti);
  const foreign = existing.some(
    (row) => row.user_id !== userId || row.provider_subject !== evidence.subject,
  );
  // A provider session identifier recorded for a different principal means
  // the presented evidence cannot be trusted — refuse without detail.
  if (foreign) return { kind: 'invalidAccessToken' };
  const live = existing.find((row) => row.revoked_at === null);
  if (live !== undefined) {
    await touchSessionLastSeen(trx, live.id);
    return {
      kind: 'sessionEstablished',
      sessionId: live.id,
      userId,
      identityId,
      ...(accountId !== undefined ? { accountId } : {}),
      created: false,
    };
  }
  // A revoked row permanently retires this origin_jti: logout is final for
  // that provider session; a new provider login carries a new origin_jti.
  if (existing.length > 0) return { kind: 'sessionRevoked' };

  const sessionId = await insertSession(trx, {
    userId,
    principalKind: 'customer',
    clientKind: client.clientKind ?? 'customer_app',
    issuer: evidence.issuer,
    subject: evidence.subject,
    originJti: evidence.originJti,
    ...(client.deviceLabel !== undefined ? { deviceLabel: client.deviceLabel } : {}),
    ...(client.ipAddress !== undefined ? { ipDigest: digestIp(client.ipAddress) } : {}),
    expiresAt: evidence.expiresAt,
  });
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: userId,
    action: 'auth.session_established',
    entityType: 'login_session',
    entityId: sessionId,
  });
  return {
    kind: 'sessionEstablished',
    sessionId,
    userId,
    identityId,
    ...(accountId !== undefined ? { accountId } : {}),
    created: true,
  };
}

export async function establishSession(
  deps: IdentityServiceDeps,
  input: { evidence: AccessTokenEvidence; client: SessionClientMetadata },
): Promise<EstablishSessionResult> {
  const validation = validateAccessTokenEvidence(input.evidence);
  if (!validation.ok) return { kind: 'invalidAccessToken' };
  const evidence = validation.evidence;

  const run = (): Promise<EstablishSessionResult> =>
    withTransaction(deps.db, (trx) => attemptEstablish(trx, evidence, input.client));

  try {
    return await run();
  } catch (error) {
    // A concurrent identical establishment won the live-origin_jti insert;
    // re-resolving converges on that session. Anything else propagates.
    if (
      isDbError(error, 'uniqueViolation') &&
      error.constraint === 'uq_login_session_origin_jti'
    ) {
      return await run();
    }
    throw error;
  }
}

export interface SessionInventoryEntry {
  sessionId: string;
  clientKind: string;
  deviceLabel: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  /** For CAS mutation of a selected session (stale-version protection). */
  version: number;
}

function toInventoryEntry(row: SessionRow): SessionInventoryEntry {
  return {
    sessionId: row.id,
    clientKind: row.client_kind,
    deviceLabel: row.device_label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    version: row.version,
  };
}

/** The user's own live sessions only (docs/26 §4.4) — never anyone else's. */
export async function listSessions(
  deps: IdentityServiceDeps,
  ctx: { userId: string },
): Promise<SessionInventoryEntry[]> {
  return withTransaction(deps.db, async (trx) => {
    const rows = await listLiveSessionsByUser(trx, ctx.userId);
    return rows.map(toInventoryEntry);
  });
}
