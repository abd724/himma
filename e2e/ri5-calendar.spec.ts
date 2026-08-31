/**
 * RI-5 — the real-stack unified Calendar journey (owner item 29/30).
 *
 * Constructs, through REAL backend authority only (no seeded Calendar
 * rows — the read is a pure derivation):
 * - one normal confirmed Session Booking (free tajweed circle);
 * - one Pass-reserved Session (free intro pack → certified reservation);
 * - one flexible unscheduled pass with NO reservation (community
 *   membership — must contribute ZERO calendar dates);
 * - one CampWeek Booking (real paid hosted checkout → 5 daily occurrences);
 * - one Cohort Booking (real paid checkout; two same-day weekly meetings
 *   at 09:00 and 17:00 with the first meeting an exception date);
 * - one recurring schedule-bound membership for the CHILD (Mon & Wed
 *   19:00 — participant context stays distinct).
 *
 * Then drives the Calendar destination: chip/week navigation with bounded
 * reloads, per-source truth, exception omission, same-day distinctness,
 * empty day, Booking/Pass navigation, a NEW reservation appearing exactly
 * once after server refresh, and the immutable-membership schedule-change
 * proof (a REAL future provider revision via the dev fulfillment actor —
 * the certified W2-13 supersede service — changes NOTHING for the
 * existing customer's calendar).
 */
import { expect, test, type Page } from '@playwright/test';

const BACKEND = 'http://127.0.0.1:3101';
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

// The app displays server instants in the customer's timezone; pin the
// browser to the platform's canonical Asia/Dubai so date math is exact.
test.use({ timezoneId: 'Asia/Dubai' });

/** Dubai civil date (YYYY-MM-DD) n days from now. */
function dubaiDate(offsetDays: number): string {
  return new Date(Date.now() + DUBAI_OFFSET_MS + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Monday-start week anchor (UTC math on the civil string). */
function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0=Sun
  return addDays(date, -((weekday + 6) % 7));
}

const MONDAY = 1;
const WEDNESDAY = 3;
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

async function signUp(page: Page, name: string): Promise<void> {
  const email = `ri5-${name}-${Date.now()}@himma.test`;
  const last = (testId: string) => page.getByTestId(testId).last();
  await page.goto('/auth/sign-up');
  await last('sign-up-name').fill(`E2E ${name}`);
  await last('sign-up-email').fill(email);
  await last('sign-up-password').fill('password123');
  await last('sign-up-submit').click();
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });
}

async function addChild(page: Page, name: string): Promise<void> {
  const last = (testId: string) => page.getByTestId(testId).last();
  await page.goto('/account/participants');
  await last('add-child').click();
  await last('participant-name').fill(name);
  await last('participant-dob').fill('2018-03-01');
  await last('participant-submit').click();
  await expect(last(`participant-row-${name}`)).toBeVisible();
}

/** Free entitlement acquisition on the Mat Pilates program for a chosen
 *  participant (the certified RI-4 flow — lands on the Pass). */
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

