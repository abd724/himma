import {
  IMPORT_SCHEMA_VERSION,
  type DetectedListing,
  type DryRunReport,
  type DryRunRowResult,
  type ImportFieldKey,
  type ImportRowInput,
  type ImportRowIssue,
} from './import-contract';
import { parseAedToFils, parseSessionsCount } from './money';

/**
 * The v1 dry-run SEMANTIC validator — a pure function over the batch plus
 * reference truth, mirroring the REAL catalogue semantics that already
 * exist (create body limits, five-value gender vocabulary, age ties,
 * ACTIVE-taxonomy rule, same-organization ACTIVE-branch rule, the Branch
 * Manager mutation scope, and the S4-1 price-option CHECK ties). It is
 * deliberately neither stricter nor weaker than the shipped backend rules:
 * a "valid" row is one the real create/associate/add-option services would
 * accept today.
 *
 * §8.5 rule 5 duplicate detection is WARN-only and never merges: in-file
 * same-title listings, repeated in-file option shapes, and same-title
 * matches against the organization's CURRENT listings (titles are the only
 * comparison the provider list contract exposes — branch-level live
 * comparison needs the future engine; recorded gap).
 *
 * Runs behind the BulkImportPort so the reference truth stays the port's
 * concern (fixtures today, a server dry-run later) — and it never mutates
 * anything.
 */

export interface ImportReferenceData {
  /** ACTIVE activity types only (the public taxonomy read's shape). */
  readonly activityTypes: ReadonlyArray<{ readonly id: string; readonly labelEn: string }>;
  /** The organization's branches (active flag included). */
  readonly branches: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly active: boolean;
  }>;
  /** Branch-scoped callers: the assigned ACTIVE branch ids; null = org-wide. */
  readonly assignedActiveBranchIds: readonly string[] | null;
  /** Current listing titles in the organization (this caller's reachable
   *  set) — the §8.5 live-catalogue duplicate heuristic. */
  readonly existingListingTitles: readonly string[];
}

const TEXT_LIMITS: Partial<Record<ImportFieldKey, number>> = {
  listingRef: 60,
  titleEn: 160,
  titleAr: 160,
  descriptionEn: 4_000,
  descriptionAr: 4_000,
  eligibilityNotes: 1_000,
  optionLabel: 120,
};

const SETTING_VALUES: Record<string, string> = {
  indoor: 'indoor',
  outdoor: 'outdoor',
};

/** Provider-facing labels AND canonical codes, both accepted. */
const WHO_FOR_VALUES: Record<string, string> = {
  everyone: 'mixed',
  mixed: 'mixed',
  'ladies only': 'women',
  women: 'women',
  'men only': 'men',
  men: 'men',
  girls: 'girls',
  boys: 'boys',
};

const SKILL_VALUES: Record<string, string> = {
  beginner: 'beginner',
  intermediate: 'intermediate',
  advanced: 'advanced',
  'all levels': 'all-levels',
  'all-levels': 'all-levels',
};

const PRICE_KIND_VALUES: Record<string, string> = {
  'drop-in': 'dropIn',
  dropin: 'dropIn',
  monthly: 'monthly',
  term: 'term',
  camp: 'camp',
  package: 'package',
  free: 'free',
};

const YES_VALUES = new Set(['yes', 'y', 'true']);
const NO_VALUES = new Set(['no', 'n', 'false']);

const LISTING_LEVEL_FIELDS: readonly ImportFieldKey[] = [
  'titleEn',
  'titleAr',
  'descriptionEn',
  'descriptionAr',
  'activityType',
  'setting',
  'whoFor',
  'minAge',
  'maxAge',
  'allAges',
  'skillLevel',
  'eligibilityNotes',
  'branches',
];

const normalize = (value: string): string => value.trim().toLowerCase();
const cell = (row: ImportRowInput, key: ImportFieldKey): string => (row.values[key] ?? '').trim();

interface RowAnalysis {
  readonly row: ImportRowInput;
  readonly issues: ImportRowIssue[];
  /** Group key: shared listing_ref, or a per-row key when blank. */
  readonly groupKey: string;
  readonly listingRef: string | null;
  hasOption: boolean;
  optionShape: string | null;
  branchNames: string[];
}

