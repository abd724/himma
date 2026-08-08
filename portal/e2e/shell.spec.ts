import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, isMobile, isTablet, noHorizontalOverflow, signInAs } from './support';

/**
 * Responsive shell smoke (W2-1 scope, updated for the W2-2 access layer):
 * runs against the production build behind an authenticated fixture session.
 * Navigation after sign-in stays client-side — fixture sessions are
 * memory-only, exactly like the future in-memory access token.
 */
const evidence = evidenceDir('portal-w2-2');

const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error));
  });
  await signInAs(page, 'director@himma.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test('authenticated shell renders with the correct responsive navigation', async ({
  page,
}, testInfo) => {
  await noHorizontalOverflow(page);

  if (isMobile(page)) {
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  } else {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    const box = await page.locator('aside').boundingBox();
    if (isTablet(page)) {
      expect(box?.width).toBeLessThan(100);
    } else {
      expect(box?.width).toBeGreaterThan(200);
    }
  }
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-shell.png`) });
});

test('navigation reaches every top-level section with correct active state', async ({ page }) => {
  test.skip(isMobile(page), 'covered by the drawer scenario on mobile');

  // Team is deliberately ABSENT here: this identity is Organization
  // Manager at the active org, and staff.read is owner-only (W2-6) — the
  // Team item renders only for memberships that hold it. The owner's Team
  // navigation is covered in e2e/team.spec.ts.
  const sections = [
    'Listings',
    'Schedule',
    'Bookings',
    'Branches',
    'Business Profile',
    'Finance',
    'Settings & Support',
  ];
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: /^Branches/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^Team/ })).toHaveCount(0);
  for (const section of sections) {
    await nav.getByRole('link', { name: new RegExp(`^${section}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible();
    await expect(nav.getByRole('link', { name: new RegExp(`^${section}`) })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await noHorizontalOverflow(page);
  }
});

test('mobile drawer opens, dismisses with Escape, and navigates', async ({ page }, testInfo) => {
  test.skip(!isMobile(page), 'mobile-only behavior');

  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await expect(drawer).toHaveCSS('opacity', '1');
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-drawer.png`) });

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await drawer.getByRole('link', { name: /^Branches/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible();
  await expect(drawer).toBeHidden();
});

test('organization switching preserves the section', async ({ page }, testInfo) => {
  const nav = isMobile(page) ? null : page.getByRole('navigation', { name: 'Primary' });
  if (nav) {
    await nav.getByRole('link', { name: /^Listings/ }).click();
  } else {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('link', { name: /^Listings/ })
      .click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();

  await page.getByRole('button', { name: /Blue Wave Swimming/ }).click();
  await page.getByRole('menuitemradio', { name: /Noor Learning Centre/ }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]+\/listings$/);
  await expect(page.getByRole('button', { name: /Noor Learning Centre/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-org-switched.png`) });
});

test('backend-later placeholders stay honest behind authentication', async ({ page }) => {
  test.skip(isMobile(page), 'representative on larger viewports');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const section of ['Schedule', 'Bookings', 'Finance']) {
    await nav.getByRole('link', { name: new RegExp(`^${section}`) }).click();
    await expect(page.getByText('Coming in a later production milestone.')).toBeVisible();
    const mainText = await page.getByRole('main').textContent();
    expect(mainText).not.toMatch(/\d/);
  }
});
