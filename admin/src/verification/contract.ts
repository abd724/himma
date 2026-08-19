/**
 * W3-5 verification review contract — the typed frontend mirror of the
 * backend's `/admin/organizations/:id/verification` surface. Internal
 * ADMIN data only (this is not the provider-safe seam): it may carry
 * internal notes and reviewer-relevant truth, but NEVER storage refs,
 * digests, keys, or credentials — the backend never sends them.
 */

export type CaseReadiness =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'missingRequirements';
      readonly missing: ReadonlyArray<{ readonly requirementKey: string; readonly labelEn: string }>;
    }
  | { readonly kind: 'policyUnavailable' };

export interface VerificationRequirementView {
  readonly requirementId: string;
  readonly requirementKey: string;
  readonly labelEn: string;
  readonly descriptionEn: string | null;
  readonly required: boolean;
  readonly currentEvidence: {
    readonly evidenceId: string;
    readonly state: string;
    readonly originalFilename: string;
    readonly declaredContentType: string;
    readonly byteSize: number | null;
    readonly storedAt: string | null;
    readonly version: number;
  } | null;
}

export interface VerificationCaseView {
  readonly caseId: string;
  readonly organizationId: string;
  readonly round: number;
  readonly state: string;
  readonly policyVersion: string;
  readonly readiness: CaseReadiness;
  readonly requirements: readonly VerificationRequirementView[];
  readonly decision: {
    readonly outcome: string;
    readonly reasonCode: string | null;
    readonly providerSafeMessage: string | null;
    readonly internalNote: string | null;
    readonly decidedBy: string;
    readonly decidedAt: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface OrganizationVerificationView {
  readonly organizationId: string;
  readonly organizationState: string;
  readonly organizationVersion: number;
  readonly contentSafetyReady: boolean;
  readonly policyConfigured: boolean;
  readonly rounds: ReadonlyArray<{
    readonly caseId: string;
    readonly round: number;
    readonly state: string;
    readonly decidedAt: string | null;
    readonly outcome: string | null;
  }>;
  readonly latestCase: VerificationCaseView | null;
}

export type VerificationViewOutcome =
  | { readonly kind: 'loaded'; readonly view: OrganizationVerificationView }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/** Typed action refusals — the backend's distinct conditions, never
 *  collapsed (the reviewer must see WHY, truthfully). */
export type VerificationActionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'stepUpRequired' }
  | { readonly kind: 'caseConflict' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | {
      readonly kind: 'notReady';
      readonly missing: ReadonlyArray<{ readonly requirementKey: string; readonly labelEn: string }>;
    }
  | { readonly kind: 'safetyUnavailable' }
  | { readonly kind: 'policyUnavailable' }
  | { readonly kind: 'invalidDecision' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type EvidenceDownloadOutcome =
  | {
      readonly kind: 'document';
      readonly blob: Blob;
      readonly filename: string;
      readonly contentType: string;
    }
  | { readonly kind: 'safetyUnavailable' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface DecideInput {
  readonly caseId: string;
  readonly expectedCaseVersion: number;
  readonly outcome: 'approved' | 'rejected';
  readonly reasonCode?: string;
  readonly providerSafeMessage?: string;
  readonly internalNote?: string;
}

export interface AdminVerificationPort {
  getVerification(organizationId: string): Promise<VerificationViewOutcome>;
  openCase(organizationId: string): Promise<VerificationActionOutcome>;
  startReview(
    organizationId: string,
    input: { caseId: string; expectedCaseVersion: number },
  ): Promise<VerificationActionOutcome>;
  decide(organizationId: string, input: DecideInput): Promise<VerificationActionOutcome>;
  /** The existing certified go-live edge (verified → live). */
  goLive(
    organizationId: string,
    input: { expectedVersion: number },
  ): Promise<VerificationActionOutcome>;
  downloadEvidence(evidenceId: string): Promise<EvidenceDownloadOutcome>;
}
