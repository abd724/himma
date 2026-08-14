import {
  IMPORT_FIELDS,
  type DryRunReport,
  type ImportFieldKey,
  type ImportRowInput,
} from '../../../catalogue/import-contract';

/**
 * Untrusted-file handling for the W2-10 import preview (docs/23 §8.5).
 * Everything here runs IN THE BROWSER — the file never leaves it in W2-10
 * (no upload endpoint exists). Values are treated strictly as text: no
 * formula/macro evaluation, no HTML rendering, bounded sizes throughout.
 *
 * Bounds are UX-only fixture limits for the preview tool — deliberately
 * conservative and RECORDED as not the final server contract (no
 * production limit exists yet).
 */
export const IMPORT_FILE_LIMITS = {
  maxBytes: 512_000,
  maxDataRows: 500,
  maxColumns: 40,
} as const;

export type ParsedImportFile = {
  readonly kind: 'parsed';
  readonly headers: readonly string[];
  /** Data rows (header excluded), padded to the header width. */
  readonly rows: ReadonlyArray<readonly string[]>;
};

export type ImportFileFailure =
  | { readonly kind: 'unsupportedType' }
  /** .xlsx/.xls — a CANON-approved production format whose in-browser
   *  parsing arrives with the import engine work; refused with save-as-CSV
   *  guidance rather than half-supported. */
  | { readonly kind: 'excelNotSupportedYet' }
  | { readonly kind: 'tooLarge' }
  | { readonly kind: 'emptyFile' }
  | { readonly kind: 'noDataRows' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'duplicateColumns'; readonly names: readonly string[] }
  | { readonly kind: 'tooManyColumns' }
  | { readonly kind: 'tooManyRows' }
  | { readonly kind: 'raggedRows'; readonly rowNumbers: readonly number[] };

export type ImportFileOutcome = ParsedImportFile | ImportFileFailure;

/** RFC-4180-style CSV: quoted fields, embedded commas/quotes/newlines,
 *  CRLF and lone-LF records. Returns null on an unterminated quote. */
export function parseCsvText(text: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;
  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  while (index < text.length) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRecord();
      index += 1;
      continue;
    }
    if (char === '\n') {
      pushRecord();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (inQuotes) {
    return null;
  }
  if (field !== '' || record.length > 0) {
    pushRecord();
  }
  return records;
}

/** `File.text()` everywhere real; FileReader covers older environments. */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsText(file);
  });
}

export async function readImportFile(file: File): Promise<ImportFileOutcome> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return { kind: 'excelNotSupportedYet' };
  }
  if (!name.endsWith('.csv')) {
    return { kind: 'unsupportedType' };
  }
  if (file.size > IMPORT_FILE_LIMITS.maxBytes) {
    return { kind: 'tooLarge' };
  }
  if (file.size === 0) {
    return { kind: 'emptyFile' };
  }
  let text: string;
  try {
    text = await readFileText(file);
  } catch {
    return { kind: 'unreadable' };
  }
  if (text.includes('\u0000')) {
    // Binary content pretending to be CSV.
    return { kind: 'unreadable' };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.trim() === '') {
    return { kind: 'emptyFile' };
  }
  const parsed = parseCsvText(text);
  if (parsed === null) {
    return { kind: 'malformed' };
  }
  const nonEmpty = parsed.filter((row) => row.some((value) => value.trim() !== ''));
  if (nonEmpty.length === 0) {
    return { kind: 'emptyFile' };
  }
  const headers = nonEmpty[0]!.map((header) => header.trim());
  if (headers.length > IMPORT_FILE_LIMITS.maxColumns) {
    return { kind: 'tooManyColumns' };
  }
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const header of headers) {
    if (header === '') continue;
    const normalized = header.toLowerCase();
    seen.set(normalized, (seen.get(normalized) ?? 0) + 1);
    if (seen.get(normalized) === 2) {
      duplicates.push(header);
    }
  }
  if (duplicates.length > 0) {
    return { kind: 'duplicateColumns', names: duplicates };
  }
  const dataRows = nonEmpty.slice(1);
  if (dataRows.length === 0) {
    return { kind: 'noDataRows' };
  }
  if (dataRows.length > IMPORT_FILE_LIMITS.maxDataRows) {
    return { kind: 'tooManyRows' };
  }
  const ragged: number[] = [];
  const rows = dataRows.map((row, index) => {
    if (row.length > headers.length) {
      ragged.push(index + 1);
    }
    const padded = [...row];
    while (padded.length < headers.length) {
      padded.push('');
    }
    return padded.slice(0, headers.length);
  });
  if (ragged.length > 0) {
    return { kind: 'raggedRows', rowNumbers: ragged.slice(0, 10) };
  }
  return { kind: 'parsed', headers, rows };
}

