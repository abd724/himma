import type { ImportFieldKey, ImportRowInput } from '../src/catalogue/import-contract';
import {
  validateImportRows,
  type ImportReferenceData,
} from '../src/catalogue/import-validation';
import { parseAedToFils } from '../src/catalogue/money';

/** A small organization: two active branches, one deactivated, one active
 *  taxonomy row — everything the v1 semantic rules resolve against. */
const REFERENCE: ImportReferenceData = {
  activityTypes: [
    { id: 'type-swimming', labelEn: 'Swimming' },
    { id: 'type-aqua', labelEn: 'Aqua Fitness' },
  ],
  branches: [
    { id: 'branch-marina', label: 'Dubai Marina pool', active: true },
    { id: 'branch-bay', label: 'Business Bay pool', active: true },
    { id: 'branch-sufouh', label: 'Al Sufouh training pool', active: false },
  ],
  assignedActiveBranchIds: null,
  existingListingTitles: ['Adult Beginner Swimming'],
};

function row(
  values: Partial<Record<ImportFieldKey, string>>,
  rowNumber = 1,
): ImportRowInput {
  return { rowNumber, values };
}

const VALID = {
  titleEn: 'Junior Swim Camp',
  activityType: 'Swimming',
  setting: 'Indoor',
  whoFor: 'Everyone',
  priceKind: 'Monthly',
  priceAed: '450',
} as const;

function issuesOf(report: ReturnType<typeof validateImportRows>, rowNumber: number) {
  return report.rows.find((entry) => entry.rowNumber === rowNumber)!.issues;
}

