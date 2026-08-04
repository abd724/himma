/**
 * Commit 16 QA — Checkout foundation and price review (docs/22 §14, §16;
 * owner decisions docs/09 §22): Continue-to-checkout activation with the
 * double-tap guard, per-type checkout price review with Booking price
 * continuity (never Total, no VAT/fees/discount arithmetic, Free never
 * AED 0), policy display with no acceptance claim, guardian context on
 * child bookings, inert CTA contract (Continue to payment / Confirm
 * booking), summary preservation beneath checkout, exact-origin back,
 * edit-booking round trip, cold-link/missing-draft/unknown recovery, and
 * provisional screenshot rows 01–09 and 14–16 at 390 × 844 and 360 × 780.
 * Run: node scripts/qa/checkout-review.mjs (Expo web on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/checkout-review';
mkdirSync(OUT, { recursive: true });

const failures = [];
const consoleErrors = [];
const check = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures.push(name);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
/** The inert CTA contract must never open a dialog of any kind. */
const dialogs = [];
page.on('dialog', (dialog) => {
  dialogs.push(dialog.message());
  dialog.dismiss().catch(() => {});
});
const shot = async (name) => {
  await page
    .addStyleTag({ content: '.__expo_fast_refresh { display: none !important; }' })
    .catch(() => {});
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
const idle = (ms = 900) => page.waitForTimeout(ms);
const visible = (locator) => locator.isVisible().catch(() => false);
const visibleText = (text) => visible(page.getByText(text).locator('visible=true').first());
/** Screens beneath a root push stay mounted; always target the visible match. */
const visibleLabel = (label) => page.getByLabel(label).locator('visible=true').first();
const noOverflow = (width) =>
  page.evaluate((w) => document.documentElement.scrollWidth <= w, width);
const bodyText = () => page.evaluate(() => document.body.innerText);
/** Deterministic absolute scroll (HANDOFF rule: never mouse.wheel). */
const scrollToY = async (y) => {
  await page.evaluate((top) => {
    const scrollers = [...document.querySelectorAll('div')].filter(
      (el) =>
        el.scrollHeight > el.clientHeight + 40 &&
        ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
        el.checkVisibility({ checkVisibilityCSS: true }),
    );
    const target = scrollers[scrollers.length - 1] ?? document.scrollingElement;
    if (target) target.scrollTop = top;
  }, y);
  await page.waitForTimeout(500);
};

/** No pricing, reservation, or legal-acceptance implication anywhere. */
const assertHonestCopy = async (context) => {
  const body = await bodyText();
  check(`${context}: never says Total`, !/\bTotal\b/.test(body));
  check(`${context}: no VAT or fee lines`, !/VAT|\bfees?\b/i.test(body));
  check(`${context}: no AED 0`, !body.includes('AED 0'));
  check(`${context}: no reservation/payment/confirmation implication`,
    !/reserv|holding|charged|payment (processed|complete)|booking confirmed|you.re booked|receipt/i.test(body));
  check(`${context}: no acceptance claim`, !/i agree|i accept|i confirm|by continuing/i.test(body));
};

/** Drive a booking flow into checkout; steps mirror the booking QA journeys. */
const openCheckout = async (path, steps) => {
  await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle' });
  await idle();
  for (const step of steps) {
    await visibleLabel(step).click();
    await idle(step instanceof RegExp && String(step).includes('Continue') ? 900 : 300);
  }
  await visibleLabel(/^Continue to checkout/).click();
  await idle();
};

// ——— Single session: full journey, price review, inert CTA, back chain ———
await page.goto(`${BASE}/program/beginner-calisthenics`, { waitUntil: 'networkidle' });
await idle();
await visibleLabel(/^Book: Beginner Calisthenics/).click();
await idle();
await visibleLabel('Today, 7:30 PM').click();
await idle(300);
await visibleLabel(/^Continue: /).click();
await idle();
await visibleLabel(/^You$/).click();
await idle(300);
await visibleLabel(/^Continue: /).click();
await idle();
check('summary: checkout CTA active', await visible(visibleLabel(/^Continue to checkout/)));
await visibleLabel(/^Continue to checkout/).click();
await idle();
check('checkout: url is /checkout', page.url().endsWith('/booking/beginner-calisthenics/checkout'));
check('checkout: heading role', await visible(page.getByRole('heading', { name: 'Checkout' }).locator('visible=true').first()));
check('checkout: recap program', await visibleText('Beginner Calisthenics'));
check('checkout: recap provider', await visibleText('Gravity Movement Studio'));
check('checkout: recap participant', await visible(visibleLabel(/^You, suitable for this program$/)));
check('checkout: recap selection', await visibleText('Today · 7:30 PM'));
check('checkout: price line', await visibleText('1 session'));
check('checkout: Booking price continuity', await visibleText('Booking price · AED 85 per session'));
check('checkout: policy displayed', await visibleText('Flexible cancellation'));
check('checkout: Full policy contract present', await visible(visibleLabel('Full policy')));
check('checkout: no checkbox exists', (await page.locator('[role="checkbox"]:visible').count()) === 0);
check('checkout: support row', await visibleText('Something wrong with your booking?'));
check('checkout: paid CTA label', await visible(visibleLabel(/^Continue to payment/)));
await assertHonestCopy('checkout single');
{
  // Reading order: recap → price → policy → CTA (docs/22 §12).
  const lower = (await bodyText()).toLowerCase();
  const order = ['beginner calisthenics', 'price', 'cancellation policy', 'continue to payment']
    .map((marker) => lower.indexOf(marker));
  check('checkout: reading order recap → price → policy → CTA',
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])));
}
await shot('01-checkout-single-390');

