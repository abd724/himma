import type { BranchScope, ProviderRole } from '../provider-access/contract';

/**
 * Business/storefront profile seam — mirrors the two REAL provider-private
 * endpoints field-for-field (task §18; W2-12 replaces the fixture behind
 * this same contract):
 *
 * - `loadOrganizationView` ⇄ `GET /provider/organizations/:organizationId`
 *   (capability `org.read`) — the private management record. `legalName`
 *   is present only when the membership holds `org.legal.view`;
 *   `commercialTermsRef` only with `commercial_terms.view` (the backend
 *   shapes the response per capability; the frontend never re-derives it).
 * - `updateProfile` ⇄ `PATCH /provider/organizations/:organizationId/profile`
 *   (capability `profile.edit` — owner + org_manager in the canonical
 *   registry). The body carries the REQUIRED `expectedVersion` (the public
 *   profile row's own version — optimistic concurrency, CAS server-side)
 *   plus only the fields being changed. `published` is a field of this same
 *   PATCH — storefront publication has NO separate endpoint; effective
 *   public visibility additionally requires `verificationState === 'live'`
 *   (admin-controlled go-live), never the flag alone.
 *
 * Nothing here exists that the real backend does not return or accept.
 */

export interface OrganizationRecord {
  readonly id: string;
  readonly tradeName: string;
  /** PRIVATE legal identity; present only with `org.legal.view`. */
  readonly legalName?: string;
  readonly orgKind: string;
  /** organization.verification_state — canonical vocabulary. */
  readonly verificationState: string;
  /** Present only with `commercial_terms.view`; content is a later slice. */
  readonly commercialTermsRef?: string | null;
  readonly version: number;
}

export interface PublicProfileRecord {
  readonly displayName: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly logoMediaRef: string | null;
  readonly coverMediaRef: string | null;
  readonly galleryMediaRefs: readonly string[];
  readonly publicPhone: string | null;
  readonly publicEmail: string | null;
  readonly publicWebsite: string | null;
  readonly publicInstagram: string | null;
  readonly published: boolean;
  readonly version: number;
}

export interface BranchRecord {
  readonly id: string;
  readonly label: string;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly areaLabel: string;
  readonly geoPoint: { readonly longitude: number; readonly latitude: number } | null;
  /** Structured weekly hours; display formatting is a later (W2-5) concern. */
  readonly openingHours: unknown;
  readonly facilities: readonly string[];
  readonly active: boolean;
  readonly version: number;
}

export interface OrganizationView {
  readonly organization: OrganizationRecord;
  readonly profile: PublicProfileRecord;
  readonly branches: readonly BranchRecord[];
  readonly membership: {
    readonly id: string;
    readonly role: ProviderRole;
    readonly branchScope: BranchScope;
    readonly capabilities: readonly string[];
  };
}

export type OrganizationViewOutcome =
  | { readonly kind: 'loaded'; readonly view: OrganizationView }
  /** Unknown org OR no membership — canonically not-found-shaped. */
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

/**
 * The PATCH body minus `expectedVersion` — only canonically provider-mutable
 * fields. `null` clears a nullable field; an absent key leaves it unchanged.
 * Media refs are accepted by the real PATCH but no provider media workflow
 * exists yet (no upload/library backend), so W2-4 never sends them.
 */
export interface ProfilePatch {
  readonly displayName?: string;
  readonly descriptionEn?: string | null;
  readonly descriptionAr?: string | null;
  readonly publicPhone?: string | null;
  readonly publicEmail?: string | null;
  readonly publicWebsite?: string | null;
  readonly publicInstagram?: string | null;
  readonly published?: boolean;
}

export type UpdateProfileOutcome =
  | { readonly kind: 'profileUpdated'; readonly version: number }
  /** Another writer saved first (CAS refusal) — never overwrite silently. */
  | { readonly kind: 'staleVersion' }
  /** Server-side schema refusal (422 validationError). */
  | { readonly kind: 'validationError' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface OrganizationProfilePort {
  loadOrganizationView(organizationId: string): Promise<OrganizationViewOutcome>;
  updateProfile(
    organizationId: string,
    expectedVersion: number,
    patch: ProfilePatch,
  ): Promise<UpdateProfileOutcome>;
}
