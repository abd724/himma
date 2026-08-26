/**
 * Provider fulfillment-configuration seam — mirrors the two REAL W2-13
 * provider routes (backend/src/modules/entitlement/http/
 * fulfillment-provider-routes.ts) field for field.
 *
 * - `loadFulfillment` ⇄ `GET /provider/organizations/:orgId/programs/
 *   :programId/price-options/:optionId/fulfillment` (`catalogue.read`).
 * - `setFulfillment` ⇄ `PUT …/fulfillment` (`listings.manage` — the exact
 *   certified PRODUCT capability that already owns the parent price
 *   option; `attendance.manage` grants nothing here).
 *
 * The S6-1 IMMUTABLE REVISION model (docs/35 §3): saving NEVER edits terms
 * in place — the backend supersedes the current active revision and
 * inserts the next immutable one. Customers who already purchased remain
 * bound to their historical revision; a save affects FUTURE purchases
 * only. Fulfillment semantics (finite/unlimited, uses, validity,
 * reservation, walk-in) live HERE — never in the price kind (D-S6-3).
 */

export const FULFILLMENT_OPERATIONS = ['loadFulfillment', 'setFulfillment'] as const;

export interface FulfillmentScheduleTerm {
  readonly weekday: number; // 0 = Sunday … 6 = Saturday
  readonly startTime: string; // HH:MM
  readonly endTime: string; // HH:MM
}

export interface FulfillmentTermsInput {
  readonly usageKind: 'finite' | 'unlimited';
  /** Finite MEMBERSHIP total; a package's total IS its sessions count. */
  readonly usesTotal?: number;
  readonly validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  readonly validityDays?: number;
  readonly validityEndDate?: string; // YYYY-MM-DD
  readonly reservationRequired: boolean;
  readonly walkInAllowed: boolean;
  readonly branchId?: string;
  readonly scheduleTerms?: readonly FulfillmentScheduleTerm[];
}

export interface FulfillmentRevision {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly state: 'active' | 'superseded';
  readonly usageKind: 'finite' | 'unlimited';
  readonly usesTotal?: number;
  readonly validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  readonly validityDays?: number;
  readonly validityEndDate?: string;
  readonly reservationRequired: boolean;
  readonly walkInAllowed: boolean;
  readonly branchId?: string;
  readonly scheduleTerms: readonly FulfillmentScheduleTerm[];
  readonly createdAt: string; // ISO
}

export type LoadFulfillmentOutcome =
  | {
      readonly kind: 'fulfillment';
      readonly optionKind: string;
      /** FALSE for capacity kinds — they carry no fulfillment config. */
      readonly supported: boolean;
      readonly active: FulfillmentRevision | null;
    }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export type SetFulfillmentOutcome =
  | { readonly kind: 'revisionCreated'; readonly revision: FulfillmentRevision }
  | { readonly kind: 'invalidFulfillmentConfig' }
  | { readonly kind: 'invalidBranch' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export interface FulfillmentConfigPort {
  loadFulfillment(
    organizationId: string,
    programId: string,
    optionId: string,
  ): Promise<LoadFulfillmentOutcome>;
  setFulfillment(
    organizationId: string,
    programId: string,
    optionId: string,
    terms: FulfillmentTermsInput,
  ): Promise<SetFulfillmentOutcome>;
}