// Inert CTA: no route change, no dialog.
await visibleLabel(/^Continue to payment/).click();
await idle(500);
check('checkout: Continue to payment produces no route change',
  page.url().endsWith('/booking/beginner-calisthenics/checkout'));

// Sticky CTA over scrolled content.
await scrollToY(4000);
check('checkout: CTA sticky at the bottom scroll position', await visibleText('Booking price · AED 85 per session'));
await shot('16-checkout-sticky-390');
await scrollToY(0);

// Summary preserved beneath checkout; exact-origin back chain.
await visibleLabel('Back').click();
await idle();
check('back: summary preserved beneath checkout', await visibleText('Review your booking'));
check('back: summary draft intact', await visibleText('Booking price · AED 85 per session'));

// Double-tap guard: one press, one checkout route.
await visibleLabel(/^Continue to checkout/).dblclick();
await idle();
check('double-tap: checkout opened once', page.url().endsWith('/checkout'));
await visibleLabel('Back').click();
await idle();
check('double-tap: one back lands on the summary', await visibleText('Review your booking'));
await visibleLabel('Back').click();
await idle();
await visibleLabel('Back').click();
await idle();
await visibleLabel('Back').click();
await idle();
check('back: chain ends on the exact Program Details origin',
  await visible(visibleLabel(/^Book: Beginner Calisthenics/)));

// ——— Monthly (membership-style, adult) ———
await openCheckout('booking/mens-strength-basics', [/^You$/, /^Continue: /]);
check('monthly: cadence Booking price', await visibleText('Booking price · AED 400 per month'));
check('monthly: paid CTA', await visible(visibleLabel(/^Continue to payment/)));
await assertHonestCopy('checkout monthly');
await shot('02-checkout-monthly-390');

// ——— Child booking: guardian context + edit round trip ———
await openCheckout('booking/junior-swim-squad', [/^Adam, age 8$/, /^Continue: /]);
check('child: participant line', await visibleText('Adam · Age 8'));
check('child: guardian context displayed', await visibleText('Booked by you'));
check('child: recurring Booking price', await visibleText('Booking price · AED 380 per month'));
check('child: no consent checkbox', (await page.locator('[role="checkbox"]:visible').count()) === 0);
await shot('08-checkout-child-390');
// Edit booking → summary owns the edits → checkout re-derives.
await visibleLabel('Edit booking').click();
await idle();
check('edit: returns to the summary', await visibleText('Review your booking'));
await visibleLabel('Change participant').click();
await idle();
await visibleLabel(/^Lina, age 12$/).click();
await idle(300);
await visibleLabel(/^Continue: /).click();
await idle();
await visibleLabel(/^Continue to checkout/).click();
await idle();
check('edit: checkout re-derives the new participant', await visibleText('Lina · Age 12'));
check('edit: guardian context persists for the new child', await visibleText('Booked by you'));
check('edit: plan unchanged', await visibleText('Booking price · AED 380 per month'));

