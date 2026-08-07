import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, FIXTURE_PASSWORD, FIXTURE_TOTP_CODE, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-3 invitation + onboarding flows over the production build (fixture
 * opt-in), across the three viewport projects. All post-sign-in navigation
 * stays client-side (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-3');

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

test('founding-owner journey: invitation → sign-in + MFA → accept → onboarding hub', async ({
  page,
}, testInfo) => {
  await page.goto('/invitation/HIMMA-INVITE-OWNER-CORAL');
  await expect(page.getByRole('heading', { level: 1, name: 'Provider invitation' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-invitation.png`) });

  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await page.getByLabel('Email address').fill('newowner@coral.demo');
  await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();

  // Back on the invitation, authenticated.
  await page.getByRole('button', { name: 'Accept invitation' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Set up your workspace' })).toBeVisible();
  await expect(page).not.toHaveURL(/HIMMA-INVITE/);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-onboarding-setup.png`),
    fullPage: true,
  });

  // Submit stays inert while incomplete, with the reason stated.
  const submit = page.getByRole('button', { name: 'Submit for review' });
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/complete your business profile and add an active branch/)).toBeVisible();
});

test('a wrong identity receives the single safe refusal', async ({ page }, testInfo) => {
  await page.goto('/invitation/HIMMA-INVITE-OWNER-CORAL');
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await page.getByLabel('Email address').fill('owner@bluewave.demo');
  await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();

  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('alert')).toContainText('This invitation can’t be used');
  await expect(page.locator('body')).not.toContainText('HIMMA-INVITE-OWNER-CORAL');
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-invitation-refused.png`) });
});

test('verification states: submitted → resubmission after changes-needed → verified hold', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'stages@himma.demo');
  // First membership: Sunrise (submitted). The shell carries the setup bar.
  await expect(page.getByText(/isn’t live on Himma yet/)).toBeVisible();
  await page.getByRole('link', { name: 'View your setup status' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Submitted for review' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-onboarding-submitted.png`),
  });

  // Switch to Desert Bloom Yoga (rejected) and resubmit.
  await page.getByRole('button', { name: /Sunrise Pottery Studio/ }).click();
  await page.getByRole('menuitemradio', { name: /Desert Bloom Yoga/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your submission needs attention' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-onboarding-rejected.png`),
  });
  await page.getByRole('button', { name: 'Submit again' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Submitted for review' })).toBeVisible();

  // Pearl Divers (verified): go-live is with Himma, no provider control.
  await page.getByRole('button', { name: /Desert Bloom Yoga/ }).click();
  await page.getByRole('menuitemradio', { name: /Pearl Divers Freediving/ }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Verified — final steps with Himma' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /go live/i })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-onboarding-verified.png`),
  });
});

test('a live organization is never trapped: no setup bar, dashboard as usual', async ({ page }) => {
  await signInAs(page, 'owner@bluewave.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText(/isn’t live on Himma yet/)).toHaveCount(0);
});
