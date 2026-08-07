import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, isMobile, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-4 business & public storefront profile over the production build
 * (fixture opt-in), across the three viewport projects. All post-sign-in
 * navigation stays client-side (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-4');

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

async function openBusinessProfile(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('link', { name: 'Business Profile' })
      .click();
  } else {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Business Profile' })
      .click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Business Profile' })).toBeVisible();
}

test('owner journey: private record → storefront editing with live preview → save → publication truth', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await openBusinessProfile(page);

  // Business information: the private record, read-only, clearly private.
  await expect(page.getByText('Blue Wave Swimming LLC')).toBeVisible();
  await expect(page.getByText('Live on Himma', { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-business-information.png`),
    fullPage: true,
  });

  // Public storefront: edit and watch the customer preview follow.
  await page.getByRole('tab', { name: 'Public storefront' }).click();
  const preview = page.getByRole('region', { name: 'Storefront preview' });
  await expect(preview.getByText('Verified')).toBeVisible();

  const displayName = page.getByLabel('Display name');
  await displayName.fill('Blue Wave Swim School');
  await expect(preview.getByText('Blue Wave Swim School')).toBeVisible();

  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-storefront-editor.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved — your storefront is up to date\./)).toBeVisible();

  // Publication: published + live + visible — with authorities named.
  await page.getByRole('tab', { name: 'Publication' }).click();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
  await expect(page.getByText('Visible', { exact: true })).toBeVisible();
  await expect(page.getByText('You control this.')).toBeVisible();
  await expect(page.getByText('Himma controls this.')).toBeVisible();
  await expect(page.getByRole('button', { name: /go live/i })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-publication-live.png`),
    fullPage: true,
  });
});

test('a stale save conflicts safely and recovers with edits kept', async ({ page }, testInfo) => {
  test.skip(isMobile(page), 'flow identical across viewports; captured on larger screens');

  await signInAs(page, 'owner@bluewave.demo');
  await openBusinessProfile(page);
  await page.getByRole('tab', { name: 'Public storefront' }).click();

  await page.getByLabel('Display name').fill('My Draft Name');
  // Another staff member saves concurrently (fixture control, e2e-only).
  await page.evaluate(
    (organizationId) =>
      window.__himmaPortalAccessFixture?.simulateConcurrentProfileEdit(organizationId),
    BLUE_WAVE_ID,
  );
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(
    page.getByText(/Someone else updated the storefront while you were editing/),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-stale-conflict.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Load the latest profile' }).click();
  await expect(page.getByText(/latest profile is loaded and your edits are kept/)).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue('My Draft Name');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved — your storefront is up to date\./)).toBeVisible();
});

test('read-only role: full visibility, no mutation affordances', async ({ page }, testInfo) => {
  await signInAs(page, 'assistant@coral.demo');
  await openBusinessProfile(page);

  await page.getByRole('tab', { name: 'Public storefront' }).click();
  await expect(
    page.getByText(/an owner or organization manager makes these changes/i),
  ).toBeVisible();
  await expect(page.locator('input, textarea, select')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-read-only.png`),
    fullPage: true,
  });
});

test('published storefront on a non-live organization stays honestly invisible', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'stages@himma.demo');
  // stages' first organization is Sunrise; switch to Pearl (verified).
  await page.getByRole('button', { name: /Sunrise Pottery Studio/ }).click();
  await page.getByRole('menuitemradio', { name: /Pearl Divers Freediving/ }).click();
  await openBusinessProfile(page);

  await page.getByRole('tab', { name: 'Publication' }).click();
  await expect(page.getByText('Published', { exact: true })).toBeVisible();
  await expect(page.getByText('Not live yet')).toBeVisible();
  await expect(page.getByText('Not visible')).toBeVisible();
  await expect(
    page.getByText(/it appears to customers once Himma takes your organization live/),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-published-not-live.png`),
    fullPage: true,
  });
});

test('unsaved edits warn before navigation; clean navigation never does', async ({ page }, testInfo) => {
  test.skip(isMobile(page), 'dialog flow identical; drawer navigation covered elsewhere');

  await signInAs(page, 'owner@bluewave.demo');
  await openBusinessProfile(page);
  await page.getByRole('tab', { name: 'Public storefront' }).click();
  await page.getByLabel('Public phone').fill('+971 4 555 0177');

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Dashboard' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-unsaved-changes.png`),
  });
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('Public phone')).toHaveValue('+971 4 555 0177');

  // Save, then the same navigation is clean — no dialog.
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved — your storefront is up to date\./)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Dashboard' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
});

test('incomplete onboarding profile: CTA lands here, saving feeds readiness back', async ({
  page,
}, testInfo) => {
  await page.goto('/invitation/HIMMA-INVITE-OWNER-CORAL');
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await page.getByLabel('Email address').fill('newowner@coral.demo');
  await page.getByLabel('Password', { exact: true }).fill('himma-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill('246810');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();

  await page.getByRole('link', { name: 'Open Business Profile' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Business Profile' })).toBeVisible();
  await expect(page.getByText('Setting up')).toBeVisible();

  await page.getByRole('tab', { name: 'Public storefront' }).click();
  const preview = page.getByRole('region', { name: 'Storefront preview' });
  await expect(preview.getByText('Add your display name')).toBeVisible();
  // Never a verified badge before live.
  await expect(preview.getByText('Verified')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-incomplete-profile.png`),
    fullPage: true,
  });

  await page.getByLabel('Display name').fill('Coral Kids Climbing');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved — your storefront is up to date\./)).toBeVisible();

  // The still-onboarding path back, with readiness reflecting the save.
  await page.getByRole('link', { name: 'Back to Getting started' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();
  const profileRow = page.locator('li', { hasText: 'Business profile' });
  await expect(profileRow.getByText('Done')).toBeVisible();
});
