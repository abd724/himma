/**
 * RI-4 — the real-stack Passes & Memberships / check-in journeys (owner
 * RI-4 §36):
 *
 * A/C/D/E/F — free finite pack: real acquisition → Pass with authoritative
 * balance → reservation of an eligible Session (no payment anywhere; the
 * Booking reads "Included with pass") → reserved-use check-in with a real
 * 8-digit code redeemed by the REAL provider path (the dev front-desk
 * actor drives the certified S6-2 services) → the customer screen observes
 * server-confirmed "Checked in" and the balance refreshes exactly once →
 * explicit regeneration (old code dies at the desk, the new one redeems).
 *
 * B — paid acquisition through the REAL W5 hosted boundary → pass ready.
 *
 * G — unlimited membership: "Unlimited", no counter, two independent
 * check-ins.
 *
 * H — CampWeek canonical occurrences (0020): each day selected explicitly,
 * one day checks in while another refuses outside its ±60 window.
 */
import { expect, test, type Page } from '@playwright/test';

const BACKEND = 'http://127.0.0.1:3101';

async function signUp(page: Page, name: string): Promise<void> {
  const email = `ri4-${name}-${Date.now()}@himma.test`;
  const last = (testId: string) => page.getByTestId(testId).last();
  await page.goto('/auth/sign-up');
  await last('sign-up-name').fill(`E2E ${name}`);
  await last('sign-up-email').fill(email);
  await last('sign-up-password').fill('password123');
  await last('sign-up-submit').click();
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
}

/** The visible 8-digit code (rendered "1234 5678"). */
async function readCode(page: Page): Promise<string> {
  const grouped = (await page.getByTestId('credential-code').last().textContent()) ?? '';
  return grouped.replace(/\s+/g, '');
}

/** The REAL provider redemption via the dev front-desk actor (certified
 *  S6-2 services under a real staff membership — never a state shortcut). */
async function providerRedeem(page: Page, code: string) {
  return page.request.post(`${BACKEND}/dev/checkin/redeem`, { data: { code } });
}

