/**
 * Per-request session liveness (docs/26 §4.7) — B2-3.
 *
 * Provider-independent and framework-neutral: receives ALREADY-VERIFIED
 * access-token evidence (verification happened outside any transaction),
 * resolves the Himma session-of-record by issuer + subject + origin_jti,
 * gates on session, identity, user, and account state, and returns the
 * principal context the B2-4 HTTP middleware will attach to requests.
 *
 * The principal carries NO business roles: Cognito claims never create
 * Himma permissions; authorization is later Himma database-backed policy
 * resolution (docs/26 §6). Local revocation is authoritative — once a
 * revocation commits, every subsequent liveness check denies (each check
 * reads current committed state; a check that began before the revocation
 * commit may authorize that already-in-flight request, exactly the docs/26
 * §4.6 "refused on its next request" rule).
 */
import { withTransaction } from '../../../db/transaction';
import {
  findSessionsByOriginJti,
  touchSessionLastSeen,
} from '../persistence/session-repository';
import {
  validateAccessTokenEvidence,
  type AccessTokenEvidence,
} from '../providers/access-token';
import type { ProviderAssurance } from '../providers/evidence';
import type { IdentityServiceDeps } from './account-status';
import { resolveActivePrincipal } from './sessions';

/** Framework-neutral authenticated principal (docs/26 §6 customer subset). */
export interface AuthenticatedSessionPrincipal {
  principalKind: 'customer';
  userId: string;
  accountId?: string;
  identityId: string;
  sessionId: string;
  clientKind: string;
  assurance: ProviderAssurance;
  /** Provider OAuth scopes — transport metadata, never Himma permissions. */
  scopes: string[];
  /** Last provider AUTHENTICATION time — step-up recency proof (§3.10). */
  stepUpAt?: Date;
}

export type SessionLivenessResult =
  | { kind: 'authenticated'; principal: AuthenticatedSessionPrincipal }
  | { kind: 'invalidAccessToken' }
  | { kind: 'sessionNotRegistered' }
  | { kind: 'sessionExpired' }
  | { kind: 'sessionRevoked' }
  | { kind: 'identityEnded' }
  | { kind: 'accountLocked' }
  | { kind: 'accountSuspended' }
  | { kind: 'accountDeleted' };

export async function checkSessionLiveness(
  deps: IdentityServiceDeps,
  input: {
    evidence: AccessTokenEvidence;
    /** Update last_seen_at (refresh-style calls); plain checks read only. */
    touch?: boolean;
  },
): Promise<SessionLivenessResult> {
  const validation = validateAccessTokenEvidence(input.evidence);
  if (!validation.ok) return { kind: 'invalidAccessToken' };
  const evidence = validation.evidence;

  return withTransaction(deps.db, async (trx) => {
    const rows = await findSessionsByOriginJti(trx, evidence.originJti);
    // Only rows registered under the SAME provider identifiers count;
    // anything else is not-found-shaped (docs/26 §11.2).
    const matching = rows.filter(
      (row) =>
        row.provider_issuer === evidence.issuer && row.provider_subject === evidence.subject,
    );
    if (matching.length === 0) return { kind: 'sessionNotRegistered' };
    const live = matching.find((row) => row.revoked_at === null);
    if (live === undefined) return { kind: 'sessionRevoked' };
    if (live.expires_at.getTime() <= Date.now()) return { kind: 'sessionExpired' };

    const gate = await resolveActivePrincipal(trx, evidence);
    if (gate.kind !== 'ok') {
      // A registered session whose identity row is unreachable is
      // impossible under the composite FK; type it not-found-shaped anyway.
      return {
        kind: gate.kind === 'identityNotFound' ? 'sessionNotRegistered' : gate.kind,
      };
    }
    // The composite FK guarantees this; assert defensively all the same.
    if (gate.rows.userId !== live.user_id) return { kind: 'sessionNotRegistered' };

    if (input.touch === true) await touchSessionLastSeen(trx, live.id);

    return {
      kind: 'authenticated',
      principal: {
        principalKind: 'customer',
        userId: gate.rows.userId,
        ...(gate.rows.accountId !== undefined ? { accountId: gate.rows.accountId } : {}),
        identityId: gate.rows.identityId,
        sessionId: live.id,
        clientKind: live.client_kind,
        assurance: evidence.assurance,
        scopes: evidence.scopes,
        ...(evidence.authTime !== undefined ? { stepUpAt: evidence.authTime } : {}),
      },
    };
  });
}
