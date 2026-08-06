/**
 * Deterministic identity fixtures for schema tests (B2-1). Test-only —
 * distinct from the production bootstrap path by construction (docs/26 §7.5).
 */
import type { Kysely } from 'kysely';

import { newId } from '../../src/db/ids';
import type { DB } from '../../src/db/kysely';

export const TEST_ISSUER = 'https://cognito.test/pool-fixture';

export async function createUser(db: Kysely<DB>): Promise<string> {
  const id = newId();
  await db.insertInto('app_user').values({ id }).execute();
  return id;
}

export interface IdentityOptions {
  provider?: 'apple' | 'google' | 'email';
  issuer?: string;
  subject?: string;
  email?: string;
  emailVerified?: boolean;
  isPrivateRelay?: boolean;
}

export async function createIdentity(
  db: Kysely<DB>,
  userId: string,
  options: IdentityOptions = {},
): Promise<{ id: string; issuer: string; subject: string }> {
  const id = newId();
  const issuer = options.issuer ?? TEST_ISSUER;
  const subject = options.subject ?? `sub-${newId()}`;
  await db
    .insertInto('auth_identity')
    .values({
      id,
      user_id: userId,
      provider: options.provider ?? 'email',
      issuer,
      subject,
      email: options.email ?? null,
      email_verified: options.emailVerified ?? false,
      is_private_relay: options.isPrivateRelay ?? false,
    })
    .execute();
  return { id, issuer, subject };
}

export async function createAccount(db: Kysely<DB>, userId: string): Promise<string> {
  const id = newId();
  await db
    .insertInto('customer_account')
    .values({ id, user_id: userId, display_name: 'Test Customer' })
    .execute();
  return id;
}

export async function createSelfParticipant(
  db: Kysely<DB>,
  accountId: string,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('participant')
    .values({ id, account_id: accountId, kind: 'self', first_name: 'Me' })
    .execute();
  return id;
}

export async function createSession(
  db: Kysely<DB>,
  userId: string,
  identity: { issuer: string; subject: string },
  originJti: string = `jti-${newId()}`,
): Promise<{ id: string; originJti: string }> {
  const id = newId();
  await db
    .insertInto('login_session')
    .values({
      id,
      user_id: userId,
      principal_kind: 'customer',
      client_kind: 'customer_app',
      provider_issuer: identity.issuer,
      provider_subject: identity.subject,
      origin_jti: originJti,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .execute();
  return { id, originJti };
}