export function validateImportRows(
  rows: readonly ImportRowInput[],
  reference: ImportReferenceData,
): DryRunReport {
  const activeTypesByLabel = new Map(
    reference.activityTypes.map((type) => [normalize(type.labelEn), type]),
  );
  // Continuation rows (a listing_ref already seen above) describe the SAME
  // listing: their blank listing-level fields inherit from the group's
  // first row, so the required-field rule applies to the group's first row
  // only. Non-blank repeats are still vocabulary-checked and must agree.
  const seenRefs = new Set<string>();
  const analyses: RowAnalysis[] = rows.map((row) => {
    const ref = (row.values.listingRef ?? '').trim();
    const key = ref === '' ? `row:${row.rowNumber}` : `ref:${ref.toLowerCase()}`;
    const isContinuation = ref !== '' && seenRefs.has(key);
    seenRefs.add(key);
    return analyzeRow(row, reference, activeTypesByLabel, isContinuation);
  });

  applyGroupConsistency(analyses);
  applyDuplicateHeuristics(analyses, reference);

  const rowResults: DryRunRowResult[] = analyses.map((analysis) => ({
    rowNumber: analysis.row.rowNumber,
    listingRef: analysis.listingRef,
    titleEn: cell(analysis.row, 'titleEn') === '' ? null : cell(analysis.row, 'titleEn'),
    issues: analysis.issues,
    valid: !analysis.issues.some((issue) => issue.severity === 'error'),
  }));

  const listings = detectListings(analyses, rowResults);

  const validRows = rowResults.filter((row) => row.valid).length;
  const errorRows = rowResults.length - validRows;
  const warningRows = rowResults.filter(
    (row) => row.valid && row.issues.some((issue) => issue.severity === 'warning'),
  ).length;

  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    summary: {
      totalRows: rowResults.length,
      validRows,
      errorRows,
      warningRows,
      detectedListings: listings.length,
      detectedPriceOptions: listings.reduce((sum, listing) => sum + listing.optionCount, 0),
    },
    rows: rowResults,
    listings,
  };
}

