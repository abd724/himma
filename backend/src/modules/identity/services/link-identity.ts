/**
 * Identity linking and unlinking (docs/26 §3.6–3.7, §9.2–9.3).
 *
 * The target user is ALWAYS supplied through the authenticated
 * application-context abstraction — never inferred from evidence, never
 * matched by email. Step-up presentation and HTTP endpoints are B2-4; these
 * are the core rules only. A provider subject binds to one user forever:
 * ended identities keep their issuer+subject claim (docs/26 §3.1, §3.7).
 */
import { appendAuditEvent } from '../../../db/audit';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import {
  endIdentityCas,
  findActiveVerifiedEmailOwner,
  findIdentityByIssuerSubject,
  findUser,
  insertIdentity,
  listActiveIdentitiesForUpdate,
  reactivateIdentity,
} from '../persistence/identity-repository';
import { validateProviderEvidence, type ProviderEvidence } from '../providers/evidence';
import type { IdentityServiceDeps } from './account-status';
import { classifyIdentityWriteError } from './first-login';

/**
 * Proof of an already-authenticated principal, constructed by the B2-4
 * middleware (after step-up where required). Services trust it; nothing in
 * this module authenticates.
 */
export interface AuthenticatedContext {
  userId: string;
}

export type LinkIdentityResult =
  | { kind: 'identityLinked'; identityId: string }
  | { kind: 'identityAlreadyLinked'; identityId: string }
  | { kind: 'identityLinkedToAnotherUser' }
  | { kind: 'verifiedEmailConflict' }
  | { kind: 'accountLocked' }
  | { kind: 'accountDeleted' }
  | { kind: 'invalidProviderEvidence' };

export type UnlinkIdentityResult =
  | { kind: 'identityUnlinked' }
  | { kind: 'lastLoginMethod' }
  | { kind: 'identityNotFound' }
  | { kind: 'staleVersion' }
  | { kind: 'accountLocked' }
  | { kind: 'accountDeleted' };

type UserGate = { kind: 'active' } | { kind: 'accountLocked' } | { kind: 'accountDeleted' };

/** Security gate on the login-method aggregate: user status only — customer
 *  account business state does not govern login-method management. */
async function gateUser(trx: Trx, userId: string): Promise<UserGate> {
  const user = await findUser(trx, userId);
  if (user === undefined || user.status === 'deleted') return { kind: 'accountDeleted' };
  if (user.status === 'locked') return { kind: 'accountLocked' };
  return { kind: 'active' };
}

async function appendLinkEvents(
  trx: Trx,
  userId: string,
  identityId: string,
  eventType: 'identity.linked' | 'identity.unlinked',
): Promise<void> {
  await appendAuditEvent(trx, {
    actorType: 'user',
    actorId: userId,
    action: eventType === 'identity.linked' ? 'auth.identity_linked' : 'auth.identity_unlinked',
    entityType: 'auth_identity',
    entityId: identityId,
  });
  await appendOutboxEvent(trx, {
    aggregateType: 'app_user',
    aggregateId: userId,
    eventType,
    payload: { identityId },
  });
}

async function attemptLink(
  trx: Trx,
  ctx: AuthenticatedContext,
  evidence: ProviderEvidence,
): Promise<LinkIdentityResult> {
  const gate = await gateUser(trx, ctx.userId);
  if (gate.kind !== 'active') return { kind: gate.kind };

  const existing = await findIdentityByIssuerSubject(trx, evidence.issuer, evidence.subject);
  if (existing !== undefined) {
    if (existing.user_id !== ctx.userId) return { kind: 'identityLinkedToAnotherUser' };
    if (existing.status === 'active') {
      return { kind: 'identityAlreadyLinked', identityId: existing.id };
    }
    // The user's own previously ended identity: relinking reactivates the
    // same row (the subject's history stays intact — docs/26 §3.7).
    await reactivateIdentity(trx, existing.id, evidence);
    await appendLinkEvents(trx, ctx.userId, existing.id, 'identity.linked');
    return { kind: 'identityLinked', identityId: existing.id };
  }

  if (evidence.emailVerified && evidence.email !== undefined) {
    const owner = await findActiveVerifiedEmailOwner(trx, evidence.email);
    if (owner !== undefined && owner !== ctx.userId) {
      return { kind: 'verifiedEmailConflict' };
    }
  }

  const identityId = await insertIdentity(trx, ctx.userId, evidence);
  await appendLinkEvents(trx, ctx.userId, identityId, 'identity.linked');
  return { kind: 'identityLinked', identityId };
}

export async function linkIdentity(
  deps: IdentityServiceDeps,
  ctx: AuthenticatedContext,
  input: { evidence: ProviderEvidence },
): Promise<LinkIdentityResult> {
  const validation = validateProviderEvidence(input.evidence);
  if (!validation.ok) return { kind: 'invalidProviderEvidence' };
  const evidence = validation.evidence;

  const run = (): Promise<LinkIdentityResult> =>
    withTransaction(deps.db, (trx) => attemptLink(trx, ctx, evidence));

  try {
    return await run();
  } catch (error) {
    switch (classifyIdentityWriteError(error)) {
      case 'convergentRace':
        // A concurrent request inserted this subject first; re-resolving
        // yields identityAlreadyLinked (same user) or
        // identityLinkedToAnotherUser (docs/26 §9.2 loser typing).
        return await run();
      case 'verifiedEmailConflict':
        return { kind: 'verifiedEmailConflict' };
      default:
        throw error;
    }
  }
}

export async function unlinkIdentity(
  deps: IdentityServiceDeps,
  ctx: AuthenticatedContext,
  input: { identityId: string; expectedVersion: number },
): Promise<UnlinkIdentityResult> {
  return withTransaction(deps.db, async (trx) => {
    const gate = await gateUser(trx, ctx.userId);
    if (gate.kind !== 'active') return { kind: gate.kind };

    // Row-locked usable-method count (docs/26 §9.3): locking every active
    // identity serializes concurrent unlinks, so two racing unlinks can
    // never remove both of a user's last two methods.
    const active = await listActiveIdentitiesForUpdate(trx, ctx.userId);
    const target = active.find((row) => row.id === input.identityId);
    // Another user's identity (or an unknown/ended one) is not-found-shaped
    // — existence is never revealed across users (docs/26 §11.2).
    if (target === undefined) return { kind: 'identityNotFound' };
    if (active.length <= 1) return { kind: 'lastLoginMethod' };

    const ended = await endIdentityCas(trx, target.id, input.expectedVersion);
    if (!ended) return { kind: 'staleVersion' };
    await appendLinkEvents(trx, ctx.userId, target.id, 'identity.unlinked');
    return { kind: 'identityUnlinked' };
  });
}
