import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, FIXTURE_TOTP_CODE, noHorizontalOverflow, signInAs } from './support';

/**
 * W3-1 fixture-mode evidence (task §34): sign-in → MFA → the
 * capability-aware shell; the no-admin-access denial; multi-role
 * navigation; mobile drawer keyboard behavior. Deterministic fixture
 * identities only — no fake business data exists anywhere.
 */
const evidence = evidenceDir('admin-w3-1');

test('operations journey: sign in → MFA → capability-aware shell → truthful placeholder', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-sign-in.png`),
    fullPage: true,
  });

  await page.getByLabel('Work email').fill('ops@himma.demo');
  await page.getByLabel('Password').fill('admin-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Verify it’s you' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-mfa.png`),
    fullPage: true,
  });
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome, Layla Operations' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-shell.png`),
    fullPage: true,
  });

  const isMobile = testInfo.project.name === 'mobile';
  if (isMobile) {
    await page.getByRole('button', { name: 'Menu' }).click();
  }
  await page
    .getByRole('navigation', { name: 'Admin navigation' })
    .getByRole('link', { name: 'Verification' })
    .click();
  await expect(page.getByText(/Connected in W3-3–W3-5/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-placeholder.png`),
    fullPage: true,
  });
});

test('capability-aware navigation: an auditor sees only read areas and is refused inside operations areas', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'audit@himma.demo');
  await expect(page.getByRole('heading', { name: 'Welcome, Aisha Audit' })).toBeVisible();

  const isMobile = testInfo.project.name === 'mobile';
  if (isMobile) {
    await page.getByRole('button', { name: 'Menu' }).click();
  }
  const nav = page.getByRole('navigation', { name: 'Admin navigation' });
  await expect(nav.getByRole('link', { name: 'Audit' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Providers' })).toHaveCount(0);
  if (isMobile) {
    await page.keyboard.press('Escape');
  }

  // A deep link into a protected area after a fresh load meets the access
  // gate first (memory-only sessions — nothing persists in the browser)…
  await page.goto('/providers');
  await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();
  // …and signing in as the auditor lands on the truthful capability
  // refusal for that same destination, never the operations surface.
  await page.getByLabel('Work email').fill('audit@himma.demo');
  await page.getByLabel('Password').fill('admin-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(
    page.getByRole('heading', { name: 'This area isn’t part of your role' }),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-auditor-refused.png`),
    fullPage: true,
  });
});

test('an authenticated identity without an admin role is truthfully denied', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'none@himma.demo');
  await expect(
    page.getByRole('heading', { name: 'This console is for Himma staff' }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin navigation' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-no-access.png`),
    fullPage: true,
  });
});

test('mobile drawer keyboard behavior: open moves focus in, Escape closes and returns focus', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'drawer exists on the mobile viewport');
  await signInAs(page, 'ops@himma.demo');
  await expect(page.getByRole('heading', { name: 'Welcome, Layla Operations' })).toBeVisible();

  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  await expect(page.locator('#admin-drawer')).toBeVisible();
  // Focus moved into the drawer.
  await expect(page.locator('#admin-drawer *:focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#admin-drawer')).toHaveCount(0);
  // Focus returned to the trigger.
  await expect(menu).toBeFocused();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-drawer-closed.png`),
    fullPage: true,
  });
});

test('W3-1 final: a stale-recent-factor admin reaches the shell with NO step-up gate (desktop representative)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'stale@himma.demo');
  // Ordinary bootstrap: straight to the shell — the step-up surface never
  // appears (owner decision: MFA assurance, not factor recency, is the
  // baseline; step-up stays an action-level mechanism for D-W3-5).
  await expect(page.getByRole('heading', { name: 'Welcome, Stefan Stale' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirm your identity' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-stale-factor-shell.png`),
    fullPage: true,
  });
});

test('multi-role admin sees the deduplicated union (desktop representative)', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'representative on desktop');
  await signInAs(page, 'duo@himma.demo');
  await expect(page.getByRole('heading', { name: 'Welcome, Dana Duo' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Admin navigation' });
  await expect(nav.getByRole('link', { name: 'Providers' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Access administration' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit' })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-multi-role.png`),
    fullPage: true,
  });
});
