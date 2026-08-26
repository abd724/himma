/**
 * S6-2 — customer redemption-credential issuance + observation (docs/35
 * §9; owner S6-2 items 5–12, 29).
 *
 * SECRET MODEL: the canonical authority is a 256-bit opaque token (QR-ready)
 * and the 8-digit numeric code is a short-lived org-scoped human alias —
 * BOTH exist in raw form only inside the issuance response; the database
 * stores sha256 digests, and nothing here ever writes a raw secret into
 * audit, outbox, idempotency snapshots, or error text.
 *
 * ISSUANCE IDEMPOTENCY (owner item 7 — the recorded design): issuance runs
 * under the repository `runIdempotent` convention, but the transaction's
 * RESULT deliberately contains no secret — the freshly minted code/token
 * travel through a closure captured only by the EXECUTING run. A same-key
 * replay therefore returns `credentialIssued` metadata WITHOUT secrets
 * (`displayCode`/`token` absent): a double-tap/timeout retry can never
 * mint a second live credential and can never supersede the credential the
 * customer is already displaying; a customer who genuinely lost the code
 * regenerates with a NEW key (supersede-and-mint — the approved
 * supersede-not-replay regeneration semantics). Two concurrent DIFFERENT-
 * key requests serialize on the live-credential row lock (or, when no live
 * credential exists yet, on the one-live-per-target partial unique with a
 * single bounded service-level retry) — the later request supersedes, and
 * each response carries only its OWN secrets.
 *
 * LOCK ORDER (docs/35 §7 canonical hierarchy): issuance acquires
 * credential (the existing live row, when present) → entitlement — never
 * the reverse, so regeneration can never deadlock against redemption
 * (`key → credential → entitlement`).
 *
 * Issuing consumes NOTHING: no attendance, no entitlement decrement, no
 * payment/commission event. Expiry (`expires_at <= now()`) is unusable by
 * every reader regardless of lifecycle cleanup — no sweeper exists or is
 * needed for correctness.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { DbError } from '../../../db/errors';
import { newId } from '../../../db/ids';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import type { CustomerActor } from '../../booking/services/booking-shared';
import type { EntitlementServiceDeps } from './entitlement-shared';

export const DEFAULT_CREDENTIAL_TTL_SECONDS = 600; // 10 minutes (owner-ratified)
export const DEFAULT_CHECK_IN_WINDOW_BEFORE_MINUTES = 60;
export const DEFAULT_CHECK_IN_WINDOW_AFTER_MINUTES = 60;
const ALIAS_RETRY_LIMIT = 5;

export interface CredentialServiceDeps extends EntitlementServiceDeps {
  /** Credential TTL (default 600 s — server configuration, never client). */
  credentialTtlSeconds?: number;
  /** Scheduled check-in window around session start (defaults ±60 min). */
  checkInWindowBeforeMinutes?: number;
  checkInWindowAfterMinutes?: number;
  /** TEST-ONLY deterministic generators (alias-collision proofs). */
  aliasGenerator?: () => string;
  tokenGenerator?: () => string;
}

/** 8-digit numeric alias (crypto-random; collisions handled by the live
 *  org-scoped unique + a bounded retry). */
export function generateDisplayCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}

/** 256-bit opaque canonical token, base64url — the QR-ready authority. */
export function generateCredentialToken(): string {
  return randomBytes(32).toString('base64url');
}

export function credentialTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Org-scoped alias digest: numeric lookup is scoped by construction. */
export function credentialAliasDigest(organizationId: string, displayCode: string): string {
  return createHash('sha256').update(`${organizationId}:${displayCode}`).digest('hex');
}

export type CredentialTarget =
  | { kind: 'booking'; bookingId: string }
  | { kind: 'entitlement'; entitlementId: string };

export interface IssuedCredentialView {
  credentialId: string;
  state: 'live';
  expiresAt: string; // ISO
  target: CredentialTarget;
  /** Present ONLY on the executing (non-replayed) issuance. */
  displayCode?: string;
  /** The opaque canonical (QR-ready) authority — executing run only. */
  token?: string;
  /** TRUE when a same-key replay returned metadata without secrets. */
  replayed: boolean;
}

