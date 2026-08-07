import type { BranchRecord } from '../profile/contract';

/**
 * Branch management seam — mirrors the REAL provider-private branch routes
 * (backend/src/modules/provider/http/provider-routes.ts) field for field.
 * W2-12 implements this port over the live API; until then the semantic
 * fixture stands behind the same contract.
 *
 * - `createBranch`     ⇄ `POST  /provider/organizations/:orgId/branches`
 *   (capability `branch.create` — owner + org_manager; org-wide by nature).
 * - `updateBranch`     ⇄ `PATCH /provider/organizations/:orgId/branches/:branchId`
 *   (capability `branch.edit` — owner + org_manager org-wide; branch_manager
 *   on explicitly assigned ACTIVE branches only, `forbidden` otherwise).
 * - `deactivateBranch` ⇄ `POST  .../branches/:branchId/deactivate`
 *   (capability `branch.deactivate` — owner + org_manager). Idempotent on an
 *   already-inactive branch; deactivate-only — branches are NEVER deleted.
 *
 * Deliberately absent because the real backend has no such operation:
 * - no branch LIST/GET route — branch reads come from the org view
 *   (`GET /provider/organizations/:organizationId` → `branches[]`, already
 *   behind `OrganizationProfilePort.loadOrganizationView`); W2-5 composes
 *   over that same read (a frontend composition, not a new endpoint).
 * - no REACTIVATION — neither the PATCH body nor any other provider (or
 *   admin) route accepts `active`; deactivation is one-way today.
 * - no DELETE, no transfer between organizations, no bulk operation.
 *
 * `areaLabel` is a plain string (1–80): the real branch contract carries the
 * denormalized area display label; `branch.area_id` exists in the schema but
 * no provider route reads or writes it (label→area reconciliation is
 * registered backend/taxonomy-admin work). The area PICKER sources labels
 * from the canonical area taxonomy read (see taxonomy/contract.ts) — the
 * portal never invents area vocabulary.
 */

export interface GeoPoint {
  readonly longitude: number;
  readonly latitude: number;
}

/** Exact TypeBox limits from the real route bodies. */
export const BRANCH_FIELD_LIMITS = {
  label: 120,
  areaLabel: 80,
  addressLine: 240,
  city: 80,
  facilityLength: 40,
  facilitiesCount: 20,
} as const;

/** `POST .../branches` body — label + areaLabel required, rest optional. */
export interface BranchInput {
  readonly label: string;
  readonly areaLabel: string;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly geoPoint?: GeoPoint | null;
  readonly openingHours?: unknown;
  readonly facilities?: readonly string[];
}

/** `PATCH .../branches/:branchId` body minus `expectedVersion` — every field
 *  optional; an absent key leaves the field unchanged (dirty-field PATCH). */
export interface BranchPatch {
  readonly label?: string;
  readonly areaLabel?: string;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly geoPoint?: GeoPoint | null;
  readonly openingHours?: unknown;
  readonly facilities?: readonly string[];
}

export type CreateBranchOutcome =
  | { readonly kind: 'branchCreated'; readonly branch: BranchRecord }
  /** Server-side schema refusal (422). */
  | { readonly kind: 'validationError' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  /** Unknown org OR no membership — canonically not-found-shaped. */
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type UpdateBranchOutcome =
  | { readonly kind: 'branchUpdated'; readonly branch: BranchRecord }
  /** Another writer saved first (CAS refusal) — never overwrite silently. */
  | { readonly kind: 'staleVersion' }
  | { readonly kind: 'validationError' }
  | { readonly kind: 'organizationSuspended' }
  /** Right organization, insufficient capability or branch scope. */
  | { readonly kind: 'forbidden' }
  /** Unknown org/branch or a foreign organization's branch id — one shape. */
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type DeactivateBranchOutcome =
  | { readonly kind: 'branchDeactivated' }
  | { readonly kind: 'staleVersion' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface BranchPort {
  createBranch(organizationId: string, input: BranchInput): Promise<CreateBranchOutcome>;
  updateBranch(
    organizationId: string,
    branchId: string,
    expectedVersion: number,
    patch: BranchPatch,
  ): Promise<UpdateBranchOutcome>;
  deactivateBranch(
    organizationId: string,
    branchId: string,
    expectedVersion: number,
  ): Promise<DeactivateBranchOutcome>;
}
