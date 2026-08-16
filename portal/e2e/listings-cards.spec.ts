import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-11 owner visual correction — the enriched Listings index: thumbnail
 * rows (with the intentional no-image placeholder), the addendum's minimum
 * row information (activity · branch summary · derived price · updated ·
 * status), semantic badge tones, whole-row navigation, and the role/scope
 * truths unchanged. Evidence for owner visual review.
 */
const evidence = evidenceDir('portal-w2-11-listings-correction');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';

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

test('A/B — lifecycle-diverse index with thumbnails, derived prices, branch summaries, and the no-image fallback', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  const list = page.getByRole('list', { name: 'Listings' });

  // Thumbnails resolve from the checked-in fixture assets.
  const adult = list.getByRole('link', { name: /Adult Beginner Swimming/ });
  await expect(adult.locator('img')).toHaveAttribute('src', '/fixture-media/pool-lanes.jpg');
  // Addendum hierarchy: activity · branches, then price · updated.
  await expect(adult.getByText('Swimming · Dubai Marina pool + 1 more')).toBeVisible();
  await expect(adult.getByText(/From AED 450 · Updated/)).toBeVisible();
  // Free option outranks paid; archived options never price a row.
  await expect(list.getByText(/^Free · Updated/)).toBeVisible();
  // The no-image listing shows the intentional placeholder (no <img>).
  const camp = list.getByRole('link', { name: /Holiday Swim Camp/ });
  await expect(camp.locator('img')).toHaveCount(0);
  await expect(camp.getByText('Swimming · No branch yet')).toBeVisible();

  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-index-enriched.png`),
    fullPage: true,
  });

  // Whole-row click reaches the DETAIL surface (never the editor).
  await adult.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Adult Beginner Swimming' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Status' })).toBeVisible();

  // Keyboard: rows are links — focus one and activate with Enter.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  const junior = page.getByRole('link', { name: /Junior Swim Squad/ });
  await junior.focus();
  await expect(junior).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Junior Swim Squad' })).toBeVisible();
});

test('C — Branch Manager scoped view keeps its reach and actions truth on the enriched rows', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  await expect(page.getByText(/listings that run at your assigned branches/)).toBeVisible();
  const list = page.getByRole('list', { name: 'Listings' });
  // Reachable rows render enriched; out-of-scope listings stay absent.
  await expect(list.getByRole('link', { name: /Ladies Aqua Fitness/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /Private Swim Coaching/ })).toHaveCount(0);
  // A Branch Manager still holds creation authority — actions unchanged.
  await expect(page.getByRole('link', { name: 'Create listing' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-index-branch-manager.png`),
    fullPage: true,
  });
});
