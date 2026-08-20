import type { ProviderRole } from '../provider-access/contract';
import type { VerificationProjection } from '../profile/contract';

/**
 * Onboarding/readiness read model — an explicit COMPOSITION of real
 * endpoints, not a pretend single API (task §21). At W2-12 the port is
 * implemented over:
 * - `GET /provider/organizations/:organizationId` (organization identity +
 *   verificationState + version, profile displayName/published, branches
 *   with `active`, membership role/capabilities), and
 * - `GET /provider/organizations/:organizationId/listings` (listing count,
 *   only where the membership holds `catalogue.read`).
 * Field names below mirror those contracts exactly; nothing here exists
 * that the real backend does not return.
 */
export interface OnboardingSnapshot {
  readonly organization: {
    readonly id: string;
    readonly tradeName: string;
    /** organization.verification_state — canonical vocabulary. */
    readonly verificationState: string;
    readonly version: number;
  };
  readonly profile: {
    readonly displayName: string;
    readonly published: boolean;
  };
  readonly branches: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly active: boolean;
  }>;
  readonly membership: {
    readonly role: ProviderRole;
    readonly capabilities: readonly string[];
  };
  /** Null when the membership cannot read the catalogue (`catalogue.read`). */
  readonly listingCount: number | null;
  /** W3-8 (docs/31 §5): the provider-safe verification projection from the
   *  org view — null when no review round has ever existed. The only
   *  reviewer text it can ever carry is the provider-safe message; internal
   *  notes and reviewer identity are unselectable server-side. */
  readonly verification: VerificationProjection | null;
}

export type OnboardingSnapshotOutcome =
  | { readonly kind: 'loaded'; readonly snapshot: OnboardingSnapshot }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/**
 * Mirrors `POST /provider/organizations/:organizationId/submit` — the only
 * provider-triggerable verification transition (draft|rejected → submitted).
 */
export type SubmitForVerificationOutcome =
  | { readonly kind: 'organizationSubmitted'; readonly version: number }
  | { readonly kind: 'organizationIncomplete' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export interface OnboardingPort {
  loadSnapshot(organizationId: string): Promise<OnboardingSnapshotOutcome>;
  submitForVerification(
    organizationId: string,
    expectedVersion: number,
  ): Promise<SubmitForVerificationOutcome>;
}
