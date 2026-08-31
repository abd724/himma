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
 *
 * MULTI-OCCURRENCE TARGETS (S6-3 Final Correction / 0020, docs/35
 * §26–§29): CampWeek/Cohort Bookings require an EXPLICIT canonical
 * occurrence selection (`occurrence: {date, startTime}`) validated against
 * the SHARED derivation authority (occurrence-authority.ts — the same
 * expansion the Calendar uses); Session Bookings and walk-ins refuse one.
 * The −60/+60 issuance window and the already-attended check key on the
 * CANONICAL occurrence instant (Asia/Dubai), never the device clock. The
 * issued credential freezes its occurrence pair for its lifetime; the
 * one-live-credential rule and explicit regeneration operate PER
 * occurrence (adjacent occurrences' windows may legally overlap).
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
import {
  expandCampOccurrences,
  expandCohortOccurrences,
  nextCivilDate,
} from './occurrence-authority';

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
  /** Initial issuance found an effectively-live credential — nothing was
   *  superseded or minted; the caller may explicitly regenerate by id. */
  | {
      kind: 'credentialAlreadyLive';
      credential: { credentialId: string; expiresAt: string };
    }
  /** Regeneration named a credential that is no longer the current live
   *  one (used/superseded/expired or replaced) — nothing changed. */
  | { kind: 'credentialNotCurrent' }
  | { kind: 'credentialNotFound' }
  | { kind: 'bookingNotFound' }
  | { kind: 'bookingNotConfirmed' }
  /** A multi-occurrence (CampWeek/Cohort) Booking without an explicit
   *  occurrence selection — the customer must identify WHICH canonical
   *  occurrence they are attending; nearest-to-now inference never exists
   *  (docs/35 §29: adjacent ±60 windows may overlap). */
  | { kind: 'occurrenceRequired' }
  /** A Session Booking with an occurrence selection — the Session IS its
   *  canonical occurrence; no day selection exists for it. */
  | { kind: 'occurrenceNotApplicable' }
  /** The requested occurrence is not generated by the Booking's canonical
   *  schedule (out-of-span camp date, wrong daily time, non-pattern cohort
   *  meeting, exception date). */
  | { kind: 'occurrenceNotEligible' }
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

/** The canonical scheduled occurrence a multi-occurrence Booking credential
 *  admits (Asia/Dubai civil date + HH:MM start — docs/35 §26–§28). */
export interface OccurrenceSelection {
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
}

export interface IssueCredentialInput {
  target: CredentialTarget;
  /**
   * REQUIRED for CampWeek/Cohort Booking targets (`occurrenceRequired`
   * otherwise) and FORBIDDEN for Session Bookings and walk-in entitlement
   * targets (`occurrenceNotApplicable`). The server derives and validates
   * everything else (branch, participant, program, duration, schedule)
   * from the Booking — the customer can never mint an arbitrary date/time
   * (docs/35 §29).
   */
  occurrence?: OccurrenceSelection;
  idempotencyKey: string;
  /**
   * EXPLICIT regeneration (owner S6-2 correction, rule B): names the
   * current live credential this request intends to replace. Absent →
   * INITIAL issuance semantics (rule A): an effectively-live credential is
   * NEVER superseded — the request returns `credentialAlreadyLive` without
   * secrets. Present → the named credential is locked, proven to be the
   * caller's CURRENT live credential for this exact target, superseded,
   * and replaced; a stale/foreign id changes nothing
   * (`credentialNotCurrent` / not-found shaping).
   */
  regenerateCredentialId?: string;
}

export async function issueRedemptionCredential(
  deps: CredentialServiceDeps,
  actor: CustomerActor,
  input: IssueCredentialInput,
): Promise<IssueCredentialRun> {
  // One bounded retry: two concurrent DIFFERENT-key INITIAL issuances race
  // on the one-live-per-target partial unique; the loser's transaction
  // aborts (key unpoisoned) and its retry finds the winner's live
  // credential → `credentialAlreadyLive` WITHOUT secrets — the winner's
  // displayed credential is never superseded by a race (rule A/D).
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await issueOnce(deps, actor, input);
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof DbError &&
        error.kind === 'uniqueViolation' &&
        (error.constraint === 'uq_redemption_credential_live_session_booking' ||
          error.constraint === 'uq_redemption_credential_live_occurrence' ||
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
  input: IssueCredentialInput,
): Promise<IssueCredentialRun> {
  const ttlSeconds = deps.credentialTtlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS;
  const ctx = {
    principalRef: `customer:${actor.accountId}`,
    endpointScope: ISSUE_SCOPE,
    idempotencyKey: input.idempotencyKey,
    requestDigest: requestDigest({
      target: input.target,
      occurrence: input.occurrence ?? null,
      regenerateCredentialId: input.regenerateCredentialId ?? null,
    }),
  };
  // The out-of-band secret channel: populated ONLY by the executing run.
  let secrets: MintedSecrets | undefined;

  const run = await runIdempotent<IssueCredentialResult>(deps.db, ctx, async (trx) => {
    const targetColumn = input.target.kind === 'booking' ? 'booking_id' : 'entitlement_id';
    const targetId =
      input.target.kind === 'booking' ? input.target.bookingId : input.target.entitlementId;

    // 1. Credential-lock phase (credential precedes entitlement in the
    //    canonical order — this also serializes against redemption).
    let supersedeIds: string[] = [];
    if (input.regenerateCredentialId !== undefined) {
      // EXPLICIT REGENERATION (rule B): lock the NAMED credential and prove
      // it is the caller's CURRENT live credential for this exact target —
      // including, for multi-occurrence Bookings, this exact OCCURRENCE
      // (the credential's frozen pair; docs/35 §28).
      const named = await sql<{
        id: string;
        state: string;
        account_id: string;
        entitlement_id: string | null;
        booking_id: string | null;
        occurrence_date: string | null;
        occurrence_start_time: string | null;
      }>`
        SELECT id, state, account_id, entitlement_id, booking_id,
               occurrence_date::text, occurrence_start_time::text
        FROM redemption_credential WHERE id = ${input.regenerateCredentialId}
        FOR UPDATE`.execute(trx);
      const row = named.rows[0];
      if (row === undefined || row.account_id !== actor.accountId) {
        return { kind: 'credentialNotFound' };
      }
      const namedTargetId = row.booking_id ?? row.entitlement_id;
      if (namedTargetId !== targetId) return { kind: 'credentialNotFound' };
      const namedOccurrence =
        row.occurrence_date === null
          ? null
          : `${row.occurrence_date}:${row.occurrence_start_time!.slice(0, 5)}`;
      const requestedOccurrence =
        input.occurrence === undefined
          ? null
          : `${input.occurrence.date}:${input.occurrence.startTime}`;
      if (namedOccurrence !== requestedOccurrence) return { kind: 'credentialNotFound' };
      // A stale/superseded/used id can never supersede its replacement —
      // the row's CURRENT state decides, under its lock (rule B/C/H).
      if (row.state !== 'live') return { kind: 'credentialNotCurrent' };
      supersedeIds = [row.id];
    } else {
      // INITIAL ISSUANCE (rule A): lock any live-state rows for the target
      // — occurrence-scoped for multi-occurrence Bookings (each canonical
      // occurrence has its own one-live-credential truth; a live Monday
      // credential never blocks issuing Tuesday's). FOR UPDATE re-evaluates
      // under READ COMMITTED, so a row superseded while we waited is
      // excluded — what remains is the CURRENT truth.
      const occurrenceScope =
        input.target.kind !== 'booking'
          ? sql``
          : input.occurrence === undefined
            ? sql`AND occurrence_date IS NULL`
            : sql`AND occurrence_date = ${input.occurrence.date}
                  AND occurrence_start_time = ${input.occurrence.startTime}`;
      const existing = await sql<{ id: string; lapsed: boolean }>`
        SELECT id, (expires_at <= now()) AS lapsed FROM redemption_credential
        WHERE ${sql.id(targetColumn)} = ${targetId} AND state = 'live' ${occurrenceScope}
        FOR UPDATE`.execute(trx);
      const effectivelyLive = existing.rows.find((row) => !row.lapsed);
      if (effectivelyLive !== undefined) {
        // NEVER superseded by a plain issuance — the customer displaying it
        // keeps a valid credential; recovery is metadata + explicit
        // regeneration (rules A/E).
        const meta = await sql<{ expires_at: Date }>`
          SELECT expires_at FROM redemption_credential
          WHERE id = ${effectivelyLive.id}`.execute(trx);
        return {
          kind: 'credentialAlreadyLive',
          credential: {
            credentialId: effectivelyLive.id,
            expiresAt: meta.rows[0]!.expires_at.toISOString(),
          },
        };
      }
      // Effectively-EXPIRED stale live rows (rule F): terminalize truthfully
      // under their lock and issue fresh — sweeper-free, and serialized
      // against provider redemption at the expiry boundary by the same lock.
      for (const stale of existing.rows) {
        await trx
          .updateTable('redemption_credential')
          .set({ state: 'expired' })
          .where('id', '=', stale.id)
          .where('state', '=', 'live')
          .execute();
      }
    }

    // 2. Target resolution + eligibility (all server-clock authority).
    let organizationId: string;
    let branchId: string | null;
    let participantId: string;
    let sessionId: string | null = null;
    let occurrence: OccurrenceSelection | null = null;
    if (input.target.kind === 'booking') {
      const before = deps.checkInWindowBeforeMinutes ?? DEFAULT_CHECK_IN_WINDOW_BEFORE_MINUTES;
      const after = deps.checkInWindowAfterMinutes ?? DEFAULT_CHECK_IN_WINDOW_AFTER_MINUTES;
      const booking = await sql<{
        id: string;
        account_id: string;
        participant_id: string;
        organization_id: string;
        state: string;
        session_id: string | null;
        camp_week_id: string | null;
        cohort_id: string | null;
        start_at: Date | null;
        session_branch_id: string | null;
        session_window_open: boolean | null;
        session_attended: boolean;
        cw_start: string | null;
        cw_end: string | null;
        cw_daily_start: string | null;
        cw_branch_id: string | null;
        ec_start: string | null;
        ec_end: string | null;
        ec_branch_id: string | null;
      }>`
        SELECT b.id, b.account_id, b.participant_id, b.organization_id, b.state,
               b.session_id, b.camp_week_id, b.cohort_id,
               s.start_at, s.branch_id AS session_branch_id,
               (now() >= s.start_at - make_interval(mins => ${before})
                AND now() <= s.start_at + make_interval(mins => ${after}))
                 AS session_window_open,
               EXISTS (SELECT 1 FROM attendance_record ar
                        WHERE ar.booking_id = b.id AND ar.session_id IS NOT NULL)
                 AS session_attended,
               cw.start_date::text AS cw_start, cw.end_date::text AS cw_end,
               cw.daily_start_time::text AS cw_daily_start, cw.branch_id AS cw_branch_id,
               ec.effective_start::text AS ec_start, ec.effective_end::text AS ec_end,
               ec.branch_id AS ec_branch_id
        FROM booking b
        LEFT JOIN session s ON s.id = b.session_id
        LEFT JOIN camp_week cw ON cw.id = b.camp_week_id
        LEFT JOIN enrolment_cohort ec ON ec.id = b.cohort_id
        WHERE b.id = ${input.target.bookingId}`.execute(trx);
      const row = booking.rows[0];
      if (row === undefined || row.account_id !== actor.accountId) {
        return { kind: 'bookingNotFound' };
      }
      if (row.state !== 'confirmed') return { kind: 'bookingNotConfirmed' };
      if (row.session_id !== null) {
        // Session Booking: the Session IS the canonical occurrence — an
        // occurrence selection is meaningless and refused (docs/35 §29).
        if (input.occurrence !== undefined) return { kind: 'occurrenceNotApplicable' };
        if (row.session_attended) return { kind: 'alreadyCheckedIn' };
        if (row.session_window_open !== true) return { kind: 'outsideCheckInWindow' };
        branchId = row.session_branch_id;
        sessionId = row.session_id;
      } else {
        // Multi-occurrence (CampWeek/Cohort) Booking: the customer names
        // the canonical occurrence explicitly — nearest-to-now inference
        // never exists (overlapping ±60 windows would make it ambiguous).
        if (input.occurrence === undefined) return { kind: 'occurrenceRequired' };
        const requested = input.occurrence;
        if (row.camp_week_id !== null) {
          // CampWeek: every span civil date at the single daily window
          // (docs/35 §26 — no closure days exist in V1; none invented).
          const eligible = expandCampOccurrences(
            {
              startDate: row.cw_start!,
              endDate: row.cw_end!,
              dailyStartTime: row.cw_daily_start!,
              dailyEndTime: row.cw_daily_start!,
            },
            requested.date,
            nextCivilDate(requested.date),
          ).some((candidate) => candidate.startTime === requested.startTime);
          if (!eligible) return { kind: 'occurrenceNotEligible' };
          branchId = row.cw_branch_id;
        } else {
          // Cohort: the CURRENT canonical schedule derivation — the SAME
          // authority the Calendar expands with (occurrence-authority.ts).
          // Once issued, the credential's pair is frozen: later schedule
          // edits retarget nothing (owner ruling, docs/35 closure record).
          const schedules = await sql<{
            weekdays: number[];
            start_time: string;
            end_time: string;
            effective_start: string;
            effective_end: string | null;
            exception_dates: string[];
          }>`
            SELECT rs.weekdays, rs.start_time::text, rs.end_time::text,
                   rs.effective_start::text, rs.effective_end::text,
                   rs.exception_dates::text[] AS exception_dates
            FROM enrolment_cohort_schedule ecs
            JOIN recurring_schedule rs ON rs.id = ecs.schedule_id
            WHERE ecs.cohort_id = ${row.cohort_id!}
              AND ecs.active = true AND rs.state = 'active'`.execute(trx);
          const eligible = expandCohortOccurrences(
            schedules.rows,
            { effectiveStart: row.ec_start!, effectiveEnd: row.ec_end! },
            requested.date,
            nextCivilDate(requested.date),
          ).some((candidate) => candidate.startTime === requested.startTime);
          if (!eligible) return { kind: 'occurrenceNotEligible' };
          branchId = row.ec_branch_id;
        }
        // Already-attended + issuance window, keyed on the CANONICAL
        // occurrence instant (Asia/Dubai) — never the device clock and
        // never the redemption timestamp (docs/35 §28; cross-midnight).
        const gate = await sql<{ window_open: boolean; attended: boolean }>`
          SELECT (now() >= ((${requested.date}::date + ${requested.startTime}::time)
                            AT TIME ZONE 'Asia/Dubai') - make_interval(mins => ${before})
                  AND now() <= ((${requested.date}::date + ${requested.startTime}::time)
                            AT TIME ZONE 'Asia/Dubai') + make_interval(mins => ${after}))
                   AS window_open,
                 EXISTS (SELECT 1 FROM attendance_record ar
                          WHERE ar.booking_id = ${row.id}
                            AND ar.occurrence_date = ${requested.date}
                            AND ar.occurrence_start_time = ${requested.startTime})
                   AS attended`.execute(trx);
        if (gate.rows[0]!.attended) return { kind: 'alreadyCheckedIn' };
        if (!gate.rows[0]!.window_open) return { kind: 'outsideCheckInWindow' };
        occurrence = requested;
      }
      organizationId = row.organization_id;
      participantId = row.participant_id;
    } else {
      // Walk-in entitlement target: no occurrence exists to select.
      if (input.occurrence !== undefined) return { kind: 'occurrenceNotApplicable' };
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

    // 3. Explicit regeneration only: the NAMED current credential — locked
    //    and verified in step 1 — becomes permanently unusable.
    for (const previousId of supersedeIds) {
      const moved = await trx
        .updateTable('redemption_credential')
        .set({ state: 'superseded' })
        .where('id', '=', previousId)
        .where('state', '=', 'live')
        .executeTakeFirst();
      if ((moved.numUpdatedRows ?? 0n) !== 1n) {
        throw new Error(`credential ${previousId} supersede CAS lost under lock — impossible`);
      }
      await appendAuditEvent(trx, {
        actorType: 'user',
        actorId: actor.accountId,
        principalContext: 'customer',
        action: 'credential.superseded',
        entityType: 'redemption_credential',
        entityId: previousId,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'redemption_credential',
        aggregateId: previousId,
        eventType: 'credential.superseded',
        payload: { credentialId: previousId, organizationId },
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
         occurrence_date, occurrence_start_time,
         account_id, participant_id, organization_id, branch_id, expires_at)
      VALUES (${credentialId}, ${credentialTokenDigest(token)},
              ${credentialAliasDigest(organizationId, displayCode)},
              ${input.target.kind === 'entitlement' ? targetId : null},
              ${input.target.kind === 'booking' ? targetId : null},
              ${sessionId}, ${occurrence?.date ?? null}, ${occurrence?.startTime ?? null},
              ${actor.accountId}, ${participantId}, ${organizationId},
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
  /** The frozen canonical occurrence (multi-occurrence Bookings only). */
  occurrence?: OccurrenceSelection;
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
    const rows = await sql<{
      id: string;
      state: string;
      expires_at: Date;
      used_at: Date | null;
      entitlement_id: string | null;
      booking_id: string | null;
      occurrence_date: string | null;
      occurrence_start_time: string | null;
      db_now: Date;
    }>`
      SELECT id, state, expires_at, used_at, entitlement_id, booking_id,
             occurrence_date::text, occurrence_start_time::text, now() AS db_now
      FROM redemption_credential
      WHERE id = ${input.credentialId} AND account_id = ${actor.accountId}`.execute(trx);
    const row = rows.rows[0];
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
        ...(row.occurrence_date !== null
          ? {
              occurrence: {
                date: row.occurrence_date,
                startTime: row.occurrence_start_time!.slice(0, 5),
              },
            }
          : {}),
      },
    };
  });
}
