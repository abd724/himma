import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * W2-1 shell smoke + responsive validation (docs/29 §15, task §17).
 * Runs against the production build (vite preview) in three viewport
 * classes: desktop 1440×900 · tablet 1024×768 · mobile 390×844.
 * Screenshot evidence lands in artifacts/portal-w2-1/.
 */
const evidenceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'artifacts',
  'portal-w2-1',
);
mkdirSync(evidenceDir, { recursive: true });

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

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 0) < 768;
}

function isTablet(page: Page) {
  const width = page.viewportSize()?.width ?? 0;
  return width >= 768 && width < 1120;
}

test('shell renders the dashboard with navigation and no overflow', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Dashboard · Himma Provider Portal');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await noHorizontalOverflow(page);

  if (isMobile(page)) {
    // Narrow: sidebar hidden, drawer trigger present.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  } else {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    const sidebar = page.locator('aside');
    const box = await sidebar.boundingBox();
    if (isTablet(page)) {
      expect(box?.width).toBeLessThan(100); // compact rail
    } else {
      expect(box?.width).toBeGreaterThan(200); // full sidebar
    }
  }

  await page.screenshot({ path: join(evidenceDir, `${testInfo.project.name}-dashboard.png`) });
});

test('navigation reaches every top-level section with correct active state', async ({
  page,
}, testInfo) => {
  test.skip(isMobile(page), 'covered by the drawer scenario on mobile');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  const sections = [
    ['Listings', 'Listings'],
    ['Schedule', 'Schedule'],
    ['Bookings', 'Bookings'],
    ['Branches', 'Branches'],
    ['Team', 'Team'],
    ['Business Profile', 'Business Profile'],
    ['Finance', 'Finance'],
    ['Settings & Support', 'Settings & Support'],
  ] as const;

  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const [label, heading] of sections) {
    await nav.getByRole('link', { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(nav.getByRole('link', { name: new RegExp(`^${label}`) })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await noHorizontalOverflow(page);
  }

  await page.screenshot({ path: join(evidenceDir, `${testInfo.project.name}-listings-active.png`) });
});

test('mobile drawer opens, is keyboard-dismissible, and navigates', async ({ page }, testInfo) => {
  test.skip(!isMobile(page), 'mobile-only behavior');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  // Let the entrance animation settle so the evidence shows the resting state.
  await expect(drawer).toHaveCSS('opacity', '1');
  await page.screenshot({ path: join(evidenceDir, `${testInfo.project.name}-drawer-open.png`) });

  // Escape closes and focus returns to the trigger.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  // Navigating from the drawer closes it and switches page.
  await trigger.click();
  await drawer.getByRole('link', { name: /^Branches/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible();
  await expect(drawer).toBeHidden();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidenceDir, `${testInfo.project.name}-branches.png`) });
});

test('organization switcher switches context and preserves the section', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary' }).isVisible();

  // Move to a section first so preservation is observable.
  await page.goto(page.url().replace(/\/$/, '') + '/listings');
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();

  const switcher = page.getByRole('button', { name: /Blue Wave Swimming/ });
  await switcher.click();
  const menu = page.getByRole('menu', { name: 'Switch organization' });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: join(evidenceDir, `${testInfo.project.name}-org-menu.png`) });

  await menu.getByRole('menuitemradio', { name: /Noor Learning Centre/ }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]+\/listings$/);
  await expect(page.getByRole('button', { name: /Noor Learning Centre/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
});

test('backend-later placeholders carry the honest milestone note and no fabricated data', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const base = page.url().replace(/\/$/, '');

  for (const segment of ['schedule', 'bookings', 'finance']) {
    await page.goto(`${base}/${segment}`);
    await expect(page.getByText('Coming in a later production milestone.')).toBeVisible();
    const mainText = await page.getByRole('main').textContent();
    expect(mainText).not.toMatch(/\d/);
  }
  await page.screenshot({ path: join(evidenceDir, `${testInfo.project.name}-finance-placeholder.png`) });
});

test('unknown routes render designed recovery surfaces', async ({ page }) => {
  await page.goto('/completely/unknown');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

  await page.goto('/o/not-a-real-organization');
  await expect(
    page.getByRole('heading', { level: 1, name: "We can't find that organization" }),
  ).toBeVisible();
});
