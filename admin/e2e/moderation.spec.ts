import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W3-6 fixture-mode evidence: the catalogue moderation queue → workspace →
 * decision journeys — approval rests at approved (no publish control), and
 * the revision workspace shows current-vs-proposed then applies exactly
 * the change-set while the listing stays published. Deterministic
 * fictional data only.
 */
const evidence = evidenceDir('admin-w3-6');

test('listing moderation: queue → workspace → start review → approve (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Catalogue moderation' })
    .click();
  await expect(page.getByRole('link', { name: 'Junior Swim Camp' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'desktop-moderation-queue.png'), fullPage: true });

  await page.getByRole('link', { name: 'Junior Swim Camp' }).click();
  await expect(page.getByRole('heading', { name: 'Junior Swim Camp' })).toBeVisible();
  await expect(page.getByText('Aquava Swim School', { exact: false })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-moderation-workspace.png'), fullPage: true });

  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByRole('button', { name: 'Approve listing' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve listing' }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  // D-S4-2: no publish control exists — publication stays with the provider.
  await expect(page.getByRole('button', { name: /publish/i })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, 'desktop-listing-approved.png'), fullPage: true });
});

test('revision moderation: current vs proposed → apply → the published listing carries the change (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Revision moderation' })
    .click();
  await expect(page.getByRole('link', { name: 'Junior Tennis Term' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-revision-queue.png'), fullPage: true });

  await page.getByRole('link', { name: 'Junior Tennis Term' }).click();
  const revisionPanel = page.getByRole('region', { name: 'Proposed change (revision)' });
  await expect(
    revisionPanel.getByText('Term-long junior coaching, ages grouped by level.'),
  ).toBeVisible();
  await expect(
    revisionPanel.getByText('Term-long junior coaching with weekly match play.'),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-revision-diff.png'), fullPage: true });

  await revisionPanel.getByRole('button', { name: 'Start revision review' }).click();
  await revisionPanel.getByRole('button', { name: 'Apply revision' }).click();
  await expect(page.getByText('Term-long junior coaching with weekly match play.')).toBeVisible();
  await expect(
    page.locator('span').filter({ hasText: /^Published$/ }),
  ).toBeVisible(); // the state badge — the listing stayed live
  await expect(page.getByRole('region', { name: 'Proposed change (revision)' })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, 'desktop-revision-applied.png'), fullPage: true });
});

test('mobile: the moderation queue and workspace stay usable without horizontal overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only');
  await signInAs(page, 'ops@himma.demo');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Catalogue moderation' })
    .click();
  await expect(page.getByRole('link', { name: 'Junior Swim Camp' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('link', { name: 'Junior Swim Camp' }).click();
  await expect(page.getByRole('heading', { name: 'Junior Swim Camp' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'mobile-moderation-workspace.png'), fullPage: true });
});