/** The REAL hosted paid boundary (the RI-3 pattern). */
async function payHosted(page: Page): Promise<void> {
  await page.getByLabel('Card payment').last().click();
  await page.getByTestId('checkout-cta').last().click();
  await expect(page.getByTestId('dev-pay')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('dev-pay').click();
  await expect(page.getByTestId('booking-confirmed').last()).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('confirmation-done').last().click();
}

/** The membership product's fulfillment terms, (re)set through the REAL
 *  W2-13 supersede-and-insert service via the dev owner actor. */
async function reviseMembershipTerms(
  page: Page,
  scheduleTerms: { weekday: number; startTime: string; endTime: string }[],
): Promise<void> {
  const response = await page.request.post(`${BACKEND}/dev/fulfillment/revise`, {
    data: {
      programTitle: 'Mat Pilates Community Classes',
      optionLabel: 'Evening membership — Mon & Wed',
      terms: {
        usageKind: 'unlimited',
        validityKind: 'fixedEndDate',
        validityEndDate: '2027-12-31',
        reservationRequired: true,
        walkInAllowed: true,
        scheduleTerms,
      },
    },
  });
  expect(response.status()).toBe(201);
}

interface DayCounts {
  tajweed: number;
  includedPass: number;
  camp: number;
  membershipAhmed: number;
  membershipYou: number;
  padel: number;
  empty: boolean;
}

/** Wait until the selected day's agenda settled (events or the truthful
 *  empty state — never a skeleton), then count by source. */
async function readDay(page: Page): Promise<DayCounts> {
  await expect
    .poll(
      async () =>
        (await page.getByTestId('calendar-empty-day').count()) +
        (await page.getByTestId(/^calendar-event-/).count()),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const events = page.getByTestId(/^calendar-event-/);
  const membership = events.filter({ hasText: 'Membership schedule' });
  return {
    tajweed: await events.filter({ hasText: 'Community Tajweed Circle' }).count(),
    includedPass: await events.filter({ hasText: 'Included with pass' }).count(),
    camp: await events.filter({ hasText: 'Creative Open Days' }).count(),
    membershipAhmed: await membership.filter({ hasText: 'For Ahmed' }).count(),
    membershipYou: await membership.filter({ hasText: 'For you' }).count(),
    padel: await events.filter({ hasText: 'Padel Fundamentals Course' }).count(),
    empty: (await page.getByTestId('calendar-empty-day').count()) > 0,
  };
}

/** Sweep `weeks` visible weeks from the current one via the REAL chip and
 *  week navigation (bounded reloads happen where the window ends). */
async function sweepWeeks(page: Page, weeks: number): Promise<Map<string, DayCounts>> {
  const byDate = new Map<string, DayCounts>();
  let monday = mondayOf(dubaiDate(0));
  for (let week = 0; week < weeks; week += 1) {
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(monday, offset);
      await page.getByTestId(`calendar-day-${date}`).last().click();
      byDate.set(date, await readDay(page));
    }
    if (week < weeks - 1) {
      await page.getByTestId('calendar-next-week').last().click();
      monday = addDays(monday, 7);
    }
  }
  return byDate;
}

test('RI-5 — the unified Calendar renders every certified source truthfully and navigates by explicit ids', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible({ timeout: 90_000 });

  // Normalize the membership product to its Mon/Wed terms through the REAL
  // revision service (a prior run's schedule-change proof may have left a
  // Tue/Thu revision active).
  await reviseMembershipTerms(page, [
    { weekday: MONDAY, startTime: '19:00', endTime: '20:00' },
    { weekday: WEDNESDAY, startTime: '19:00', endTime: '20:00' },
  ]);

  await signUp(page, 'cal');
  await addChild(page, 'Ahmed');

  // 1 — normal confirmed Session Booking (free tajweed circle).
  await page.goto('/discover/results?q=tajweed');
  await page.getByLabel(/Community Tajweed Circle by Noor Learning Center/).last().click();
  await page.getByLabel(/^Book free session: Community Tajweed Circle/).last().click();
  await page.getByRole('radio', { name: /, \d{1,2}:\d{2} (AM|PM)/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByLabel(/Continue to checkout/).last().click();
  await page.getByTestId('checkout-cta').last().click();
  await expect(page.getByTestId('booking-confirmed').last()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('confirmation-done').last().click();

  // 2 — free intro pack (self) + a certified entitlement reservation.
  await acquireFreeOption(page, /Intro pack — 5 classes/, /^You/);
  await page.getByTestId('pass-reserve').last().click();
  await page.getByTestId(/^reserve-session-/).first().click();
  await page.getByTestId('reserve-cta').last().click();
  await expect(page.getByTestId('reservation-confirmed').last()).toBeVisible({ timeout: 30_000 });

  // 3 — flexible unscheduled pass, NO reservation (must produce no dates).
  await acquireFreeOption(page, /Community membership/, /^You/);

  // 4 — the schedule-bound membership for the CHILD (Mon & Wed 19:00).
  await acquireFreeOption(page, /Evening membership — Mon & Wed/, /Ahmed/);

  // 5 — CampWeek Booking through the real paid boundary.
  await page.goto('/discover/results?q=creative%20open');
  await page.getByLabel(/Creative Open Days by Bright Minds Studio/).last().click();
  await page.getByLabel(/^Book: Creative Open Days/).last().click();
  await page.getByRole('radio', { name: /Camp week/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByLabel(/Continue to checkout/).last().click();
  await payHosted(page);

  // 6 — Cohort Booking (two weekly meetings; first meeting = exception).
  await page.goto('/discover/results?q=padel%20fundamentals');
  await page.getByLabel(/Padel Fundamentals Course by Coastal Padel Club/).last().click();
  await page.getByLabel(/^Book: Padel Fundamentals Course/).last().click();
  await page.getByRole('radio', { name: /^Starts / }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByRole('radio', { name: /^You/ }).last().click();
  await page.getByText('Continue', { exact: true }).last().click();
  await page.getByLabel(/Continue to checkout/).last().click();
  await payHosted(page);

  // ——— The Calendar destination (a first-class Bookings view). ———
  await page.goto('/bookings?view=calendar');
  await expect(page.getByTestId('bookings-segment-calendar').last()).toBeVisible({
    timeout: 60_000,
  });
  const swept = await sweepWeeks(page, 4);

  const total = (pick: (day: DayCounts) => number) =>
    [...swept.values()].reduce((sum, day) => sum + pick(day), 0);
  const today = dubaiDate(0);

  // Normal Session Booking: exactly once across the whole swept range.
  expect(total((day) => day.tajweed)).toBe(1);

  // Entitlement-reserved Session: exactly ONE event (never a Booking event
  // plus a Pass event), truthfully "Included with pass".
  expect(total((day) => day.includedPass)).toBe(1);

  // CampWeek: five INDIVIDUAL daily occurrences, one per civil day.
  expect(total((day) => day.camp)).toBe(5);
  for (const [, day] of swept) expect(day.camp).toBeLessThanOrEqual(1);

  // Flexible unscheduled pass: ZERO fabricated dates — no membership
  // occurrence ever appears for the account holder.
  expect(total((day) => day.membershipYou)).toBe(0);

  // The child's schedule-bound membership: occurrences ONLY on Mondays and
  // Wednesdays, one per day, participant context preserved.
  expect(total((day) => day.membershipAhmed)).toBeGreaterThanOrEqual(4);
  for (const [date, day] of swept) {
    if (day.membershipAhmed > 0) {
      expect([MONDAY, WEDNESDAY]).toContain(weekdayOf(date));
      expect(day.membershipAhmed).toBe(1);
    }
  }

  // Cohort: the first meeting date is the EXCEPTION (no occurrence); one
  // week later the two same-day meetings render as DISTINCT events.
  const exceptionDate = dubaiDate(10);
  const meetingDate = dubaiDate(17);
  expect(swept.get(exceptionDate)?.padel).toBe(0);
  expect(swept.get(meetingDate)?.padel).toBe(2);

  // An empty future day renders the bounded empty state (and never claims
  // the customer has no bookings).
  const emptyDay = [...swept.entries()].find(
    ([date, day]) =>
      date > today &&
      day.empty &&
      day.tajweed + day.includedPass + day.camp + day.membershipAhmed + day.padel === 0,
  );
  expect(emptyDay).toBeDefined();

  // ——— Navigation by EXPLICIT ids. ———
  // A Booking-backed event (the two 09:00/17:00 cohort meetings) opens the
  // Booking detail.
  await page.goto(`/bookings?view=calendar&date=${meetingDate}`);
  await readDay(page);
  await page
    .getByTestId(/^calendar-event-/)
    .filter({ hasText: 'Padel Fundamentals Course' })
    .first()
    .click();
  await expect(page.getByTestId('booking-check-in').last()).toBeVisible({ timeout: 30_000 });

  // A membership occurrence (no Booking) opens the owning Pass.
  const membershipDay = [...swept.entries()].find(
    ([date, day]) => date > today && day.membershipAhmed > 0,
  );
  expect(membershipDay).toBeDefined();
  await page.goto(`/bookings?view=calendar&date=${membershipDay![0]}`);
  await readDay(page);
  await page
    .getByTestId(/^calendar-event-/)
    .filter({ hasText: 'Membership schedule' })
    .first()
    .click();
  await expect(page.getByTestId('pass-balance').last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('pass-balance').last()).toHaveText('Unlimited visits');

  // ——— A NEW reservation appears exactly once after server refresh. ———
  await page.goto('/bookings?view=passes');
  await page.getByTestId(/^pass-row-/).filter({ hasText: 'Intro pack' }).first().click();
  await page.getByTestId('pass-reserve').last().click();
  await page.getByTestId(/^reserve-session-/).last().click();
  await page.getByTestId('reserve-cta').last().click();
  await expect(page.getByTestId('reservation-confirmed').last()).toBeVisible({ timeout: 30_000 });

  await page.goto('/bookings?view=calendar');
  await expect(page.getByTestId('bookings-segment-calendar').last()).toBeVisible({
    timeout: 60_000,
  });
  const afterReservation = await sweepWeeks(page, 3);
  const includedAfter = [...afterReservation.values()].reduce(
    (sum, day) => sum + day.includedPass,
    0,
  );
  expect(includedAfter).toBe(2); // the new reservation appears exactly once
  for (const [, day] of afterReservation) expect(day.includedPass).toBeLessThanOrEqual(1);

  // ——— Schedule-change immutability (owner item 30). ———
  // The provider revises the membership product to Tue/Thu 07:00 through
  // the REAL supersede-and-insert service. The existing customer's
  // purchased Mon/Wed calendar must not move.
  await reviseMembershipTerms(page, [
    { weekday: 2, startTime: '07:00', endTime: '08:00' },
    { weekday: 4, startTime: '07:00', endTime: '08:00' },
  ]);
  await page.goto(`/bookings?view=calendar&date=${membershipDay![0]}`);
  const stillMonWed = await readDay(page);
  expect(stillMonWed.membershipAhmed).toBe(1);
  // And the adjacent Tuesday gained nothing for this customer.
  const tuesday = addDays(mondayOf(membershipDay![0]), 1);
  await page.goto(`/bookings?view=calendar&date=${tuesday}`);
  const tuesdayCounts = await readDay(page);
  expect(tuesdayCounts.membershipAhmed).toBe(0);
});
