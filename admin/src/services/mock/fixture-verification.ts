import type {
  AdminVerificationPort,
  CaseReadiness,
  OrganizationVerificationView,
  VerificationActionOutcome,
  VerificationCaseView,
} from '../../verification/contract';
import type {
  FixtureProviderData,
  FixtureOrgRecord,
  FixtureRound,
} from './fixture-providers';
import { fixtureReviewState } from './fixture-providers';

/**
 * Deterministic FIXTURE verification review port (W3-5) — mirrors the
 * SERVER semantics over the shared mutable fixture data so the full
 * journey (open round → start review → decide → the organization's
 * canonical state changes, visible in the directory) is exercisable in
 * tests/demos. Readiness is computed, approval requires readiness AND an
 * explicit decision, rejection requires the machine + provider-safe
 * layers, and the D-W3-5 step-up seam plus the W3-4 content-safety
 * fail-close are both representable through the runtime controls.
 * Live mode can never reach this module (composition-locked).
 */

export interface FixtureVerificationAuthority {
  currentAuthority(): { hasProvidersCapability: boolean } | null;
  takeFailure(): boolean;
  /** The D-W3-5 seam: mutations answer stepUpRequired while demanded. */
  stepUpDemanded(): boolean;
  /** The W3-4 gate: false = review/decision/download refuse (typed). */
  contentSafetyReady(): boolean;
}

function readinessOf(round: FixtureRound): CaseReadiness {
  const missing = round.requirements
    .filter((entry) => entry.required && entry.evidence?.state !== 'stored')
    .map((entry) => ({ requirementKey: entry.requirementKey, labelEn: entry.labelEn }));
  return missing.length === 0 ? { kind: 'ready' } : { kind: 'missingRequirements', missing };
}

function caseViewOf(record: FixtureOrgRecord, round: FixtureRound): VerificationCaseView {
  return {
    caseId: round.caseId,
    organizationId: record.org.id,
    round: round.round,
    state: round.state,
    policyVersion: round.policyVersion,
    readiness: readinessOf(round),
    requirements: round.requirements.map((entry) => ({
      requirementId: entry.requirementId,
      requirementKey: entry.requirementKey,
      labelEn: entry.labelEn,
      descriptionEn: entry.descriptionEn,
      required: entry.required,
      currentEvidence:
        entry.evidence === null
          ? null
          : {
              evidenceId: entry.evidence.evidenceId,
              state: entry.evidence.state,
              originalFilename: entry.evidence.originalFilename,
              declaredContentType: entry.evidence.declaredContentType,
              byteSize: entry.evidence.byteSize,
              storedAt: entry.evidence.storedAt,
              version: entry.evidence.version,
            },
    })),
    decision: round.decision,
    createdAt: round.createdAt,
    updatedAt: round.updatedAt,
    version: round.version,
  };
}

