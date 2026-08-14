import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureAuthRuntime, fixtureOrganizations } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const importPath = `/o/${blueWave.organizationId}/listings/import`;

function csvFile(content: string, name = 'catalogue.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

const VALID_CSV = [
  'listing_ref,title_en,activity_type,setting,who_for,branches,price_kind,price_aed,sessions_count',
  'SWIM-01,Morning Lap Swimming,Swimming,Indoor,Everyone,Dubai Marina pool,Monthly,450,',
  'SWIM-01,,,,,,Package,1200,12',
].join('\n');

const MIXED_CSV = [
  'title_en,activity_type,setting,who_for,price_kind,price_aed',
  'Good Row Aqua,Aqua Fitness,Indoor,Everyone,Monthly,390',
  'Bad Row,Underwater Basket Weaving,Indoor,Everyone,Monthly,390',
].join('\n');

async function loadWorkspace(page: ReturnType<typeof renderPortal>) {
  await screen.findByRole('heading', { level: 1, name: 'Import listings' });
  await screen.findByText('Choose a CSV file');
  return page;
}

async function uploadAndValidate(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.upload(screen.getByLabelText('Choose a CSV file'), file);
  await screen.findByRole('heading', { name: 'Match your columns' });
  await user.click(screen.getByRole('button', { name: 'Run the validation preview' }));
  await screen.findByRole('heading', { name: 'Validation preview' });
}

describe('bulk-import page (W2-10)', () => {
  test('roles without listings.manage get a truthful no-access surface and the Listings index shows them no import entry', async () => {
    const first = renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [importPath],
    });
    expect(
      await screen.findByText('Importing is managed by your catalogue team'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Choose a CSV file')).not.toBeInTheDocument();
    first.unmount();

    renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Listings' });
    expect(
      screen.queryByRole('link', { name: 'Import listings from a spreadsheet' }),
    ).not.toBeInTheDocument();
  });

  test('an authorized role reaches the import workspace from the Listings index', async () => {
    const user = userEvent.setup();
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/listings`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Listings' });
    await user.click(
      await screen.findByRole('link', { name: 'Import listings from a spreadsheet' }),
    );
    await screen.findByRole('heading', { level: 1, name: 'Import listings' });
    // The truthful engine status is stated up front.
    expect(screen.getByText(/Bulk processing isn’t enabled yet/)).toBeInTheDocument();
    expect(screen.getByText(/created as private drafts/)).toBeInTheDocument();
  });

  test('a suspended organization gets no upload surface', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${fixtureOrganizations.falcon.organizationId}/listings/import`],
    });
    expect(await screen.findByText(/currently suspended\. Importing is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Choose a CSV file')).not.toBeInTheDocument();
  });

  test('the Branch Manager sees the scope limitation up front', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [importPath],
    });
    await loadWorkspace(undefined as never);
    expect(screen.getByText(/Your branch scope: Dubai Marina pool/)).toBeInTheDocument();
    expect(
      screen.getByText(/rows that reference other branches won’t validate/),
    ).toBeInTheDocument();
  });

  test('valid file end-to-end: upload → auto-mapped columns → dry run → truthful ready state, with NO network call and NO fake persistence vocabulary', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await loadWorkspace(undefined as never);

    await uploadAndValidate(user, csvFile(VALID_CSV));

    // Truthful summary: 2 rows → ONE listing (D-S4-1 grouping) with two options.
    const results = screen.getByRole('heading', { name: 'Validation preview' }).closest('section')!;
    expect(within(results).getByText('Rows that validate').previousSibling?.textContent).toBe('2');
    expect(within(results).getByText('Listings detected').previousSibling?.textContent).toBe('1');
    expect(
      within(results).getByText('Pricing options detected').previousSibling?.textContent,
    ).toBe('2');
    expect(
      within(results).getByText(/ready for import once bulk processing is enabled — nothing has been imported yet/),
    ).toBeInTheDocument();
    expect(within(results).getByText('Morning Lap Swimming')).toBeInTheDocument();
    expect(within(results).getByText(/private draft/)).toBeInTheDocument();

    // No live API of any kind, and no fabricated success/persistence.
    expect(fetchSpy).not.toHaveBeenCalled();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/imported successfully|listings created|import id|job/i);
    fetchSpy.mockRestore();
  });

  test('a dry run leaves the shared catalogue untouched: the listings index still shows exactly the fixture truth', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await loadWorkspace(undefined as never);
    await uploadAndValidate(user, csvFile(VALID_CSV));
    await screen.findByText(/nothing has been imported yet/);

    const list = await runtime.listingsPort.listListings(blueWave.organizationId, { limit: 100 });
    if (list.kind !== 'loaded') throw new Error(list.kind);
    expect(list.page.programs).toHaveLength(12);
    expect(list.page.programs.some((program) => program.titleEn === 'Morning Lap Swimming')).toBe(false);
  });

  test('mixed file: atomicity is explained, errors point to row and field, and the valid-subset re-batch is an explicit new preview', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await loadWorkspace(undefined as never);
    await uploadAndValidate(user, csvFile(MIXED_CSV));

    expect(screen.getByText(/imports apply all-or-nothing/)).toBeInTheDocument();
    const issueCard = screen.getByText('Row 2').closest('li')!;
    expect(within(issueCard).getByText('Fix needed')).toBeInTheDocument();
    expect(within(issueCard).getByText('Activity type:')).toBeInTheDocument();
    expect(within(issueCard).getByText(/isn’t a current Himma activity type/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue with the 1 valid row' }));
    await screen.findByText(/previewing a new batch made of only the valid rows/);
    expect(
      await screen.findByText(/ready for import once bulk processing is enabled — nothing has been imported yet/),
    ).toBeInTheDocument();
  });

  test('file-level failures are provider-readable; replacing the file resets the run safely', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await loadWorkspace(undefined as never);

    await user.upload(screen.getByLabelText('Choose a CSV file'), csvFile('a,b', 'listings.xlsx'));
    expect(await screen.findByText(/Excel files aren’t read by the preview tool yet/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    await user.upload(screen.getByLabelText('Choose a CSV file'), csvFile('title_en'));
    expect(await screen.findByText(/only has a header row/)).toBeInTheDocument();

    // Replace with a valid file: the old failure clears, mapping appears.
    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    await uploadAndValidate(user, csvFile(VALID_CSV));
    expect(screen.queryByText(/only has a header row/)).not.toBeInTheDocument();

    // Removing the file clears the report too.
    await user.click(screen.getByRole('button', { name: 'Remove file' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Validation preview' })).not.toBeInTheDocument(),
    );
  });

  test('unmapped required columns block the preview with guidance instead of a doomed run', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await loadWorkspace(undefined as never);
    await user.upload(
      screen.getByLabelText('Choose a CSV file'),
      csvFile('name,price\nSwim Club,450'),
    );
    await screen.findByRole('heading', { name: 'Match your columns' });
    expect(screen.getByText(/Match these required fields to run the preview/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Run the validation preview' }),
    ).not.toBeInTheDocument();

    // Mapping the file's own column names onto Himma fields unlocks the run.
    await user.selectOptions(screen.getByLabelText('Title (English) (required)'), '0');
    expect(screen.queryByRole('button', { name: 'Run the validation preview' })).not.toBeInTheDocument();
  });

  test('malicious cell content renders strictly as text', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [importPath] });
    await loadWorkspace(undefined as never);
    const hostile = [
      'title_en,activity_type,setting,who_for',
      '"=HYPERLINK(""https://evil.example"",""<img src=x onerror=alert(1)>"")",Swimming,Indoor,Everyone',
    ].join('\n');
    await uploadAndValidate(user, csvFile(hostile));

    const main = screen.getByRole('main');
    // The raw text is displayed as-is (React escapes it) — no anchor, no
    // image, no script materializes from cell content.
    expect(main.textContent).toContain('=HYPERLINK("https://evil.example"');
    expect(main.querySelector('img[src="x"]')).toBeNull();
    expect(main.querySelector('a[href*="evil.example"]')).toBeNull();
  });
});
