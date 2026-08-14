/**
 * Provider bulk-import PREVIEW seam (W2-10) — docs/23 §8.5, docs/29 PP-17.
 *
 * NO bulk-import backend/processing engine exists yet, and the PRODUCTION
 * import file contract is explicitly unresolved (docs/23 §18.17 blocks the
 * §8.5 template on the Arabic-content decision; no column specification
 * exists anywhere in the repository). This module therefore defines:
 *
 * - the clearly VERSIONED frontend fixture schema ("import preview format
 *   v1") the dry-run UX validates against — a pre-release working format,
 *   deliberately NOT a production contract; and
 * - the `BulkImportPort` seam the future engine integration evolves into.
 *
 * The port exposes exactly ONE operation: `dryRun`. There is deliberately
 * NO execute/submit/commit operation — no canonical backend contract exists
 * for one, so none is pretended (recorded Class-B gap). Dry runs are
 * READ-ONLY: they never create, mutate, submit, or publish anything, and
 * §8.5 atomicity stands untouched for the future engine (a batch applies
 * atomically or not at all; a failed batch never partially commits; the
 * validated-subset re-batch is an explicit NEW batch).
 *
 * Row model (D-S4-1 made visible): one ROW describes one price option; rows
 * sharing a non-blank `listing_ref` form ONE listing (Program) with several
 * ProgramPriceOptions. A listing never comes from an option and an option
 * never becomes its own listing. Import-created listings are always private
 * DRAFTS (docs/24 §2.8) — nothing here can bypass completeness, moderation,
 * or publication authority.
 */

export const IMPORT_SCHEMA_VERSION = 'v1';

export type ImportFieldKey =
  | 'listingRef'
  | 'titleEn'
  | 'titleAr'
  | 'descriptionEn'
  | 'descriptionAr'
  | 'activityType'
  | 'setting'
  | 'whoFor'
  | 'minAge'
  | 'maxAge'
  | 'allAges'
  | 'skillLevel'
  | 'eligibilityNotes'
  | 'branches'
  | 'priceKind'
  | 'priceAed'
  | 'sessionsCount'
  | 'optionLabel';

export interface ImportFieldSpec {
  readonly key: ImportFieldKey;
  /** The v1 template column header (stable, provider-facing snake case). */
  readonly header: string;
  readonly label: string;
  readonly required: boolean;
  /** Whether the field describes the LISTING (must agree across a
   *  listing_ref group) or one PRICE OPTION (per-row). */
  readonly level: 'listing' | 'option';
  /** Provider-facing guidance shown in the instructions panel. */
  readonly guidance: string;
}

/** The v1 fixture schema — ordered exactly as the template columns. */
export const IMPORT_FIELDS: readonly ImportFieldSpec[] = [
  {
    key: 'listingRef',
    header: 'listing_ref',
    label: 'Listing reference',
    required: false,
    level: 'listing',
    guidance:
      'Your own short reference (like SWIM-01). Rows that share a reference become ONE listing with several pricing options. Leave blank for a listing with a single row.',
  },
  {
    key: 'titleEn',
    header: 'title_en',
    label: 'Title (English)',
    required: true,
    level: 'listing',
    guidance: 'The listing title customers see. Up to 160 characters.',
  },
  {
    key: 'titleAr',
    header: 'title_ar',
    label: 'Title (Arabic)',
    required: false,
    level: 'listing',
    guidance: 'Optional. Arabic can also be added later in the listing editor.',
  },
  {
    key: 'descriptionEn',
    header: 'description_en',
    label: 'Description (English)',
    required: false,
    level: 'listing',
    guidance: 'Optional. What customers read on the listing. Up to 4000 characters.',
  },
  {
    key: 'descriptionAr',
    header: 'description_ar',
    label: 'Description (Arabic)',
    required: false,
    level: 'listing',
    guidance: 'Optional.',
  },
  {
    key: 'activityType',
    header: 'activity_type',
    label: 'Activity type',
    required: true,
    level: 'listing',
    guidance:
      'One of the Himma activity types, written exactly as it appears in the portal — for example Swimming or Aqua Fitness.',
  },
  {
    key: 'setting',
    header: 'setting',
    label: 'Setting',
    required: true,
    level: 'listing',
    guidance: 'Indoor or Outdoor.',
  },
  {
    key: 'whoFor',
    header: 'who_for',
    label: 'Who it’s for',
    required: true,
    level: 'listing',
    guidance: 'Everyone, Ladies only, Men only, Girls, or Boys.',
  },
  {
    key: 'minAge',
    header: 'min_age',
    label: 'Minimum age',
    required: false,
    level: 'listing',
    guidance: 'Optional whole number (0–130).',
  },
  {
    key: 'maxAge',
    header: 'max_age',
    label: 'Maximum age',
    required: false,
    level: 'listing',
    guidance: 'Optional whole number (0–130), not below the minimum age.',
  },
  {
    key: 'allAges',
    header: 'all_ages',
    label: 'All ages',
    required: false,
    level: 'listing',
    guidance: 'Yes to welcome all ages — leave the age columns blank in that case.',
  },
  {
    key: 'skillLevel',
    header: 'skill_level',
    label: 'Skill level',
    required: false,
    level: 'listing',
    guidance: 'Optional: Beginner, Intermediate, Advanced, or All levels.',
  },
  {
    key: 'eligibilityNotes',
    header: 'eligibility_notes',
    label: 'Eligibility notes',
    required: false,
    level: 'listing',
    guidance: 'Optional. Anything participants should know before joining. Up to 1000 characters.',
  },
  {
    key: 'branches',
    header: 'branches',
    label: 'Branches',
    required: false,
    level: 'listing',
    guidance:
      'Optional: your branch names exactly as they appear in the portal, separated by semicolons — for example Dubai Marina pool; Business Bay pool. A listing without a branch starts as an incomplete draft.',
  },
  {
    key: 'priceKind',
    header: 'price_kind',
    label: 'Price type',
    required: false,
    level: 'option',
    guidance:
      'Drop-in, Monthly, Term, Camp, Package, or Free. Each row describes one pricing option of its listing.',
  },
  {
    key: 'priceAed',
    header: 'price_aed',
    label: 'Price (AED)',
    required: false,
    level: 'option',
    guidance: 'The amount in AED, like 450 or 450.50. Leave blank for Free options.',
  },
  {
    key: 'sessionsCount',
    header: 'sessions_count',
    label: 'Sessions included',
    required: false,
    level: 'option',
    guidance: 'For Package options only: how many sessions the package includes.',
  },
  {
    key: 'optionLabel',
    header: 'option_label',
    label: 'Option label',
    required: false,
    level: 'option',
    guidance: 'Optional display name for the option, like “3 months”. Up to 120 characters.',
  },
] as const;

