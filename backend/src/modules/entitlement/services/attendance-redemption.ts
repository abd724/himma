/**
 * S6-2 — provider check-in authority: preview + atomic redemption (docs/35
 * §10, §14, §16; owner S6-2 items 13–28).
 *
 * PREVIEW is a pure read that grants NOTHING: it resolves the entered
 * numeric code ONLY within the authenticated provider organization among
 * effectively-live credentials, enforces staff branch/assignment scope,
 * and returns the minimal front-desk context (participant first name,
 * program title, occurrence/validity/usage facts). Foreign-org, random,
 * superseded, and unknown codes are ONE generic refusal — a provider
 * learns nothing about other organizations' credentials.
 *
 * REDEEM is the single atomic check-in transaction (idempotency-keyed per
 * staff principal): rate-limit gate → credential row FOR UPDATE → fresh
 * effective-liveness + org/branch/coach-assignment scope → target
 * resolution (walk-in entitlement · reserved entitlement use via the
 * reservation subtype · plain session Booking) → entitlement FOR UPDATE
 * LAST where consumption applies, with a FRESH post-lock availability
 * count (READ COMMITTED discipline) → credential `live → used` → ONE
 * append-only AttendanceRecord (credential_id UNIQUE = the structural
 * single-use backstop) → audit/outbox once → `entitlement.exhausted` only
 * when the final finite use was genuinely consumed. Preview output is
 * never authority — everything is re-proven here.
 *
 * BRUTE FORCE (owner item 25): validation lookups are bounded by a DURABLE
 * PostgreSQL fixed-window failure counter per provider principal +
 * organization (`redemption_lookup_attempt`) — correct across horizontally
 * scaled instances by construction; the identity RateLimiterStore is
 * in-memory and production-refusing, so it cannot carry this. Only MISSES
 * count; raw attempted codes are never stored anywhere.
 *
 * LOCK ORDER: `key → credential → entitlement` — the canonical hierarchy's
 * suffix; the Booking row is validated BY READ (V1 check-in never mutates
 * a Booking), so no `credential → booking` lock edge exists anywhere.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../../../db/audit';
import { runIdempotent, requestDigest } from '../../../db/idempotency';
import { newId } from '../../../db/ids';
import type { Trx } from '../../../db/transaction';
import { withTransaction } from '../../../db/transaction';
import { appendOutboxEvent } from '../../../outbox/outbox';
import { branchInScope, type OrgScope } from '../../provider/services/provider-principal';
import { credentialAliasDigest, type CredentialServiceDeps } from './redemption-credential';

export const DEFAULT_REDEMPTION_ATTEMPT_LIMIT = 20;
export const DEFAULT_REDEMPTION_ATTEMPT_WINDOW_SECONDS = 600;

export interface RedemptionDeps extends CredentialServiceDeps {
  /** Durable brute-force window (defaults: 20 failures / 600 s). */
  redemptionAttemptLimit?: number;
  redemptionAttemptWindowSeconds?: number;
  /** TEST-ONLY failure injection at named redemption points. */
  onRedeemPhase?: (phase: RedeemPhase) => void;
}

export type RedeemPhase =
  | 'credentialLocked'
  | 'credentialConsumed'
  | 'attendanceInserted'
  | 'beforeCommit';

interface CredentialRow {
  id: string;
  state: string;
  lapsed: boolean;
  entitlement_id: string | null;
  booking_id: string | null;
  session_id: string | null;
  /** The frozen canonical occurrence (camp/cohort credentials — docs/35
   *  §28): the SCHEDULED identity, never the redemption instant. */
  occurrence_date: string | null;
  occurrence_start_time: string | null;
  account_id: string;
  participant_id: string;
  organization_id: string;
  branch_id: string | null;
  expires_at: Date;
}

// ---------------------------------------------------------------------------
// Durable brute-force windows
// ---------------------------------------------------------------------------

async function attemptWindowStart(trx: Trx, windowSeconds: number): Promise<Date> {
  const row = await sql<{ window_start: Date }>`
    SELECT to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds})
                        * ${windowSeconds}) AS window_start`.execute(trx);
  return row.rows[0]!.window_start;
}

