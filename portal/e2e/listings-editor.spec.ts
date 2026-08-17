import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-8 Listing editor (create + edit) over the production build (fixture
 * opt-in), across the three viewport projects. All post-sign-in navigation
 * stays client-side (fixture sessions are memory-only). Lifecycle actions
 * (submit/publish/pause/archive/resubmit) must not exist anywhere here.
 */
const evidence = evidenceDir('portal-w2-8');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';

const HOLIDAY_CAMP_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f05'; // branchless draft
const PRIVATE_COACHING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f04'; // approved (review-gated)
const ADULT_SWIMMING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f01'; // published, Marina+Bay
const LADIES_AQUA_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f03'; // Marina-only (BM-editable)
const SCHOOL_TERM_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f06'; // submitted (locked)
const AQUA_THERAPY_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f08'; // changes_requested
const SUNSET_OPEN_WATER_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f10'; // archived

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

test('create flow: minimal structural draft → editor, then locations/pricing build the listing up', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'Create listing' })).toBeVisible();
  await expect(page.getByText(/Start with the basics — drafts start private/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-create-form.png`),
    fullPage: true,
  });

  await page.getByLabel(/Listing title/).fill('Sunrise Paddle Club');
  await page.getByRole('combobox', { name: /Activity type/ }).click();
  await page.getByRole('option', { name: /^Swimming/ }).click();
  await page.getByRole('radio', { name: 'Outdoor' }).check();
  await page.getByRole('button', { name: 'Create draft listing' }).click();

  // Lands in the new draft's editor: incomplete, with truthful readiness.
  await expect(page.getByRole('heading', { level: 1, name: 'Sunrise Paddle Club' })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  const readiness = page.locator('section', {
    has: page.getByRole('heading', { name: 'Ready for review?' }),
  });
  await expect(readiness.getByText('Missing', { exact: true })).toHaveCount(2); // branch + price option
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-new-draft-editor.png`),
    fullPage: true,
  });

  // Associate a branch, add a price option — readiness completes live.
  const locations = page.locator('section', {
    has: page.getByRole('heading', { name: 'Locations' }),
  });
  await locations
    .locator('li', { hasText: 'Dubai Marina pool' })
    .getByRole('button', { name: 'Offer here' })
    .click();
  await expect(locations.locator('li', { hasText: 'Dubai Marina pool' })).toContainText(
    'Offers this listing',
  );

  const pricing = page.locator('section', {
    has: page.getByRole('heading', { name: 'Pricing options' }),
  });
  await pricing.getByRole('button', { name: 'Add price option' }).click();
  await pricing.getByLabel('Price (AED)').fill('450.50');
  await pricing.getByLabel('Label (optional)').fill('Monthly pass');
  await pricing.getByRole('button', { name: 'Save option' }).click();
  await expect(page.getByText('Price option added.')).toBeVisible();
  await expect(pricing.getByText('AED 450.50')).toBeVisible();
  await expect(readiness.getByText('Missing', { exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-draft-complete-readiness.png`),
    fullPage: true,
  });
});

test('draft editor: direct save, stale-conflict reload keeps user values, archive option is permanent', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${HOLIDAY_CAMP_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Holiday Swim Camp' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-draft-editor.png`),
    fullPage: true,
  });

  // Direct dirty-field save.
  await page.getByLabel(/Listing title/).fill('Holiday Swim Camp Plus');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();

  // Stale conflict via the fixture concurrency control (another writer).
  await page.getByLabel(/Listing title/).fill('My Conflicted Title');
  await page.evaluate(
    ([orgId, programId]) => {
      window.__himmaPortalAccessFixture?.simulateConcurrentListingEdit(orgId!, programId!);
    },
    [BLUE_WAVE_ID, HOLIDAY_CAMP_ID],
  );
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText(/Someone else saved this listing while you were editing/),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-stale-conflict.png`),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Reload latest version' }).click();
  await expect(page.getByLabel(/Listing title/)).toHaveValue('My Conflicted Title');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();

  // Archive an option through the explicit irreversible confirmation.
  const pricing = page.locator('section', {
    has: page.getByRole('heading', { name: 'Pricing options' }),
  });
  await pricing.getByRole('button', { name: /^Archive Camp week$/ }).click();
  await expect(page.getByText(/can never be reactivated/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText(/was archived/)).toBeVisible();
  await expect(pricing.getByText('Archived', { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-option-archived.png`),
    fullPage: true,
  });
});