export const REQUIRED_IMPORT_FIELDS: readonly ImportFieldKey[] = IMPORT_FIELDS.filter(
  (field) => field.required,
).map((field) => field.key);

/** One parsed data row after column mapping — raw text values only. */
export interface ImportRowInput {
  /** 1-based DATA row number as the provider sees it in their file
   *  (excluding the header row) — every issue points back to it. */
  readonly rowNumber: number;
  readonly values: Partial<Readonly<Record<ImportFieldKey, string>>>;
}

export type ImportIssueSeverity = 'error' | 'warning' | 'info';

export interface ImportRowIssue {
  readonly severity: ImportIssueSeverity;
  /** The field the issue points at; absent for whole-row issues. */
  readonly fieldKey?: ImportFieldKey;
  /** Provider-facing sentence — never internals. */
  readonly message: string;
}

export interface DryRunRowResult {
  readonly rowNumber: number;
  readonly listingRef: string | null;
  readonly titleEn: string | null;
  readonly issues: readonly ImportRowIssue[];
  /** True when the row carries no error-severity issue. */
  readonly valid: boolean;
}

/** One detected listing (Program) grouped from the batch's VALID rows. */
export interface DetectedListing {
  readonly listingRef: string | null;
  readonly titleEn: string;
  readonly rowNumbers: readonly number[];
  readonly optionCount: number;
  readonly branchNames: readonly string[];
  /** Listing-level guidance (completeness/duplicate notes). */
  readonly notes: readonly ImportRowIssue[];
}

export interface DryRunSummary {
  readonly totalRows: number;
  readonly validRows: number;
  readonly errorRows: number;
  /** Rows without errors that still carry warnings. */
  readonly warningRows: number;
  readonly detectedListings: number;
  readonly detectedPriceOptions: number;
}

export interface DryRunReport {
  readonly schemaVersion: typeof IMPORT_SCHEMA_VERSION;
  readonly summary: DryRunSummary;
  readonly rows: readonly DryRunRowResult[];
  readonly listings: readonly DetectedListing[];
}

export type DryRunOutcome =
  | { readonly kind: 'dryRunComplete'; readonly report: DryRunReport }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'unavailable' };

export interface BulkImportPort {
  /**
   * Semantic validation preview over the addressed organization's current
   * truth (taxonomy, branches, existing listings, the caller's branch
   * scope). READ-ONLY — nothing is created or changed. The live W2-12+
   * implementation becomes a server-side dry-run once that contract exists.
   */
  dryRun(organizationId: string, rows: readonly ImportRowInput[]): Promise<DryRunOutcome>;
}

/** The exact structural surface — locked by tests and the fail-closed
 *  unconfigured port. NO execute/commit operation exists. */
export const BULK_IMPORT_OPERATIONS = ['dryRun'] as const;
