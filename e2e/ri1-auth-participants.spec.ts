/**
 * RI-1 — the production-like local journey (owner item 17):
 *
 * guest opens app → signs up (real backend, real PostgreSQL) → sees the
 * account → adds a child participant → RELOADS the app (session restores
 * from stored tokens; participants come back from the backend) → child is
 * still there → logout → the protected account surface is inaccessible.
 */
import { expect, test } from '@playwright/test';

test('guest → sign up → account → add child → reload persistence → logout → protected surface locked', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@himma.test`;
  // Expo-router web keeps previously stacked screens mounted in the DOM;
  // `.last()` always targets the topmost (visible) instance.
  const last = (testId: string) => page.getByTestId(testId).last();

  // Guest opens the app (first Metro bundle can be slow — generous wait).
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });

  // Profile tab → guest state → real sign-in flow → create account.
  await page.getByRole('tab', { name: 'Profile' }).click();
  await expect(last('profile-sign-in')).toBeVisible();
  await last('profile-sign-in').click();
  await page.getByLabel('Create an account', { exact: true }).click();
  await last('sign-up-name').fill('E2E Parent');
  await last('sign-up-email').fill(email);
  await last('sign-up-password').fill('password123');
  await last('sign-up-submit').click();

  // Back on Profile with the REAL account (server truth).
  await expect(last('profile-display-name')).toHaveText('E2E Parent');
  await expect(last('profile-email')).toHaveText(email);

  // Participants: the structural self profile, then add a child.
  await last('profile-participants-row').click();
  await expect(last('participant-row-self')).toBeVisible();
  await last('add-child').click();
  await last('participant-name').fill('Ahmed');
  await last('participant-dob').fill('2018-03-01');
  await last('participant-submit').click();
  await expect(last('participant-row-Ahmed')).toBeVisible();

  // App reload ON the protected deep URL: the session restores from stored
  // tokens and the child comes back from PostgreSQL — nothing was local
  // fiction.
  await page.reload();
  await expect(last('participant-row-Ahmed')).toBeVisible({ timeout: 90_000 });
  await expect(last('participant-row-self')).toBeVisible();

  // Server-validated failure surfaces truthfully (no optimistic fiction):
  // an invalid DOB is refused and NOTHING is added.
  await last('add-child').click();
  await last('participant-name').fill('Ghost');
  await last('participant-dob').fill('2099-01-01');
  await last('participant-submit').click();
  await expect(last('form-error')).toBeVisible();
  await page.getByLabel('Back').last().click();
  await expect(last('participant-row-Ahmed')).toBeVisible();
  await expect(last('participant-row-Ghost')).toHaveCount(0);

  // Logout: guest again, and the protected surface routes to sign-in.
  await page.getByLabel('Back').last().click();
  await last('profile-sign-out').click();
  await expect(last('profile-sign-in')).toBeVisible();
  await page.goto('/account/participants');
  await expect(last('sign-in-submit')).toBeVisible({ timeout: 60_000 });
});
