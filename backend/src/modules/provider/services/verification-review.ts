/**
 * Verification review/decision integration (W3-5; docs/31) — the ONE
 * authoritative path: case → readiness → review ownership → decision →
 * canonical organization transition.
 *
 * Composition rules (binding):
 * - W3-3 stays the domain authority (case/evidence/readiness/decision);
 *   the ORGANIZATION aggregate stays the lifecycle authority. This module
 *   composes the two inside ONE transaction through their shared internal
 *   cores (`recordDecisionForLockedCaseInTrx`,
 *   `transitionOrganizationInTrx`) — no second state machine, no second
 *   transaction path, no way for a decision and its lifecycle effect to
 *   diverge.
 * - CONTENT SAFETY IS MANDATORY (W3-4 owner correction): beginning a
 *   review and recording ANY evidence-based decision refuse with the typed
 *   `evidenceSafetyUnavailable` while the content-safety capability is
 *   unavailable — which is the ONLY production-representable state until
 *   real scanning exists (build-app refuses a production `true`). The
 *   production review path is therefore inoperable by construction; test
 *   compositions set the capability ready to certify the full mechanics.
 * - READINESS IS NECESSARY, NOT SUFFICIENT: approval additionally requires
 *   an explicit reviewer decision, and a case that is merely `ready` never
 *   transitions anything. Approval REQUIRES readiness (`ready`); rejection
 *   is legal regardless of readiness (incomplete evidence is a legitimate
 *   rejection ground) and drives the organization's `reject` edge.
 * - D-S3-3 disposition (deliberate, NOT deletion): the placeholder flag
 *   stays on the standalone verify/go-live edges as production
 *   defense-in-depth. The composed decision path never reaches that gate
 *   in production because the content-safety gate refuses first — so the
 *   real prerequisite chain (case + policy + readiness + safety + explicit
 *   decision) is the only road to `verified`, and it is closed until the
 *   scanning capability truthfully exists.
 *
 * Authorization: operations role fresh per transaction (the W3-1..W3-3
 * pattern); no verification-specific role exists. Route policy for these
 * mutations is `adminStepUp` — the safer existing boundary — because
 * D-W3-5 (the final high-risk step-up set) remains an owner decision.
 */
import { withTransaction } from '../../../db/transaction';
import type { Db } from '../../../db/kysely';
import type { Trx } from '../../../db/transaction';
import type { NodeEnv } from '../../../config/env';
import { listActiveRoles } from '../../identity/persistence/admin-role-repository';
import {
  transitionOrganizationInTrx,
  type TransitionOrganizationResult,
} from './organization-admin';
import {
  evaluateCaseReadiness,
  recordDecisionForLockedCaseInTrx,
  getInternalVerificationCaseView,
  type InternalVerificationCaseView,
  type VerificationDecisionOutcome,
} from './verification-case';

export interface VerificationReviewDeps {
  db: Db;
  lifecycle: {
    nodeEnv: NodeEnv;
    verificationEvidenceCapabilityReady: boolean;
  };
  /** W3-4 content-safety capability — false in every production build. */
  contentSafetyReady: boolean;
}

export interface ReviewActor {
  userId: string;
}

async function hasOperationsRole(trx: Trx, userId: string): Promise<boolean> {
  return (await listActiveRoles(trx, userId)).includes('operations');
}

async function lockCaseWithOrg(
  trx: Trx,
  caseId: string,
): Promise<
  | {
      id: string;
      organization_id: string;
      round: number;
      state: string;
      version: number;
    }
  | undefined
> {
  return trx
    .selectFrom('verification_case')
    .select(['id', 'organization_id', 'round', 'state', 'version'])
    .where('id', '=', caseId)
    .forUpdate()
    .executeTakeFirst();
}

// -- begin review (case in_review + org start_review where needed) ------------

export type BeginVerificationReviewResult =
  | { kind: 'reviewStarted'; caseVersion: number; organizationState: string }
  | { kind: 'forbidden' }
  | { kind: 'caseNotFound' }
  | { kind: 'caseStateConflict' }
  | { kind: 'organizationStateConflict' }
  | { kind: 'staleVersion' }
  | { kind: 'evidenceSafetyUnavailable' };

/**
 * The reviewer takes ownership of an OPEN round: the case moves to
 * `in_review`, and if the organization is still `submitted` its canonical
 * `start_review` edge runs in the SAME transaction (one authoritative
 * path). Refused while content safety is unavailable — a reviewer must
 * never own a review whose evidence they cannot safely open.
 */
