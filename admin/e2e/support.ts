import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PASSWORD = 'admin-demo';
export const FIXTURE_TOTP_CODE = '246810';

export function evidenceDir(milestone: string): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifacts', milestone);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** UI sign-in through the real access flow (fixture adapter). */
export async function signInAs(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(FIXTURE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
