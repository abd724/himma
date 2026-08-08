import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  evidenceDir,
  FIXTURE_PASSWORD,
  FIXTURE_TOTP_CODE,
  noHorizontalOverflow,
  signInAs,
} from './support';

/**
 * W2-2 access & session flows over the production build, at all three
 * viewport classes (desktop/tablet/mobile projects). Fixture adapter only —
 * no real Cognito/backend integration exists.
 */
const evidence = evidenceDir('portal-w2-2');

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

test('a signed-out deep link is blocked, and sign-in + MFA return to the destination', async ({
  page,
}, testInfo) => {
  await page.goto('/o/0198a2f0-5b7a-7000-8000-1f4a2d9c6e01/listings');
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-sign-in.png`) });

  await page.getByLabel('Email address').fill('owner@bluewave.demo');
  await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Two-step verification' }),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-mfa.png`) });
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
  await expect(page).toHaveURL(/\/o\/0198a2f0-5b7a-7000-8000-1f4a2d9c6e01\/listings$/);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-authenticated.png`) });
});

test('failed credentials show the safe message; wrong TOTP explains itself', async ({
  page,
}, testInfo) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill('owner@bluewave.demo');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByText('Sign-in could not be completed with the provided credentials.'),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-sign-in-error.png`) });

  await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(
    page.getByText("That code didn't work. Check your authenticator app and try again."),
  ).toBeVisible();
});

test('multi-org access switches context; suspended organizations carry the banner', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'director@himma.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  await page.getByRole('button', { name: /Blue Wave Swimming/ }).click();
  await page.getByRole('menuitemradio', { name: /Falcon Combat Academy/ }).click();
  await expect(
    page.getByText('This organization is currently suspended. Changes are unavailable.'),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-suspended.png`) });
});

test('an inaccessible organization deep link resolves to the safe unavailable surface', async ({
  page,
}, testInfo) => {
  await page.goto('/o/11111111-2222-7000-8000-333333333333');
  await page.getByLabel('Email address').fill('owner@bluewave.demo');
  await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: "This workspace isn't available" }),
  ).toBeVisible();
  await expect(page.getByText('11111111')).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-workspace-unavailable.png`),
  });
});

test('no membership resolves to its dedicated surface', async ({ page }, testInfo) => {
  await signInAs(page, 'former@himma.demo');
  await expect(
    page.getByRole('heading', { level: 1, name: 'No provider workspace available' }),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-no-membership.png`) });
});

test('session expiry mid-use leaves the protected route safely', async ({ page }, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  await page.evaluate(() => window.__himmaPortalAccessFixture?.expireSession());

  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Your session has ended. Please sign in again.')).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-session-expired.png`) });
});

test('sign-out clears context and browser Back does not restore protected content', async ({
  page,
}) => {
  await signInAs(page, 'owner@bluewave.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  await page.getByRole('button', { name: /Account — Rana Haddad/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1, name: "You're signed out" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeHidden();
});

test('a cold step-up link without a session lands on sign-in (fail-safe)', async ({ page }) => {
  // A full page load drops the in-memory fixture session — signed out is the
  // safe outcome for a cold step-up deep link. (The interstitial's interactive
  // behavior is covered by the Jest suites; no shipped action routes to it yet.)
  await page.goto('/step-up?returnTo=%2Fo%2Fx%2Fteam');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
});

test('mobile access flow works end-to-end', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'mobile-only scenario');
  await signInAs(page, 'director@himma.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  // Team is hidden for this Organization Manager (staff.read is owner-only
  // since W2-6); Branches is the equivalent org-section navigation proof.
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('link', { name: /^Branches/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `mobile-branches-authenticated.png`) });
});
