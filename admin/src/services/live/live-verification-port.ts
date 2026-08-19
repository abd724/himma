import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  AdminVerificationPort,
  CaseReadiness,
  EvidenceDownloadOutcome,
  OrganizationVerificationView,
  VerificationActionOutcome,
  VerificationCaseView,
  VerificationViewOutcome,
} from '../../verification/contract';

/**
 * LIVE verification review port (W3-5) over the REAL
 * `/admin/organizations/:id/verification` surface and the W3-4 evidence
 * download boundary. Fail-closed DTO validation; every typed backend
 * refusal maps to its own outcome (safety, policy, readiness with the
 * structured missing list, case/lifecycle conflicts, stale versions,
 * step-up) — the reviewer always sees the true reason. In live production
 * today, review/decision actions surface `safetyUnavailable`: the W3-4
 * content-safety capability cannot exist yet, and this port never
 * pretends otherwise.
 */

function readinessFrom(raw: unknown): CaseReadiness | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'ready') return { kind: 'ready' };
  if (kind === 'policyUnavailable') return { kind: 'policyUnavailable' };
  if (kind === 'missingRequirements') {
    const missing = (raw as { missing?: unknown }).missing;
    if (!Array.isArray(missing)) return null;
    const entries: Array<{ requirementKey: string; labelEn: string }> = [];
    for (const entry of missing) {
      const item = entry as Record<string, unknown>;
      if (typeof item.requirementKey !== 'string' || typeof item.labelEn !== 'string') {
        return null;
      }
      entries.push({ requirementKey: item.requirementKey, labelEn: item.labelEn });
    }
    return { kind: 'missingRequirements', missing: entries };
  }
  return null;
}

function stringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function caseViewFrom(raw: unknown): VerificationCaseView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const readiness = readinessFrom(record.readiness);
  if (
    typeof record.caseId !== 'string' ||
    typeof record.organizationId !== 'string' ||
    typeof record.round !== 'number' ||
    typeof record.state !== 'string' ||
    typeof record.policyVersion !== 'string' ||
    readiness === null ||
    !Array.isArray(record.requirements) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.version !== 'number'
  ) {
    return null;
  }
  const requirements: VerificationCaseView['requirements'][number][] = [];
  for (const entry of record.requirements) {
    const item = entry as Record<string, unknown>;
    if (
      typeof item.requirementId !== 'string' ||
      typeof item.requirementKey !== 'string' ||
      typeof item.labelEn !== 'string' ||
      !stringOrNull(item.descriptionEn) ||
      typeof item.required !== 'boolean'
    ) {
      return null;
    }
    let currentEvidence: (typeof requirements)[number]['currentEvidence'] = null;
    if (item.currentEvidence !== null) {
      const evidence = item.currentEvidence as Record<string, unknown>;
      if (
        typeof evidence.evidenceId !== 'string' ||
        typeof evidence.state !== 'string' ||
        typeof evidence.originalFilename !== 'string' ||
        typeof evidence.declaredContentType !== 'string' ||
        !(typeof evidence.byteSize === 'number' || evidence.byteSize === null) ||
        !stringOrNull(evidence.storedAt) ||
        typeof evidence.version !== 'number'
      ) {
        return null;
      }
      currentEvidence = {
        evidenceId: evidence.evidenceId,
        state: evidence.state,
        originalFilename: evidence.originalFilename,
        declaredContentType: evidence.declaredContentType,
        byteSize: evidence.byteSize,
        storedAt: evidence.storedAt,
        version: evidence.version,
      };
    }
    requirements.push({
      requirementId: item.requirementId,
      requirementKey: item.requirementKey,
      labelEn: item.labelEn,
      descriptionEn: item.descriptionEn,
      required: item.required,
      currentEvidence,
    });
  }
  let decision: VerificationCaseView['decision'] = null;
  if (record.decision !== null) {
    const raw = record.decision as Record<string, unknown>;
    if (
      typeof raw.outcome !== 'string' ||
      !stringOrNull(raw.reasonCode) ||
      !stringOrNull(raw.providerSafeMessage) ||
      !stringOrNull(raw.internalNote) ||
      typeof raw.decidedBy !== 'string' ||
      typeof raw.decidedAt !== 'string'
    ) {
      return null;
    }
    decision = {
      outcome: raw.outcome,
      reasonCode: raw.reasonCode,
      providerSafeMessage: raw.providerSafeMessage,
      internalNote: raw.internalNote,
      decidedBy: raw.decidedBy,
      decidedAt: raw.decidedAt,
    };
  }
  return {
    caseId: record.caseId,
    organizationId: record.organizationId,
    round: record.round,
    state: record.state,
    policyVersion: record.policyVersion,
    readiness,
    requirements,
    decision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
  };
}

