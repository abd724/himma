import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-13 fulfillment terms editor over the production build (fixture
 * opt-in): the entitlement price options (package/membership) carry a
 * Fulfillment block in the listing editor, saving states the immutable
 * "future purchases only" rule before AND after, a save supersedes the
 * previously active terms in what the editor shows, and impossible
 * combinations are refused with plain guidance. All post-sign-in
 * navigation stays client-side (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-13');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const PRIVATE_COACHING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f04'; // approved; package option

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

test('owner sets package fulfillment terms: the future-purchases-only rule is stated, the save is confirmed, and a later save supersedes', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: /Private Swim Coaching/ })).toBeVisible();

  const block = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Fulfillment — 8 sessions' }) });
  await expect(block.getByText(/No fulfillment terms yet/)).toBeVisible();
  await noHorizontalOverflow(page);

  await block.getByRole('button', { name: 'Set terms' }).click();
  const form = page.getByRole('form', { name: 'Fulfillment terms for 8 sessions' });
  await expect(form.getByText(/Changes apply to future purchases only/)).toBeVisible();
  // A package's total IS its sessions count — no visits input exists.
  await expect(form.getByText(/A package is a fixed number of visits/)).toBeVisible();
  await expect(form.getByLabel('Visits included')).toHaveCount(0);

  // Refusal first: no walk-in and no reservation is an unusable purchase.
  await form.getByLabel('Valid for (days)').fill('90');
  await form.getByLabel(/Walk-in — show a check-in code at the desk/).uncheck();
  await form.getByRole('button', { name: 'Save terms' }).click();
  await expect(form.getByText(/Choose at least one way to attend/)).toBeVisible();

  await form.getByLabel(/Walk-in — show a check-in code at the desk/).check();
  await form.getByRole('button', { name: 'Save terms' }).click();
  await expect(
    page.getByText(/Fulfillment terms saved\. They apply to future purchases only/),
  ).toBeVisible();
  await expect(
    page.getByText(/One visit per package session, valid 90 days from purchase/),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `fulfillment-saved-${testInfo.project.name}.png`),
    fullPage: true,
  });

  // Supersede: the next save replaces what the editor shows as ACTIVE.
  await block.getByRole('button', { name: 'Change terms' }).click();
  const reopened = page.getByRole('form', { name: 'Fulfillment terms for 8 sessions' });
  await reopened.getByLabel('Valid for (days)').fill('120');
  await reopened.getByRole('button', { name: 'Save terms' }).click();
  await expect(page.getByText(/valid 120 days from purchase/)).toBeVisible();
  await expect(page.getByText(/valid 90 days from purchase/)).toHaveCount(0);
});
