/**
 * Account-state checks (docs/26 §3.8). Himma PostgreSQL is the only
 * authority for account state — provider-side (Cognito) enable/disable state
 * is never consulted for a Himma business decision.
 */
import type { Db } from '../../../db/kysely';
import { withTransaction } from '../../../db/transaction';
import { findAccountByUser, findUser } from '../persistence/identity-repository';

export type AccountStateKind =
  | 'active'
  | 'accountLocked'
  | 'accountDeleted'
  | 'accountSuspended';

export interface AccountState {
  kind: AccountStateKind;
  accountId?: string;
}

export interface IdentityServiceDeps {
  db: Db;
}

/**
 * Pure classification shared by every identity service: user status first
 * (security state), then customer-account business state.
 */
export function classifyAccountState(
  userStatus: string | undefined,
  account: { id: string; status: string } | undefined,
): AccountState {
  // Unknown users are deleted-shaped: existence is never confirmed (docs/26 §11.2).
  if (userStatus === undefined || userStatus === 'deleted') return { kind: 'accountDeleted' };
  if (userStatus === 'locked') return { kind: 'accountLocked' };
  if (account === undefined) return { kind: 'active' };
  if (account.status === 'suspended') return { kind: 'accountSuspended', accountId: account.id };
  if (account.status === 'anonymized') return { kind: 'accountDeleted' };
  return { kind: 'active', accountId: account.id };
}

export async function readAccountState(
  deps: IdentityServiceDeps,
  userId: string,
): Promise<AccountState> {
  return withTransaction(deps.db, async (trx) => {
    const user = await findUser(trx, userId);
    const account = user === undefined ? undefined : await findAccountByUser(trx, user.id);
    return classifyAccountState(user?.status, account);
  });
}