async function attemptsExhausted(
  trx: Trx,
  deps: RedemptionDeps,
  scope: OrgScope,
): Promise<boolean> {
  const windowSeconds =
    deps.redemptionAttemptWindowSeconds ?? DEFAULT_REDEMPTION_ATTEMPT_WINDOW_SECONDS;
  const limit = deps.redemptionAttemptLimit ?? DEFAULT_REDEMPTION_ATTEMPT_LIMIT;
  const windowStart = await attemptWindowStart(trx, windowSeconds);
  const row = await trx
    .selectFrom('redemption_lookup_attempt')
    .select('failures')
    .where('principal_ref', '=', `staff:${scope.membershipId}`)
    .where('organization_id', '=', scope.organizationId)
    .where('window_start', '=', windowStart)
    .executeTakeFirst();
  return row !== undefined && row.failures >= limit;
}

async function recordFailedLookup(
  trx: Trx,
  deps: RedemptionDeps,
  scope: OrgScope,
): Promise<void> {
  const windowSeconds =
    deps.redemptionAttemptWindowSeconds ?? DEFAULT_REDEMPTION_ATTEMPT_WINDOW_SECONDS;
  const windowStart = await attemptWindowStart(trx, windowSeconds);
  await sql`
    INSERT INTO redemption_lookup_attempt (principal_ref, organization_id, window_start, failures)
    VALUES (${`staff:${scope.membershipId}`}, ${scope.organizationId}, ${windowStart}, 1)
    ON CONFLICT (principal_ref, organization_id, window_start)
    DO UPDATE SET failures = redemption_lookup_attempt.failures + 1`.execute(trx);
}

// ---------------------------------------------------------------------------
// Shared resolution + scope
// ---------------------------------------------------------------------------

/** Coach authority (owner item 13; re-ratified at the 0020 correction):
 *  assigned-session check-ins ONLY — a coach never redeems walk-in
 *  entitlements, unassigned sessions, or ANY CampWeek/Cohort occurrence
 *  (no occurrence-level assignment proof exists — `camp_week` has no
 *  instructor column and `recurring_schedule.instructor_staff_id` is
 *  schedule-level, optional, and mutable; coach occurrence assignment is
 *  recorded DEFERRED, docs/35 §31). */
async function coachAssignmentDenied(
  trx: Trx,
  scope: OrgScope,
  credential: CredentialRow,
): Promise<boolean> {
  if (scope.role !== 'coach') return false;
  if (credential.session_id === null) return true;
  const session = await trx
    .selectFrom('session')
    .select('instructor_staff_id')
    .where('id', '=', credential.session_id)
    .executeTakeFirst();
  return session?.instructor_staff_id !== scope.membershipId;
}

function branchDenied(scope: OrgScope, credential: CredentialRow): boolean {
  return credential.branch_id !== null && !branchInScope(scope, credential.branch_id);
}

export type RedemptionTargetKind =
  | 'session'
  | 'reservedEntitlementUse'
  | 'walkIn'
  | 'campWeekOccurrence'
  | 'cohortOccurrence';

interface TargetContext {
  participantFirstName: string;
  programTitle: string;
  targetKind: RedemptionTargetKind;
  sessionStartAt?: string;
  /** The credential's frozen canonical occurrence (camp/cohort). */
  occurrenceDate?: string;
  occurrenceStartTime?: string;
  branchLabel?: string;
  /** The consuming entitlement (walk-in or reserved use), if any. */
  consumingEntitlementId: string | null;
  usage?: { usageKind: 'finite' | 'unlimited'; usesTotal?: number; used?: number; remaining?: number };
  validity?: { validFrom: string; validUntil?: string };
}

