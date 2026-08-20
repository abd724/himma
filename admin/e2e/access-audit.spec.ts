import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W3-9 fixture-mode evidence: AD-17 access administration (five roles, no
 * superadmin, dual-control refusal on self-approval) and the AD-18
 * read-only audit explorer. Deterministic fictional data only.
 */
const evidence = evidenceDir('admin-w3-9');

test('access administration: assignments → dual-control self-approval refusal (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'access@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Access administration' })
    .click();
  await expect(page.getByText('fixture-ops@himma.demo')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'desktop-access-assignments.png'), fullPage: true });

  // The pending finance request was requested BY this very administrator —
  // their own approval is the database's dual-control refusal.
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Dual control: the administrator who requested/)).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-access-dual-control.png'), fullPage: true });
});

test('a different access administrator approves; the auditor sees read-only truth (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'duo@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Access administration' })
    .click();
  await page.getByLabel('Assignment state').selectOption('requested');
  await expect(page.getByText('fixture-newcomer@himma.demo')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('No role assignments match this view.')).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-access-approved.png'), fullPage: true });
});

test('audit explorer: the read-only bounded trail with server-side filters (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'audit@himma.demo');
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Audit' })
    .click();
  await expect(page.getByText('listing.approved')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'desktop-audit-trail.png'), fullPage: true });

  await page.getByLabel('Entity type').fill('organization');
  await expect(page.getByText('org.verification_rejected')).toBeVisible();
  await expect(page.getByText('listing.approved')).toHaveCount(0);
  await page.screenshot({ path: join(evidence, 'desktop-audit-filtered.png'), fullPage: true });
});

test('mobile: access administration and audit stay usable without horizontal overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only');
  await signInAs(page, 'access@himma.demo');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Access administration' })
    .click();
  await expect(page.getByText('fixture-ops@himma.demo')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'mobile-access-assignments.png'), fullPage: true });
});
