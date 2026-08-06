/**
 * First-login identity resolution (docs/26 §3, §9.1).
 *
 * One transaction: resolve by normalized issuer + subject; return the
 * existing canonical user when linked, otherwise create User + AuthIdentity
 * + CustomerAccount + adult self participant atomically with their audit and
 * outbox events. Email NEVER matches an identity and NEVER merges accounts
 * (docs/26 §3.2, §3.5). The provider token was already validated by an
 * AuthProviderAdapter OUTSIDE any transaction; this service receives only
 * normalized evidence. The docs/26 §9.1 login_session insert is the B2-3
 * seam and is deliberately absent here.
 */
import { isDbError } from '../../../db/errors';
import { appendAuditEvent } from '../../../db/audit';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import {
  findAccountByUser,
  findActiveVerifiedEmailOwner,
  findIdentityByIssuerSubject,
  findUser,
  insertAccountWithSelfParticipant,
  insertIdentity,
  insertUser,
  touchLastLogin,
} from '../persistence/identity-repository';
import { validateProviderEvidence, type ProviderEvidence } from '../providers/evidence';
import { classifyAccountState, type IdentityServiceDeps } from './account-status';

export type FirstLoginResult =
  | { kind: 'identityResolved'; userId: string; identityId: string; accountId: string }
  | {
      kind: 'newCustomerCreated';
      userId: string;
      identityId: string;
      accountId: string;
      participantId: string;
    }
  /** Ended identity presented as a login: routes map this to the docs/26 §10
   *  accountLinkConflict guidance (sign in with an existing method, relink). */
  | { kind: 'identityEnded' }
  | { kind: 'verifiedEmailConflict' }
  | { kind: 'accountLocked' }
  | { kind: 'accountDeleted' }
  | { kind: 'accountSuspended' }
  | { kind: 'invalidProviderEvidence' };

/** Uniqueness races that mean "an identical concurrent request won" — the
 *  retry re-resolves and converges on the winner's canonical records. */
const CONVERGENT_UNIQUE_CONSTRAINTS = [
  'uq_auth_identity_issuer_subject',
  'uq_auth_identity_user_issuer_subject',
  'uq_customer_account_user',
  'uq_participant_one_self',
];
const VERIFIED_EMAIL_OWNER_CONSTRAINT = 'excl_auth_identity_verified_email_owner';

export function classifyIdentityWriteError(
  error: unknown,
): 'convergentRace' | 'verifiedEmailConflict' | 'unexpected' {
  if (isDbError(error, 'uniqueViolation') && error.constraint !== undefined) {
    if (CONVERGENT_UNIQUE_CONSTRAINTS.includes(error.constraint)) return 'convergentRace';
  }
  if (
    isDbError(error, 'exclusionViolation') &&
    error.constraint === VERIFIED_EMAIL_OWNER_CONSTRAINT
  ) {
    return 'verifiedEmailConflict';
  }
  return 'unexpected';
}

/** Provisional account-name default until W1 onboarding provides real names. */
function defaultDisplayName(evidence: ProviderEvidence): string {
  if (evidence.displayName !== undefined) return evidence.displayName;
  const localPart = evidence.email?.split('@')[0];
  return localPart !== undefined && localPart.length > 0 ? localPart : 'Customer';
}

async function createAccountWithEvents(
  trx: Trx,
  userId: string,
  evidence: ProviderEvidence,
): Promise<{ accountId: string; participantId: string }> {
  const created = await insertAccountWithSelfParticipant(trx, {
    userId,
    displayName: defaultDisplayName(evidence),
    ...(evidence.emailVerified && evidence.email !== undefined
      ? { contactEmail: evidence.email }
      : {}),
  });
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: userId,
    action: 'auth.account_created',
    entityType: 'customer_account',
    entityId: created.accountId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'customer_account',
    aggregateId: created.accountId,
    eventType: 'account.created',
    payload: { userId, participantId: created.participantId },
  });
  return created;
}

async function attemptFirstLogin(trx: Trx, evidence: ProviderEvidence): Promise<FirstLoginResult> {
  const identity = await findIdentityByIssuerSubject(trx, evidence.issuer, evidence.subject);

  if (identity !== undefined) {
    if (identity.status !== 'active') return { kind: 'identityEnded' };
    const user = await findUser(trx, identity.user_id);
    const account =
      user === undefined ? undefined : await findAccountByUser(trx, user.id);
    const state = classifyAccountState(user?.status, account);
    if (state.kind !== 'active') return { kind: state.kind };
    // First CUSTOMER sign-in of a user provisioned without a customer
    // account creates it now (docs/26 §1.3: created on first customer
    // sign-in), atomically with its self participant and events.
    const accountId =
      state.accountId ??
      (await createAccountWithEvents(trx, identity.user_id, evidence)).accountId;
    await touchLastLogin(trx, identity.user_id);
    return {
      kind: 'identityResolved',
      userId: identity.user_id,
      identityId: identity.id,
      accountId,
    };
  }

  // New identity. A verified email already actively owned by any existing
  // user is a typed conflict — never a merge (docs/26 §3.5). The database
  // exclusion constraint enforces the same rule under race conditions.
  if (evidence.emailVerified && evidence.email !== undefined) {
    const owner = await findActiveVerifiedEmailOwner(trx, evidence.email);
    if (owner !== undefined) return { kind: 'verifiedEmailConflict' };
  }

  const userId = await insertUser(trx);
  const identityId = await insertIdentity(trx, userId, evidence);
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: userId,
    action: 'auth.user_created',
    entityType: 'app_user',
    entityId: userId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'app_user',
    aggregateId: userId,
    eventType: 'user.created',
    payload: { identityId },
  });
  const { accountId, participantId } = await createAccountWithEvents(trx, userId, evidence);
  return { kind: 'newCustomerCreated', userId, identityId, accountId, participantId };
}

export async function firstLogin(
  deps: IdentityServiceDeps,
  input: { evidence: ProviderEvidence },
): Promise<FirstLoginResult> {
  const validation = validateProviderEvidence(input.evidence);
  if (!validation.ok) return { kind: 'invalidProviderEvidence' };
  const evidence = validation.evidence;

  const run = (): Promise<FirstLoginResult> =>
    withTransaction(deps.db, (trx) => attemptFirstLogin(trx, evidence));

  try {
    return await run();
  } catch (error) {
    switch (classifyIdentityWriteError(error)) {
      case 'convergentRace':
        // An identical concurrent first login won the insert — re-resolve
        // once; the second pass finds the winner's rows. Any further error
        // is unexpected and propagates.
        return await run();
      case 'verifiedEmailConflict':
        return { kind: 'verifiedEmailConflict' };
      default:
        // Unexpected database failures stay failures (owner directive) —
        // never mislabeled as user-facing conflicts.
        throw error;
    }
  }
}
