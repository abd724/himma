import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2 owner interaction correction — provider listing creation & editor
 * input model. Owner evidence over the production fixture build:
 * provider-authored content = direct text; Himma-managed vocabulary =
 * searchable canonical selector (no free-text taxonomy, truthful
 * missing-activity fallback); provider-owned entities (branches, price
 * options, offers) = create/manage workflows, never global dropdowns;
 * finite enums = segmented/chip controls; Arabic = compact optional
 * disclosure.
 */
const evidence = evidenceDir('portal-listing-interaction-correction');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const ADULT_SWIMMING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f01'; // published, multi-option

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

test('create listing: sections, searchable activity selector, missing-activity truth, Arabic disclosure', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'Create listing' })).toBeVisible();
  await expect(page.getByText(/Start with the basics — drafts start private/)).toBeVisible();
  // Section structure + requiredness convention.
  await expect(page.getByText('Basic information')).toBeVisible();
  await expect(page.getByText('Who can join')).toBeVisible();
  await expect(page.getByText(/you can complete everything else later/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-create-initial.png`),
    fullPage: true,
  });

  // Searchable Himma-managed selector with category context.
  const combobox = page.getByRole('combobox', { name: /Activity type/ });
  await combobox.click();
  await expect(page.getByRole('listbox', { name: 'Activity types' })).toBeVisible();
  await expect(page.getByRole('option', { name: /Swimming/ })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-activity-selector-open.png`),
    fullPage: true,
  });

  // Free text is never taxonomy — the truthful Himma/Support fallback.
  await combobox.fill('Rock climbing');
  await expect(page.getByText('No matching activity', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Support', exact: true })).toBeVisible();
  await expect(page.getByText(/Create ["“']?Rock climbing/i)).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-activity-no-match.png`),
    fullPage: true,
  });
  await combobox.fill('swim');
  await page.getByRole('option', { name: /^Swimming/ }).click();
  await expect(combobox).toHaveValue('Swimming');

  // Optional Arabic disclosure — expanded state.
  await page.getByRole('button', { name: 'Add Arabic content (optional)' }).click();
  await expect(page.getByLabel('Title (Arabic)')).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-arabic-expanded.png`),
    fullPage: true,
  });

  // Create the draft — private, incomplete by design.
  await page.getByLabel(/Listing title/).fill('Owner Correction Demo Listing');
  await page.getByRole('button', { name: 'Create draft listing' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Owner Correction Demo Listing' }),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-created-draft-editor.png`),
    fullPage: true,
  });

  // Locations: the provider's OWN branches with the real add-branch route.
  const locations = page.locator('section', {
    has: page.getByRole('heading', { name: 'Locations' }),
  });
  await locations.scrollIntoViewIfNeeded();
  await expect(
    locations.getByRole('link', { name: /Add a new branch/ }),
  ).toHaveAttribute('href', `/o/${BLUE_WAVE_ID}/branches/new`);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-locations-add-branch.png`),
    fullPage: true,
  });

  // Pricing: the provider CREATES price options (type chips, AED input).
  const pricing = page.locator('section', {
    has: page.getByRole('heading', { name: 'Pricing options' }),
  });
  await pricing.getByRole('button', { name: 'Add price option' }).click();
  await expect(
    pricing.getByRole('radiogroup', { name: 'Price option type' }),
  ).toBeVisible();
  await pricing.getByRole('radio', { name: 'Monthly' }).check();
  await pricing.getByLabel('Price (AED)').fill('250');
  await pricing.getByLabel('Label (optional)').fill('Monthly membership');
  await pricing.getByRole('button', { name: 'Save option' }).click();
  await expect(page.getByText('Price option added.')).toBeVisible();
  await noHorizontalOverflow(page);
});

test('editor pricing shows multiple provider-created options under ONE listing', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${ADULT_SWIMMING_ID}/edit`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Adult Beginner Swimming' }),
  ).toBeVisible();
  const pricing = page.locator('section', {
    has: page.getByRole('heading', { name: 'Pricing options' }),
  });
  await pricing.scrollIntoViewIfNeeded();
  await expect(pricing.getByRole('button', { name: 'Add price option' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-pricing-multiple-options.png`),
    fullPage: true,
  });
});

test('mobile-focused walkthrough: activity selection and eligibility controls stay usable', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-specific spot check');
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/new`);
  await expect(page.getByRole('heading', { level: 1, name: 'Create listing' })).toBeVisible();

  const combobox = page.getByRole('combobox', { name: /Activity type/ });
  await combobox.click();
  await expect(page.getByRole('listbox', { name: 'Activity types' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-activity-selection.png`),
    fullPage: true,
  });
  await page.getByRole('option', { name: /^Swimming/ }).click();

  // Eligibility chips wrap and age fields stay usable at 390.
  const audience = page.getByRole('radiogroup', { name: 'Who is this activity for?' });
  await audience.scrollIntoViewIfNeeded();
  await page.getByRole('radio', { name: 'Everyone' }).check();
  await page.getByLabel('Youngest age').fill('6');
  await page.getByLabel('Oldest age').fill('12');
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-eligibility-section.png`),
    fullPage: true,
  });
});