function analyzeRow(
  row: ImportRowInput,
  reference: ImportReferenceData,
  activeTypesByLabel: ReadonlyMap<string, { id: string; labelEn: string }>,
  isContinuation: boolean,
): RowAnalysis {
  const issues: ImportRowIssue[] = [];
  const error = (fieldKey: ImportFieldKey | undefined, message: string) =>
    issues.push(fieldKey ? { severity: 'error', fieldKey, message } : { severity: 'error', message });

  // Text bounds first (mirrors the route body limits).
  for (const [key, limit] of Object.entries(TEXT_LIMITS) as Array<[ImportFieldKey, number]>) {
    if (cell(row, key).length > limit) {
      error(key, `Keep this under ${limit.toLocaleString('en-US')} characters.`);
    }
  }

  const titleEn = cell(row, 'titleEn');
  if (titleEn === '' && !isContinuation) {
    error('titleEn', 'An English title is required.');
  }

  const typeText = cell(row, 'activityType');
  if (typeText === '') {
    if (!isContinuation) {
      error('activityType', 'An activity type is required.');
    }
  } else if (!activeTypesByLabel.has(normalize(typeText))) {
    error(
      'activityType',
      'This isn’t a current Himma activity type. Use one of the types listed in the guidance, written exactly as it appears in the portal.',
    );
  }

  const settingText = cell(row, 'setting');
  if (settingText === '') {
    if (!isContinuation) {
      error('setting', 'A setting is required — Indoor or Outdoor.');
    }
  } else if (!(normalize(settingText) in SETTING_VALUES)) {
    error('setting', 'Use Indoor or Outdoor.');
  }

  const whoForText = cell(row, 'whoFor');
  if (whoForText === '') {
    if (!isContinuation) {
      error('whoFor', 'Say who the listing is for — Everyone, Ladies only, Men only, Girls, or Boys.');
    }
  } else if (!(normalize(whoForText) in WHO_FOR_VALUES)) {
    error('whoFor', 'Use Everyone, Ladies only, Men only, Girls, or Boys.');
  }

  const skillText = cell(row, 'skillLevel');
  if (skillText !== '' && !(normalize(skillText) in SKILL_VALUES)) {
    error('skillLevel', 'Use Beginner, Intermediate, Advanced, or All levels — or leave it blank.');
  }

  // Ages — the exact backend ties (0–130 integers, min ≤ max, all-ages
  // excludes explicit ages).
  const ages: { min: number | null; max: number | null } = { min: null, max: null };
  for (const [key, target] of [
    ['minAge', 'min'],
    ['maxAge', 'max'],
  ] as const) {
    const text = cell(row, key);
    if (text === '') continue;
    if (!/^\d+$/.test(text) || Number(text) > 130) {
      error(key, 'Use a whole number between 0 and 130, or leave it blank.');
    } else {
      ages[target] = Number(text);
    }
  }
  if (ages.min !== null && ages.max !== null && ages.min > ages.max) {
    error('maxAge', 'The maximum age can’t be below the minimum age.');
  }
  const allAgesText = cell(row, 'allAges');
  let allAges = false;
  if (allAgesText !== '') {
    if (YES_VALUES.has(normalize(allAgesText))) {
      allAges = true;
    } else if (!NO_VALUES.has(normalize(allAgesText))) {
      error('allAges', 'Use Yes or No, or leave it blank.');
    }
  }
  if (allAges && (ages.min !== null || ages.max !== null)) {
    error('allAges', 'All ages and specific age limits can’t be combined — use one or the other.');
  }

  // Branches — same-organization ACTIVE branches only, by exact portal
  // name; a branch-scoped caller may only reference assigned branches
  // (the real association rule, mirrored — never invented org-wide reach).
  const branchNames: string[] = [];
  const branchesText = cell(row, 'branches');
  if (branchesText !== '') {
    const seen = new Set<string>();
    for (const rawName of branchesText.split(';')) {
      const name = rawName.trim();
      if (name === '') continue;
      const matches = reference.branches.filter(
        (branch) => normalize(branch.label) === normalize(name),
      );
      if (matches.length === 0) {
        error('branches', `“${name}” doesn’t match any of your branches. Use branch names exactly as they appear in the portal.`);
        continue;
      }
      if (matches.length > 1) {
        error('branches', `“${name}” matches more than one branch — rename one in the portal first, or import without it and place the listing in the editor.`);
        continue;
      }
      const match = matches[0]!;
      if (!match.active) {
        error('branches', `“${match.label}” is deactivated, so new listings can’t be placed there.`);
        continue;
      }
      if (
        reference.assignedActiveBranchIds !== null &&
        !reference.assignedActiveBranchIds.includes(match.id)
      ) {
        error('branches', `“${match.label}” is outside your branch scope.`);
        continue;
      }
      if (seen.has(match.id)) {
        issues.push({
          severity: 'warning',
          fieldKey: 'branches',
          message: `“${match.label}” is listed more than once.`,
        });
        continue;
      }
      seen.add(match.id);
      branchNames.push(match.label);
    }
  }

  // Price option — the exact S4-1 CHECK ties via the proven money boundary.
  let hasOption = false;
  let optionShape: string | null = null;
  const priceKindText = cell(row, 'priceKind');
  const priceAedText = cell(row, 'priceAed');
  const sessionsText = cell(row, 'sessionsCount');
  if (priceKindText === '') {
    if (priceAedText !== '' || sessionsText !== '' || cell(row, 'optionLabel') !== '') {
      error('priceKind', 'Price details need a price type — Drop-in, Monthly, Term, Camp, Package, or Free.');
    }
  } else {
    const kind = PRICE_KIND_VALUES[normalize(priceKindText)];
    if (kind === undefined) {
      error('priceKind', 'Use Drop-in, Monthly, Term, Camp, Package, or Free.');
    } else {
      let optionValid = true;
      let amountFils: number | null = null;
      if (kind === 'free') {
        if (priceAedText !== '') {
          error('priceAed', 'Free options don’t take a price — leave this blank.');
          optionValid = false;
        }
      } else if (priceAedText === '') {
        error('priceAed', 'This price type needs an amount in AED, like 450 or 450.50.');
        optionValid = false;
      } else {
        const parsed = parseAedToFils(priceAedText);
        if (parsed.kind !== 'fils') {
          error('priceAed', 'Use a plain AED amount like 450 or 450.50 — no symbols or commas.');
          optionValid = false;
        } else {
          amountFils = parsed.fils;
        }
      }
      if (kind === 'package') {
        if (sessionsText === '') {
          error('sessionsCount', 'Package options need how many sessions are included.');
          optionValid = false;
        } else if (parseSessionsCount(sessionsText).kind !== 'sessions') {
          error('sessionsCount', 'Use a whole number of sessions, like 8.');
          optionValid = false;
        }
      } else if (sessionsText !== '') {
        error('sessionsCount', 'Sessions included applies to Package options only — leave it blank here.');
        optionValid = false;
      }
      if (optionValid) {
        hasOption = true;
        optionShape = `${kind}|${amountFils ?? ''}|${kind === 'package' ? sessionsText.trim() : ''}`;
      }
    }
  }

  const listingRef = cell(row, 'listingRef') === '' ? null : cell(row, 'listingRef');
  return {
    row,
    issues,
    groupKey: listingRef === null ? `row:${row.rowNumber}` : `ref:${normalize(listingRef)}`,
    listingRef,
    hasOption,
    optionShape,
    branchNames,
  };
}

