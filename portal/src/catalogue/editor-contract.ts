/**
 * Provider catalogue MUTATION seam (W2-8) — mirrors the REAL S4
 * provider-private catalogue management routes
 * (backend/src/modules/catalogue/http/catalogue-routes.ts) operation for
 * operation. W2-12 implements this port over the live API; until then the
 * semantic fixture stands behind the same contract.
 *
 * Operations and their real routes (capability in parentheses):
 * - `createProgram`            ⇄ POST  .../listings                         (`listings.manage`)
 * - `updateProgram`            ⇄ PATCH .../listings/:programId              (`listings.manage`)
 * - `addPriceOption`           ⇄ POST  .../listings/:programId/price-options            (`listings.manage`)
 * - `updatePriceOption`        ⇄ PATCH .../price-options/:optionId          (`listings.manage`)
 * - `archivePriceOption`       ⇄ POST  .../price-options/:optionId/archive  (`listings.manage`)
 * - `addBranchAssociation`     ⇄ POST  .../listings/:programId/branches     (`listings.manage`)
 * - `removeBranchAssociation`  ⇄ POST  .../branches/:branchId/remove        (`listings.manage`)
 * - `addMedia`                 ⇄ POST  .../listings/:programId/media        (`media.manage`)
 * - `updateMedia`              ⇄ PATCH .../media/:mediaId                   (`media.manage`)
 * - `archiveMedia`             ⇄ POST  .../media/:mediaId/archive           (`media.manage`)
 * - `addOffer`                 ⇄ POST  .../listings/:programId/offers       (`listings.manage`)
 * - `updateOffer`              ⇄ PATCH .../offers/:offerId                  (`listings.manage`)
 * - `endOffer`                 ⇄ POST  .../offers/:offerId/end              (`listings.manage`)
 *
 * Deliberately ABSENT because W2-9 owns the lifecycle surface: no submit, no
 * publish, no unpublish, no pause, no resume, no archive-listing, no
 * revision decision/withdrawal — the port type cannot express them, and a
 * structural test locks the operation set.
 *
 * Semantics preserved from the shipped services:
 * - Edit-state matrix: `draft`/`changes_requested` edit DIRECTLY;
 *   `approved`/`published`/`paused` are REVIEW-GATED (sensitive changes
 *   create a ProgramRevision instead of touching live fields);
 *   `submitted`/`in_review`/`archived` are LOCKED (`lifecycleConflict`).
 * - Sensitive set (docs/28 §7 seed): descriptions, eligibility fields, and
 *   EVERY price-option add/edit/archive. Non-sensitive: titleEn/titleAr/
 *   setting/activityTypeId, branch associations, media metadata, offers —
 *   these apply directly even on review-gated listings.
 * - At most ONE open revision per listing: a further sensitive change while
 *   one is open is `revisionPending`, never a second revision.
 * - Branch-scope MUTATION rule (stricter than the W2-7 read rule, on
 *   purpose): a branch-scoped membership may mutate a listing only while
 *   EVERY active association lies inside its assigned ACTIVE branches
 *   (vacuously true for branchless drafts), and may only associate/remove
 *   branches it controls. Readable ≠ editable.
 * - CAS: program PATCH, option PATCH/archive, media PATCH/archive, offer
 *   PATCH/end all carry `expectedVersion`; a stale version never overwrites.
 *   Option add and branch association commands carry none (the real bodies
 *   have none).
 * - Archive-only retirement: an archived option is immutable history
 *   (update → `lifecycleConflict`); archive/remove/end commands are
 *   idempotent exactly where the services are.
 * - Suspended organizations: every mutation refuses `organizationSuspended`
 *   at the policy layer (reads stay). Refusal order mirrors the pipeline:
 *   not-found shaping → capability `forbidden` → suspended → service
 *   outcomes.
 */
import type {
  OfferRecord,
  PriceOptionRecord,
  ProgramMediaRecord,
} from './contract';

/** Exact TypeBox limits from the real route bodies. */
export const PROGRAM_FIELD_LIMITS = {
  titleEn: 160,
  titleAr: 160,
  descriptionEn: 4_000,
  descriptionAr: 4_000,
  eligibilityNotes: 1_000,
  ageMax: 130,
  optionLabel: 120,
  offerLabel: 160,
  altText: 300,
  sortHintMax: 100_000,
} as const;

