import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, SearchX } from 'lucide-react';
import { useId, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { usePortalPorts } from '../../../app/ports-context';
import {
  IMPORT_FIELDS,
  IMPORT_SCHEMA_VERSION,
  type DryRunReport,
  type ImportFieldKey,
  type ImportRowInput,
  type ImportRowIssue,
} from '../../../catalogue/import-contract';
import { Button } from '../../../components/ui/button';
import { InlineAlert } from '../../../components/ui/inline-alert';
import { PageHeader } from '../../../components/ui/page-header';
import { usePageTitle } from '../../../hooks/use-page-title';
import { organizationPath } from '../../../navigation/nav-items';
import { useActiveOrganization } from '../../../organization/organization-context';
import type { OrganizationView } from '../../../profile/contract';
import { editorAuthority } from '../editor/editor-domain';
import { StateChip } from '../state-chip';
import listingStyles from '../listings.module.css';
import {
  applyMapping,
  autoMapColumns,
  buildErrorReportCsv,
  buildTemplateCsv,
  ignoredColumns,
  IMPORT_FILE_LIMITS,
  readImportFile,
  unmappedRequiredFields,
  type ColumnMapping,
  type ImportFileFailure,
} from './import-file';
import styles from './import.module.css';

/**
 * W2-10 bulk-import PREVIEW (docs/23 §8.5, docs/29 PP-17) at
 * `/o/:organizationId/listings/import`.
 *
 * NO import engine exists yet: this surface parses the provider's file IN
 * THE BROWSER (the file never leaves it), maps columns, and runs a
 * dry-run validation preview over the same truth the portal already reads.
 * Nothing is ever imported, created, submitted, or published here — the
 * truthful end state is "ready for import once bulk processing is
 * enabled". §8.5 atomicity is stated, not simulated: a file with errors
 * imports nothing; the valid-subset action forms a NEW previewed batch.
 *
 * Authority: importing is a catalogue mutation workflow → `listings.manage`
 * (Owner, Organization Manager, Listings Editor; Branch Manager within
 * branch scope — rows referencing branches outside the assigned scope fail
 * validation exactly like the real association rule). Suspended
 * organizations don't get an upload surface (mutations are refused).
 */
export function ListingImportPage() {
  usePageTitle('Import listings');
  const organization = useActiveOrganization();
  const { profilePort } = usePortalPorts();

  const viewQuery = useQuery({
    queryKey: ['organizationView', organization.id],
    queryFn: () => profilePort.loadOrganizationView(organization.id),
  });
  const view = viewQuery.data?.kind === 'loaded' ? viewQuery.data.view : null;

  return (
    <>
      <p className={listingStyles.backLinkWrap}>
        <Link className={listingStyles.backLink} to={organizationPath(organization.id, 'listings')}>
          <ArrowLeft aria-hidden="true" strokeWidth={1.75} className={listingStyles.backIcon} />
          Back to listings
        </Link>
      </p>
      <PageHeader
        title="Import listings"
        description="Bring your existing catalogue into Himma from a spreadsheet — validated first, imported when bulk processing is enabled."
      />
      {viewQuery.isPending ? (
        <p className={listingStyles.loading} role="status">
          Loading the import workspace…
        </p>
      ) : view === null ? (
        <div className={listingStyles.unavailable}>
          <InlineAlert tone="error">
            We couldn&rsquo;t load this workspace. Try again in a moment.
          </InlineAlert>
          <Button variant="secondary" onClick={() => void viewQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : !editorAuthority(view).canManage ? (
        <div className={listingStyles.emptyCard}>
          <SearchX className={listingStyles.emptyIcon} aria-hidden="true" strokeWidth={1.5} />
          <h2 className={listingStyles.emptyTitle}>Importing is managed by your catalogue team</h2>
          <p className={listingStyles.emptyBody}>
            Owners, Organization Managers, Branch Managers, and Listings Editors manage the
            catalogue, including imports. Your role doesn&rsquo;t include it.
          </p>
        </div>
      ) : editorAuthority(view).suspended ? (
        <InlineAlert tone="info">
          This organization is currently suspended. Importing is unavailable — listings stay
          readable in the meantime.
        </InlineAlert>
      ) : (
        <ImportWorkspace view={view} />
      )}
    </>
  );
}

// -- workspace ----------------------------------------------------------------

type FileState =
  | { kind: 'none' }
  | { kind: 'failed'; fileName: string; failure: ImportFileFailure }
  | {
      kind: 'ready';
      fileName: string;
      headers: readonly string[];
      rows: ReadonlyArray<readonly string[]>;
      mapping: ColumnMapping;
    };

type ReportState =
  | { kind: 'none' }
  | { kind: 'validating' }
  | {
      kind: 'report';
      report: DryRunReport;
      /** The inputs this report was produced from (subset re-batches
       *  re-validate a filtered copy — the file itself never changes). */
      inputs: readonly ImportRowInput[];
      subset: boolean;
    }
  | { kind: 'refused'; message: string };

const FILE_FAILURE_COPY: Record<ImportFileFailure['kind'], string> = {
  unsupportedType:
    'This file type isn’t supported. Save your catalogue as a CSV file (most spreadsheet apps offer “Save as CSV (UTF-8)”).',
  excelNotSupportedYet:
    'Excel files aren’t read by the preview tool yet — that arrives with bulk processing. Save the sheet as CSV (UTF-8) and upload that instead.',
  tooLarge: `This file is larger than the preview tool reads (${Math.round(IMPORT_FILE_LIMITS.maxBytes / 1_000)} KB). Split the catalogue into smaller files for now.`,
  emptyFile: 'This file is empty.',
  noDataRows: 'This file only has a header row — there are no listings to read.',
  unreadable: 'This file couldn’t be read. Re-export it as CSV (UTF-8) and try again.',
  malformed:
    'This file has an unclosed quote, so its rows couldn’t be read reliably. Re-export it as CSV and try again.',
  duplicateColumns: 'Two columns share the same name. Give every column a unique name.',
  tooManyColumns: `This file has more than ${IMPORT_FILE_LIMITS.maxColumns} columns. Remove the ones the import doesn’t use.`,
  tooManyRows: `The preview tool reads up to ${IMPORT_FILE_LIMITS.maxDataRows} listing rows per file. Split the catalogue into smaller files for now.`,
  raggedRows: 'Some rows have more cells than the header row — usually a stray comma.',
};

const REFUSAL_COPY: Record<string, string> = {
  forbidden: 'Your role can’t run imports for this organization.',
  notFound: 'This workspace isn’t available any more.',
  organizationSuspended: 'This organization is currently suspended, so importing is unavailable.',
  unavailable: 'The validation preview didn’t run — nothing was changed. Try again in a moment.',
};

function ImportWorkspace({ view }: { view: OrganizationView }) {
  const { bulkImportPort } = usePortalPorts();
  const authority = editorAuthority(view);
  const [file, setFile] = useState<FileState>({ kind: 'none' });
  const [report, setReport] = useState<ReportState>({ kind: 'none' });
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();

  const scopedBranchNames =
    authority.assignedActiveBranchIds === null
      ? null
      : view.branches
          .filter(
            (branch) => branch.active && authority.assignedActiveBranchIds!.includes(branch.id),
          )
          .map((branch) => branch.label);

  const chooseFile = async (chosen: File) => {
    setReport({ kind: 'none' });
    const outcome = await readImportFile(chosen);
    if (outcome.kind === 'parsed') {
      setFile({
        kind: 'ready',
        fileName: chosen.name,
        headers: outcome.headers,
        rows: outcome.rows,
        mapping: autoMapColumns(outcome.headers),
      });
    } else {
      setFile({ kind: 'failed', fileName: chosen.name, failure: outcome });
    }
  };

  const resetFile = () => {
    setFile({ kind: 'none' });
    setReport({ kind: 'none' });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) {
      void chooseFile(dropped);
    }
  };

  const runValidation = async (inputs: readonly ImportRowInput[], subset: boolean) => {
    if (report.kind === 'validating') {
      return;
    }
    setReport({ kind: 'validating' });
    const outcome = await bulkImportPort.dryRun(view.organization.id, inputs);
    if (outcome.kind === 'dryRunComplete') {
      setReport({ kind: 'report', report: outcome.report, inputs, subset });
    } else {
      setReport({
        kind: 'refused',
        message: REFUSAL_COPY[outcome.kind] ?? REFUSAL_COPY['unavailable']!,
      });
    }
    requestAnimationFrame(() => resultsRef.current?.focus());
  };

  const downloadCsv = (content: string, fileName: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const requiredUnmapped = file.kind === 'ready' ? unmappedRequiredFields(file.mapping) : [];

  return (
    <div className={styles.importWrap}>
      {scopedBranchNames !== null ? (
        <InlineAlert tone="info">
          Your branch scope: {scopedBranchNames.length > 0 ? scopedBranchNames.join(', ') : 'no active branches'}.
          Imported listings can only run at your assigned branches — rows that reference other
          branches won&rsquo;t validate.
        </InlineAlert>
      ) : null}

      <BeforeYouStart onDownloadTemplate={() => downloadCsv(buildTemplateCsv(), 'himma-import-template-v1.csv')} />

      <section aria-labelledby="import-file-heading" className={listingStyles.section}>
        <h2 id="import-file-heading" className={listingStyles.sectionTitle}>
          Your file
        </h2>
        <div
          className={`${styles.dropZone} ${dragActive ? styles.dropZoneActive : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
        >
          {file.kind === 'none' ? (
            <>
              <label className={styles.fileInputLabel} htmlFor={fileInputId}>
                Choose a CSV file
                <input
                  ref={fileInputRef}
                  id={fileInputId}
                  className={styles.fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    if (chosen) {
                      void chooseFile(chosen);
                    }
                  }}
                />
              </label>
              <p className={listingStyles.supportingText}>
                …or drag a CSV file into this area. The file stays on your device — nothing is
                uploaded during validation.
              </p>
            </>
          ) : (
            <>
              <div className={styles.fileMeta}>
                <span className={styles.fileName}>{file.fileName}</span>
                {file.kind === 'ready' ? (
                  <span className={listingStyles.supportingText}>
                    {file.rows.length} row{file.rows.length === 1 ? '' : 's'} read
                  </span>
                ) : null}
              </div>
              <div className={styles.actionsRow}>
                <Button variant="secondary" onClick={resetFile}>
                  Remove file
                </Button>
              </div>
            </>
          )}
        </div>
        {file.kind === 'failed' ? (
          <InlineAlert tone="error">
            {FILE_FAILURE_COPY[file.failure.kind]}
            {file.failure.kind === 'duplicateColumns'
              ? ` Duplicated: ${file.failure.names.join(', ')}.`
              : ''}
            {file.failure.kind === 'raggedRows'
              ? ` Check row${file.failure.rowNumbers.length === 1 ? '' : 's'} ${file.failure.rowNumbers.join(', ')}.`
              : ''}
          </InlineAlert>
        ) : null}
      </section>

      {file.kind === 'ready' ? (
        <MappingSection
          file={file}
          requiredUnmapped={requiredUnmapped}
          onMappingChange={(mapping) => {
            setFile({ ...file, mapping });
            // A mapping change invalidates any previous validation run.
            setReport({ kind: 'none' });
          }}
          onRunValidation={() => void runValidation(applyMapping(file.rows, file.mapping), false)}
          validating={report.kind === 'validating'}
        />
      ) : null}

      {/* Focus target after a run — the results section carries its own
          heading, so no label is needed here. */}
      <div ref={resultsRef} tabIndex={-1} className={styles.alertFocus}>
        {report.kind === 'refused' ? <InlineAlert tone="error">{report.message}</InlineAlert> : null}
        {report.kind === 'report' ? (
          <DryRunResults
            report={report.report}
            subset={report.subset}
            fileName={file.kind === 'ready' ? file.fileName : ''}
            onDownloadErrors={() =>
              downloadCsv(buildErrorReportCsv(report.report), 'himma-import-validation-report.csv')
            }
            onContinueWithValid={() => {
              const validNumbers = new Set(
                report.report.rows.filter((row) => row.valid).map((row) => row.rowNumber),
              );
              void runValidation(
                report.inputs.filter((input) => validNumbers.has(input.rowNumber)),
                true,
              );
            }}
          />
        ) : null}
      </div>
      <p role="status" className={styles.srOnlyStatus}>
        {report.kind === 'validating'
          ? 'Running the validation preview…'
          : report.kind === 'report'
            ? 'Validation preview complete.'
            : ''}
      </p>
    </div>
  );
}

// -- instructions -------------------------------------------------------------

function BeforeYouStart({ onDownloadTemplate }: { onDownloadTemplate: () => void }) {
  return (
    <section aria-labelledby="import-instructions-heading" className={listingStyles.section}>
      <h2 id="import-instructions-heading" className={listingStyles.sectionTitle}>
        Before you start
      </h2>
      <div className={listingStyles.sectionCard}>
        <p className={listingStyles.bodyText}>
          Upload your catalogue as a CSV file — one row per pricing option. Rows that share a
          listing reference become one listing with several pricing options.
        </p>
        <ul className={styles.guidanceList} aria-label="How importing works">
          <li className={listingStyles.supportingText}>
            Imported listings are created as private drafts. Nothing is published automatically —
            Himma review and your own publication step still apply.
          </li>
          <li className={listingStyles.supportingText}>
            Files import all-or-nothing: a file with errors imports no rows. You can always
            continue with only the valid rows as a new batch after reviewing the errors.
          </li>
          <li className={listingStyles.supportingText}>
            Bulk processing isn&rsquo;t enabled yet — this tool validates your file and gets it
            ready, and nothing is imported today.
          </li>
          <li className={listingStyles.supportingText}>
            The preview tool reads CSV files (save your spreadsheet as CSV UTF-8). Excel upload
            arrives with bulk processing.
          </li>
        </ul>
        <div className={styles.actionsRow}>
          <Button variant="secondary" onClick={onDownloadTemplate}>
            Download the template (CSV)
          </Button>
          <span className={listingStyles.supportingText}>
            Import preview format {IMPORT_SCHEMA_VERSION} — a working format while the final
            import format is agreed.
          </span>
        </div>
        <details>
          <summary className={listingStyles.bodyText}>Columns and allowed values</summary>
          <dl className={styles.guidanceList}>
            {IMPORT_FIELDS.map((field) => (
              <div key={field.key} className={styles.guidanceRow}>
                <dt>
                  {field.label}
                  {field.required ? <span className={styles.requiredChip}>Required</span> : null}
                </dt>
                <dd>{field.guidance}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </section>
  );
}

// -- column mapping -----------------------------------------------------------

function MappingSection({
  file,
  requiredUnmapped,
  onMappingChange,
  onRunValidation,
  validating,
}: {
  file: Extract<FileState, { kind: 'ready' }>;
  requiredUnmapped: readonly ImportFieldKey[];
  onMappingChange: (mapping: ColumnMapping) => void;
  onRunValidation: () => void;
  validating: boolean;
}) {
  const ignored = ignoredColumns(file.headers, file.mapping);
  const labelByKey = new Map(IMPORT_FIELDS.map((field) => [field.key, field.label]));
  return (
    <section aria-labelledby="import-mapping-heading" className={listingStyles.section}>
      <h2 id="import-mapping-heading" className={listingStyles.sectionTitle}>
        Match your columns
      </h2>
      <div className={listingStyles.sectionCard}>
        <p className={listingStyles.supportingText}>
          Columns matching the template were matched automatically. Adjust anything that
          doesn&rsquo;t line up — a Himma field left unmatched is simply not imported.
        </p>
        <div className={styles.mappingGrid}>
          {IMPORT_FIELDS.map((field) => {
            const selectId = `import-map-${field.key}`;
            const takenElsewhere = new Set(
              IMPORT_FIELDS.filter((other) => other.key !== field.key)
                .map((other) => file.mapping[other.key])
                .filter((index): index is number => index !== null),
            );
            return (
              <div key={field.key} className={styles.mappingField}>
                <label htmlFor={selectId}>
                  {field.label}
                  {field.required ? ' (required)' : ''}
                </label>
                <select
                  id={selectId}
                  value={file.mapping[field.key] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value === '' ? null : Number(event.target.value);
                    onMappingChange({ ...file.mapping, [field.key]: value });
                  }}
                >
                  <option value="">Not in this file</option>
                  {file.headers.map((header, index) =>
                    header === '' || takenElsewhere.has(index) ? null : (
                      <option key={`${header}-${index}`} value={index}>
                        {header}
                      </option>
                    ),
                  )}
                </select>
              </div>
            );
          })}
        </div>
        {ignored.length > 0 ? (
          <p className={listingStyles.supportingText}>
            Not imported (no matching Himma field): {ignored.join(', ')}.
          </p>
        ) : null}
        {requiredUnmapped.length > 0 ? (
          <InlineAlert tone="info">
            Match these required fields to run the preview:{' '}
            {requiredUnmapped.map((key) => labelByKey.get(key) ?? key).join(', ')}.
          </InlineAlert>
        ) : (
          <div className={styles.actionsRow}>
            <Button busy={validating} busyLabel="Validating…" onClick={onRunValidation}>
              Run the validation preview
            </Button>
            <span className={listingStyles.supportingText}>
              Checks your file against your branches and the Himma catalogue rules — nothing is
              imported.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

// -- results ------------------------------------------------------------------

function severityLabel(issue: ImportRowIssue): { label: string; tone: 'attention' | 'pending' | 'neutral' } {
  if (issue.severity === 'error') return { label: 'Fix needed', tone: 'attention' };
  if (issue.severity === 'warning') return { label: 'Check this', tone: 'pending' };
  return { label: 'Note', tone: 'neutral' };
}

function DryRunResults({
  report,
  subset,
  fileName,
  onDownloadErrors,
  onContinueWithValid,
}: {
  report: DryRunReport;
  subset: boolean;
  fileName: string;
  onDownloadErrors: () => void;
  onContinueWithValid: () => void;
}) {
  const { summary } = report;
  const fieldLabel = new Map(IMPORT_FIELDS.map((field) => [field.key, field.label]));
  const rowsWithIssues = report.rows.filter((row) => row.issues.length > 0);
  const ready = summary.errorRows === 0 && summary.validRows > 0;

  return (
    <section aria-labelledby="import-results-heading" className={listingStyles.section}>
      <h2 id="import-results-heading" className={listingStyles.sectionTitle}>
        Validation preview
      </h2>
      {subset ? (
        <InlineAlert tone="info">
          You&rsquo;re previewing a new batch made of only the valid rows
          {fileName !== '' ? ` from ${fileName}` : ''}. Your file itself is unchanged.
        </InlineAlert>
      ) : null}

      <div className={styles.summaryTiles}>
        <SummaryTile value={summary.totalRows} label="Rows read" />
        <SummaryTile value={summary.validRows} label="Rows that validate" />
        <SummaryTile value={summary.errorRows} label="Rows needing fixes" />
        <SummaryTile value={summary.warningRows} label="Rows to double-check" />
        <SummaryTile value={summary.detectedListings} label="Listings detected" />
        <SummaryTile value={summary.detectedPriceOptions} label="Pricing options detected" />
      </div>

      {ready ? (
        <InlineAlert tone="success">
          Validation complete. This batch is ready for import once bulk processing is enabled —
          nothing has been imported yet.
        </InlineAlert>
      ) : summary.validRows === 0 ? (
        <InlineAlert tone="error">
          None of the rows can be imported yet. Fix the issues below in your file, then upload it
          again.
        </InlineAlert>
      ) : (
        <InlineAlert tone="error">
          This file can&rsquo;t be imported as it stands — {summary.errorRows} row
          {summary.errorRows === 1 ? ' needs' : 's need'} fixing, and imports apply all-or-nothing
          (no rows are imported from a file with errors). Fix your file and upload it again, or
          continue with only the valid rows as a new batch.
        </InlineAlert>
      )}

      <div className={styles.actionsRow}>
        {rowsWithIssues.length > 0 ? (
          <Button variant="secondary" onClick={onDownloadErrors}>
            Download the validation report (CSV)
          </Button>
        ) : null}
        {!ready && summary.validRows > 0 ? (
          <Button variant="secondary" onClick={onContinueWithValid}>
            Continue with the {summary.validRows} valid row{summary.validRows === 1 ? '' : 's'}
          </Button>
        ) : null}
      </div>

      {report.listings.length > 0 ? (
        <div className={listingStyles.sectionCard}>
          <h3 className={listingStyles.bodyText} id="import-detected-heading">
            What this batch creates
          </h3>
          <ul className={styles.listingList} aria-labelledby="import-detected-heading">
            {report.listings.map((listing) => (
              <li key={`${listing.listingRef ?? ''}:${listing.rowNumbers[0]}`} className={styles.rowCard}>
                <div className={styles.rowHeadline}>
                  <span className={styles.rowNumber}>{listing.titleEn}</span>
                  <span className={styles.rowTitle}>
                    {listing.listingRef !== null ? `${listing.listingRef} · ` : ''}
                    {listing.optionCount} pricing option{listing.optionCount === 1 ? '' : 's'}
                    {listing.branchNames.length > 0
                      ? ` · ${listing.branchNames.join(', ')}`
                      : ' · no branch yet'}
                  </span>
                </div>
                <ul className={styles.issueList}>
                  {listing.notes.map((note, index) => (
                    <li key={index} className={styles.issueRow}>
                      {note.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rowsWithIssues.length > 0 ? (
        <div className={listingStyles.sectionCard}>
          <h3 className={listingStyles.bodyText} id="import-issues-heading">
            Rows needing attention
          </h3>
          <ul className={styles.rowList} aria-labelledby="import-issues-heading">
            {rowsWithIssues.map((row) => (
              <li key={row.rowNumber} className={styles.rowCard}>
                <div className={styles.rowHeadline}>
                  <span className={styles.rowNumber}>Row {row.rowNumber}</span>
                  {row.titleEn !== null ? <span className={styles.rowTitle}>{row.titleEn}</span> : null}
                  {row.listingRef !== null ? (
                    <span className={styles.rowTitle}>{row.listingRef}</span>
                  ) : null}
                </div>
                <ul className={styles.issueList}>
                  {row.issues.map((issue, index) => {
                    const severity = severityLabel(issue);
                    return (
                      <li key={index} className={styles.issueRow}>
                        <StateChip label={severity.label} tone={severity.tone} />
                        {issue.fieldKey ? (
                          <span className={styles.issueField}>
                            {fieldLabel.get(issue.fieldKey) ?? issue.fieldKey}:
                          </span>
                        ) : null}
                        <span>{issue.message}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function SummaryTile({ value, label }: { value: number; label: string }) {
  return (
    <div className={styles.summaryTile}>
      <span className={styles.summaryValue}>{value}</span>
      <span className={styles.summaryLabel}>{label}</span>
    </div>
  );
}