/**
 * listing_ref grouping: listing-level fields must AGREE across the group.
 * Later rows may leave them blank (they describe the same listing); a
 * non-blank mismatch is an error pointing at the exact row and field.
 * Duplicate option shapes inside one listing warn (§8.5 rule 5).
 */
function applyGroupConsistency(analyses: RowAnalysis[]): void {
  const groups = new Map<string, RowAnalysis[]>();
  for (const analysis of analyses) {
    const group = groups.get(analysis.groupKey) ?? [];
    group.push(analysis);
    groups.set(analysis.groupKey, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    for (const later of group.slice(1)) {
      for (const key of LISTING_LEVEL_FIELDS) {
        const laterValue = cell(later.row, key);
        if (laterValue === '') continue;
        const firstValue = cell(first.row, key);
        if (firstValue !== '' && laterValue !== firstValue) {
          later.issues.push({
            severity: 'error',
            fieldKey: key,
            message: `Doesn’t match row ${first.row.rowNumber} of the same listing (“${first.listingRef ?? ''}”). Listing details must agree across its rows — leave repeats blank or make them identical.`,
          });
        }
      }
    }
    const seenShapes = new Map<string, number>();
    for (const analysis of group) {
      if (analysis.optionShape === null) continue;
      const priorRow = seenShapes.get(analysis.optionShape);
      if (priorRow !== undefined) {
        analysis.issues.push({
          severity: 'warning',
          fieldKey: 'priceKind',
          message: `Same pricing option as row ${priorRow} of this listing — is it repeated by mistake?`,
        });
      } else {
        seenShapes.set(analysis.optionShape, analysis.row.rowNumber);
      }
    }
  }
}

/** §8.5 rule 5: warn-only duplicate heuristics — never merged, never
 *  blocking — within the batch and against the current catalogue titles. */
function applyDuplicateHeuristics(analyses: RowAnalysis[], reference: ImportReferenceData): void {
  const existing = new Set(reference.existingListingTitles.map(normalize));
  const firstRowByTitle = new Map<string, RowAnalysis>();
  for (const analysis of analyses) {
    const title = cell(analysis.row, 'titleEn');
    if (title === '') continue;
    if (existing.has(normalize(title))) {
      analysis.issues.push({
        severity: 'warning',
        fieldKey: 'titleEn',
        message: 'You already have a listing with this title. It won’t be merged — check it isn’t a duplicate.',
      });
    }
    const prior = firstRowByTitle.get(normalize(title));
    if (prior === undefined) {
      firstRowByTitle.set(normalize(title), analysis);
    } else if (prior.groupKey !== analysis.groupKey) {
      analysis.issues.push({
        severity: 'warning',
        fieldKey: 'titleEn',
        message: `Row ${prior.row.rowNumber} creates a different listing with the same title. They won’t be merged — use a listing reference if they belong together.`,
      });
    }
  }
}

/** Detected listings come from the rows that would import (valid rows). */
function detectListings(
  analyses: readonly RowAnalysis[],
  rowResults: readonly DryRunRowResult[],
): DetectedListing[] {
  const validByNumber = new Map(rowResults.map((row) => [row.rowNumber, row.valid]));
  const groups = new Map<string, RowAnalysis[]>();
  for (const analysis of analyses) {
    if (validByNumber.get(analysis.row.rowNumber) !== true) continue;
    const group = groups.get(analysis.groupKey) ?? [];
    group.push(analysis);
    groups.set(analysis.groupKey, group);
  }
  const listings: DetectedListing[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const titleEn = cell(first.row, 'titleEn');
    if (titleEn === '') continue;
    const branchNames = [...new Set(group.flatMap((analysis) => analysis.branchNames))];
    const optionCount = group.filter((analysis) => analysis.hasOption).length;
    const notes: ImportRowIssue[] = [
      {
        severity: 'info',
        message: 'Will be created as a private draft — customers never see drafts, and Himma review still applies before publication.',
      },
    ];
    if (optionCount === 0) {
      notes.push({
        severity: 'info',
        message: 'No pricing option in this file — the draft will need one before it can be submitted for review.',
      });
    }
    if (branchNames.length === 0) {
      notes.push({
        severity: 'info',
        message: 'No branch in this file — the draft will need an active branch before it can be submitted for review.',
      });
    }
    listings.push({
      listingRef: first.listingRef,
      titleEn,
      rowNumbers: group.map((analysis) => analysis.row.rowNumber),
      optionCount,
      branchNames,
      notes,
    });
  }
  return listings.sort((a, b) => (a.rowNumbers[0]! < b.rowNumbers[0]! ? -1 : 1));
}
