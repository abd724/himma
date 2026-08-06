/**
 * Identity persistence (docs/26 §8; repository layer of the docs/25 §10
 * boundary). Every function takes the caller's transaction — services own
 * the documented transaction boundaries (docs/26 §9) and this module owns
 * ALL table access for the identity aggregate. No module above it touches
 * identity tables directly.
 */
import { sql } from 'kysely';

import { newId } from '../../../db/ids';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import type { ProviderEvidence } from '../providers/evidence';

export interface UserRow {
  id: string;
  status: string;
}

export interface IdentityRow {
  id: string;
  user_id: string;
  status: string;
  version: number;
}

export interface AccountRow {
  id: string;
  user_id: string;
  status: string;
  display_name: string;
  contact_email: string | null;
}

// -- app_user -----------------------------------------------------------------

export async function insertUser(trx: Trx): Promise<string> {
  const id = newId();
  await trx
    .insertInto('app_user')
    .values({ id, last_login_at: new Date() })
    .execute();
  return id;
}

export async function findUser(trx: Trx, userId: string): Promise<UserRow | undefined> {
  return trx
    .selectFrom('app_user')
    .select(['id', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
}

export async function touchLastLogin(trx: Trx, userId: string): Promise<void> {
  await trx
    .updateTable('app_user')
    .set({ last_login_at: new Date() })
    .where('id', '=', userId)
    .execute();
}

// -- auth_identity ------------------------------------------------------------

export async function findIdentityByIssuerSubject(
  trx: Trx,
  issuer: string,
  subject: string,
): Promise<IdentityRow | undefined> {
  return trx
    .selectFrom('auth_identity')
    .select(['id', 'user_id', 'status', 'version'])
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .executeTakeFirst();
}

/** Owner of an actively verified normalized email, if any (docs/26 §3.5). */
export async function findActiveVerifiedEmailOwner(
  trx: Trx,
  email: string,
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('auth_identity')
    .select(['user_id'])
    .where(sql`lower(email)`, '=', email.toLowerCase())
    .where('email_verified', '=', true)
    .where('status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
  return row?.user_id;
}

/**
 * Provider identifiers of one active identity of the user — the reference
 * used for user-scoped provider revocation follow-up (post-commit, so this
 * accepts a plain Db as well as a transaction).
 */
export async function findActiveIdentityProviderRef(
  db: Db | Trx,
  userId: string,
): Promise<{ issuer: string; subject: string } | undefined> {
  return db
    .selectFrom('auth_identity')
    .select(['issuer', 'subject'])
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .limit(1)
    .executeTakeFirst();
}

export async function insertIdentity(
  trx: Trx,
  userId: string,
  evidence: ProviderEvidence,
): Promise<string> {
  const id = newId();
  await trx
    .insertInto('auth_identity')
    .values({
      id,
      user_id: userId,
      provider: evidence.provider,
      issuer: evidence.issuer,
      subject: evidence.subject,
      email: evidence.email ?? null,
      email_verified: evidence.emailVerified,
      is_private_relay: evidence.isPrivateRelay,
    })
    .execute();
  return id;
}

/** Reactivates a previously ended identity of the SAME user (docs/26 §3.6). */
export async function reactivateIdentity(
  trx: Trx,
  identityId: string,
  evidence: ProviderEvidence,
): Promise<void> {
  await trx
    .updateTable('auth_identity')
    .set({
      status: 'active',
      email: evidence.email ?? null,
      email_verified: evidence.emailVerified,
      is_private_relay: evidence.isPrivateRelay,
    })
    .where('id', '=', identityId)
    .execute();
}

/**
 * Locks and returns every ACTIVE identity of the user (FOR UPDATE) — the
 * docs/26 §9.3 row-locked usable-method count that keeps concurrent unlinks
 * from stranding a user with no login method.
 */
export async function listActiveIdentitiesForUpdate(
  trx: Trx,
  userId: string,
): Promise<IdentityRow[]> {
  return trx
    .selectFrom('auth_identity')
    .select(['id', 'user_id', 'status', 'version'])
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .forUpdate()
    .execute();
}

/** CAS active→ended; false when the version is stale (docs/24 §11 staleVersion). */
export async function endIdentityCas(
  trx: Trx,
  identityId: string,
  expectedVersion: number,
): Promise<boolean> {
  const result = await trx
    .updateTable('auth_identity')
    .set({ status: 'ended' })
    .where('id', '=', identityId)
    .where('status', '=', 'active')
    .where('version', '=', expectedVersion)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

// -- customer_account + self participant --------------------------------------

export async function findAccountByUser(
  trx: Trx,
  userId: string,
): Promise<AccountRow | undefined> {
  return trx
    .selectFrom('customer_account')
    .select(['id', 'user_id', 'status', 'display_name', 'contact_email'])
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

export interface NewAccount {
  userId: string;
  displayName: string;
  contactEmail?: string;
}

/**
 * Creates the customer account WITH its single adult self participant `Me`
 * (docs/24 §1.2) — the two are never created separately.
 */
export async function insertAccountWithSelfParticipant(
  trx: Trx,
  account: NewAccount,
): Promise<{ accountId: string; participantId: string }> {
  const accountId = newId();
  await trx
    .insertInto('customer_account')
    .values({
      id: accountId,
      user_id: account.userId,
      display_name: account.displayName,
      contact_email: account.contactEmail ?? null,
    })
    .execute();
  const participantId = newId();
  await trx
    .insertInto('participant')
    .values({ id: participantId, account_id: accountId, kind: 'self', first_name: 'Me' })
    .execute();
  return { accountId, participantId };
}

/** The account's single self participant (docs/24 §1.2). */
export async function findSelfParticipant(
  trx: Trx,
  accountId: string,
): Promise<{ id: string; first_name: string } | undefined> {
  return trx
    .selectFrom('participant')
    .select(['id', 'first_name'])
    .where('account_id', '=', accountId)
    .where('kind', '=', 'self')
    .executeTakeFirst();
}

/** Active email-provider identity for an address — enumeration-safe flows
 *  branch on this internally and never reveal the result. */
export async function findActiveEmailIdentity(
  trx: Trx,
  email: string,
): Promise<{ id: string; user_id: string } | undefined> {
  return trx
    .selectFrom('auth_identity')
    .select(['id', 'user_id'])
    .where('provider', '=', 'email')
    .where('status', '=', 'active')
    .where(sql`lower(email)`, '=', email.toLowerCase())
    .limit(1)
    .executeTakeFirst();
}

// -- auth_challenge -----------------------------------------------------------

export interface NewChallenge {
  kind: 'email_verification' | 'password_reset';
  identityId: string;
  userId?: string;
  expiresAt?: Date;
}

export async function insertChallenge(trx: Trx, challenge: NewChallenge): Promise<string> {
  const id = newId();
  await trx
    .insertInto('auth_challenge')
    .values({
      id,
      kind: challenge.kind,
      auth_identity_id: challenge.identityId,
      user_id: challenge.userId ?? null,
      expires_at: challenge.expiresAt ?? null,
    })
    .execute();
  return id;
}

/** Increments the attempt counter while the challenge is still open. */
export async function incrementChallengeAttempt(
  trx: Trx,
  challengeId: string,
): Promise<number | undefined> {
  const row = await trx
    .updateTable('auth_challenge')
    .set((eb) => ({ attempt_count: eb('attempt_count', '+', 1) }))
    .where('id', '=', challengeId)
    .where('completed_at', 'is', null)
    .where((eb) =>
      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]),
    )
    .returning('attempt_count')
    .executeTakeFirst();
  return row?.attempt_count;
}

/** CAS single-use completion (docs/26 §8.6); false when already spent/expired. */
export async function completeChallengeCas(trx: Trx, challengeId: string): Promise<boolean> {
  const result = await trx
    .updateTable('auth_challenge')
    .set({ completed_at: new Date() })
    .where('id', '=', challengeId)
    .where('completed_at', 'is', null)
    .where((eb) =>
      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]),
    )
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