export function createFixtureVerificationPort(
  authority: FixtureVerificationAuthority,
  data: FixtureProviderData,
): AdminVerificationPort {
  const admit = (): VerificationActionOutcome | null => {
    const auth = authority.currentAuthority();
    if (auth === null) return { kind: 'unavailable' };
    if (authority.takeFailure()) return { kind: 'unavailable' };
    if (!auth.hasProvidersCapability) return { kind: 'forbidden' };
    return null;
  };

  const recordOf = (organizationId: string): FixtureOrgRecord | undefined =>
    data.orgs.find((entry) => entry.org.id === organizationId);

  const activeRound = (record: FixtureOrgRecord): FixtureRound | undefined =>
    record.verification.find((round) => round.state === 'open' || round.state === 'in_review');

  return {
    async getVerification(organizationId) {
      const refused = admit();
      if (refused !== null) {
        return refused.kind === 'forbidden' || refused.kind === 'unavailable'
          ? { kind: refused.kind }
          : { kind: 'unavailable' };
      }
      const record = recordOf(organizationId);
      if (record === undefined) return { kind: 'notFound' };
      const rounds = [...record.verification].sort((a, b) => b.round - a.round);
      const latest = rounds[0];
      const view: OrganizationVerificationView = {
        organizationId: record.org.id,
        organizationState: record.org.state,
        organizationVersion: 1,
        contentSafetyReady: authority.contentSafetyReady(),
        policyConfigured: true,
        rounds: rounds.map((round) => ({
          caseId: round.caseId,
          round: round.round,
          state: round.state,
          decidedAt: round.decision?.decidedAt ?? null,
          outcome: round.decision?.outcome ?? null,
        })),
        latestCase: latest === undefined ? null : caseViewOf(record, latest),
      };
      return { kind: 'loaded', view };
    },

    async openCase(organizationId) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      const record = recordOf(organizationId);
      if (record === undefined) return { kind: 'notFound' };
      if (record.org.state !== 'submitted' && record.org.state !== 'in_review') {
        return { kind: 'lifecycleConflict' };
      }
      if (activeRound(record) !== undefined) return { kind: 'caseConflict' };
      const round = record.verification.length + 1;
      const slug = `${record.org.id.replace(/^org-/, '')}-r${round}`;
      record.verification.push({
        caseId: `case-${slug}`,
        round,
        state: 'open',
        policyVersion: 'fixture-policy-v1',
        requirements: [
          {
            requirementId: `req-${slug}-business_document`,
            requirementKey: 'business_document',
            labelEn: 'Business document',
            descriptionEn: null,
            required: true,
            evidence: null,
          },
          {
            requirementId: `req-${slug}-operating_license`,
            requirementKey: 'operating_license',
            labelEn: 'Operating licence',
            descriptionEn: null,
            required: true,
            evidence: null,
          },
          {
            requirementId: `req-${slug}-optional_reference`,
            requirementKey: 'optional_reference',
            labelEn: 'Optional reference',
            descriptionEn: null,
            required: false,
            evidence: null,
          },
        ],
        decision: null,
        createdAt: record.org.updatedAt,
        updatedAt: record.org.updatedAt,
        version: 1,
      });
      return { kind: 'completed' };
    },

    async startReview(organizationId, input) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      if (!authority.contentSafetyReady()) return { kind: 'safetyUnavailable' };
      const record = recordOf(organizationId);
      const round = record?.verification.find((entry) => entry.caseId === input.caseId);
      if (record === undefined || round === undefined) return { kind: 'notFound' };
      if (round.state !== 'open') return { kind: 'caseConflict' };
      if (round.version !== input.expectedCaseVersion) return { kind: 'staleVersion' };
      if (record.org.state === 'submitted') {
        record.org.state = 'in_review';
      } else if (record.org.state !== 'in_review') {
        return { kind: 'lifecycleConflict' };
      }
      round.state = 'in_review';
      round.version += 1;
      return { kind: 'completed' };
    },

    async decide(organizationId, input) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      if (!authority.contentSafetyReady()) return { kind: 'safetyUnavailable' };
      if (
        input.outcome === 'rejected' &&
        (input.reasonCode === undefined || input.providerSafeMessage === undefined)
      ) {
        return { kind: 'invalidDecision' };
      }
      const record = recordOf(organizationId);
      const round = record?.verification.find((entry) => entry.caseId === input.caseId);
      if (record === undefined || round === undefined) return { kind: 'notFound' };
      if (round.state !== 'in_review') return { kind: 'caseConflict' };
      if (round.version !== input.expectedCaseVersion) return { kind: 'staleVersion' };
      if (record.org.state !== 'in_review') return { kind: 'lifecycleConflict' };
      if (input.outcome === 'approved') {
        const readiness = readinessOf(round);
        if (readiness.kind === 'missingRequirements') {
          return { kind: 'notReady', missing: readiness.missing };
        }
      }
      round.state = 'decided';
      round.version += 1;
      round.decision = {
        outcome: input.outcome,
        reasonCode: input.reasonCode ?? null,
        providerSafeMessage: input.providerSafeMessage ?? null,
        internalNote: input.internalNote ?? null,
        decidedBy: 'fixture-ops@himma.demo',
        decidedAt: '2026-08-19T12:00:00.000Z',
      };
      // The canonical organization transition — atomic with the decision,
      // exactly like the server composition.
      record.org.state = input.outcome === 'approved' ? 'verified' : 'rejected';
      return { kind: 'completed' };
    },

    async goLive(organizationId) {
      const refused = admit();
      if (refused !== null) return refused;
      if (authority.stepUpDemanded()) return { kind: 'stepUpRequired' };
      const record = recordOf(organizationId);
      if (record === undefined) return { kind: 'notFound' };
      if (record.org.state !== 'verified') return { kind: 'lifecycleConflict' };
      record.org.state = 'live';
      return { kind: 'completed' };
    },

    async downloadEvidence(evidenceId) {
      const auth = authority.currentAuthority();
      if (auth === null || authority.takeFailure()) return { kind: 'unavailable' };
      if (!auth.hasProvidersCapability) return { kind: 'forbidden' };
      if (!authority.contentSafetyReady()) return { kind: 'safetyUnavailable' };
      for (const record of data.orgs) {
        for (const round of record.verification) {
          for (const requirement of round.requirements) {
            if (
              requirement.evidence?.evidenceId === evidenceId &&
              requirement.evidence.state === 'stored'
            ) {
              return {
                kind: 'document',
                blob: new Blob(
                  [`Fictional fixture document: ${requirement.evidence.originalFilename}`],
                  { type: requirement.evidence.declaredContentType },
                ),
                filename: requirement.evidence.originalFilename,
                contentType: requirement.evidence.declaredContentType,
              };
            }
          }
        }
      }
      return { kind: 'notFound' };
    },
  };
}

/** Directory summaries stay derived from the mutable org state — the
 *  review journey's canonical transitions surface in the queue/directory
 *  exactly as they would against the real backend. */
export { fixtureReviewState };