export type IssueCredentialResult =
  | { kind: 'credentialIssued'; credential: IssuedCredentialView }
  | { kind: 'bookingNotFound' }
  | { kind: 'bookingNotConfirmed' }
  /** CampWeek/Cohort bookings have no canonical occurrence identity yet —
   *  credential issuance stays FAIL-CLOSED until S6-3 (docs/35 §10). */
  | { kind: 'occurrenceUnsupported' }
  | { kind: 'outsideCheckInWindow' }
  | { kind: 'alreadyCheckedIn' }
  | { kind: 'entitlementNotFound' }
  | { kind: 'entitlementNotActive' }
  | { kind: 'walkInNotAllowed' }
  | { kind: 'entitlementExhausted' }
  | { kind: 'idempotencyConflict' };

export interface IssueCredentialRun {
  outcome: IssueCredentialResult;
}

const ISSUE_SCOPE = 'redemption.credential.issue';

interface MintedSecrets {
  displayCode: string;
  token: string;
}

export async function issueRedemptionCredential(
  deps: CredentialServiceDeps,
  actor: CustomerActor,
  input: { target: CredentialTarget; idempotencyKey: string },
): Promise<IssueCredentialRun> {
  // One bounded retry: two concurrent DIFFERENT-key first-issuances race on
  // the one-live-per-target partial unique; the loser's transaction aborts
  // (key unpoisoned) and the retry supersedes the winner under its row lock.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await issueOnce(deps, actor, input);
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof DbError &&
        error.kind === 'uniqueViolation' &&
        (error.constraint === 'uq_redemption_credential_live_booking' ||
          error.constraint === 'uq_redemption_credential_live_entitlement')
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function issueOnce(
  deps: CredentialServiceDeps,
  actor: CustomerActor,
  input: { target: CredentialTarget; idempotencyKey: string },
): Promise<IssueCredentialRun> {
  const ttlSeconds = deps.credentialTtlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS;
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: ISSUE_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({ target: input.target }),
  };
  // The out-of-band secret channel: populated ONLY by the executing run.
  let secrets: MintedSecrets | undefined;

  const run = await runIdempotent<IssueCredentialResult>(deps.db, ctx, async (trx) => {
    // 1. Any existing LIVE credential for this target is locked FIRST
    //    (credential precedes entitlement in the canonical order) — this
    //    serializes regeneration against a concurrent redemption.
    const targetColumn = input.target.kind === 'booking' ? 'booking_id' : 'entitlement_id';
    const targetId =
      input.target.kind === 'booking' ? input.target.bookingId : input.target.entitlementId;
    const existing = await sql<{ id: string }>`
      SELECT id FROM redemption_credential
      WHERE ${sql.id(targetColumn)} = ${targetId} AND state = 'live'
      FOR UPDATE`.execute(trx);

    // 2. Target resolution + eligibility (all server-clock authority).
    let organizationId: string;
    let branchId: string | null;
    let participantId: string;
    let sessionId: string | null = null;
    if (input.target.kind === 'booking') {
      const booking = await sql<{
        id: string;
        account_id: string;
        participant_id: string;
        organization_id: string;
        state: string;
        session_id: string | null;
        start_at: Date | null;
        branch_id: string | null;
        window_open: boolean | null;
        attended: boolean;
      }>`
        SELECT b.id, b.account_id, b.participant_id, b.organization_id, b.state,
               b.session_id, s.start_at, s.branch_id,
               (now() >= s.start_at - make_interval(mins =>
                  ${deps.checkInWindowBeforeMinutes ?? DEFAULT_CHECK_IN_WINDOW_BEFORE_MINUTES})
                AND now() <= s.start_at + make_interval(mins =>
                  ${deps.checkInWindowAfterMinutes ?? DEFAULT_CHECK_IN_WINDOW_AFTER_MINUTES}))
                 AS window_open,
               EXISTS (SELECT 1 FROM attendance_record ar
                        WHERE ar.booking_id = b.id AND ar.session_id IS NOT NULL) AS attended
        FROM booking b LEFT JOIN session s ON s.id = b.session_id
        WHERE b.id = ${input.target.bookingId}`.execute(trx);
      const row = booking.rows[0];
      if (row === undefined || row.account_id !== actor.accountId) {
        return { kind: 'bookingNotFound' };
      }
      if (row.state !== 'confirmed') return { kind: 'bookingNotConfirmed' };
      if (row.session_id === null) return { kind: 'occurrenceUnsupported' };
      if (row.attended) return { kind: 'alreadyCheckedIn' };
      if (row.window_open !== true) return { kind: 'outsideCheckInWindow' };
      organizationId = row.organization_id;
      branchId = row.branch_id;
      participantId = row.participant_id;
      sessionId = row.session_id;
    } else {
      // Walk-in: entitlement lock LAST (canonical order) — the availability
      // read below is a fresh statement under this lock.
      const entitlement = await sql<{
        id: string;
        account_id: string;
        participant_id: string;
        organization_id: string;
        branch_id: string | null;
        walk_in_allowed: boolean;
        uses_total: number | null;
        active_now: boolean;
        consumed: string;
      }>`
        SELECT e.id, e.account_id, e.participant_id, e.organization_id, e.branch_id,
               e.walk_in_allowed, e.uses_total,
               (now() >= e.valid_from AND (e.valid_until IS NULL OR now() < e.valid_until))
                 AS active_now,
               (SELECT count(*) FROM attendance_record ar
                 WHERE ar.entitlement_id = e.id) AS consumed
        FROM entitlement e WHERE e.id = ${input.target.entitlementId}
        FOR UPDATE OF e`.execute(trx);
      const row = entitlement.rows[0];
      if (row === undefined || row.account_id !== actor.accountId) {
        return { kind: 'entitlementNotFound' };
      }
      if (!row.active_now) return { kind: 'entitlementNotActive' };
      // A reservation-required-only product can never bypass S6-3 through
      // a walk-in credential (owner item 11).
      if (!row.walk_in_allowed) return { kind: 'walkInNotAllowed' };
      if (row.uses_total !== null && Number(row.consumed) >= row.uses_total) {
        return { kind: 'entitlementExhausted' };
      }
      organizationId = row.organization_id;
      branchId = row.branch_id;
      participantId = row.participant_id;
    }

    // 3. Supersede-and-mint (regeneration IS issuance): the previous live
    //    credential — locked above — becomes permanently unusable.
    for (const previous of existing.rows) {
      await trx
        .updateTable('redemption_credential')
        .set({ state: 'superseded' })
        .where('id', '=', previous.id)
        .where('state', '=', 'live')
        .execute();
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.accountId,
        principalContext: 'customer',
        action: 'credential.superseded',
        entityType: 'redemption_credential',
        entityId: previous.id,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'redemption_credential',
        aggregateId: previous.id,
        eventType: 'credential.superseded',
        payload: { credentialId: previous.id, organizationId },
      });
    }

    const credentialId = newId();
    const token = (deps.tokenGenerator ?? generateCredentialToken)();
    let displayCode: string | undefined;
    for (let aliasAttempt = 0; aliasAttempt < ALIAS_RETRY_LIMIT; aliasAttempt += 1) {
      const candidate = (deps.aliasGenerator ?? generateDisplayCode)();
      const collision = await trx
        .selectFrom('redemption_credential')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('alias_digest', '=', credentialAliasDigest(organizationId, candidate))
        .where('state', '=', 'live')
        .executeTakeFirst();
      if (collision === undefined) {
        displayCode = candidate;
        break;
      }
    }
    if (displayCode === undefined) {
      // Astronomically unlikely with 10^8 aliases per org; typed loudly,
      // never silent reuse (owner item 26).
      throw new Error('redemption alias generation exhausted its bounded retries');
    }
    const inserted = await sql<{ expires_at: Date }>`
      INSERT INTO redemption_credential
        (id, token_digest, alias_digest, entitlement_id, booking_id, session_id,
         account_id, participant_id, organization_id, branch_id, expires_at)
      VALUES (${credentialId}, ${credentialTokenDigest(token)},
              ${credentialAliasDigest(organizationId, displayCode)},
              ${input.target.kind === 'entitlement' ? targetId : null},
              ${input.target.kind === 'booking' ? targetId : null},
              ${sessionId}, ${actor.accountId}, ${participantId}, ${organizationId},
              ${branchId}, now() + make_interval(secs => ${ttlSeconds}))
      RETURNING expires_at`.execute(trx);

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.accountId,
      principalContext: 'customer',
      action: 'credential.issued',
      entityType: 'redemption_credential',
      entityId: credentialId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'redemption_credential',
      aggregateId: credentialId,
      eventType: 'credential.issued',
      payload: {
        credentialId,
        organizationId,
        targetKind: input.target.kind,
        targetId,
      },
    });

    secrets = { displayCode, token };
    // The RESULT (and therefore the idempotency snapshot) carries NO secret.
    return {
      kind: 'credentialIssued',
      credential: {
        credentialId,
        state: 'live',
        expiresAt: inserted.rows[0]!.expires_at.toISOString(),
        target: input.target,
        replayed: false,
      },
    };
  });

  if (run.kind === 'idempotencyConflict') {
    return { outcome: { kind: 'idempotencyConflict' } };
  }
  if (run.result.kind !== 'credentialIssued') return { outcome: run.result };
  if (run.kind === 'replayed') {
    return {
      outcome: {
        kind: 'credentialIssued',
        credential: { ...run.result.credential, replayed: true },
      },
    };
  }
  // Executing run: attach the once-only secrets from the closure channel.
  return {
    outcome: {
      kind: 'credentialIssued',
      credential: {
        ...run.result.credential,
        displayCode: secrets!.displayCode,
        token: secrets!.token,
        replayed: false,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Customer credential observation (owner item 29) — the smallest read RI-4
// needs: live/expired/superseded/used truth + expiry, never secrets.
// ---------------------------------------------------------------------------

export interface CredentialStatusView {
  credentialId: string;
  /** EFFECTIVE state: a lapsed live credential reads `expired` NOW. */
  state: 'live' | 'used' | 'superseded' | 'expired';
  expiresAt: string; // ISO
  redeemedAt?: string; // ISO — present when used
  target: CredentialTarget;
}

export type CredentialStatusResult =
  | { kind: 'credentialStatus'; credential: CredentialStatusView }
  | { kind: 'credentialNotFound' };

export async function getRedemptionCredentialStatus(
  deps: CredentialServiceDeps,
  actor: CustomerActor,
  input: { credentialId: string },
): Promise<CredentialStatusResult> {
  return withTransaction(deps.db, async (trx: Trx) => {
    const row = await trx
      .selectFrom('redemption_credential')
      .select(({ eb }) => [
        'id',
        'state',
        'expires_at',
        'used_at',
        'entitlement_id',
        'booking_id',
        eb.fn<Date>('now', []).as('db_now'),
      ])
      .where('id', '=', input.credentialId)
      .where('account_id', '=', actor.accountId)
      .executeTakeFirst();
    if (row === undefined) return { kind: 'credentialNotFound' as const };
    const effectiveState =
      row.state === 'live' && row.expires_at <= row.db_now
        ? ('expired' as const)
        : (row.state as 'live' | 'used' | 'superseded' | 'expired');
    return {
      kind: 'credentialStatus' as const,
      credential: {
        credentialId: row.id,
        state: effectiveState,
        expiresAt: row.expires_at.toISOString(),
        ...(row.used_at !== null ? { redeemedAt: row.used_at.toISOString() } : {}),
        target:
          row.booking_id !== null
            ? { kind: 'booking' as const, bookingId: row.booking_id }
            : { kind: 'entitlement' as const, entitlementId: row.entitlement_id! },
      },
    };
  });
}