async function loadTargetContext(
  trx: Trx,
  credential: CredentialRow,
): Promise<TargetContext> {
  const participant = await trx
    .selectFrom('participant')
    .select('first_name')
    .where('id', '=', credential.participant_id)
    .executeTakeFirstOrThrow();
  let programId: string;
  let targetKind: TargetContext['targetKind'];
  let consumingEntitlementId: string | null = null;
  let sessionStartAt: string | undefined;
  let occurrenceDate: string | undefined;
  let occurrenceStartTime: string | undefined;
  let branchLabel: string | undefined;
  if (credential.booking_id !== null) {
    const booking = await trx
      .selectFrom('booking')
      .select(['program_id', 'camp_week_id', 'cohort_id'])
      .where('id', '=', credential.booking_id)
      .executeTakeFirstOrThrow();
    programId = booking.program_id;
    if (credential.session_id !== null) {
      const reservation = await trx
        .selectFrom('entitlement_reservation')
        .select('entitlement_id')
        .where('booking_id', '=', credential.booking_id)
        .executeTakeFirst();
      consumingEntitlementId = reservation?.entitlement_id ?? null;
      targetKind = reservation !== undefined ? 'reservedEntitlementUse' : 'session';
      const session = await trx
        .selectFrom('session')
        .leftJoin('branch', 'branch.id', 'session.branch_id')
        .select(['session.start_at', 'branch.label'])
        .where('session.id', '=', credential.session_id)
        .executeTakeFirst();
      sessionStartAt = session?.start_at.toISOString();
      branchLabel = session?.label ?? undefined;
    } else {
      // Multi-occurrence (camp/cohort) Booking credential: the context is
      // the credential's FROZEN canonical occurrence — the provider can
      // never choose or change the occurrence at the desk (docs/35 §28).
      targetKind = booking.camp_week_id !== null ? 'campWeekOccurrence' : 'cohortOccurrence';
      occurrenceDate = credential.occurrence_date!;
      occurrenceStartTime = credential.occurrence_start_time!.slice(0, 5);
      if (credential.branch_id !== null) {
        const branch = await trx
          .selectFrom('branch')
          .select('label')
          .where('id', '=', credential.branch_id)
          .executeTakeFirst();
        branchLabel = branch?.label;
      }
    }
  } else {
    const entitlement = await trx
      .selectFrom('entitlement')
      .select(['program_id'])
      .where('id', '=', credential.entitlement_id!)
      .executeTakeFirstOrThrow();
    programId = entitlement.program_id;
    consumingEntitlementId = credential.entitlement_id;
    targetKind = 'walkIn';
  }
  const program = await trx
    .selectFrom('program')
    .select('title_en')
    .where('id', '=', programId)
    .executeTakeFirstOrThrow();

  let usage: TargetContext['usage'];
  let validity: TargetContext['validity'];
  if (consumingEntitlementId !== null) {
    const entitlement = await trx
      .selectFrom('entitlement')
      .select(({ eb }) => [
        'usage_kind',
        'uses_total',
        'valid_from',
        'valid_until',
        eb
          .selectFrom('attendance_record')
          .select(({ fn }) => fn.countAll<string>().as('n'))
          .whereRef('attendance_record.entitlement_id', '=', 'entitlement.id')
          .as('consumed'),
      ])
      .where('id', '=', consumingEntitlementId)
      .executeTakeFirstOrThrow();
    const used = Number(entitlement.consumed ?? 0);
    usage = {
      usageKind: entitlement.usage_kind as 'finite' | 'unlimited',
      ...(entitlement.uses_total !== null
        ? {
            usesTotal: entitlement.uses_total,
            used,
            remaining: Math.max(0, entitlement.uses_total - used),
          }
        : {}),
    };
    validity = {
      validFrom: entitlement.valid_from.toISOString(),
      ...(entitlement.valid_until !== null
        ? { validUntil: entitlement.valid_until.toISOString() }
        : {}),
    };
  }
  return {
    participantFirstName: participant.first_name,
    programTitle: program.title_en,
    targetKind,
    ...(sessionStartAt !== undefined ? { sessionStartAt } : {}),
    ...(occurrenceDate !== undefined ? { occurrenceDate } : {}),
    ...(occurrenceStartTime !== undefined ? { occurrenceStartTime } : {}),
    ...(branchLabel !== undefined ? { branchLabel } : {}),
    consumingEntitlementId,
    ...(usage !== undefined ? { usage } : {}),
    ...(validity !== undefined ? { validity } : {}),
  };
}

async function resolveCredentialByCode(
  trx: Trx,
  scope: OrgScope,
  code: string,
  options: { forUpdate: boolean },
): Promise<CredentialRow | undefined> {
  const digest = credentialAliasDigest(scope.organizationId, code);
  const lock = options.forUpdate ? sql`FOR UPDATE` : sql``;
  // Live rows only: superseded/used rows released their alias; foreign-org
  // codes never resolve (the digest is org-scoped by construction).
  const rows = await sql<CredentialRow>`
    SELECT id, state, (expires_at <= now()) AS lapsed, entitlement_id, booking_id,
           session_id, occurrence_date::text, occurrence_start_time::text,
           account_id, participant_id, organization_id, branch_id, expires_at
    FROM redemption_credential
    WHERE organization_id = ${scope.organizationId} AND alias_digest = ${digest}
      AND state = 'live'
    ${lock}`.execute(trx);
  return rows.rows[0];
}