describe('import dry-run semantic validation (W2-10 — mirrors the real catalogue rules)', () => {
  test('a fully valid row validates, detects one listing with one option, and previews draft truth', () => {
    const report = validateImportRows([row({ ...VALID, branches: 'Dubai Marina pool' })], REFERENCE);
    expect(report.summary).toEqual({
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
      warningRows: 0,
      detectedListings: 1,
      detectedPriceOptions: 1,
    });
    const listing = report.listings[0]!;
    expect(listing.titleEn).toBe('Junior Swim Camp');
    expect(listing.branchNames).toEqual(['Dubai Marina pool']);
    expect(listing.notes.map((note) => note.severity)).toEqual(['info']);
    expect(listing.notes[0]!.message).toMatch(/private draft/);
  });

  test('English title is required; Arabic stays optional (never required, only bounded)', () => {
    const missing = validateImportRows([row({ ...VALID, titleEn: '' })], REFERENCE);
    expect(issuesOf(missing, 1)).toContainEqual({
      severity: 'error',
      fieldKey: 'titleEn',
      message: 'An English title is required.',
    });

    const noArabic = validateImportRows([row({ ...VALID })], REFERENCE);
    expect(noArabic.summary.validRows).toBe(1);
    const longArabic = validateImportRows([row({ ...VALID, titleAr: 'ا'.repeat(161) })], REFERENCE);
    expect(issuesOf(longArabic, 1).some((issue) => issue.fieldKey === 'titleAr')).toBe(true);
  });

  test('unknown or inactive taxonomy is identified (ACTIVE labels only; no fuzzy matching)', () => {
    for (const value of ['Rock Climbing', 'Swim', 'swimmingg']) {
      const report = validateImportRows([row({ ...VALID, activityType: value })], REFERENCE);
      expect(issuesOf(report, 1).some((issue) => issue.fieldKey === 'activityType' && issue.severity === 'error')).toBe(true);
    }
    // Case-insensitive exact match is allowed.
    const cased = validateImportRows([row({ ...VALID, activityType: '  swimming ' })], REFERENCE);
    expect(cased.summary.validRows).toBe(1);
  });

  test('branch resolution: unknown, deactivated, and cross-organization names all refuse; ambiguity refuses', () => {
    const unknown = validateImportRows([row({ ...VALID, branches: 'Palm pool' })], REFERENCE);
    expect(issuesOf(unknown, 1)[0]!.message).toMatch(/doesn’t match any of your branches/);

    const inactive = validateImportRows([row({ ...VALID, branches: 'Al Sufouh training pool' })], REFERENCE);
    expect(issuesOf(inactive, 1)[0]!.message).toMatch(/deactivated/);

    // Another organization's branch name is simply not among this org's
    // branches — cross-org assignment is unrepresentable by construction.
    const foreign = validateImportRows([row({ ...VALID, branches: 'Al Quoz dojo' })], REFERENCE);
    expect(issuesOf(foreign, 1).some((issue) => issue.severity === 'error')).toBe(true);

    const ambiguous = validateImportRows([row({ ...VALID, branches: 'Marina POOL' })], {
      ...REFERENCE,
      branches: [
        ...REFERENCE.branches,
        { id: 'branch-dupe-1', label: 'Marina Pool', active: true },
        { id: 'branch-dupe-2', label: 'marina pool', active: true },
      ],
    });
    expect(issuesOf(ambiguous, 1)[0]!.message).toMatch(/more than one branch/);
  });

  test('a branch-scoped caller cannot validate rows referencing branches outside the assigned scope', () => {
    const scoped: ImportReferenceData = {
      ...REFERENCE,
      assignedActiveBranchIds: ['branch-marina'],
    };
    const outside = validateImportRows([row({ ...VALID, branches: 'Business Bay pool' })], scoped);
    expect(issuesOf(outside, 1)[0]).toEqual({
      severity: 'error',
      fieldKey: 'branches',
      message: '“Business Bay pool” is outside your branch scope.',
    });
    const inside = validateImportRows([row({ ...VALID, branches: 'Dubai Marina pool' })], scoped);
    expect(inside.summary.validRows).toBe(1);
  });

  test('eligibility mirrors the backend exactly: vocabulary, 0–130 bounds, min≤max, all-ages exclusivity', () => {
    const badWho = validateImportRows([row({ ...VALID, whoFor: 'Adults' })], REFERENCE);
    expect(issuesOf(badWho, 1)[0]!.message).toMatch(/Everyone, Ladies only, Men only, Girls, or Boys/);

    const badAge = validateImportRows([row({ ...VALID, minAge: '131' })], REFERENCE);
    expect(issuesOf(badAge, 1).some((issue) => issue.fieldKey === 'minAge')).toBe(true);

    const inverted = validateImportRows([row({ ...VALID, minAge: '12', maxAge: '6' })], REFERENCE);
    expect(issuesOf(inverted, 1).some((issue) => issue.fieldKey === 'maxAge')).toBe(true);

    const conflict = validateImportRows([row({ ...VALID, allAges: 'Yes', minAge: '6' })], REFERENCE);
    expect(issuesOf(conflict, 1).some((issue) => issue.fieldKey === 'allAges')).toBe(true);

    // Provider labels AND canonical codes both resolve.
    for (const value of ['Ladies only', 'women', 'Girls', 'boys', 'Everyone', 'mixed']) {
      const ok = validateImportRows([row({ ...VALID, whoFor: value })], REFERENCE);
      expect(`${value}:${ok.summary.validRows}`).toBe(`${value}:1`);
    }
  });

  test('money is exact integer fils through the proven boundary — no floats, symbols, or over-precision', () => {
    expect(parseAedToFils('19.99')).toEqual({ kind: 'fils', fils: 1999 });

    const decimal = validateImportRows([row({ ...VALID, priceAed: '450.50' })], REFERENCE);
    expect(decimal.summary.validRows).toBe(1);

    for (const bad of ['450.505', 'AED 450', '1,200', '-5', '0']) {
      const report = validateImportRows([row({ ...VALID, priceAed: bad })], REFERENCE);
      expect(`${bad}:${issuesOf(report, 1).some((issue) => issue.fieldKey === 'priceAed')}`).toBe(`${bad}:true`);
    }
  });

  test('price-option ties are preserved: free⇔no amount, paid⇒amount, package⇔sessions, kind required for price details', () => {
    const freeWithPrice = validateImportRows([row({ ...VALID, priceKind: 'Free', priceAed: '10' })], REFERENCE);
    expect(issuesOf(freeWithPrice, 1)[0]!.message).toMatch(/Free options don’t take a price/);

    const paidMissing = validateImportRows([row({ ...VALID, priceAed: '' })], REFERENCE);
    expect(issuesOf(paidMissing, 1)[0]!.message).toMatch(/needs an amount in AED/);

    const packageMissingSessions = validateImportRows([row({ ...VALID, priceKind: 'Package' })], REFERENCE);
    expect(issuesOf(packageMissingSessions, 1).some((issue) => issue.fieldKey === 'sessionsCount')).toBe(true);

    const sessionsOnMonthly = validateImportRows([row({ ...VALID, sessionsCount: '8' })], REFERENCE);
    expect(issuesOf(sessionsOnMonthly, 1).some((issue) => issue.fieldKey === 'sessionsCount')).toBe(true);

    const detailsWithoutKind = validateImportRows([row({ ...VALID, priceKind: '', priceAed: '20' })], REFERENCE);
    expect(issuesOf(detailsWithoutKind, 1)[0]!.message).toMatch(/need a price type/);

    const noOptionAtAll = validateImportRows([row({ ...VALID, priceKind: '', priceAed: '' })], REFERENCE);
    expect(noOptionAtAll.summary.validRows).toBe(1);
    expect(noOptionAtAll.summary.detectedPriceOptions).toBe(0);
    expect(
      noOptionAtAll.listings[0]!.notes.some((note) => note.message.match(/No pricing option in this file/)),
    ).toBe(true);
  });

  test('D-S4-1 grouping: rows sharing listing_ref stay ONE listing with several options; conflicting listing fields refuse; repeats may stay blank', () => {
    const report = validateImportRows(
      [
        row({ ...VALID, listingRef: 'SWIM-01', branches: 'Dubai Marina pool' }, 1),
        row({ listingRef: 'SWIM-01', priceKind: 'Package', priceAed: '1200', sessionsCount: '12' }, 2),
        row({ listingRef: 'SWIM-01', titleEn: 'A DIFFERENT TITLE', priceKind: 'Free' }, 3),
      ],
      REFERENCE,
    );
    expect(issuesOf(report, 2)).toHaveLength(0);
    expect(issuesOf(report, 3).some((issue) => issue.fieldKey === 'titleEn' && issue.severity === 'error')).toBe(true);
    // The two agreeing rows form ONE listing with TWO options — never two
    // discoverable listings.
    expect(report.summary.detectedListings).toBe(1);
    expect(report.summary.detectedPriceOptions).toBe(2);
    expect(report.listings[0]!.rowNumbers).toEqual([1, 2]);
  });

  test('duplicate detection warns and never blocks or merges: in-file same shape, in-file same title, and current-catalogue titles', () => {
    const report = validateImportRows(
      [
        row({ ...VALID, listingRef: 'A' }, 1),
        row({ listingRef: 'A', priceKind: 'Monthly', priceAed: '450' }, 2),
        row({ ...VALID, listingRef: 'B' }, 3),
        row({ ...VALID, titleEn: 'Adult Beginner Swimming' }, 4),
      ],
      REFERENCE,
    );
    // Row 2 repeats row 1's option shape inside listing A.
    expect(issuesOf(report, 2).some((issue) => issue.severity === 'warning' && issue.message.match(/Same pricing option as row 1/))).toBe(true);
    // Row 3 duplicates listing A's title as a DIFFERENT listing.
    expect(issuesOf(report, 3).some((issue) => issue.severity === 'warning' && issue.message.match(/same title/))).toBe(true);
    // Row 4 matches an existing catalogue title.
    expect(issuesOf(report, 4).some((issue) => issue.severity === 'warning' && issue.message.match(/already have a listing/))).toBe(true);
    // Warnings never block: every row still validates, nothing merged.
    expect(report.summary.validRows).toBe(4);
    expect(report.summary.errorRows).toBe(0);
    expect(report.summary.detectedListings).toBe(3);
  });

  test('warnings never become blockers and errors always do: a mixed file summarizes truthfully', () => {
    const report = validateImportRows(
      [
        row({ ...VALID }, 1),
        row({ ...VALID, titleEn: 'Adult Beginner Swimming' }, 2), // warning only
        row({ ...VALID, activityType: 'Nope' }, 3), // error
      ],
      REFERENCE,
    );
    expect(report.summary).toMatchObject({ totalRows: 3, validRows: 2, errorRows: 1, warningRows: 1 });
    expect(report.rows[1]!.valid).toBe(true);
    expect(report.rows[2]!.valid).toBe(false);
    // Detected listings come from rows that would import.
    expect(report.summary.detectedListings).toBe(2);
  });
});