export async function beginVerificationReview(
  deps: VerificationReviewDeps,
  actor: ReviewActor,
  input: { organizationId: string; caseId: string; expectedCaseVersion: number },
): Promise<BeginVerificationReviewResult> {
  if (!deps.contentSafetyReady) return { kind: 'evidenceSafetyUnavailable' };
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const caseRow = await lockCaseWithOrg(trx, input.caseId);
    if (caseRow === undefined || caseRow.organization_id !== input.organizationId) {
      return { kind: 'caseNotFound' as const };
    }
    if (caseRow.state !== 'open') return { kind: 'caseStateConflict' as const };
    if (caseRow.version !== input.expectedCaseVersion) return { kind: 'staleVersion' as const };

    const org = await trx
      .selectFrom('organization')
      .select(['verification_state', 'version'])
      .where('id', '=', caseRow.organization_id)
      .forUpdate()
      .executeTakeFirst();
    if (org === undefined) return { kind: 'organizationStateConflict' as const };
    let organizationState = org.verification_state;
    if (org.verification_state === 'submitted') {
      // The canonical edge, through the ONE lifecycle implementation, with
      // the version read under the same lock (serialized by construction).
      const transitioned = await transitionOrganizationInTrx(trx, deps.lifecycle, actor, {
        organizationId: caseRow.organization_id,
        action: 'start_review',
        expectedVersion: org.version,
      });
      if (transitioned.kind !== 'organizationTransitioned') {
        return { kind: 'organizationStateConflict' as const };
      }
      organizationState = transitioned.state;
    } else if (org.verification_state !== 'in_review') {
      // The organization left the review path concurrently (e.g. directly
      // rejected/offboarded) — the round cannot be owned.
      return { kind: 'organizationStateConflict' as const };
    }

    const updated = await trx
      .updateTable('verification_case')
      .set({ state: 'in_review' })
      .where('id', '=', caseRow.id)
      .where('version', '=', input.expectedCaseVersion)
      .returning('version')
      .executeTakeFirstOrThrow();
    return {
      kind: 'reviewStarted' as const,
      caseVersion: updated.version,
      organizationState,
    };
  });
}

// -- decide (decision + canonical org transition, ONE transaction) ------------

export type DecideVerificationResult =
  | {
      kind: 'verificationDecided';
      decisionId: string;
      caseVersion: number;
      organizationState: string;
      organizationVersion: number;
    }
  | { kind: 'forbidden' }
  | { kind: 'caseNotFound' }
  | { kind: 'caseStateConflict' }
  | { kind: 'staleVersion' }
  | { kind: 'invalidDecision' }
  | { kind: 'evidenceSafetyUnavailable' }
  | { kind: 'policyUnavailable' }
  | {
      kind: 'caseNotReady';
      missing: Array<{ requirementKey: string; labelEn: string }>;
    }
  | { kind: 'organizationStateConflict' };

