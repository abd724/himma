import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PASSWORD = 'himma-demo';
export const FIXTURE_TOTP_CODE = '246810';

export function evidenceDir(milestone: string): string {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'artifacts',
    milestone,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** UI sign-in through the real access flow (fixture adapter). */
export async function signInAs(page: Page, email: string, { mfa = true } = {}) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (mfa) {
    await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

export function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 0) < 768;
}

export function isTablet(page: Page) {
  const width = page.viewportSize()?.width ?? 0;
  return width >= 768 && width < 1120;
}
