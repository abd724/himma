/**
 * RI-6 — production-like hardening journeys over the REAL stack (owner
 * item 35):
 *
 * 1. LOST RETURN + ACCOUNT SWITCH: a paid checkout whose browser never
 *    returns keeps its truth (Needs attention → authoritative status
 *    copy), recovery through /bookings/return replays the SAME intent
 *    (no duplicate provider session), and logout clears every
 *    account-scoped trace before the next account signs in — including
 *    the persisted pending-checkout record.
 * 2. NETWORK RETRY IDEMPOTENCY: a reservation attempt that dies on the
 *    wire surfaces a recoverable retry state, and the retry produces
 *    EXACTLY ONE reservation — never a duplicate booking.
 * 3. SECRET LIFECYCLE: a reload loses the one-time check-in code by
 *    design; the screen recovers metadata only and EXPLICIT regeneration
 *    mints a fresh working code (redeemed by the real provider actor).
 * 4. TIMEZONE (America/New_York device): a Dubai 00:30 session books,
 *    lists, and calendars on its DUBAI civil day with the venue time —
 *    never drifting onto the US civil day.
 */
import { expect, test, type Page } from '@playwright/test';

const BACKEND = 'http://127.0.0.1:3101';
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

function dubaiDate(offsetDays: number): string {
  return new Date(Date.now() + DUBAI_OFFSET_MS + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function signUp(page: Page, name: string): Promise<string> {
  const email = `ri6-${name}-${Date.now()}@himma.test`;
  const last = (testId: string) => page.getByTestId(testId).last();
  await page.goto('/auth/sign-up');
  await last('sign-up-name').fill(`E2E ${name}`);
  await last('sign-up-email').fill(email);
  await last('sign-up-password').fill('password123');
  await last('sign-up-submit').click();
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  return email;
}

async function paymentProviderState(page: Page): Promise<{
  createRequestCount: number;
  sessionCount: number;
}> {
  const response = await page.request.get(`${BACKEND}/dev/payments/state`);
  return response.json();
}

async function acquireFreeOption(
  page: Page,
  optionLabel: RegExp,
  participant: RegExp,
): Promise<void> {
  await page.goto('/discover/results?q=mat%20pilates');
  await page.getByLabel(/Mat Pilates Community Classes by Serenity Pilates House/).last().click();
  await page.getByLabel(/^Book.*Mat Pilates Community Classes/).last().click();
  await page.getByRole('radio', { name: optionLabel }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: participant }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await expect(page.getByText('Price · Free').last()).toBeVisible();
  await page.getByLabel(/Continue to checkout/).last().click();
  await expect(page.getByTestId('checkout-cta').last()).toBeVisible();
  await page.getByTestId('checkout-cta').last().click();
  await expect(page.getByTestId('pass-acquired').last()).toBeVisible({ timeout: 30_000 });
}

test('lost payment return keeps truth, recovery replays the SAME intent, and account switch clears every trace', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'switch-a');

  // Account A initiates a PAID checkout and the browser NEVER returns
  // (the customer abandons the provider page).
  await page.goto('/discover/results?q=padel');
  await page.getByLabel(/Adult Padel Open Play by Coastal Padel Club/).last().click();
  await page.getByLabel(/^Book: Adult Padel Open Play/).last().click();
  await page
    .getByRole('radio', { name: /, \d{1,2}:\d{2} (AM|PM)/, disabled: false })
    .last()
    .click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByLabel(/Continue to checkout/).last().click();
  await page.getByLabel('Card payment').last().click();
  await page.getByTestId('checkout-cta').last().click();
  await expect(page.getByTestId('dev-pay')).toBeVisible({ timeout: 30_000 });
  const afterInitiate = await paymentProviderState(page);

  // Lost return: straight back into the app — payment truth survives via
  // the backend, never the browser.
  await page.goto('/bookings');
  await expect(page.getByText('Needs attention').last()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(/^booking-row-/).first().click();
  await expect(page.getByTestId('payment-status').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("We're checking your payment status…").last()).toBeVisible({
    timeout: 20_000,
  });

  // Recovery through the return route replays the SAME commercial intent:
  // no second provider session is ever created.
  await page.goto('/bookings/return');
  await expect(page.getByTestId('payment-status').last()).toBeVisible({ timeout: 30_000 });
  const afterRecovery = await paymentProviderState(page);
  expect(afterRecovery.sessionCount).toBe(afterInitiate.sessionCount);
  expect(afterRecovery.createRequestCount).toBe(afterInitiate.createRequestCount);

  // Account switch: logout clears the pending record and every
  // account-scoped surface before B signs in on the same device.
  await page.goto('/profile');
  await page.getByTestId('profile-sign-out').last().click();
  await expect(page.getByTestId('profile-sign-in').last()).toBeVisible({ timeout: 30_000 });
  await signUp(page, 'switch-b');

  await page.goto('/bookings');
  await expect(page.getByText('No bookings yet').last()).toBeVisible({ timeout: 30_000 });
  await page.goto('/bookings?view=calendar');
  await expect(page.getByTestId('calendar-empty-day').last()).toBeVisible({ timeout: 30_000 });
  // The persisted pending-checkout record did NOT survive into B's session.
  await page.goto('/bookings/return');
  await expect(page.getByText('Welcome back').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('payment-status')).toHaveCount(0);
});

test('network-loss retry preserves idempotency: one refusal, one retry, EXACTLY ONE reservation', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'retry');

  await acquireFreeOption(page, /Intro pack — 5 classes/, /^You/);

  // Kill the FIRST reservation-quote on the wire (offline mid-intent).
  let aborted = 0;
  await page.route('**/reservation-quote', (route) => {
    if (aborted === 0) {
      aborted += 1;
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });

  await page.getByTestId('pass-reserve').last().click();
  await page.getByTestId(/^reserve-session-/).first().click();
  await page.getByTestId('reserve-cta').last().click();
  await expect(
    page.getByText('Connection problem. Check your internet and try again.').last(),
  ).toBeVisible({ timeout: 20_000 });

  // Retry the SAME intent — the certified chain completes exactly once.
  // (Past the screen's 700 ms accidental-double-tap guard — a real retry
  // is a deliberate second press, not a bounce.)
  await page.waitForTimeout(900);
  await page.getByTestId(/^reserve-session-/).first().click();
  await page.getByTestId('reserve-cta').last().click();
  await expect(page.getByTestId('reservation-confirmed').last()).toBeVisible({ timeout: 30_000 });
  expect(aborted).toBe(1);

  // Exactly ONE reservation exists: one commitment on the pass, one
  // included-with-pass booking row.
  await page.goto('/bookings?view=passes');
  await page.getByTestId(/^pass-row-/).filter({ hasText: 'Intro pack' }).first().click();
  await expect(page.getByText(/1 visit reserved for upcoming sessions/).last()).toBeVisible({
    timeout: 20_000,
  });
  await page.goto('/bookings');
  await expect(
    page.getByTestId(/^booking-row-/).filter({ hasText: 'Mat Pilates Community Classes' }),
  ).toHaveCount(1, { timeout: 30_000 });
});

