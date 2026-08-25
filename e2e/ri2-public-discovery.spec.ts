/**
 * RI-2 — the real-stack PUBLIC discovery journey (owner item 22):
 *
 * guest (NO authentication anywhere) → Home with real catalogue rails →
 * search → real results → real program detail with the D-RI-4 public
 * upcoming occurrences and availability → provider storefront → deep-link
 * reload recovers from backend truth → booking CTA hits the truthful RI-3
 * pending boundary (real ids never enter mock commerce) → a no-results
 * search and a no-upcoming-sessions listing state truthfully render.
 */
import { expect, test } from '@playwright/test';

test('guest public discovery: home → search → detail (availability) → storefront → deep link → truthful states', async ({
  page,
}) => {
  // Home renders REAL catalogue rails without any sign-in.
  await page.goto('/');
  await expect(page.getByText('New on Himma').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Community Tajweed Circle').first()).toBeVisible();
  // The header shows a real canonical area.
  await expect(page.getByText('Khalifa City, Abu Dhabi').first()).toBeVisible();

  // Search → real results with EXACT totals (server truth, complete page).
  await page.getByLabel('Search activities, providers or classes').first().click();
  await page.getByLabel('Search activities or providers').last().fill('padel');
  await page.getByLabel('Search activities or providers').last().press('Enter');
  await expect(page.getByText('2 activities · 1 provider').last()).toBeVisible();
  await expect(page.getByText('Adult Padel Open Play').last()).toBeVisible();

  // Real program detail: D-RI-4 public occurrences with dates, branch
  // identity, and the customer-safe availability band (a genuine low
  // spotsLeft from the capacity-2 session — never a total).
  await page
    .getByLabel(/Adult Padel Open Play by Coastal Padel Club/)
    .last()
    .click();
  await expect(page.getByText('AED 90').last()).toBeVisible();
  await expect(page.getByText('Upcoming sessions').last()).toBeVisible();
  await expect(page.getByText('2 places left').last()).toBeVisible();
  await expect(page.getByText('Al Raha Courts').last()).toBeVisible();
  // No fabricated marketplace truth anywhere on the page.
  await expect(page.getByText(/reviews/)).toHaveCount(0);

  // Provider storefront — real public profile + real listings.
  await page.getByLabel('Coastal Padel Club, verified provider').last().click();
  await expect(page.getByText('Verified provider').last()).toBeVisible();
  await expect(page.getByText('Padel Fundamentals Course').last()).toBeVisible();
  const storefrontUrl = page.url();

  // Deep-link reload: the SAME canonical URL recovers from backend truth.
  await page.reload();
  await expect(page.getByText('Padel Fundamentals Course').last()).toBeVisible({
    timeout: 60_000,
  });
  expect(page.url()).toBe(storefrontUrl);

  // Booking handoff: the real program id reaches the truthful RI-3 pending
  // boundary — never a mock quote/hold/Booking.
  await page.getByText('Adult Padel Open Play').last().click();
  await page.getByLabel(/^Book: Adult Padel Open Play/).last().click();
  await expect(page.getByTestId('booking-pending').last()).toBeVisible();
  await expect(page.getByText(/Booking is almost here/).last()).toBeVisible();

  // Truthful no-results state.
  await page.goto('/discover/results?q=zzzznotathing');
  await expect(page.getByText(/No results for/).last()).toBeVisible({ timeout: 60_000 });

  // Truthful no-upcoming-sessions state on a published listing with no
  // capacity units (deep link by real title through search).
  await page.goto('/discover/results?q=scratch coding');
  await page.getByLabel(/Scratch Coding Basics by Bright Minds Studio/).last().click();
  await expect(page.getByText('No upcoming sessions listed', { exact: false }).last()).toBeVisible();
});

test('unknown and unpublished program ids truthfully show not-found — an ID conveys nothing', async ({
  page,
}) => {
  await page.goto('/program/00000000-0000-7000-8000-000000000000');
  await expect(page.getByText('This program is no longer offered.').last()).toBeVisible({
    timeout: 90_000,
  });
});