test('review-gated editor: protected fields marked; a protected save goes to Himma review; offers hot-apply', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Private Swim Coaching' })).toBeVisible();
  await expect(page.getByText(/Protected details/)).toBeVisible();
  await expect(page.getByText('Needs Himma review').first()).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-review-gated-editor.png`),
    fullPage: true,
  });

  await page.getByLabel('Description', { exact: true }).fill('Refined protected description.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Sent to Himma for review: English description/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-protected-edit-submitted.png`),
    fullPage: true,
  });

  // Offers are NOT protected — they hot-apply even here.
  const offers = page.locator('section', { has: page.getByRole('heading', { name: 'Offers' }) });
  await offers.getByRole('button', { name: 'Add offer' }).click();
  await offers.getByLabel('Label').fill('Founding week promo');
  await offers.getByRole('radio', { name: 'Promotion' }).check();
  await offers.getByRole('button', { name: 'Save offer' }).click();
  await expect(page.getByText('Offer added.')).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-offer-management.png`),
    fullPage: true,
  });
});

test('media metadata management on a published listing (no upload anywhere)', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${ADULT_SWIMMING_ID}/edit`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Adult Beginner Swimming' }),
  ).toBeVisible();
  const photos = page.locator('section', { has: page.getByRole('heading', { name: 'Photos' }) });
  await expect(photos.getByText(/Uploading new photos isn’t available/)).toBeVisible();
  expect(await page.locator('input[type="file"]').count()).toBe(0);

  await photos.getByRole('button', { name: /Edit description for Coach guiding/ }).click();
  await photos
    .getByRole('textbox', { name: 'Photo description' })
    .fill('Coach with adult beginners, main pool');
  await photos.getByRole('button', { name: 'Save description' }).click();
  await expect(page.getByText('Photo description saved.')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-media-metadata.png`),
    fullPage: true,
  });
});

test('Branch Manager: in-scope listing editable with scoped branch controls; readable out-of-scope listing not editable', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');

  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${LADIES_AQUA_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: 'Ladies Aqua Fitness' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  const locations = page.locator('section', {
    has: page.getByRole('heading', { name: 'Locations' }),
  });
  await expect(
    locations.locator('li', { hasText: 'Business Bay pool' }).getByText('Outside your branch scope'),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-manager-editor.png`),
    fullPage: true,
  });

  // Readable via the some-rule, NOT mutable under the every-rule.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${ADULT_SWIMMING_ID}/edit`);
  await expect(page.getByText(/can’t be edited from your branch scope/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-manager-out-of-scope.png`),
    fullPage: true,
  });
});

test('locked lifecycle states are frozen: submitted read-only and archived historical, with zero lifecycle actions anywhere', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');

  // Changes-requested stays fully editable (corrections now, resubmit W2-9).
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${AQUA_THERAPY_ID}/edit`);
  await expect(
    page.getByText(/Himma asked for changes before this listing can be approved/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-changes-requested-editor.png`),
    fullPage: true,
  });

  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${SCHOOL_TERM_ID}/edit`);
  await expect(page.getByText(/with Himma for review/)).toBeVisible();
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-submitted-frozen.png`),
    fullPage: true,
  });

  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${SUNSET_OPEN_WATER_ID}/edit`);
  await expect(page.getByText(/Archiving is final/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-archived-frozen.png`),
    fullPage: true,
  });

  // No lifecycle vocabulary exists on any editor surface.
  for (const path of [
    `/o/${BLUE_WAVE_ID}/listings/${HOLIDAY_CAMP_ID}/edit`,
    `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}/edit`,
  ]) {
    await clientGoto(page, path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const buttons = page.getByRole('main').getByRole('button');
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      const text = (await buttons.nth(index).textContent()) ?? '';
      expect(text).not.toMatch(
        /submit for review|publish|unpublish|pause|resume|archive listing|resubmit/i,
      );
    }
  }
});
