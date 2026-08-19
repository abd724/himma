import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W3-2 fixture-mode evidence (task §38): the real Provider Directory,
 * server-driven search and state filtering, the Review Queue view, and the
 * read-only Provider detail — desktop and mobile (stacked rows, no
 * horizontal overflow). Deterministic fictional fixture providers only.
 */
const evidence = evidenceDir('admin-w3-2');

test('directory journey: real table → search → state filter → detail (desktop/tablet)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'mobile has its own stacked-row coverage');
  await signInAs(page, 'ops@himma.demo');
  const nav = page.getByRole('navigation', { name: 'Admin navigation' });
  await nav.getByRole('link', { name: 'Providers' }).click();

  // The real directory, one row per organization.
  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Aquava Swim School' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-directory.png`),
    fullPage: true,
  });

  // Server-driven search narrows to the match.
  await page.getByLabel('Search providers').fill('marina');
  await expect(page.getByRole('link', { name: 'Aquava Swim School' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-search.png`),
    fullPage: true,
  });
  await page.getByLabel('Search providers').fill('');

  // State filter.
  await page.getByLabel('Organization state').selectOption('in_review');
  await expect(page.getByRole('link', { name: 'Crestpeak Climbing' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-state-filter.png`),
    fullPage: true,
  });
  await page.getByLabel('Organization state').selectOption('');

  // Row → the read-only internal detail.
  await page.getByRole('link', { name: 'Marina Ace Tennis' }).click();
  await expect(page.getByRole('heading', { name: 'Marina Ace Tennis' })).toBeVisible();
  await expect(page.getByText('Evidence review isn’t available yet', { exact: false })).toBeVisible();
  // Read-only: no lifecycle action buttons exist.
  for (const forbidden of ['Verify', 'Reject', 'Go live', 'Suspend', 'Start review']) {
    await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
  }
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-detail.png`),
    fullPage: true,
  });
});

test('review queue: exactly the organizations needing Himma action, linking to detail (desktop representative)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Providers' }).click();
  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toBeVisible();

  await page.getByRole('button', { name: 'Review queue' }).click();
  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Aquava Swim School' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Falcon Kick Karate' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Awaiting go-live' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-review-queue.png`),
    fullPage: true,
  });

  // A queue item opens the provider detail.
  await page.getByRole('link', { name: 'Aquava Swim School' }).click();
  await expect(page.getByRole('heading', { name: 'Aquava Swim School' })).toBeVisible();
});

test('mobile: stacked directory rows, usable filters, and detail without horizontal overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only stacked-row coverage');
  await signInAs(page, 'ops@himma.demo');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Providers' }).click();

  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-directory.png`),
    fullPage: true,
  });

  // Filters stay usable at 390px.
  await page.getByLabel('Organization state').selectOption('submitted');
  await expect(page.getByRole('link', { name: 'Aquava Swim School' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Marina Ace Tennis' })).toHaveCount(0);
  await noHorizontalOverflow(page);

  await page.getByRole('link', { name: 'Aquava Swim School' }).click();
  await expect(page.getByRole('heading', { name: 'Aquava Swim School' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-detail.png`),
    fullPage: true,
  });
});
