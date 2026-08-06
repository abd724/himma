/**
 * Customer principal snapshot for `/me` (docs/26 §10, §12) — B2-4.
 *
 * Only the approved foundation fields: user id, customer account, the self
 * participant, and the (empty, customer) roles list. No security metadata,
 * no lock reasons, no digests, no child legal fields — none exist yet and
 * none would belong here.
 */
import { withTransaction } from '../../../db/transaction';
import {
  findAccountByUser,
  findSelfParticipant,
} from '../persistence/identity-repository';
import type { IdentityServiceDeps } from './account-status';

export interface CustomerProfile {
  user: { id: string };
  account?: { id: string; displayName: string; contactEmail: string | null };
  participants: { id: string; kind: 'self'; firstName: string }[];
  roles: never[];
}

export async function readCustomerProfile(
  deps: IdentityServiceDeps,
  ctx: { userId: string },
): Promise<CustomerProfile> {
  return withTransaction(deps.db, async (trx) => {
    const account = await findAccountByUser(trx, ctx.userId);
    const self =
      account === undefined ? undefined : await findSelfParticipant(trx, account.id);
    return {
      user: { id: ctx.userId },
      ...(account !== undefined
        ? {
            account: {
              id: account.id,
              displayName: account.display_name,
              contactEmail: account.contact_email,
            },
          }
        : {}),
      participants:
        self === undefined
          ? []
          : [{ id: self.id, kind: 'self' as const, firstName: self.first_name }],
      roles: [],
    };
  });
}