test('secret lifecycle: reload loses the one-time code by design; explicit regeneration mints a working replacement', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'secret');

  // Walk-in-capable unlimited membership → a live code.
  await acquireFreeOption(page, /Community membership/, /^You/);
  await page.getByTestId('pass-checkin').last().click();
  await expect(page.getByTestId('credential-code').last()).toBeVisible({ timeout: 30_000 });

  // Process loss: the secret dies with the process — after reload the
  // screen recovers METADATA ONLY and never fabricates the old code.
  await page.reload();
  await expect(page.getByTestId('credential-regenerate').last()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('credential-code')).toHaveCount(0);

  // Explicit regeneration mints a fresh code the REAL provider redeems.
  await page.getByTestId('credential-regenerate').last().click();
  await expect(page.getByTestId('credential-code').last()).toBeVisible({ timeout: 30_000 });
  const grouped = (await page.getByTestId('credential-code').last().textContent()) ?? '';
  const code = grouped.replace(/\s+/g, '');
  expect(code).toMatch(/^\d{8}$/);
  const redeemed = await page.request.post(`${BACKEND}/dev/checkin/redeem`, { data: { code } });
  expect(redeemed.status()).toBe(201);
  await expect(page.getByTestId('credential-used').last()).toBeVisible({ timeout: 20_000 });
});

test.describe('device timezone far from the venue', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('a Dubai 00:30 session stays on its DUBAI civil day end-to-end (selection, bookings, calendar)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
    await signUp(page, 'tz');

    // Booking selection presents the VENUE time (12:30 AM), not the New
    // York rendering of the same instant (≈4:30 PM the previous day).
    await page.goto('/discover/results?q=tajweed');
    await page.getByLabel(/Community Tajweed Circle by Noor Learning Center/).last().click();
    await page.getByLabel(/^Book free session: Community Tajweed Circle/).last().click();
    await page.getByRole('radio', { name: /12:30 AM/ }).last().click();
    await page.getByText('Continue', { exact: true }).last().click();
    await page.getByRole('radio', { name: /^You/ }).last().click();
    await page.getByText('Continue', { exact: true }).last().click();
    await page.getByLabel(/Continue to checkout/).last().click();
    await page.getByTestId('checkout-cta').last().click();
    await expect(page.getByTestId('booking-confirmed').last()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('confirmation-done').last().click();

    // My Bookings keeps the venue time.
    await expect(
      page
        .getByTestId(/^booking-row-/)
        .filter({ hasText: 'Community Tajweed Circle' })
        .filter({ hasText: '12:30 AM' }),
    ).toHaveCount(1, { timeout: 30_000 });

    // Calendar: the event sits on the DUBAI civil day...
    const dubaiDay = dubaiDate(6); // the seeded cross-midnight session's day
    await page.goto(`/bookings?view=calendar&date=${dubaiDay}`);
    await expect(
      page
        .getByTestId(/^calendar-event-/)
        .filter({ hasText: 'Community Tajweed Circle' })
        .filter({ hasText: '12:30 AM' }),
    ).toHaveCount(1, { timeout: 30_000 });
    // ...and NOT on the previous civil day the US device clock would claim.
    await page.goto(`/bookings?view=calendar&date=${dubaiDate(5)}`);
    await expect
      .poll(async () =>
        (await page.getByTestId('calendar-empty-day').count()) +
        (await page.getByTestId(/^calendar-event-/).count()),
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByTestId(/^calendar-event-/).filter({ hasText: 'Community Tajweed Circle' }),
    ).toHaveCount(0);
  });
});
