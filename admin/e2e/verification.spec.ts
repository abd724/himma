import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W3-5 fixture-mode evidence: the verification review journey — the
 * Verification nav lands on the review queue; the provider detail carries
 * the real case workspace (checklist, readiness truth, decisions); an
 * approval drives the canonical organization state (verified → go-live →
 * live) visibly; a rejection records the three layers. Deterministic
 * fictional data only.
 */
const evidence = evidenceDir('admin-w3-5');

test('review journey: queue → case workspace → approve → verified → go live (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  // The Verification nav area IS the review queue now.
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Verification' }).click();
  await expect(page.getByRole('button', { name: 'Review queue' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Desert Padel Hub' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-queue.png'), fullPage: true });

  await page.getByRole('link', { name: 'Desert Padel Hub' }).click();
  const verification = page.getByRole('region', { name: 'Verification' });
  await expect(verification.getByText(/Round 1 — under review/)).toBeVisible();
  await expect(
    verification.getByText(/All required evidence is stored — ready for a decision/),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'desktop-case-workspace.png'), fullPage: true });

  await verification.getByRole('button', { name: 'Approve' }).click();
  await expect(verification.getByText('Verified', { exact: true })).toBeVisible();
  await expect(verification.getByText('approved', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-approved.png'), fullPage: true });

  await verification.getByRole('button', { name: 'Go live' }).click();
  await expect(verification.getByText('Live', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-live.png'), fullPage: true });
});

test('rejection records the three layers with the staff-only note labeled (desktop)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'ops@himma.demo');
  // In-app navigation (memory-only fixture sessions do not survive a
  // hard reload — the W3-1 lesson).
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Providers' }).click();
  await page.getByRole('link', { name: 'Crestpeak Climbing' }).click();
  const verification = page.getByRole('region', { name: 'Verification' });
  await expect(verification.getByText(/Round 1 — under review/)).toBeVisible();
  // Approval is truthfully disabled: required evidence is missing.
  await expect(verification.getByRole('button', { name: 'Approve' })).toBeDisabled();

  await verification.getByRole('button', { name: 'Reject…' }).click();
  await page.getByLabel('Reason code (machine)').fill('expired_document');
  await page
    .getByLabel('Provider-facing message')
    .fill('Please renew your operating licence and resubmit.');
  await page
    .getByLabel('Internal note (never shown to the provider)')
    .fill('Licence lapsed; do not fast-track.');
  await page.screenshot({ path: join(evidence, 'desktop-reject-form.png'), fullPage: true });
  await verification.getByRole('button', { name: 'Record rejection' }).click();

  await expect(verification.getByText('rejected', { exact: true })).toBeVisible();
  await expect(verification.getByText('Internal note (staff-only)')).toBeVisible();
  await expect(verification.getByText('Rejected', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'desktop-rejected.png'), fullPage: true });
});

test('mobile: the case workspace stays usable without horizontal overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only');
  await signInAs(page, 'ops@himma.demo');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('link', { name: 'Providers' }).click();
  await page.getByLabel('Search providers').fill('desert padel');
  await page.getByRole('link', { name: 'Desert Padel Hub' }).click();
  const verification = page.getByRole('region', { name: 'Verification' });
  await expect(verification.getByText(/Round 1 — under review/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, 'mobile-case-workspace.png'), fullPage: true });
});
