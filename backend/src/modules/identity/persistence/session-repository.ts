/**
 * login_session persistence (docs/26 §4.4, §8.4) — B2-3. All table access
 * for the session aggregate; every function takes the caller's transaction.
 * Rows hold ONLY normalized session metadata: no token material of any kind
 * exists here or anywhere in the schema (structural guard tests).
 */
import { newId } from '../../../db/ids';
import type { Trx } from '../../../db/transaction';

export interface SessionRow {
  id: string;
  user_id: string;
  principal_kind: string;
  client_kind: string;
  provider_issuer: string;
  provider_subject: string;
  origin_jti: string;
  device_label: string | null;
  ip_digest: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  version: number;
}

const SESSION_COLUMNS = [
  'id',
  'user_id',
  'principal_kind',
  'client_kind',
  'provider_issuer',
  'provider_subject',
  'origin_jti',
  'device_label',
  'ip_digest',
  'created_at',
  'last_seen_at',
  'expires_at',
  'revoked_at',
  'revoke_reason',
  'version',
] as const;

export type ClientKind = 'customer_app' | 'admin_portal' | 'provider_portal';

export interface NewSession {
  userId: string;
  principalKind: 'customer';
  clientKind: ClientKind;
  issuer: string;
  subject: string;
  originJti: string;
  deviceLabel?: string;
  ipDigest?: string;
  expiresAt: Date;
}

export async function insertSession(trx: Trx, session: NewSession): Promise<string> {
  const id = newId();
  await trx
    .insertInto('login_session')
    .values({
      id,
      user_id: session.userId,
      principal_kind: session.principalKind,
      client_kind: session.clientKind,
      provider_issuer: session.issuer,
      provider_subject: session.subject,
      origin_jti: session.originJti,
      device_label: session.deviceLabel ?? null,
      ip_digest: session.ipDigest ?? null,
      expires_at: session.expiresAt,
    })
    .execute();
  return id;
}

/**
 * Sessions recorded for a provider session identifier, live first then most
 * recent — liveness distinguishes revoked from never-registered with this.
 */
export async function findSessionsByOriginJti(
  trx: Trx,
  originJti: string,
): Promise<SessionRow[]> {
  return trx
    .selectFrom('login_session')
    .select(SESSION_COLUMNS)
    .where('origin_jti', '=', originJti)
    .orderBy('revoked_at', 'asc')
    .orderBy('created_at', 'desc')
    .execute();
}

export async function findSessionById(
  trx: Trx,
  sessionId: string,
): Promise<SessionRow | undefined> {
  return trx
    .selectFrom('login_session')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .executeTakeFirst();
}

export async function findSessionByIdForUpdate(
  trx: Trx,
  sessionId: string,
): Promise<SessionRow | undefined> {
  return trx
    .selectFrom('login_session')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();
}

export async function listLiveSessionsByUser(trx: Trx, userId: string): Promise<SessionRow[]> {
  return trx
    .selectFrom('login_session')
    .select(SESSION_COLUMNS)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .orderBy('last_seen_at', 'desc')
    .execute();
}

export async function touchSessionLastSeen(trx: Trx, sessionId: string): Promise<void> {
  await trx
    .updateTable('login_session')
    .set({ last_seen_at: new Date() })
    .where('id', '=', sessionId)
    .execute();
}

/** Revokes one still-live session; false when it was already revoked. */
export async function revokeSessionIfLive(
  trx: Trx,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  const result = await trx
    .updateTable('login_session')
    .set({ revoked_at: new Date(), revoke_reason: reason })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** Version-CAS revocation for stale-mutation protection (docs/24 §11). */
export async function revokeSessionCas(
  trx: Trx,
  sessionId: string,
  expectedVersion: number,
  reason: string,
): Promise<boolean> {
  const result = await trx
    .updateTable('login_session')
    .set({ revoked_at: new Date(), revoke_reason: reason })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .where('version', '=', expectedVersion)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/** Revokes every live session of a user; returns the revoked session ids. */
export async function revokeAllLiveSessions(
  trx: Trx,
  userId: string,
  reason: string,
): Promise<string[]> {
  const rows = await trx
    .updateTable('login_session')
    .set({ revoked_at: new Date(), revoke_reason: reason })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}
