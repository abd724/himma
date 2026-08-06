/**
 * Deterministic identity fixtures for schema tests (B2-1). Test-only —
 * distinct from the production bootstrap path by construction (docs/26 §7.5).
 */
import { sql, type Kysely } from 'kysely';

import { newId } from '../../src/db/ids';
import type { DB } from '../../src/db/kysely';
import { withTransaction } from '../../src/db/transaction';

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

/**
 * Test-side equivalent of the docs/26 §9.9 production bootstrap shape: one
 * transaction inserting the bootstrap seal plus exactly two cross-witnessed
 * active access_admin assignments. Runs as the table owner (the elevated
 * path); himma_app cannot write the seal, which is asserted elsewhere.
 */
export async function bootstrapAccessAdmins(
  db: Kysely<DB>,
): Promise<{ adminA: string; adminB: string }> {
  const adminA = await createUser(db);
  const adminB = await createUser(db);
  await withTransaction(db, async (trx) => {
    await sql`INSERT INTO bootstrap_seal (manifest_digest, executed_by)
              VALUES ('test-manifest-digest', 'test-fixture')`.execute(trx);
    await trx
      .insertInto('admin_role_assignment')
      .values([
        {
          id: newId(),
          user_id: adminA,
          role: 'access_admin',
          state: 'active',
          requested_by: adminB,
          approved_by: adminA,
        },
        {
          id: newId(),
          user_id: adminB,
          role: 'access_admin',
          state: 'active',
          requested_by: adminA,
          approved_by: adminB,
        },
      ])
      .execute();
  });
  return { adminA, adminB };
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