export async function decideVerification(
  deps: VerificationReviewDeps,
  actor: ReviewActor,
  input: {
    organizationId: string;
    caseId: string;
    expectedCaseVersion: number;
    outcome: VerificationDecisionOutcome;
    reasonCode?: string;
    providerSafeMessage?: string;
    internalNote?: string;
  },
): Promise<DecideVerificationResult> {
  // The W3-4 invariant, FIRST: no evidence-based decision of any kind can
  // complete while content safety is unavailable (all of production today).
  if (!deps.contentSafetyReady) return { kind: 'evidenceSafetyUnavailable' };
  if (
    input.outcome === 'rejected' &&
    (input.reasonCode === undefined || input.providerSafeMessage === undefined)
  ) {
    return { kind: 'invalidDecision' };
  }
  return withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const caseRow = await lockCaseWithOrg(trx, input.caseId);
    if (caseRow === undefined || caseRow.organization_id !== input.organizationId) {
      return { kind: 'caseNotFound' as const };
    }
    if (caseRow.state !== 'in_review') return { kind: 'caseStateConflict' as const };
    if (caseRow.version !== input.expectedCaseVersion) return { kind: 'staleVersion' as const };

    // Approval REQUIRES readiness (explicit decision + complete required
    // evidence); rejection is legal regardless of readiness.
    if (input.outcome === 'approved') {
      const readiness = await evaluateCaseReadiness(trx, caseRow.id);
      if (readiness.kind === 'policyUnavailable' || readiness.kind === 'caseNotFound') {
        return { kind: 'policyUnavailable' as const };
      }
      if (readiness.kind === 'missingRequirements') {
        return { kind: 'caseNotReady' as const, missing: readiness.missing };
      }
    }

    // Lock the organization and run its canonical edge FIRST (it can
    // refuse); the decision insert follows in the same transaction, so the
    // pair commits or rolls back together and can never diverge.
    const org = await trx
      .selectFrom('organization')
      .select(['verification_state', 'version'])
      .where('id', '=', caseRow.organization_id)
      .forUpdate()
      .executeTakeFirst();
    if (org === undefined) return { kind: 'organizationStateConflict' as const };
    const transitioned: TransitionOrganizationResult = await transitionOrganizationInTrx(
      trx,
      deps.lifecycle,
      actor,
      {
        organizationId: caseRow.organization_id,
        action: input.outcome === 'approved' ? 'verify' : 'reject',
        expectedVersion: org.version,
        ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      },
    );
    if (transitioned.kind !== 'organizationTransitioned') {
      // lifecycleConflict = the org is not on the review edge (changed
      // concurrently or reviewed elsewhere); everything rolls back — no
      // partial decision can exist.
      return { kind: 'organizationStateConflict' as const };
    }

    const decided = await recordDecisionForLockedCaseInTrx(trx, actor.userId, caseRow, {
      expectedVersion: input.expectedCaseVersion,
      outcome: input.outcome,
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      ...(input.providerSafeMessage !== undefined
        ? { providerSafeMessage: input.providerSafeMessage }
        : {}),
      ...(input.internalNote !== undefined ? { internalNote: input.internalNote } : {}),
    });
    if (decided.kind !== 'decisionRecorded') {
      // Unreachable given the checks above; surface as a conflict and roll
      // the organization transition back with the same transaction.
      throw new Error(`decision persistence refused: ${decided.kind}`);
    }
    return {
      kind: 'verificationDecided' as const,
      decisionId: decided.decisionId,
      caseVersion: decided.caseVersion,
      organizationState: transitioned.state,
      organizationVersion: transitioned.version,
    };
  });
}

// -- the organization-scoped internal view (reviewer workspace read) ----------

export interface OrganizationVerificationView {
  organizationId: string;
  organizationState: string;
  organizationVersion: number;
  /** Internal truthfulness for the reviewer UI — NEVER provider-visible. */
  contentSafetyReady: boolean;
  policyConfigured: boolean;
  rounds: Array<{
    caseId: string;
    round: number;
    state: string;
    decidedAt: string | null;
    outcome: string | null;
  }>;
  latestCase: InternalVerificationCaseView | null;
}

export type GetOrganizationVerificationViewResult =
  | { kind: 'verificationView'; view: OrganizationVerificationView }
  | { kind: 'forbidden' }
  | { kind: 'organizationNotFound' };

export async function getOrganizationVerificationView(
  deps: VerificationReviewDeps & { policyConfigured: boolean },
  actor: ReviewActor,
  organizationId: string,
): Promise<GetOrganizationVerificationViewResult> {
  const admitted = await withTransaction(deps.db, async (trx) => {
    if (!(await hasOperationsRole(trx, actor.userId))) return { kind: 'forbidden' as const };
    const org = await trx
      .selectFrom('organization')
      .select(['id', 'verification_state', 'version'])
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (org === undefined) return { kind: 'organizationNotFound' as const };
    const rounds = await trx
      .selectFrom('verification_case')
      .leftJoin('verification_decision', 'verification_decision.case_id', 'verification_case.id')
      .select([
        'verification_case.id as case_id',
        'verification_case.round as round',
        'verification_case.state as state',
        'verification_case.decided_at as decided_at',
        'verification_decision.outcome as outcome',
      ])
      .where('verification_case.organization_id', '=', organizationId)
      .orderBy('verification_case.round', 'desc')
      .execute();
    return { kind: 'admitted' as const, org, rounds };
  });
  if (admitted.kind !== 'admitted') return admitted;

  const latestRound = admitted.rounds[0];
  let latestCase: InternalVerificationCaseView | null = null;
  if (latestRound !== undefined) {
    const view = await getInternalVerificationCaseView(
      { db: deps.db },
      actor,
      latestRound.case_id,
    );
    if (view.kind === 'caseView') latestCase = view.view;
  }
  return {
    kind: 'verificationView',
    view: {
      organizationId: admitted.org.id,
      organizationState: admitted.org.verification_state,
      organizationVersion: admitted.org.version,
      contentSafetyReady: deps.contentSafetyReady,
      policyConfigured: deps.policyConfigured,
      rounds: admitted.rounds.map((row) => ({
        caseId: row.case_id,
        round: row.round,
        state: row.state,
        decidedAt: row.decided_at?.toISOString() ?? null,
        outcome: row.outcome,
      })),
      latestCase,
    },
  };
}
