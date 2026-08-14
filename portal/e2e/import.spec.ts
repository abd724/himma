import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-10 bulk-import preview over the production build (fixture opt-in),
 * across the three viewport projects: instructions/template, file
 * selection, column mapping, dry-run preview with §8.5 atomicity truth,
 * per-row errors, valid-subset re-batch, Branch Manager scope, and the
 * no-engine end state. Files are set via the input (buffer payloads) —
 * nothing leaves the browser.
 */
const evidence = evidenceDir('portal-w2-10');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';

const VALID_CSV = [
  'listing_ref,title_en,activity_type,setting,who_for,branches,price_kind,price_aed,sessions_count',
  'SWIM-01,Morning Lap Swimming,Swimming,Indoor,Everyone,Dubai Marina pool,Monthly,450,',
  'SWIM-01,,,,,,Package,1200,12',
  ',Ladies Sunset Aqua,Aqua Fitness,Outdoor,Ladies only,Business Bay pool,Drop-in,65,',
].join('\n');

const MIXED_CSV = [
  'title_en,activity_type,setting,who_for,price_kind,price_aed',
  'Good Row Aqua,Aqua Fitness,Indoor,Everyone,Monthly,390',
  'Broken Type,Underwater Basket Weaving,Indoor,Everyone,Monthly,390',
  'Broken Price,Swimming,Indoor,Everyone,Monthly,AED 90',
].join('\n');

const consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error));
  });
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

async function clientGoto(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function setCsv(page: Page, content: string, name = 'catalogue.csv') {
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(content, 'utf-8'),
  });
}

test('owner journey: instructions → valid file → mapping → dry run → truthful ready state (nothing imported)', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  await page.getByRole('link', { name: 'Import listings from a spreadsheet' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import listings' })).toBeVisible();
  await expect(page.getByText(/Bulk processing isn’t enabled yet/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-initial.png`),
    fullPage: true,
  });

  await setCsv(page, VALID_CSV);
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
  await page.getByRole('button', { name: 'Run the validation preview' }).click();
  await expect(page.getByRole('heading', { name: 'Validation preview' })).toBeVisible();
  await expect(
    page.getByText(/ready for import once bulk processing is enabled — nothing has been imported yet/),
  ).toBeVisible();
  // D-S4-1 made visible: three rows, TWO listings, three options.
  await expect(page.getByText('Morning Lap Swimming')).toBeVisible();
  await expect(page.getByText('Ladies Sunset Aqua')).toBeVisible();
  await expect(page.getByText(/private draft/).first()).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-valid.png`),
    fullPage: true,
  });

  // The shared catalogue is untouched: the index still serves exactly the
  // fixture truth (first page of 10 of the 12 listings) and none of the
  // previewed titles exists anywhere.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  await expect(page.getByText('10 listings loaded so far')).toBeVisible();
  await page.getByRole('button', { name: 'Load more listings' }).click();
  await expect(page.getByText(/12 listings/)).toBeVisible();
  await expect(page.getByText('Morning Lap Swimming')).toHaveCount(0);
});

test('mixed file: atomicity stated, row/field errors, then an explicit valid-subset re-batch', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await setCsv(page, MIXED_CSV);
  await page.getByRole('button', { name: 'Run the validation preview' }).click();
  await expect(page.getByText(/imports apply all-or-nothing/)).toBeVisible();
  await expect(page.getByText('Row 2')).toBeVisible();
  await expect(page.getByText(/isn’t a current Himma activity type/)).toBeVisible();
  await expect(page.getByText('Row 3')).toBeVisible();
  await expect(page.getByText(/no symbols or commas/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-mixed.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Continue with the 1 valid row' }).click();
  await expect(page.getByText(/previewing a new batch made of only the valid rows/)).toBeVisible();
  await expect(
    page.getByText(/ready for import once bulk processing is enabled — nothing has been imported yet/),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-subset.png`),
    fullPage: true,
  });
});

test('fully blocked file: a readable file-level failure with recovery', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await setCsv(page, 'title_en\n"unclosed', 'broken.csv');
  await expect(page.getByText(/unclosed quote/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-blocked.png`),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Remove file' }).click();
  await expect(page.getByText('Choose a CSV file')).toBeVisible();
});

test('Branch Manager: visible scope limitation, and out-of-scope branch rows fail validation', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await expect(page.getByText(/Your branch scope: Dubai Marina pool/)).toBeVisible();

  const scoped = [
    'title_en,activity_type,setting,who_for,branches,price_kind,price_aed',
    'Marina Aqua Sprint,Aqua Fitness,Indoor,Everyone,Dubai Marina pool,Monthly,300',
    'Bay Aqua Sprint,Aqua Fitness,Indoor,Everyone,Business Bay pool,Monthly,300',
  ].join('\n');
  await setCsv(page, scoped);
  await page.getByRole('button', { name: 'Run the validation preview' }).click();
  await expect(page.getByText('“Business Bay pool” is outside your branch scope.')).toBeVisible();
  await expect(page.getByText('Row 2')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-branch-scope.png`),
    fullPage: true,
  });
});

test('roles without catalogue management get the truthful no-access surface', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'finance@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await expect(page.getByText('Importing is managed by your catalogue team')).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-import-no-access.png`),
    fullPage: true,
  });
});
