/**
 * RI-3 — the real-stack booking journeys (owner items 30/31):
 *
 * FREE: discovery → real session → real participant → server quote (Free)
 * → authoritative hold → checkout review → certified free confirmation →
 * confirmed Booking → My Bookings — with PROVIDER-SIDE proof that no
 * payment session and no provider request were ever created.
 *
 * PAID: discovery → session → participant → server quote (AED) → 10-min
 * hold + countdown → checkout → deterministic HOSTED payment boundary
 * (the provider's own page; the browser never calls a trusted endpoint) →
 * signed webhook → certified W5 saga → return + status revalidation
 * (browser return is navigation only) → confirmed → My Bookings.
 */
import { expect, test, type Page } from '@playwright/test';

const BACKEND = 'http://127.0.0.1:3101';

async function paymentProviderState(page: Page): Promise<{
  createRequestCount: number;
  sessionCount: number;
}> {
  const response = await page.request.get(`${BACKEND}/dev/payments/state`);
  return response.json();
}

async function signUp(page: Page, name: string): Promise<void> {
  const email = `ri3-${name}-${Date.now()}@himma.test`;
  const last = (testId: string) => page.getByTestId(testId).last();
  await page.goto('/auth/sign-up');
  await last('sign-up-name').fill(`E2E ${name}`);
  await last('sign-up-email').fill(email);
  await last('sign-up-password').fill('password123');
  await last('sign-up-submit').click();
  // Landed back on the app authenticated.
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
}

test('FREE journey: quote → hold → free confirm → confirmed → My Bookings; no payment machinery touched', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  const before = await paymentProviderState(page);
  await signUp(page, 'free');

  // Real discovery → the genuinely FREE seeded program.
  await page.goto('/discover/results?q=tajweed');
  await page.getByLabel(/Community Tajweed Circle by Noor Learning Center/).last().click();
  await page.getByLabel(/^Book free session: Community Tajweed Circle/).last().click();

  // Step 1 — real occurrence selection (single free option auto-selected;
  // expo-router keeps stacked screens mounted, so target the LAST match).
  await page.getByRole('radio', { name: /, \d{1,2}:\d{2} (AM|PM)/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();

  // Step 2 — real participant (Me).
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();

  // Step 3 — review with the SERVER quote (Free) → hold → checkout.
  await expect(page.getByText('Booking price · Free').last()).toBeVisible();
  await page.getByLabel(/Continue to checkout/).last().click();

  // Checkout: the authoritative hold countdown; the free CTA commits via
  // the certified path only.
  await expect(page.getByTestId('hold-countdown').last()).toBeVisible();
  await expect(page.getByTestId('hold-countdown').last()).toContainText('Your spot is held');
  await page.getByTestId('checkout-cta').last().click();

  // Confirmed — authoritative reference, then My Bookings shows it.
  await expect(page.getByTestId('booking-confirmed').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('booking-reference').last()).toHaveText(/^HM-/);
  await page.getByTestId('confirmation-done').last().click();
  await expect(page.getByText('Upcoming').last()).toBeVisible();
  await expect(page.getByText('Community Tajweed Circle').last()).toBeVisible();

  // Provider-side proof: the free path touched NO payment machinery.
  const after = await paymentProviderState(page);
  expect(after.createRequestCount).toBe(before.createRequestCount);
  expect(after.sessionCount).toBe(before.sessionCount);
});

test('PAID journey: hold countdown → hosted boundary → signed webhook → saga → revalidated confirmation → My Bookings', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 'paid');

  // Real discovery → the paid drop-in program.
  await page.goto('/discover/results?q=padel');
  await page.getByLabel(/Adult Padel Open Play by Coastal Padel Club/).last().click();
  await page.getByLabel(/^Book: Adult Padel Open Play/).last().click();

  await page.getByRole('radio', { name: /, \d{1,2}:\d{2} (AM|PM)/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();

  // Review shows the SERVER-authoritative price; entering checkout claims
  // the 10-minute hold with its countdown.
  await expect(page.getByText('Booking price · AED 90').last()).toBeVisible();
  await page.getByLabel(/Continue to checkout/).last().click();
  await expect(page.getByTestId('hold-countdown').last()).toContainText(/held for 09:/, {
    timeout: 20_000,
  });

  // Paid checkout requires the payment method, then navigates to the
  // HOSTED page (the provider's own boundary — never card fields here).
  await page.getByLabel('Card payment').last().click();
  await page.getByTestId('checkout-cta').last().click();

  // The deterministic provider's hosted page (Stripe stand-in).
  await expect(page.getByTestId('dev-pay')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('AED 90')).toBeVisible();
  await page.getByTestId('dev-pay').click();

  // Browser RETURN is navigation only: the app lands on the status read
  // and shows the D-RI-5 progress truth until the certified saga confirms.
  await expect(page.getByTestId('payment-status').last()).toBeVisible({ timeout: 60_000 });
  await expect(
    page
      .getByText("We're checking your payment status…")
      .or(page.getByText('Payment received — confirming your booking…'))
      .last(),
  ).toBeVisible({ timeout: 20_000 });

  // The certified webhook→saga path confirms; the app revalidates into
  // the real confirmation.
  await expect(page.getByTestId('booking-confirmed').last()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('booking-reference').last()).toHaveText(/^HM-/);
  await page.getByTestId('confirmation-done').last().click();
  await expect(page.getByText('Adult Padel Open Play').last()).toBeVisible();
  await expect(page.getByText('Upcoming').last()).toBeVisible();
});

test('S6 product boundary: a package option is visible but truthfully NOT bookable', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
  await signUp(page, 's6');

  // The seeded BJJ program carries a dropIn option AND a 10-class pack.
  await page.goto('/discover/results?q=bjj');
  await page.getByLabel(/Adult BJJ Fundamentals by Harbor Martial Arts/).last().click();
  await page.getByLabel(/^Book: Adult BJJ Fundamentals/).last().click();

  await expect(page.getByText('Coming soon', { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('10-class pack').last()).toBeVisible();
  // The unavailable option is disabled — selecting it is impossible.
  const unavailable = page.getByTestId(/^option-unavailable-/).last();
  await expect(unavailable).toHaveAttribute('aria-disabled', 'true');
});