export const PROGRAM_SETTINGS = ['indoor', 'outdoor'] as const;
export type ProgramSetting = (typeof PROGRAM_SETTINGS)[number];

/** docs/24 A3 — the exact five-value stored gender vocabulary. */
export const GENDER_ELIGIBILITY_VALUES = ['women', 'men', 'girls', 'boys', 'mixed'] as const;
export type GenderEligibility = (typeof GENDER_ELIGIBILITY_VALUES)[number];

export const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced', 'all-levels'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** POST .../listings body — exactly the real create fields. */
export interface ProgramCreateInput {
  readonly titleEn: string;
  readonly titleAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly descriptionAr?: string | null;
  readonly activityTypeId: string;
  readonly setting: ProgramSetting;
  readonly genderEligibility: GenderEligibility;
  readonly minAge?: number | null;
  readonly maxAge?: number | null;
  readonly allAges?: boolean;
  readonly skillLevel?: SkillLevel | null;
  readonly eligibilityNotes?: string | null;
}

/** PATCH .../listings/:programId body minus `expectedVersion` — every field
 *  optional; an absent key leaves the field unchanged (dirty-field PATCH). */
export interface ProgramPatch {
  readonly titleEn?: string;
  readonly titleAr?: string | null;
  readonly descriptionEn?: string | null;
  readonly descriptionAr?: string | null;
  readonly activityTypeId?: string;
  readonly setting?: ProgramSetting;
  readonly genderEligibility?: GenderEligibility;
  readonly minAge?: number | null;
  readonly maxAge?: number | null;
  readonly allAges?: boolean;
  readonly skillLevel?: SkillLevel | null;
  readonly eligibilityNotes?: string | null;
}

export interface PriceOptionInput {
  readonly kind: string;
  readonly amountFils?: number | null;
  readonly sessionsCount?: number | null;
  readonly labelEn?: string | null;
  readonly labelAr?: string | null;
  readonly sortHint?: number;
}

export interface PriceOptionPatch {
  readonly kind?: string;
  readonly amountFils?: number | null;
  readonly sessionsCount?: number | null;
  readonly labelEn?: string | null;
  readonly labelAr?: string | null;
  readonly sortHint?: number;
}

export interface MediaInput {
  readonly mediaRef: string;
  readonly sortHint?: number;
  readonly altTextEn?: string | null;
  readonly altTextAr?: string | null;
}

export interface MediaPatch {
  readonly sortHint?: number;
  readonly altTextEn?: string | null;
  readonly altTextAr?: string | null;
}

export interface OfferInput {
  readonly kind: string;
  readonly labelEn: string;
  readonly labelAr?: string | null;
  readonly trialAmountFils?: number | null;
  /** ISO date-time strings, exactly like the wire body. */
  readonly effectiveStart?: string | null;
  readonly effectiveEnd?: string | null;
}

export interface OfferPatch {
  readonly labelEn?: string;
  readonly labelAr?: string | null;
  readonly trialAmountFils?: number | null;
  readonly effectiveStart?: string | null;
  readonly effectiveEnd?: string | null;
}

/** Shared policy-layer refusals (exact pipeline order is documented above). */
type PolicyRefusal =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'unavailable' };

export type CreateProgramOutcome =
  | {
      readonly kind: 'programCreated';
      readonly program: { readonly id: string; readonly listingState: string; readonly version: number };
    }
  | { readonly kind: 'invalidTaxonomy' }
  | { readonly kind: 'invalidEligibility' }
  | PolicyRefusal;

