/**
 * Commits 16–17 QA — Checkout foundation, price review, and the
 * payment-method contract (docs/22 §14, §16; owner decisions docs/09 §22):
 * Continue-to-checkout activation with the double-tap guard, per-type
 * checkout price review with Booking price continuity (never Total, no
 * VAT/fees/discount arithmetic, Free never AED 0), policy display with no
 * acceptance claim, guardian context on child bookings, the generic
 * `Card payment` contract method (radiogroup/radio semantics with explicit
 * aria-checked, no card details of any kind), CTA readiness with the named
 * blocker (`Choose a payment method to continue`) resolving on selection,
 * free bookings with no payment section and an immediately-ready CTA,
 * the inert duplicate-press-protected CTA contract in both ready and
 * unready states (Commit 17 accessibility correction: unready exposes
 * aria-disabled="true" plus native disabled semantics so click, Enter,
 * Space, and native press can never advance; ready exposes enabled
 * semantics and accepts focus; ordinary interactions never reset the
 * method selection), clean checkout-local state on re-entry, summary
 * preservation beneath checkout, exact-origin back, edit-booking round
 * trip, cold-link/missing-draft/unknown recovery, and screenshot rows
 * 01–11 and 14–16 at 390 × 844 and 360 × 780.
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
  // docs/09 §22.6: the generic method never implies card details.
  check(`${context}: no card details of any kind`,
    !/ending in|last four|expir|cvv|cardholder|•{2,}|\*{2,}/i.test(body));
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

// ——— Commit 17: payment-method contract + CTA readiness ———
check('method: Payment method section header', await visibleText('Payment method'));
check('method: radiogroup present',
  (await page.locator('[role="radiogroup"]:visible').count()) > 0);
check('method: exactly one radio — the generic contract method',
  (await page.locator('[role="radio"]:visible').count()) === 1);
check('method: Card payment row unchecked initially',
  (await page.locator('[role="radio"][aria-checked="false"]:visible').count()) === 1);
// The CTA is never unready without a visible reason (docs/22 §9), and the
// unready state is exposed semantically on web: aria-disabled="true" plus
// the browser's native disabled semantics (RN-web couples them for button
// hosts) — activation is impossible and assistive tech reads the control
// as dimmed, with the named blocker in the adjacent polite live region.
check('readiness: blocker named before selection',
  await visibleText('Choose a payment method to continue'));
const blockedCta = page.locator('[role="button"][aria-disabled="true"]:visible');
check('readiness: unready CTA exposes aria-disabled="true"', (await blockedCta.count()) === 1);
check('readiness: unready CTA carries native disabled semantics',
  (await blockedCta.first().getAttribute('disabled')) !== null);
await assertHonestCopy('checkout single');
{
  // Reading order: recap → price → policy → payment → CTA (docs/22 §12).
  const lower = (await bodyText()).toLowerCase();
  const order = ['beginner calisthenics', 'price', 'cancellation policy', 'payment method', 'continue to payment']
    .map((marker) => lower.indexOf(marker));
  check('checkout: reading order recap → price → policy → payment → CTA',
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])));
}
await shot('01-checkout-single-390');
await shot('11-checkout-readiness-blocker-390');

// Unready CTA activation: focus attempt + Enter + Space + forced click —
// none may advance or invoke anything. The browser refuses focus on the
// natively-disabled button, making keyboard activation impossible by
// construction; the presses are dispatched anyway as proof.
await blockedCta.first().focus().catch(() => {});
check('readiness: keyboard activation impossible while unready (focus refused)',
  await page.evaluate(() => document.activeElement?.getAttribute('aria-disabled') !== 'true'));
await page.keyboard.press('Enter');
await page.keyboard.press('Space');
await idle(400);
check('readiness: Enter/Space while unready produce no route change',
  page.url().endsWith('/booking/beginner-calisthenics/checkout'));
// Forced click bypasses pointer-events suppression to prove the handler
// layer is also inert while unready.
await blockedCta.first().click({ force: true }).catch(() => {});
await idle(400);
check('readiness: click while unready produces no route change',
  page.url().endsWith('/booking/beginner-calisthenics/checkout'));

// Selecting the contract method resolves the blocker.
await visibleLabel('Card payment').click();
await idle(300);
check('method: Card payment checked after selection',
  (await page.locator('[role="radio"][aria-checked="true"]:visible').count()) === 1);
check('readiness: blocker resolves to the booking price after selection',
  !(await visibleText('Choose a payment method to continue')));
// Ready state exposes correct enabled semantics: no aria-disabled and no
// native disabled attribute (attribute absence is the ARIA enabled default),
// and the CTA is focusable again.
const readyCta = visibleLabel(/^Continue to payment/);
check('readiness: ready CTA has no aria-disabled', (await readyCta.getAttribute('aria-disabled')) === null);
check('readiness: ready CTA has no native disabled attribute',
  (await readyCta.getAttribute('disabled')) === null);
check('readiness: ready CTA is focusable (tabindex 0)',
  (await readyCta.getAttribute('tabindex')) === '0');
check('readiness: no aria-disabled="true" control remains',
  (await page.locator('[role="button"][aria-disabled="true"]:visible').count()) === 0);
await shot('10-checkout-method-selected-390');

// Ready CTA press remains the inert contract: no route change, no dialog —
// for click and keyboard alike.
await visibleLabel(/^Continue to payment/).click();
await idle(500);
check('checkout: Continue to payment produces no route change',
  page.url().endsWith('/booking/beginner-calisthenics/checkout'));
await readyCta.focus();
check('checkout: ready CTA accepts focus',
  await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Continue to payment') === true));
await page.keyboard.press('Enter');
await idle(400);
check('checkout: Enter on the ready CTA stays the inert contract',
  page.url().endsWith('/booking/beginner-calisthenics/checkout'));

// Ordinary interactions re-render the screen without resetting the
// checkout-local selection (docs/22 §5: reset only on genuine re-entry,
// draft replacement, or service re-derivation).
await visibleLabel('Full policy').click();
await idle(300);
await scrollToY(4000);
await scrollToY(0);
check('rerender: method selection preserved through ordinary interactions',
  (await page.locator('[role="radio"][aria-checked="true"]:visible').count()) === 1);
check('rerender: status still shows the booking price',
  !(await visibleText('Choose a payment method to continue')));

// Sticky CTA over scrolled content (status shows the booking price when ready).
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
// Re-entry starts clean (docs/22 §5): the earlier selection is discarded.
check('re-entry: method selection cleared',
  (await page.locator('[role="radio"][aria-checked="true"]:visible').count()) === 0);
check('re-entry: readiness blocker returns',
  await visibleText('Choose a payment method to continue'));
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
check('monthly: Card payment contract method present', await visible(visibleLabel('Card payment')));
await assertHonestCopy('checkout monthly');
await shot('02-checkout-monthly-390');

// ——— Child booking: guardian context + edit round trip ———
await openCheckout('booking/junior-swim-squad', [/^Adam, age 8$/, /^Continue: /]);
check('child: participant line', await visibleText('Adam · Age 8'));
check('child: guardian context displayed', await visibleText('Booked by you'));
check('child: recurring Booking price', await visibleText('Booking price · AED 380 per month'));
check('child: no consent checkbox', (await page.locator('[role="checkbox"]:visible').count()) === 0);
// Paid child booking follows the same method contract.
await visibleLabel('Card payment').click();
await idle(300);
check('child: method selectable, blocker resolved',
  !(await visibleText('Choose a payment method to continue')));
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
// The round trip re-derives with clean checkout-local state (docs/22 §5).
check('edit: method selection starts clean after the round trip',
  (await page.locator('[role="radio"][aria-checked="true"]:visible').count()) === 0);

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
// Free bookings have no payment-method section (docs/22 §4/§7.6) and no
// readiness blocker — the CTA is ready immediately.
check('free: no payment-method section', !(await visibleText('Payment method')));
check('free: no payment radios', (await page.locator('[role="radio"]:visible').count()) === 0);
check('free: CTA ready immediately — no blocker',
  !(await visibleText('Choose a payment method to continue')));
check('free: CTA exposes enabled semantics (no disabled attributes)',
  (await visibleLabel(/^Confirm booking/).getAttribute('aria-disabled')) === null &&
  (await visibleLabel(/^Confirm booking/).getAttribute('disabled')) === null);
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
check('free trial: no payment-method section', !(await visibleText('Payment method')));
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
check('paid trial: Card payment method present', await visible(visibleLabel('Card payment')));
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
check('360 method: Card payment row unchecked initially',
  (await page.locator('[role="radio"][aria-checked="false"]:visible').count()) === 1);
check('360 readiness: blocker named', await visibleText('Choose a payment method to continue'));
check('360 readiness: unready CTA aria-disabled',
  (await page.locator('[role="button"][aria-disabled="true"]:visible').count()) === 1);
await assertHonestCopy('360 checkout single');
await shot('01-checkout-single-360');
await shot('11-checkout-readiness-blocker-360');
await visibleLabel('Card payment').click();
await idle(300);
check('360 method: checked after selection',
  (await page.locator('[role="radio"][aria-checked="true"]:visible').count()) === 1);
check('360 readiness: blocker resolved',
  !(await visibleText('Choose a payment method to continue')));
check('360 readiness: ready CTA enabled semantics',
  (await visibleLabel(/^Continue to payment/).getAttribute('aria-disabled')) === null);
await shot('10-checkout-method-selected-360');
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