function viewFrom(body: unknown): OrganizationVerificationView | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (
    typeof raw.organizationId !== 'string' ||
    typeof raw.organizationState !== 'string' ||
    typeof raw.organizationVersion !== 'number' ||
    typeof raw.contentSafetyReady !== 'boolean' ||
    typeof raw.policyConfigured !== 'boolean' ||
    !Array.isArray(raw.rounds)
  ) {
    return null;
  }
  const rounds: OrganizationVerificationView['rounds'][number][] = [];
  for (const entry of raw.rounds) {
    const item = entry as Record<string, unknown>;
    if (
      typeof item.caseId !== 'string' ||
      typeof item.round !== 'number' ||
      typeof item.state !== 'string' ||
      !stringOrNull(item.decidedAt) ||
      !stringOrNull(item.outcome)
    ) {
      return null;
    }
    rounds.push({
      caseId: item.caseId,
      round: item.round,
      state: item.state,
      decidedAt: item.decidedAt,
      outcome: item.outcome,
    });
  }
  let latestCase: VerificationCaseView | null = null;
  if (raw.latestCase !== null) {
    latestCase = caseViewFrom(raw.latestCase);
    if (latestCase === null) return null;
  }
  return {
    organizationId: raw.organizationId,
    organizationState: raw.organizationState,
    organizationVersion: raw.organizationVersion,
    contentSafetyReady: raw.contentSafetyReady,
    policyConfigured: raw.policyConfigured,
    rounds,
    latestCase,
  };
}

function actionOutcomeFrom(response: {
  status: number;
  code: string | null;
  body: unknown;
}): VerificationActionOutcome {
  if (response.status === 200) return { kind: 'completed' };
  switch (response.code) {
    case 'stepUpRequired':
      return { kind: 'stepUpRequired' };
    case 'verificationCaseConflict':
      return { kind: 'caseConflict' };
    case 'lifecycleConflict':
      return { kind: 'lifecycleConflict' };
    case 'staleVersion':
      return { kind: 'staleVersion' };
    case 'verificationCaseNotReady': {
      const readiness = readinessFrom({
        kind: 'missingRequirements',
        missing: (response.body as { missing?: unknown } | null)?.missing ?? [],
      });
      return readiness?.kind === 'missingRequirements'
        ? { kind: 'notReady', missing: readiness.missing }
        : { kind: 'notReady', missing: [] };
    }
    case 'verificationEvidenceSafetyUnavailable':
      return { kind: 'safetyUnavailable' };
    case 'verificationPolicyUnavailable':
      return { kind: 'policyUnavailable' };
    case 'invalidVerificationDecision':
      return { kind: 'invalidDecision' };
    case 'forbidden':
      return { kind: 'forbidden' };
    case 'notFound':
      return { kind: 'notFound' };
    default:
      return { kind: 'unavailable' };
  }
}

export function createLiveVerificationPort(transport: LiveTransport): AdminVerificationPort {
  const act = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<VerificationActionOutcome> => {
    const response = await transport.authorizedRequest(path, { method: 'POST', body });
    if (response === null || response.networkFailure) return { kind: 'unavailable' };
    return actionOutcomeFrom(response);
  };

  return {
    async getVerification(organizationId): Promise<VerificationViewOutcome> {
      const response = await transport.authorizedRequest(
        `/admin/organizations/${encodeURIComponent(organizationId)}/verification`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const view = viewFrom(response.body);
        return view === null ? { kind: 'unavailable' } : { kind: 'loaded', view };
      }
      if (response.code === 'forbidden') return { kind: 'forbidden' };
      if (response.status === 404 || response.status === 422) return { kind: 'notFound' };
      return { kind: 'unavailable' };
    },

    openCase(organizationId) {
      return act(
        `/admin/organizations/${encodeURIComponent(organizationId)}/verification/cases`,
        {},
      );
    },

    startReview(organizationId, input) {
      return act(
        `/admin/organizations/${encodeURIComponent(organizationId)}/verification/cases/${encodeURIComponent(input.caseId)}/review`,
        { expectedCaseVersion: input.expectedCaseVersion },
      );
    },

    decide(organizationId, input) {
      return act(
        `/admin/organizations/${encodeURIComponent(organizationId)}/verification/cases/${encodeURIComponent(input.caseId)}/decision`,
        {
          expectedCaseVersion: input.expectedCaseVersion,
          outcome: input.outcome,
          ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
          ...(input.providerSafeMessage !== undefined
            ? { providerSafeMessage: input.providerSafeMessage }
            : {}),
          ...(input.internalNote !== undefined ? { internalNote: input.internalNote } : {}),
        },
      );
    },

    goLive(organizationId, input) {
      return act(`/admin/organizations/${encodeURIComponent(organizationId)}/go-live`, {
        expectedVersion: input.expectedVersion,
      });
    },

    async downloadEvidence(evidenceId): Promise<EvidenceDownloadOutcome> {
      const response = await transport.authorizedBinaryRequest(
        `/admin/verification/evidence/${encodeURIComponent(evidenceId)}/content`,
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200 && response.blob !== null) {
        return {
          kind: 'document',
          blob: response.blob,
          filename: response.filename ?? 'document',
          contentType: response.contentType ?? 'application/octet-stream',
        };
      }
      switch (response.code) {
        case 'verificationEvidenceSafetyUnavailable':
          return { kind: 'safetyUnavailable' };
        case 'forbidden':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };
}
