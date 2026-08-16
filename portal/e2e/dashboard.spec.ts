import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-11 owner Dashboard correction over the production build (fixture
 * opt-in): the operational dashboard — truthful KPI row, the exact
 * needs-attention rule, the Awaiting-Himma split, concise organization
 * status, compact catalogue overview, recently-updated rows — all
 * scope-aware, with NO fabricated business metrics (bookings, participants,
 * revenue, growth, charts, goals stay absent until their backends exist).
 */
const evidence = evidenceDir('portal-w2-11-dashboard-correction');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const DESERT_BLOOM_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e07';
const SUNRISE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e05';

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

test('A — established provider: KPI row, needs-attention/awaiting split, compact overview, recent listings', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  // KPI truth (scope-aware): published 3 · attention 4 · branches 2 · team 8.
  const kpis = page.getByRole('list', { name: 'Key numbers' });
  await expect(kpis.getByText('Published listings')).toBeVisible();
  await expect(kpis.getByText('Needs attention')).toBeVisible();
  await expect(kpis.getByText('Active branches')).toBeVisible();
  await expect(kpis.getByText('Team members')).toBeVisible();

  // Needs attention: actionable rows linking into the portal.
  await expect(page.getByRole('link', { name: /Aqua Therapy Sessions/ })).toBeVisible();
  await expect(page.getByText(/publish when you’re ready/)).toBeVisible();
  // Awaiting Himma stays separate, with no action framing.
  await expect(page.getByRole('heading', { name: 'Awaiting Himma' })).toBeVisible();
  await expect(page.getByText(/nothing you need to do/)).toBeVisible();

  // Compact overview + recent activity.
  await expect(page.getByRole('list', { name: 'Listings by status' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recently updated' })).toBeVisible();

  // No fabricated business metrics of any kind.
  const mainText = (await page.getByRole('main').textContent()) ?? '';
  expect(mainText).not.toMatch(/revenue|booking|participant|attendance|rating|goal|% up|% down|chart/i);

  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-owner.png`),
    fullPage: true,
  });

  // KPI navigation: published → Listings.
  await kpis.getByRole('link', { name: /Published listings/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
});

test('B — provider mid-verification: setup blocker prioritized truthfully', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'stages@himma.demo');
  // Rejected verification → the provider's own action, top of attention.
  await clientGoto(page, `/o/${DESERT_BLOOM_ID}`);
  await expect(
    page.getByRole('link', { name: /Finish setting up your organization/ }),
  ).toBeVisible();
  await expect(page.getByText(/review and resubmit/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-setup-action.png`),
    fullPage: true,
  });

  // Submitted verification → Awaiting Himma, calm up-to-date state.
  await clientGoto(page, `/o/${SUNRISE_ID}`);
  await expect(page.getByText(/You’re up to date/)).toBeVisible();
  await expect(page.getByText('Organization verification')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create your first listing' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-awaiting-verification.png`),
    fullPage: true,
  });
});

test('C — Branch Manager: scoped KPI wording and no org-wide leakage', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(
    page.getByText(/Listing numbers cover the listings you can access/),
  ).toBeVisible();
  await expect(page.getByText('Published (your scope)')).toBeVisible();
  // The Bay-only approved listing never surfaces for the Marina scope.
  const mainText = (await page.getByRole('main').textContent()) ?? '';
  expect(mainText).not.toMatch(/Private Swim Coaching/);
  // No Team KPI without staff.read.
  await expect(page.getByText('Team members')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-dashboard-branch-manager.png`),
    fullPage: true,
  });
});
