import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, isMobile, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-13 front-desk check-in over the production build (fixture opt-in),
 * across the three viewport projects: the Check-In destination is directly
 * reachable by front-desk staff, the 8-digit numeric-first entry (no QR
 * scanner), the preview card that grants nothing, the atomic confirm with
 * server-confirmed success only, the truthful consumed-between-preview-
 * and-confirm race refusal (never a false success), and the invalid/
 * expired refusal copy. All post-sign-in navigation stays client-side
 * (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-13');

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

async function openCheckIn(page: Page) {
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/check-in`);
  await expect(page.getByRole('heading', { level: 1, name: 'Check-In' })).toBeVisible();
}

test('front desk happy path: reach Check-In, verify an 8-digit code, review the preview, confirm, and see the server-confirmed result', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'frontdesk@bluewave.demo');
  await openCheckIn(page);
  await noHorizontalOverflow(page);

  const code = page.getByLabel('Customer’s check-in code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  // Numeric-first: pasted junk is filtered to digits; there is no scanner.
  await code.fill('11112222');
  await expect(page.getByText(/scan|camera/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify code' }).click();

  await expect(page.getByRole('heading', { name: 'Confirm this check-in' })).toBeVisible();
  await expect(page.getByText('Maya')).toBeVisible();
  await expect(page.getByText('Aqua Fitness 8-pack')).toBeVisible();
  await expect(page.getByText('6 of 8 visits left')).toBeVisible();
  await page.screenshot({
    path: join(evidence, `check-in-preview-${testInfo.project.name}.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Confirm Check-In' }).click();
  await expect(page.getByRole('heading', { name: 'Checked in' })).toBeVisible();
  await expect(page.getByText(/5 visits left on this pass after this check-in/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `check-in-success-${testInfo.project.name}.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Check in the next customer' }).click();
  await expect(page.getByLabel('Customer’s check-in code')).toHaveValue('');
});

test('front-desk navigation shows Check-In but not Listings or Team', async ({ page }) => {
  await signInAs(page, 'frontdesk@bluewave.demo');
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  }
  const nav = page.getByRole('navigation', { name: 'Primary' }).first();
  await expect(nav.getByRole('link', { name: 'Check-In' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Listings' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Team' })).toHaveCount(0);
});

test('invalid and expired codes surface honest refusals without any preview', async ({ page }) => {
  await signInAs(page, 'frontdesk@bluewave.demo');
  await openCheckIn(page);

  await page.getByLabel('Customer’s check-in code').fill('90009000');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(
    page.getByText(/doesn’t match a current check-in code for this organization/),
  ).toBeVisible();

  await page.getByLabel('Customer’s check-in code').fill('55556666');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByText(/That code has expired/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirm this check-in' })).toHaveCount(0);
});

test('RACE: a code consumed between preview and confirm is a truthful refusal — the stale preview clears and no success ever renders', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'frontdesk@bluewave.demo');
  await openCheckIn(page);

  await page.getByLabel('Customer’s check-in code').fill('33334444');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm this check-in' })).toBeVisible();
  await expect(page.getByText('Omar')).toBeVisible();

  // Another device consumes the credential while this desk reviews it
  // (fixture-mode race seam — the REAL race truth is proven in the
  // backend S6-2 suite and the portal contract suite).
  await page.evaluate((orgId) => {
    window.__himmaPortalCheckInFixture?.consume(orgId, '33334444');
  }, BLUE_WAVE_ID);

  await page.getByRole('button', { name: 'Confirm Check-In' }).click();
  await expect(page.getByText(/This check-in wasn’t recorded/)).toBeVisible();
  await expect(page.getByText(/already been used/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirm this check-in' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Checked in' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `check-in-race-refusal-${testInfo.project.name}.png`),
    fullPage: true,
  });
});
