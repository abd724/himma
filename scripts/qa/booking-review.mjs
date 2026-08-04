/**
 * Commit 12 QA — Booking foundation + session/plan selection (docs/21 §16,
 * §18): entry activation, per-type selection states, availability states,
 * draft validity, inert Continue, stubs, recovery, and the provisional
 * screenshot rows 01–07 + 18 at 390 × 844 and 360 × 780.
 * Run: node scripts/qa/booking-review.mjs (Expo web on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/booking-review';
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

// ——— Entry: Program Details Book CTA opens the flow; exact-origin back ———
await page.goto(`${BASE}/program/beginner-calisthenics`, { waitUntil: 'networkidle' });
await idle();
const bookCta = visibleLabel(/^Book: Beginner Calisthenics/);
check('details: Book CTA present', await visible(bookCta));
await bookCta.click();
await idle();
check('entry: selection step heading', await visibleText('Choose a session'));
check('entry: step progress line', await visibleText('Step 1 of 3'));
check('entry: url is /booking/[programId]', page.url().endsWith('/booking/beginner-calisthenics'));
check('entry: price orientation on program card', await visibleText('AED 85 per session'));
check('entry: session radio present', await visible(visibleLabel('Today, 7:30 PM')));
check('entry: continue gated until a session is chosen', await visibleText('Choose a session to continue'));

// Select a session → status updates, Continue becomes valid but stays inert.
await visibleLabel('Today, 7:30 PM').click();
await idle(300);
check('select: status line reflects the draft', await visibleText('AED 85 per session · Today'));
await shot('01-booking-single-session-390');
await visibleLabel(/^Continue: /).click();
await idle(500);
check('continue: inert this commit — still on the selection step', page.url().endsWith('/booking/beginner-calisthenics'));
check('continue: no fake next step rendered', await visibleText('Choose a session'));

// No reservation implication anywhere in the flow copy.
const selectionCopy = await bodyText();
check('copy: no reservation/hold/charged-today implication', !/reserv|holding|charged today/i.test(selectionCopy));

// Exact-origin back to Program Details.
await visibleLabel('Back').click();
await idle();
check('back: returns to Program Details', await visible(visibleLabel(/^Book: Beginner Calisthenics/)));

// ——— Double-tap guard: one action, one booking route ———
await visibleLabel(/^Book: Beginner Calisthenics/).dblclick();
await idle();
check('double-tap: flow opened once', await visibleText('Choose a session'));
await visibleLabel('Back').click();
await idle();
check('double-tap: one back lands on Program Details', await visible(visibleLabel(/^Book: Beginner Calisthenics/)));

// ——— Trial options (free trial) ———
await page.goto(`${BASE}/booking/ladies-strength`, { waitUntil: 'networkidle' });
await idle();
check('trial: option-choice heading', await visibleText('How would you like to start?'));
check('trial: trial option first', await visible(visibleLabel('Free trial session, Free')));
check('trial: full enrolment option', await visible(visibleLabel('Monthly enrolment, AED 450 per month')));
await visibleLabel('Free trial session, Free').click();
await idle(300);
check('trial: choosing the trial reveals its session list', await visibleText('9:30 AM'));
await shot('06-booking-trial-free-390');
await visibleLabel('Monthly enrolment, AED 450 per month').click();
await idle(300);
check('trial: switching to enrolment shows plan lines', await visibleText('Sun & Wed · 9:30 AM'));
check('trial: enrolment start line present', await visibleText(/Starts with the next session/));
check('trial: option switch cleared the stale session', await visibleText('AED 450 per month'));

// ——— Paid trial priced from structured extras ———
await page.goto(`${BASE}/booking/junior-football-u10`, { waitUntil: 'networkidle' });
await idle();
check('paid trial: AED 35 option', await visible(visibleLabel('Trial session, AED 35')));
await shot('06-booking-trial-paid-390');

// ——— Dateless single option (recurring) — temporary pre-skip rendering ———
await page.goto(`${BASE}/booking/junior-swim-squad`, { waitUntil: 'networkidle' });
await idle();
check('recurring: plan heading', await visibleText('Your plan'));
check('recurring: cadence price', await visibleText('AED 380 per month'));
check('recurring: schedule orientation', await visibleText('Sat & Sun · 10:00 AM'));
check('recurring: start line', await visibleText(/Starts with the next session/));

// ——— Package: size + price only ———
await page.goto(`${BASE}/booking/adult-swim-technique`, { waitUntil: 'networkidle' });
await idle();
check('package: title shows size', await visibleText('Package of 6 sessions'));
check('package: no redemption/expiry rules invented', !/expir|redeem|valid for/i.test(await bodyText()));

// ——— Few places left ———
await page.goto(`${BASE}/booking/padel-beginners`, { waitUntil: 'networkidle' });
await idle();
check('few left: honest spots count', await visibleText('2 places left'));
await shot('02-booking-few-left-390');

// ——— Full session: visible, disabled, explained ———
await page.goto(`${BASE}/booking/morning-yoga`, { waitUntil: 'networkidle' });
await idle();
check('full: Full pill visible', await visibleText('Full'));
await page.getByLabel(/full\. This session is full\.$/).locator('visible=true').first().click({ force: true });
await idle(300);
check('full: tapping a full session selects nothing', await visibleText('Choose a session to continue'));
await visibleLabel('Tomorrow, 6:45 AM').click();
await idle(300);
check('full: an open session still selects', await visibleText('AED 65 per session · Tomorrow'));
await shot('03-booking-full-session-390');

// Details shows the same full occurrence (shared derivation, docs/09 §21.5).
await page.goto(`${BASE}/program/morning-yoga`, { waitUntil: 'networkidle' });
await idle();
check('details: same session reads Full', await visibleText('Full'));

// ——— No upcoming sessions (both surfaces) ———
await page.goto(`${BASE}/booking/sunrise-breathwork`, { waitUntil: 'networkidle' });
await idle();
check('no sessions: booking state', await visibleText('No upcoming sessions listed'));
check('no sessions: recovery action', await visible(visibleLabel('Browse activities')));
await shot('04-booking-no-sessions-390');
await page.goto(`${BASE}/program/sunrise-breathwork`, { waitUntil: 'networkidle' });
await idle();
check('no sessions: details agrees', await visibleText(/No upcoming sessions listed/));

// ——— Registration closed ———
await page.goto(`${BASE}/booking/teen-arabic-summer`, { waitUntil: 'networkidle' });
await idle();
check('closed: entry state', await visibleText('Registration has closed'));
check('closed: customer reason', await visibleText(/Registration for this camp has closed/));
await shot('05-booking-registration-closed-390');

// ——— Camp weeks ———
await page.goto(`${BASE}/booking/active-summer-camp`, { waitUntil: 'networkidle' });
await idle();
check('camp: week heading', await visibleText('Choose a week'));
check('camp: all three override weeks',
  (await visibleText('Week of 10–14 Aug')) &&
  (await visibleText('Week of 17–21 Aug')) &&
  (await visibleText('Week of 24–28 Aug')));
await visibleLabel(/^Week of 10–14 Aug/).click();
await idle(300);
check('camp: week selection updates the draft status', await visibleText('AED 990 per week · Week of 10–14 Aug'));
await shot('07-booking-camp-weeks-390');
await page.goto(`${BASE}/booking/holiday-swim-camp`, { waitUntil: 'networkidle' });
await idle();
check('camp: single derived week', await visibleText('Week of 17–21 Aug'));

// ——— Unknown program recovery ———
await page.goto(`${BASE}/booking/does-not-exist`, { waitUntil: 'networkidle' });
await idle();
check('unknown: recovery state', await visibleText('This program is no longer offered.'));
await shot('18-booking-unknown-390');

// ——— Step stubs redirect to the flow start (no dead routes) ———
await page.goto(`${BASE}/booking/beginner-calisthenics/participant`, { waitUntil: 'networkidle' });
await idle();
check('stub: participant deep link lands on the flow start', await visibleText('Choose a session'));
await page.goto(`${BASE}/booking/beginner-calisthenics/summary`, { waitUntil: 'networkidle' });
await idle();
check('stub: summary deep link lands on the flow start', await visibleText('Choose a session'));

// ——— Cold deep link: back falls back to Program Details ———
await visibleLabel('Back').click();
await idle();
check('cold link: back lands on Program Details', await visible(visibleLabel(/^Book: Beginner Calisthenics/)));

// ——— Error and retry ———
await page.goto(`${BASE}/booking/beginner-calisthenics?qa-fail=1`, { waitUntil: 'networkidle' });
await idle();
check('error: state renders', await visibleText('Can’t load activities right now'));
await shot('17-booking-error-390');
await visibleLabel('Retry').click();
await idle();
check('error: retry recovers to the selection step', await visibleText('Choose a session'));

check('390: no horizontal overflow', await noOverflow(390));

// ——— 360 × 780 pass: provisional screenshot rows + overflow ———
await page.setViewportSize({ width: 360, height: 780 });
const smallShots = [
  ['booking/beginner-calisthenics', '01-booking-single-session-360', 'Choose a session'],
  ['booking/padel-beginners', '02-booking-few-left-360', '2 places left'],
  ['booking/morning-yoga', '03-booking-full-session-360', 'Full'],
  ['booking/sunrise-breathwork', '04-booking-no-sessions-360', 'No upcoming sessions listed'],
  ['booking/teen-arabic-summer', '05-booking-registration-closed-360', 'Registration has closed'],
  ['booking/ladies-strength', '06-booking-trial-free-360', 'How would you like to start?'],
  ['booking/junior-football-u10', '06-booking-trial-paid-360', 'Trial session'],
  ['booking/active-summer-camp', '07-booking-camp-weeks-360', 'Choose a week'],
  ['booking/does-not-exist', '18-booking-unknown-360', 'This program is no longer offered.'],
];
for (const [path, name, marker] of smallShots) {
  await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle' });
  await idle();
  check(`360 ${name}: renders`, await visibleText(marker));
  await shot(name);
}
check('360: no horizontal overflow', await noOverflow(360));

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