// ---------------------------------------------------------------------------
// Preview — pure read (owner item 14)
// ---------------------------------------------------------------------------

export interface RedemptionPreviewView {
  credentialId: string;
  expiresAt: string;
  participantFirstName: string;
  programTitle: string;
  targetKind: RedemptionTargetKind;
  sessionStartAt?: string;
  /** The credential's frozen canonical occurrence (camp/cohort). */
  occurrenceDate?: string;
  occurrenceStartTime?: string;
  branchLabel?: string;
  usage?: { usageKind: 'finite' | 'unlimited'; usesTotal?: number; used?: number; remaining?: number };
  validity?: { validFrom: string; validUntil?: string };
}

export type PreviewRedemptionResult =
  | { kind: 'redemptionPreview'; preview: RedemptionPreviewView }
  /** Generic: unknown / foreign-org / superseded — indistinguishable. */
  | { kind: 'credentialNotFound' }
  | { kind: 'credentialExpired' }
  | { kind: 'forbiddenScope' }
  | { kind: 'tooManyAttempts' };

export async function previewRedemption(
  deps: RedemptionDeps,
  scope: OrgScope,
  input: { code: string },
): Promise<PreviewRedemptionResult> {
  return withTransaction(deps.db, async (trx) => {
    if (await attemptsExhausted(trx, deps, scope)) return { kind: 'tooManyAttempts' as const };
    const credential = await resolveCredentialByCode(trx, scope, input.code, {
      forUpdate: false,
    });
    if (credential === undefined) {
      await recordFailedLookup(trx, deps, scope);
      return { kind: 'credentialNotFound' as const };
    }
    if (credential.lapsed) return { kind: 'credentialExpired' as const };
    if (branchDenied(scope, credential)) return { kind: 'forbiddenScope' as const };
    if (await coachAssignmentDenied(trx, scope, credential)) {
      return { kind: 'forbiddenScope' as const };
    }
    const context = await loadTargetContext(trx, credential);
    return {
      kind: 'redemptionPreview' as const,
      preview: {
        credentialId: credential.id,
        expiresAt: credential.expires_at.toISOString(),
        participantFirstName: context.participantFirstName,
        programTitle: context.programTitle,
        targetKind: context.targetKind,
        ...(context.sessionStartAt !== undefined
          ? { sessionStartAt: context.sessionStartAt }
          : {}),
        ...(context.occurrenceDate !== undefined
          ? { occurrenceDate: context.occurrenceDate }
          : {}),
        ...(context.occurrenceStartTime !== undefined
          ? { occurrenceStartTime: context.occurrenceStartTime }
          : {}),
        ...(context.branchLabel !== undefined ? { branchLabel: context.branchLabel } : {}),
        ...(context.usage !== undefined ? { usage: context.usage } : {}),
        ...(context.validity !== undefined ? { validity: context.validity } : {}),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Atomic redeem (owner item 15)
// ---------------------------------------------------------------------------

export interface AttendanceView {
  attendanceId: string;
  credentialId: string;
  participantFirstName: string;
  programTitle: string;
  targetKind: RedemptionTargetKind;
  occurredAt: string;
  /** The scheduled canonical occurrence this attendance fulfilled
   *  (camp/cohort) — distinct from `occurredAt`, the redemption instant. */
  occurrenceDate?: string;
  occurrenceStartTime?: string;
  /** Post-consumption remaining for finite entitlements. */
  remaining?: number;
  entitlementExhausted?: boolean;
}

export type RedeemCredentialResult =
  | { kind: 'attendanceRecorded'; attendance: AttendanceView }
  | { kind: 'credentialNotFound' }
  | { kind: 'credentialExpired' }
  | { kind: 'credentialAlreadyUsed' }
  | { kind: 'forbiddenScope' }
  | { kind: 'entitlementNotActive' }
  | { kind: 'entitlementExhausted' }
  /** S6-3 invariant (docs/35 §7: used + active commitments ≤ uses_total):
   *  every unconsumed finite use is committed to upcoming reservations, so
   *  a WALK-IN cannot claim one — the reserved uses belong to their
   *  occurrences. Redeeming a reserved use itself is unaffected (its own
   *  commitment covers it). */
  | { kind: 'entitlementFullyCommitted' }
  | { kind: 'tooManyAttempts' }
  | { kind: 'idempotencyConflict' };

export interface RedeemCredentialRun {
  replayed: boolean;
  outcome: RedeemCredentialResult;
}

const REDEEM_SCOPE = 'attendance.redeem';

export async function redeemCredential(
  deps: RedemptionDeps,
  scope: OrgScope,
  actor: { userId: string },
  input: { code: string; credentialId: string; idempotencyKey: string },
): Promise<RedeemCredentialRun> {
  const ctx = {
    principalRef: `staff:${scope.membershipId}`,
    endpointScope: REDEEM_SCOPE,
    idempotencyKey: input.idempotencyKey,
    // The digest hashes the payload — the raw code itself is never stored.
    requestDigest: requestDigest({
      credentialId: input.credentialId,
      alias: credentialAliasDigest(scope.organizationId, input.code),
    }),
  };
  const run = await runIdempotent<RedeemCredentialResult>(deps.db, ctx, async (trx) => {
    if (await attemptsExhausted(trx, deps, scope)) return { kind: 'tooManyAttempts' };
    // Resolve + LOCK the live credential (the canonical `credential` lock).
    const credential = await resolveCredentialByCode(trx, scope, input.code, {
      forUpdate: true,
    });
    if (credential === undefined || credential.id !== input.credentialId) {
      // Distinguish a genuinely used/known credential (org-visible truth)
      // from unknown/foreign/superseded (generic).
      const known = await trx
        .selectFrom('redemption_credential')
        .select(['id', 'state'])
        .where('id', '=', input.credentialId)
        .where('organization_id', '=', scope.organizationId)
        .where('alias_digest', '=', credentialAliasDigest(scope.organizationId, input.code))
        .executeTakeFirst();
      if (known?.state === 'used') return { kind: 'credentialAlreadyUsed' };
      await recordFailedLookup(trx, deps, scope);
      return { kind: 'credentialNotFound' };
    }
    deps.onRedeemPhase?.('credentialLocked');
    // Effective expiry under the lock: server time only, sweeper-free.
    if (credential.lapsed) return { kind: 'credentialExpired' };
    if (branchDenied(scope, credential)) return { kind: 'forbiddenScope' };
    if (await coachAssignmentDenied(trx, scope, credential)) {
      return { kind: 'forbiddenScope' };
    }

    const context = await loadTargetContext(trx, credential);

    // Consumption path: entitlement lock LAST + FRESH post-lock reads.
    let remaining: number | undefined;
    let exhaustedNow = false;
    if (context.consumingEntitlementId !== null) {
      const entitlement = await sql<{
        uses_total: number | null;
        active_now: boolean;
      }>`
        SELECT uses_total,
               (now() >= valid_from AND (valid_until IS NULL OR now() < valid_until))
                 AS active_now
        FROM entitlement WHERE id = ${context.consumingEntitlementId}
        FOR UPDATE`.execute(trx);
      const row = entitlement.rows[0]!;
      if (!row.active_now) return { kind: 'entitlementNotActive' };
      if (row.uses_total !== null) {
        const consumed = await sql<{ n: string }>`
          SELECT count(*) AS n FROM attendance_record
          WHERE entitlement_id = ${context.consumingEntitlementId}`.execute(trx);
        const used = Number(consumed.rows[0]!.n);
        if (used >= row.uses_total) return { kind: 'entitlementExhausted' };
        // S6-3 (docs/35 §7): a WALK-IN consumes only an UNCOMMITTED use —
        // active reservation commitments hold their credits for their own
        // occurrences. This FRESH statement runs under the entitlement
        // lock (the serialization point); a reserved-use redemption is
        // covered by its own commitment and skips this gate.
        if (context.targetKind === 'walkIn') {
          const committed = await sql<{ n: string }>`
            SELECT count(*) AS n FROM entitlement_reservation er
              JOIN booking b ON b.id = er.booking_id
              JOIN session s ON s.id = b.session_id
            WHERE er.entitlement_id = ${context.consumingEntitlementId}
              AND b.state = 'confirmed'
              AND s.end_at > now()
              AND NOT EXISTS (SELECT 1 FROM attendance_record ar
                               WHERE ar.booking_id = er.booking_id)`.execute(trx);
          if (used + Number(committed.rows[0]!.n) >= row.uses_total) {
            return { kind: 'entitlementFullyCommitted' };
          }
        }
        remaining = row.uses_total - used - 1;
        exhaustedNow = remaining === 0;
      }
    }

    // Credential live → used FIRST (the attendance shape trigger requires a
    // consumed credential), then the ONE append-only attendance row.
    const consumedCas = await sql<{ id: string }>`
      UPDATE redemption_credential
      SET state = 'used', used_at = now(),
          redeemed_by_staff_membership_id = ${scope.membershipId}
      WHERE id = ${credential.id} AND state = 'live'
      RETURNING id`.execute(trx);
    if (consumedCas.rows.length !== 1) {
      throw new Error(`credential ${credential.id} consume CAS lost under lock — impossible`);
    }
    deps.onRedeemPhase?.('credentialConsumed');

    // The attendance row copies the credential's FROZEN occurrence pair —
    // the scheduled identity, never derived from the redemption instant
    // (`occurred_at`): a cross-midnight redemption stays bound to its
    // scheduled occurrence date/time (docs/35 §28).
    const attendanceId = newId();
    const occurred = await sql<{ occurred_at: Date }>`
      INSERT INTO attendance_record
        (id, organization_id, branch_id, account_id, participant_id, entitlement_id,
         booking_id, session_id, occurrence_date, occurrence_start_time,
         credential_id, validated_by_staff_membership_id, source)
      VALUES (${attendanceId}, ${scope.organizationId}, ${credential.branch_id},
              ${credential.account_id}, ${credential.participant_id},
              ${context.consumingEntitlementId}, ${credential.booking_id},
              ${credential.session_id}, ${credential.occurrence_date},
              ${credential.occurrence_start_time}, ${credential.id}, ${scope.membershipId},
              'numericCode')
      RETURNING occurred_at`.execute(trx);
    deps.onRedeemPhase?.('attendanceInserted');

    await appendAuditEvent(trx, {
      actorType: 'user',
      actorId: actor.userId,
      principalContext: 'provider',
      action: 'attendance.redeemed',
      entityType: 'attendance_record',
      entityId: attendanceId,
    });
    await appendOutboxEvent(trx, {
      aggregateType: 'attendance_record',
      aggregateId: attendanceId,
      eventType: 'attendance.redeemed',
      payload: {
        attendanceId,
        credentialId: credential.id,
        organizationId: scope.organizationId,
        ...(credential.booking_id !== null ? { bookingId: credential.booking_id } : {}),
        ...(context.consumingEntitlementId !== null
          ? { entitlementId: context.consumingEntitlementId }
          : {}),
      },
    });
    if (exhaustedNow) {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'entitlement.exhausted',
        entityType: 'entitlement',
        entityId: context.consumingEntitlementId!,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'entitlement',
        aggregateId: context.consumingEntitlementId!,
        eventType: 'entitlement.exhausted',
        payload: { entitlementId: context.consumingEntitlementId! },
      });
    }
    deps.onRedeemPhase?.('beforeCommit');

    return {
      kind: 'attendanceRecorded',
      attendance: {
        attendanceId,
        credentialId: credential.id,
        participantFirstName: context.participantFirstName,
        programTitle: context.programTitle,
        targetKind: context.targetKind,
        occurredAt: occurred.rows[0]!.occurred_at.toISOString(),
        ...(context.occurrenceDate !== undefined
          ? { occurrenceDate: context.occurrenceDate }
          : {}),
        ...(context.occurrenceStartTime !== undefined
          ? { occurrenceStartTime: context.occurrenceStartTime }
          : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(exhaustedNow ? { entitlementExhausted: true } : {}),
      },
    };
  });
  if (run.kind === 'idempotencyConflict') {
    return { replayed: false, outcome: { kind: 'idempotencyConflict' } };
  }
  return { replayed: run.kind === 'replayed', outcome: run.result };
}