// ——— Camp ———
await openCheckout('booking/holiday-swim-camp', [
  'Week of 17–21 Aug, 9 AM–12 PM',
  /^Continue: /,
  /^Adam, age 8$/,
  /^Continue: /,
]);
check('camp: week line', await visibleText('1 week · Week of 17–21 Aug'));
check('camp: per-week Booking price', await visibleText('Booking price · AED 850 per week'));
await shot('03-checkout-camp-390');

// ——— Package ———
await openCheckout('booking/adult-swim-technique', [/^You$/, /^Continue: /]);
check('package: contents line', await visibleText('Package of 6 sessions'));
check('package: Booking price', await visibleText('Booking price · AED 480'));
check('package: no expiry or redemption claims', !/expir|redeem|valid for/i.test(await bodyText()));
await shot('04-checkout-package-390');

// ——— Free booking ———
await openCheckout('booking/community-park-football', [
  'Sat 8 Aug, 6:30 AM',
  /^Continue: /,
  /^You$/,
  /^Continue: /,
]);
check('free: Booking price · Free', await visibleText('Booking price · Free'));
check('free: Confirm booking CTA', await visible(visibleLabel(/^Confirm booking/)));
check('free: no Continue to payment', !(await visibleText('Continue to payment')));
await assertHonestCopy('checkout free');
await visibleLabel(/^Confirm booking/).click();
await idle(500);
check('free: Confirm booking is inert', page.url().endsWith('/booking/community-park-football/checkout'));
await shot('05-checkout-free-390');

// ——— Free trial ———
await openCheckout('booking/ladies-strength', [
  'Free trial session, Free',
  'Today, 9:30 AM',
  /^Continue: /,
  /^You$/,
  /^Continue: /,
]);
check('free trial: Free price', await visibleText('Booking price · Free'));
check('free trial: Confirm booking CTA', await visible(visibleLabel(/^Confirm booking/)));
check('free trial: full-plan price never the booking price', !(await bodyText()).includes('Booking price · AED 450'));
await shot('06-checkout-free-trial-390');

// ——— Paid trial ———
await openCheckout('booking/junior-football-u10', [
  'Trial session, AED 35',
  'Tomorrow, 5:30 PM',
  /^Continue: /,
  /^Adam, age 8$/,
  /^Continue: /,
]);
check('paid trial: structured Booking price', await visibleText('Booking price · AED 35'));
check('paid trial: paid CTA', await visible(visibleLabel(/^Continue to payment/)));
await shot('07-checkout-paid-trial-390');

// ——— Offer: informational only ———
await openCheckout('booking/reformer-pilates', [/^You$/, /^Continue: /]);
check('offer: informational line', await visibleText('20% off first month'));
check('offer: catalogue price unchanged', await visibleText('Booking price · AED 650 per month'));
check('offer: no discount arithmetic', !(await bodyText()).includes('520'));
await shot('09-checkout-offer-390');

// ——— Recovery: cold link, unknown program, error ———
await page.goto(`${BASE}/booking/beginner-calisthenics/checkout`, { waitUntil: 'networkidle' });
await idle();
check('cold link: empty draft redirects to the flow start', await visibleText('Choose a session'));
await shot('15-checkout-cold-link-390');
await page.goto(`${BASE}/booking/does-not-exist/checkout`, { waitUntil: 'networkidle' });
await idle();
check('unknown: recovery state', await visibleText('This program is no longer offered.'));
await page.goto(`${BASE}/booking/beginner-calisthenics/checkout?qa-fail=1`, { waitUntil: 'networkidle' });
await idle();
check('error: state renders', await visibleText('Can’t load activities right now'));
await shot('14-checkout-error-390');
await visibleLabel('Retry').click();
await idle();
check('error: retry recovers via the empty-draft redirect', await visibleText('Choose a session'));