async function acquireFreeOption(page: Page, optionLabel: RegExp): Promise<void> {
  await page.goto('/discover/results?q=mat%20pilates');
  await page.getByLabel(/Mat Pilates Community Classes by Serenity Pilates House/).last().click();
  await page.getByLabel(/^Book.*Mat Pilates Community Classes/).last().click();
  await page.getByRole('radio', { name: optionLabel }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  // The acquisition summary: server terms + Price · Free; continuing skips
  // any hold (nothing is reserved for a unit-less purchase).
  await expect(page.getByText('Price · Free').last()).toBeVisible();
  await page.getByLabel(/Continue to checkout/).last().click();
  await expect(page.getByTestId('checkout-cta').last()).toBeVisible();
  await page.getByTestId('checkout-cta').last().click();
  // Free acquisition lands directly on the Pass.
  await expect(page.getByTestId('pass-acquired').last()).toBeVisible({ timeout: 30_000 });
}

test('A/C/D/E/F — free pack: acquire → authoritative balance → reserve (included with pass) → reserved check-in → regeneration → balances refresh from the server only', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'pack');

  // A — free finite acquisition; the Pass appears with the server balance.
  await acquireFreeOption(page, /Intro pack — 5 classes/);
  await expect(page.getByTestId('pass-balance').last()).toHaveText('5 of 5 visits remaining');

  // C — reserve the first eligible Session: no payment page, no AED 0
  // purchase — "Included with your pass".
  await page.getByTestId('pass-reserve').last().click();
  await expect(page.getByTestId('reserve-credits').last()).toContainText(
    '5 of 5 visits available to book',
  );
  await page.getByTestId(/^reserve-session-/).first().click();
  await page.getByTestId('reserve-cta').last().click();
  await expect(page.getByTestId('reservation-confirmed').last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Included with your pass — no payment needed.').last()).toBeVisible();

  // The reservation Booking presents as included-with-pass, never Free.
  await page.getByTestId('reservation-view-booking').last().click();
  await expect(page.getByText('Included with pass').last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('booking-view-pass').last()).toBeVisible();

  // F — reserved-use check-in: real code → REAL provider redemption → the
  // customer observes server-confirmed "Checked in".
  await page.getByTestId('booking-check-in').last().click();
  await expect(page.getByTestId('credential-code').last()).toBeVisible({ timeout: 30_000 });
  const reservedCode = await readCode(page);
  expect(reservedCode).toMatch(/^\d{8}$/);
  const redeemed = await providerRedeem(page, reservedCode);
  expect(redeemed.status()).toBe(201);
  await expect(page.getByTestId('credential-used').last()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('credential-done').last().click();

  // The finite balance refreshed EXACTLY once server-side: 4 of 5 (the
  // commitment converted to consumption — nothing was double-counted).
  await page.goto('/bookings?view=passes');
  await page.getByTestId(/^pass-row-/).last().click();
  await expect(page.getByTestId('pass-balance').last()).toHaveText('4 of 5 visits remaining', {
    timeout: 20_000,
  });

  // D/E — walk-in code C1, EXPLICIT regeneration to C2: C1 dies at the
  // desk, C2 redeems; the balance moves to 3 of 5.
  await page.getByTestId('pass-checkin').last().click();
  await expect(page.getByTestId('credential-code').last()).toBeVisible({ timeout: 30_000 });
  const c1 = await readCode(page);
  await page.getByTestId('credential-regenerate').last().click();
  await expect(page.getByTestId('credential-code').last()).not.toHaveText(
    `${c1.slice(0, 4)} ${c1.slice(4)}`,
    { timeout: 30_000 },
  );
  const c2 = await readCode(page);
  expect(c2).not.toBe(c1);
  const staleRedeem = await providerRedeem(page, c1);
  expect(staleRedeem.status()).not.toBe(201); // the replaced code is dead
  const freshRedeem = await providerRedeem(page, c2);
  expect(freshRedeem.status()).toBe(201);
  await expect(page.getByTestId('credential-used').last()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('credential-done').last().click();
  await page.goto('/bookings?view=passes');
  await page.getByTestId(/^pass-row-/).last().click();
  await expect(page.getByTestId('pass-balance').last()).toHaveText('3 of 5 visits remaining', {
    timeout: 20_000,
  });
});

test('B — PAID pack acquisition through the real W5 hosted boundary → Pass ready with the full balance', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'paid');

  await page.goto('/discover/results?q=bjj');
  await page.getByLabel(/Adult BJJ Fundamentals by Harbor Martial Arts/).last().click();
  await page.getByLabel(/^Book: Adult BJJ Fundamentals/).last().click();
  await page.getByRole('radio', { name: /10-class pack/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await expect(page.getByText('Price · AED 600').last()).toBeVisible();
  await page.getByLabel(/Continue to checkout/).last().click();

  // Paid acquisition: the ordinary W5 hosted boundary; no hold countdown
  // exists (a purchase reserves no inventory).
  await page.getByLabel('Card payment').last().click();
  await page.getByTestId('checkout-cta').last().click();
  await expect(page.getByTestId('dev-pay')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('AED 600')).toBeVisible();
  await page.getByTestId('dev-pay').click();

  // Return is navigation only — the purchase STATUS read owns the truth,
  // then the customer lands on their Pass.
  await expect(page.getByTestId('pass-acquired').last()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('pass-balance').last()).toHaveText('10 of 10 visits remaining');
});

test('G — unlimited membership: "Unlimited", no counter, two independent legitimate check-ins', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'member');

  await acquireFreeOption(page, /Community membership/);
  await expect(page.getByTestId('pass-balance').last()).toHaveText('Unlimited visits');

  for (const visit of [1, 2]) {
    await page.getByTestId('pass-checkin').last().click();
    await expect(page.getByTestId('credential-code').last()).toBeVisible({ timeout: 30_000 });
    const code = await readCode(page);
    const redeemed = await providerRedeem(page, code);
    expect(redeemed.status(), `visit ${visit}`).toBe(201);
    await expect(page.getByTestId('credential-used').last()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('credential-done').last().click();
    // Never a fake counter — the membership stays "Unlimited".
    await expect(page.getByTestId('pass-balance').last()).toHaveText('Unlimited visits');
  }
});

test('H — CampWeek canonical occurrences (0020): explicit day selection; today checks in, another day refuses outside its window', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'camp');

  // Book the open-day camp week through the ordinary paid camp flow.
  await page.goto('/discover/results?q=creative%20open');
  await page.getByLabel(/Creative Open Days by Bright Minds Studio/).last().click();
  await page.getByLabel(/^Book: Creative Open Days/).last().click();
  await page.getByRole('radio', { name: /Camp week/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await expect(page.getByText('Booking price · AED 50').last()).toBeVisible();
  await page.getByLabel(/Continue to checkout/).last().click();
  await page.getByLabel('Card payment').last().click();
  await page.getByTestId('checkout-cta').last().click();
  await expect(page.getByTestId('dev-pay')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('dev-pay').click();
  await expect(page.getByTestId('booking-confirmed').last()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('confirmation-done').last().click();

  // Open the camp booking → Check in → the CANONICAL day list (server
  // occurrence truth; the app never derives dates from the span).
  await page.getByText('Creative Open Days').last().click();
  await page.getByTestId('booking-check-in').last().click();
  const occurrenceRows = page.getByTestId(/^occurrence-/);
  await expect(occurrenceRows.first()).toBeVisible({ timeout: 30_000 });
  expect(await occurrenceRows.count()).toBeGreaterThanOrEqual(5);

  // Today's occurrence (first) is inside its ±60 window → a real code.
  await occurrenceRows.first().click();
  await expect(page.getByTestId('credential-code').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('credential-occurrence').last()).toBeVisible();
  const code = await readCode(page);
  const redeemed = await providerRedeem(page, code);
  expect(redeemed.status()).toBe(201);
  await expect(page.getByTestId('credential-used').last()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('credential-done').last().click();

  // Done returns to the day list — a DIFFERENT camp day is a separate
  // occurrence: selecting tomorrow refuses truthfully outside its window —
  // never a fake code, and the whole camp is never marked attended by one
  // day.
  await expect(occurrenceRows.first()).toBeVisible({ timeout: 30_000 });
  await occurrenceRows.nth(1).click();
  await expect(
    page.getByText('Check-in opens closer to your session time.').last(),
  ).toBeVisible({ timeout: 20_000 });
});
