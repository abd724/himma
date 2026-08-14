import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-9 provider Dashboard over the production build (fixture opt-in):
 * truthful status derived from the shared catalogue/org/team fixture truth
 * only — counts by real lifecycle state, role/scope-aware cards, no
 * fabricated business metrics — refreshed by lifecycle mutations.
 */
const evidence = evidenceDir('portal-w2-9');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const SUNRISE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e05';
const PRIVATE_COACHING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f04'; // approved

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

test('Owner dashboard: truthful org/catalogue/team cards, refreshed by a lifecycle mutation (before/after)', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Live on Himma')).toBeVisible();
  await expect(page.getByText('1 listing approved and not yet published')).toBeVisible();
  await expect(page.getByText(/publish when you’re ready/)).toBeVisible();
  await expect(page.getByText(/8 active members/)).toBeVisible();
  // No fabricated business metrics anywhere on the page.
  const mainText = (await page.getByRole('main').textContent()) ?? '';
  expect(mainText).not.toMatch(/revenue|payout|booking|attendance|rating|occupancy|conversion/i);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-owner-before.png`),
    fullPage: true,
  });

  // Publish the approved listing, then return: the dashboard reflects the
  // SAME shared truth (no second source).
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}`);
  await page.getByRole('button', { name: 'Publish listing' }).click();
  await expect(page.getByText(/Published\. Customers can find it/)).toBeVisible();
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/approved and not yet published/)).toHaveCount(0);
  const publishedRow = page
    .getByRole('list', { name: 'Listings by status' })
    .getByRole('listitem')
    .filter({ hasText: 'Published' });
  await expect(publishedRow).toContainText('4');
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-owner-after.png`),
    fullPage: true,
  });
});

test('Branch Manager dashboard: scoped counts only, no organization-wide leak, no team card', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(
    page.getByText('These numbers cover the listings within your branch scope.'),
  ).toBeVisible();
  // The out-of-scope approved listing must not surface an attention row.
  await expect(page.getByText(/approved and not yet published/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Team' })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-branch-manager.png`),
    fullPage: true,
  });
});

test('scope-limited role: organization status only, no catalogue or team data', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'finance@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(page.getByRole('heading', { name: 'Organization' })).toBeVisible();
  await expect(
    page.getByText(/Your role’s dashboard covers organization status/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Listings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Team' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-scope-limited.png`),
    fullPage: true,
  });
});

test('empty catalogue: truthful first-use state with the creation entry and the onboarding home', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'stages@himma.demo');
  await clientGoto(page, `/o/${SUNRISE_ID}`);
  await expect(page.getByText('No listings yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first listing' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue your onboarding' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-empty.png`),
    fullPage: true,
  });
});