check('390: no horizontal overflow', await noOverflow(390));

// ——— 360 × 780 pass ———
await page.setViewportSize({ width: 360, height: 780 });

await page.goto(`${BASE}/booking/beginner-calisthenics`, { waitUntil: 'networkidle' });
await idle();
await visibleLabel('Today, 7:30 PM').click();
await idle(300);
await visibleLabel(/^Continue: /).click();
await idle();
await visibleLabel(/^You$/).click();
await idle(300);
await visibleLabel(/^Continue: /).click();
await idle();
await visibleLabel(/^Continue to checkout/).click();
await idle();
check('360 single: Booking price', await visibleText('Booking price · AED 85 per session'));
await assertHonestCopy('360 checkout single');
await shot('01-checkout-single-360');
await scrollToY(4000);
check('360: CTA sticky over scrolled content', await visibleText('Booking price · AED 85 per session'));
await shot('16-checkout-sticky-360');

await openCheckout('booking/mens-strength-basics', [/^You$/, /^Continue: /]);
check('360 monthly: renders', await visibleText('Booking price · AED 400 per month'));
await shot('02-checkout-monthly-360');

await openCheckout('booking/junior-swim-squad', [/^Adam, age 8$/, /^Continue: /]);
check('360 child: guardian context', await visibleText('Booked by you'));
await shot('08-checkout-child-360');

await openCheckout('booking/holiday-swim-camp', [
  'Week of 17–21 Aug, 9 AM–12 PM',
  /^Continue: /,
  /^Adam, age 8$/,
  /^Continue: /,
]);
check('360 camp: renders', await visibleText('Booking price · AED 850 per week'));
await shot('03-checkout-camp-360');

await openCheckout('booking/adult-swim-technique', [/^You$/, /^Continue: /]);
check('360 package: renders', await visibleText('Booking price · AED 480'));
await shot('04-checkout-package-360');

await openCheckout('booking/community-park-football', [
  'Sat 8 Aug, 6:30 AM',
  /^Continue: /,
  /^You$/,
  /^Continue: /,
]);
check('360 free: Confirm booking', await visible(visibleLabel(/^Confirm booking/)));
await shot('05-checkout-free-360');

await openCheckout('booking/ladies-strength', [
  'Free trial session, Free',
  'Today, 9:30 AM',
  /^Continue: /,
  /^You$/,
  /^Continue: /,
]);
check('360 free trial: renders', await visibleText('Booking price · Free'));
await shot('06-checkout-free-trial-360');

await openCheckout('booking/junior-football-u10', [
  'Trial session, AED 35',
  'Tomorrow, 5:30 PM',
  /^Continue: /,
  /^Adam, age 8$/,
  /^Continue: /,
]);
check('360 paid trial: renders', await visibleText('Booking price · AED 35'));
await shot('07-checkout-paid-trial-360');

await openCheckout('booking/reformer-pilates', [/^You$/, /^Continue: /]);
check('360 offer: renders', await visibleText('20% off first month'));
await shot('09-checkout-offer-360');

await page.goto(`${BASE}/booking/beginner-calisthenics/checkout`, { waitUntil: 'networkidle' });
await idle();
check('360 cold link: redirects to the flow start', await visibleText('Choose a session'));
await shot('15-checkout-cold-link-360');
await page.goto(`${BASE}/booking/beginner-calisthenics/checkout?qa-fail=1`, { waitUntil: 'networkidle' });
await idle();
check('360 error: renders', await visibleText('Can’t load activities right now'));
await shot('14-checkout-error-360');

check('360: no horizontal overflow', await noOverflow(360));

check('inert CTA contract opened no dialogs', dialogs.length === 0);
check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