export type UpdateProgramOutcome =
  | { readonly kind: 'programUpdated'; readonly version: number }
  | {
      readonly kind: 'revisionSubmitted';
      readonly revisionId: string;
      readonly appliedFields: readonly string[];
      readonly deferredFields: readonly string[];
    }
  | { readonly kind: 'revisionPending' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'invalidTaxonomy' }
  | { readonly kind: 'invalidEligibility' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type AddPriceOptionOutcome =
  | { readonly kind: 'optionAdded'; readonly option: PriceOptionRecord }
  | { readonly kind: 'revisionSubmitted'; readonly revisionId: string }
  | { readonly kind: 'revisionPending' }
  | { readonly kind: 'invalidPriceOption' }
  | { readonly kind: 'lifecycleConflict' }
  | PolicyRefusal;

export type UpdatePriceOptionOutcome =
  | { readonly kind: 'optionUpdated'; readonly option: PriceOptionRecord }
  | { readonly kind: 'revisionSubmitted'; readonly revisionId: string }
  | { readonly kind: 'revisionPending' }
  | { readonly kind: 'invalidPriceOption' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type ArchivePriceOptionOutcome =
  | { readonly kind: 'optionArchived' }
  | { readonly kind: 'revisionSubmitted'; readonly revisionId: string }
  | { readonly kind: 'revisionPending' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type AddBranchAssociationOutcome =
  | { readonly kind: 'branchAssociated' }
  | { readonly kind: 'invalidBranch' }
  | { readonly kind: 'lifecycleConflict' }
  | PolicyRefusal;

export type RemoveBranchAssociationOutcome =
  | { readonly kind: 'branchAssociationRemoved' }
  | { readonly kind: 'lifecycleConflict' }
  | PolicyRefusal;

export type AddMediaOutcome =
  | { readonly kind: 'mediaAdded'; readonly media: ProgramMediaRecord }
  | { readonly kind: 'lifecycleConflict' }
  | PolicyRefusal;

export type UpdateMediaOutcome =
  | { readonly kind: 'mediaUpdated'; readonly media: ProgramMediaRecord }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type ArchiveMediaOutcome =
  | { readonly kind: 'mediaArchived' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type AddOfferOutcome =
  | { readonly kind: 'offerAdded'; readonly offer: OfferRecord }
  | { readonly kind: 'invalidOffer' }
  | { readonly kind: 'lifecycleConflict' }
  | PolicyRefusal;

export type UpdateOfferOutcome =
  | { readonly kind: 'offerUpdated'; readonly offer: OfferRecord }
  | { readonly kind: 'invalidOffer' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export type EndOfferOutcome =
  | { readonly kind: 'offerEnded' }
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'staleVersion' }
  | PolicyRefusal;

export interface ListingEditorPort {
  createProgram(organizationId: string, input: ProgramCreateInput): Promise<CreateProgramOutcome>;
  updateProgram(
    organizationId: string,
    programId: string,
    expectedVersion: number,
    patch: ProgramPatch,
  ): Promise<UpdateProgramOutcome>;
  addPriceOption(
    organizationId: string,
    programId: string,
    input: PriceOptionInput,
  ): Promise<AddPriceOptionOutcome>;
  updatePriceOption(
    organizationId: string,
    programId: string,
    optionId: string,
    expectedVersion: number,
    patch: PriceOptionPatch,
  ): Promise<UpdatePriceOptionOutcome>;
  archivePriceOption(
    organizationId: string,
    programId: string,
    optionId: string,
    expectedVersion: number,
  ): Promise<ArchivePriceOptionOutcome>;
  addBranchAssociation(
    organizationId: string,
    programId: string,
    branchId: string,
  ): Promise<AddBranchAssociationOutcome>;
  removeBranchAssociation(
    organizationId: string,
    programId: string,
    branchId: string,
  ): Promise<RemoveBranchAssociationOutcome>;
  addMedia(organizationId: string, programId: string, input: MediaInput): Promise<AddMediaOutcome>;
  updateMedia(
    organizationId: string,
    programId: string,
    mediaId: string,
    expectedVersion: number,
    patch: MediaPatch,
  ): Promise<UpdateMediaOutcome>;
  archiveMedia(
    organizationId: string,
    programId: string,
    mediaId: string,
    expectedVersion: number,
  ): Promise<ArchiveMediaOutcome>;
  addOffer(organizationId: string, programId: string, input: OfferInput): Promise<AddOfferOutcome>;
  updateOffer(
    organizationId: string,
    programId: string,
    offerId: string,
    expectedVersion: number,
    patch: OfferPatch,
  ): Promise<UpdateOfferOutcome>;
  endOffer(
    organizationId: string,
    programId: string,
    offerId: string,
    expectedVersion: number,
  ): Promise<EndOfferOutcome>;
}

/** The 13 real operations — the exact structural surface, used by the
 *  contract lock test and the fail-closed unconfigured port. */
export const LISTING_EDITOR_OPERATIONS = [
  'createProgram',
  'updateProgram',
  'addPriceOption',
  'updatePriceOption',
  'archivePriceOption',
  'addBranchAssociation',
  'removeBranchAssociation',
  'addMedia',
  'updateMedia',
  'archiveMedia',
  'addOffer',
  'updateOffer',
  'endOffer',
] as const;
