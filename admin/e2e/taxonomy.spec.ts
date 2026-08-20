import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W3-7 fixture-mode evidence: the AD-06 taxonomy workspace — four distinct
 * resource types with inactive rows administrable, creation, CAS editing,
 * deactivation-only retirement (no delete control anywhere), and the
 * immutable stable identifiers. Deterministic fictional data only.
 */
const evidence = evidenceDir('admin-w3-7');

test('taxonomy workspace: sections → create a category → edit → deactivate (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Taxonomy' })
    .click();
  await expect(page.getByRole('button', { name: 'Water Sports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retired Category' })).toBeVisible(); // inactive stays administrable
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'desktop-taxonomy-categories.png'), fullPage: true });

  // Create — the slug is chosen once, permanently.
  await page.getByLabel('Slug (permanent identifier)').fill('martial-arts');
  await page.getByRole('region', { name: 'New category' }).getByLabel('Label (English)').fill('Martial Arts');
  await page.getByRole('button', { name: 'Create category' }).click();
  await expect(page.getByRole('button', { name: 'Martial Arts' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-taxonomy-created.png'), fullPage: true });

  // Edit: no slug input exists; the identifier is displayed as immutable.
  await page.getByRole('button', { name: 'Martial Arts' }).click();
  const editor = page.getByRole('form', { name: 'Edit Martial Arts' });
  await expect(editor.getByText('stable identifier, cannot be changed')).toBeVisible();
  await expect(page.getByRole('button', { name: /delete|remove/i })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Deactivate' }).click();
  await expect(
    page.getByRole('button', { name: 'Martial Arts' }).locator('xpath=ancestor::tr').getByText('Inactive'),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-taxonomy-deactivated.png'), fullPage: true });
});

test('activity types carry their lifetime parent; collections manage editorial lifecycle (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Taxonomy' })
    .click();
  await page.getByRole('button', { name: 'Activity types' }).click();
  await expect(page.getByRole('button', { name: 'Swimming' })).toBeVisible();
  await page.getByRole('button', { name: 'Swimming' }).click();
  await expect(page.getByText('fixed at creation, cannot be changed')).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-taxonomy-types.png'), fullPage: true });

  await page.getByRole('button', { name: 'Collections' }).click();
  await page.getByRole('button', { name: 'Summer Camps' }).click();
  const editor = page.getByRole('form', { name: 'Edit Summer Camps' });
  await editor.getByLabel('Lifecycle state').selectOption('archived');
  await editor.getByRole('button', { name: 'Save collection' }).click();
  await expect(
    page.getByRole('button', { name: 'Summer Camps' }).locator('xpath=ancestor::tr').getByText('archived'),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-taxonomy-collections.png'), fullPage: true });
});

test('mobile: the taxonomy workspace stays usable without horizontal overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only');
  await signInAs(page, 'ops@himma.demo');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Taxonomy' })
    .click();
  await expect(page.getByRole('button', { name: 'Water Sports' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Water Sports' }).click();
  await expect(page.getByRole('form', { name: 'Edit Water Sports' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'mobile-taxonomy-workspace.png'), fullPage: true });
});