/** Column mapping: Himma field → file column index (or null = not mapped). */
export type ColumnMapping = Readonly<Record<ImportFieldKey, number | null>>;

const normalizeHeader = (header: string): string =>
  header.toLowerCase().replace(/[\s_-]+/g, '');

/** Auto-match file headers to the v1 fields (exact normalized match on the
 *  template header or the display label — no fuzzy matching). */
export function autoMapColumns(headers: readonly string[]): ColumnMapping {
  const byNormalized = new Map<string, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (normalized !== '' && !byNormalized.has(normalized)) {
      byNormalized.set(normalized, index);
    }
  });
  const entries = IMPORT_FIELDS.map((field) => {
    const index =
      byNormalized.get(normalizeHeader(field.header)) ??
      byNormalized.get(normalizeHeader(field.label)) ??
      null;
    return [field.key, index] as const;
  });
  return Object.fromEntries(entries) as ColumnMapping;
}

export function unmappedRequiredFields(mapping: ColumnMapping): ImportFieldKey[] {
  return IMPORT_FIELDS.filter((field) => field.required && mapping[field.key] === null).map(
    (field) => field.key,
  );
}

/** File columns no Himma field consumes (shown as ignored). */
export function ignoredColumns(headers: readonly string[], mapping: ColumnMapping): string[] {
  const used = new Set(Object.values(mapping).filter((index) => index !== null));
  return headers.filter((header, index) => header !== '' && !used.has(index));
}

export function applyMapping(
  rows: ReadonlyArray<readonly string[]>,
  mapping: ColumnMapping,
): ImportRowInput[] {
  const inputs: ImportRowInput[] = [];
  rows.forEach((row, index) => {
    const values: Partial<Record<ImportFieldKey, string>> = {};
    for (const field of IMPORT_FIELDS) {
      const columnIndex = mapping[field.key];
      if (columnIndex !== null && columnIndex < row.length) {
        values[field.key] = row[columnIndex]!;
      }
    }
    inputs.push({ rowNumber: index + 1, values });
  });
  return inputs;
}

// -- generated downloads (formula-injection guarded) --------------------------

/** Cells that a spreadsheet could interpret as a formula get a leading
 *  apostrophe so they always render as text (task §23). */
export function formulaGuard(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const guarded = formulaGuard(value);
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function buildCsv(rows: ReadonlyArray<readonly string[]>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** The v1 pre-release template: headers + two example rows demonstrating
 *  the one-listing-many-options grouping. Safe static content only. */
export function buildTemplateCsv(): string {
  const headers = IMPORT_FIELDS.map((field) => field.header);
  const exampleByKey: Partial<Record<ImportFieldKey, [string, string]>> = {
    listingRef: ['SWIM-01', 'SWIM-01'],
    titleEn: ['Adult Beginner Swimming', ''],
    descriptionEn: ['Small-group swimming classes for adults starting from zero.', ''],
    activityType: ['Swimming', ''],
    setting: ['Indoor', ''],
    whoFor: ['Everyone', ''],
    minAge: ['16', ''],
    skillLevel: ['Beginner', ''],
    branches: ['Dubai Marina pool; Business Bay pool', ''],
    priceKind: ['Monthly', 'Package'],
    priceAed: ['450', '1200'],
    sessionsCount: ['', '12'],
    optionLabel: ['', '12-session pack'],
  };
  const exampleRows = [0, 1].map((exampleIndex) =>
    IMPORT_FIELDS.map((field) => exampleByKey[field.key]?.[exampleIndex] ?? ''),
  );
  return buildCsv([headers, ...exampleRows]);
}

/** §8.5 rule 4: the downloadable per-row error report. */
export function buildErrorReportCsv(report: DryRunReport): string {
  const header = ['row', 'listing_ref', 'field', 'severity', 'message'];
  const fieldLabel = new Map(IMPORT_FIELDS.map((field) => [field.key, field.label]));
  const lines: string[][] = [header];
  for (const row of report.rows) {
    for (const issue of row.issues) {
      lines.push([
        String(row.rowNumber),
        row.listingRef ?? '',
        issue.fieldKey ? (fieldLabel.get(issue.fieldKey) ?? issue.fieldKey) : '',
        issue.severity,
        issue.message,
      ]);
    }
  }
  return buildCsv(lines);
}
