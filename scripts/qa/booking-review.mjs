/**
 * Commits 12–13 QA — Booking foundation, session/plan selection, and
 * participant selection with eligibility (docs/21 §16, §18): entry
 * activation, per-type selection states, availability states, skip rule,
 * participant preselection and recovery, guest contract, draft behavior,
 * and provisional screenshot rows 01–11, 17–18, 20 at 390 × 844 and
 * 360 × 780. Run: node scripts/qa/booking-review.mjs (Expo web on 8081).
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

// Select a session → status updates → Continue reaches the participant step.
await visibleLabel('Today, 7:30 PM').click();
await idle(300);
check('select: status line reflects the draft', await visibleText('AED 85 per session · Today'));
await shot('01-booking-single-session-390');
await visibleLabel(/^Continue: /).click();
await idle();
check('continue: selection leads to the participant step', await visibleText('Who is attending?'));
check('participant: three-step progress after a dated selection', await visibleText('Step 2 of 3'));
check('participant: everyone context preselects nothing', await visibleText('Choose who is attending'));
check('participant: ineligible child visible with the age reason', await visibleText('Ages 16+ — Adam is 8'));
check('participant: not-suitable pill', await visibleText('Not suitable'));

// No reservation implication anywhere in the flow copy.
check('copy: no reservation/hold/charged-today implication', !/reserv|holding|charged today/i.test(await bodyText()));

// Explicit selection announces; Continue stays inert until Commit 14.
await visibleLabel(/^You$/).click();
await idle(300);
check('participant: explicit selection announces', await visibleText('Booking for you'));
await visibleLabel(/^Continue: /).click();
await idle(500);
check('participant: continue inert until the summary ships', page.url().endsWith('/participant'));

// Back preserves the selection draft, then lands on the exact origin.
await visibleLabel('Back').click();
await idle();
check('back: selection step preserves the draft', await visibleText('AED 85 per session · Today'));
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
await visibleLabel('Free trial session, Free').click();
await idle(300);
await visibleLabel('Today, 9:30 AM').click();
await idle(300);
await visibleLabel(/^Continue: /).click();
await idle();
check('trial: continue reaches the participant step', await visibleText('Who is attending?'));
check('trial: ladies-only never gender-blocks the adult', await visible(visibleLabel(/^You$/)));

// ——— Paid trial priced from structured extras ———
await page.goto(`${BASE}/booking/junior-football-u10`, { waitUntil: 'networkidle' });
await idle();
check('paid trial: AED 35 option', await visible(visibleLabel('Trial session, AED 35')));
await shot('06-booking-trial-paid-390');

// ——— Skip rule: dateless single options land directly on participant ———
await page.goto(`${BASE}/booking/junior-swim-squad`, { waitUntil: 'networkidle' });
await idle();
check('skip: recurring flow lands on the participant step', await visibleText('Who is attending?'));
check('skip: two-step progress', await visibleText('Step 1 of 2'));
check('skip: plan recap on the program card', await visibleText('Monthly enrolment'));
check('skip: eligible children listed with ages', (await visibleText('Age 8')) && (await visibleText('Age 12')));
check('skip: adult honestly ineligible', await visibleText('Designed for ages 6–14'));
check('skip: no preselection under everyone', await visibleText('Choose who is attending'));

// Participant change (row 11): explicit switches announce politely.
await visibleLabel(/^Adam, age 8$/).click();
await idle(300);
check('change: booking for Adam', await visibleText('Booking for Adam'));
await visibleLabel(/^Lina, age 12$/).click();
await idle(300);
check('change: booking for Lina', await visibleText('Booking for Lina'));
await shot('11-booking-participant-changed-390');

await page.goto(`${BASE}/booking/adult-swim-technique`, { waitUntil: 'networkidle' });
await idle();
check('skip: package flow lands on the participant step', await visibleText('Who is attending?'));
check('skip: package recap shows size', await visibleText('Package of 6 sessions'));
check('package: no redemption/expiry rules invented', !/expir|redeem|valid for/i.test(await bodyText()));

// Exact-origin back after a skipped selection: details, never an empty step.
await page.goto(`${BASE}/program/junior-swim-squad`, { waitUntil: 'networkidle' });
await idle();
await visibleLabel(/^Book: Junior Swim Squad/).click();
await idle();
check('skip: Book lands on participant directly', await visibleText('Who is attending?'));
await visibleLabel('Back').click();
await idle();
check('skip: one back returns to Program Details', await visible(visibleLabel(/^Book: Junior Swim Squad/)));

// ——— Preselection + no silent context mutation (browsing as Adam) ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle();
await page.getByText('Adam', { exact: true }).locator('visible=true').first().click();
await idle(400);
await visibleLabel('Search activities, providers or classes').click();
await idle();
await page.keyboard.type('swim');
await page.keyboard.press('Enter');
await idle();
await page.getByText('Junior Swim Squad').locator('visible=true').first().click();
await idle();
check('context: details shows suitability for Adam', await visibleText(/Suitable for Adam/));
await visibleLabel(/^Book: Junior Swim Squad/).click();
await idle();
check('preselect: eligible browsing participant preselected', await visibleText('Booking for Adam'));
await shot('08-booking-participant-preselected-390');
await visibleLabel(/^Lina, age 12$/).click();
await idle(300);
check('preselect: switching in the flow announces Lina', await visibleText('Booking for Lina'));
await visibleLabel('Back').click();
await idle();
check('no-mutation: details still browses as Adam', await visibleText(/Suitable for Adam/));

// Ineligible browsing participant (still Adam): adult-only programs are
// hard-excluded from child-context results by design, so the realistic
// route is the storefront's honest ineligible group.
await visibleLabel(/^Blue Wave Swimming/).click();
await idle();
await page.getByText(/^Not for Adam’s age/).locator('visible=true').first().click();
await idle(300);
await page.getByText('Adult Swim Technique Clinic').locator('visible=true').first().click();
await idle();
check('ineligible: details warns before booking', await visibleText(/Not suitable for Adam/));
await visibleLabel(/^Book: Adult Swim Technique Clinic/).click();
await idle();
check('ineligible: package flow opens straight to participant', await visibleText('Who is attending?'));
check('ineligible: browsing participant not preselected', await visibleText('Choose who is attending'));
check('ineligible: Adam visible with the age reason', await visibleText('Ages 16+ — Adam is 8'));
check('ineligible: eligible alternative offered', await visible(visibleLabel(/^You$/)));
await shot('09-booking-participant-ineligible-390');

// ——— No eligible participants (me-only account, junior program) ———
await page.goto(`${BASE}/booking/junior-karate?qa-scenario=me-only`, { waitUntil: 'networkidle' });
await idle();
check('none: recovery headline', await visibleText('None of your profiles can join this program.'));
check('none: canonical age eligibility', await visibleText(/is for ages 6–12/));
check('none: back to program action', await visible(visibleLabel('Back to program')));
check('none: browse action', await visible(visibleLabel('Browse activities')));
check('none: no add-child or profile-editing action', !/add (a )?child|edit participant/i.test(await bodyText()));
await shot('10-booking-participant-none-390');

// ——— Guest: sign-in-required contract state ———
await page.goto(`${BASE}/booking/junior-swim-squad?qa-scenario=guest`, { waitUntil: 'networkidle' });
await idle();
check('guest: sign-in heading', await visibleText('Sign in to book'));
check('guest: program context preserved', await visibleText('Junior Swim Squad'));
check('guest: no participant radios and no fabricated Me', !/Who is attending|Booking for/.test(await bodyText()));
await visibleLabel(/^Sign in$/).click();
await idle(400);
check('guest: sign-in action is inert', page.url().includes('/booking/junior-swim-squad'));
await shot('20-booking-guest-390');

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

// ——— Cold links with an empty draft land on the flow start ———
await page.goto(`${BASE}/booking/beginner-calisthenics/participant`, { waitUntil: 'networkidle' });
await idle();
check('cold link: dated participant link redirects to selection', await visibleText('Choose a session'));
await page.goto(`${BASE}/booking/beginner-calisthenics/summary`, { waitUntil: 'networkidle' });
await idle();
check('cold link: summary stub redirects to the flow start', await visibleText('Choose a session'));
await visibleLabel('Back').click();
await idle();
check('cold link: back lands on Program Details', await visible(visibleLabel(/^Book: Beginner Calisthenics/)));
await page.goto(`${BASE}/booking/junior-swim-squad/participant`, { waitUntil: 'networkidle' });
await idle();
check('cold link: skip-flow participant link renders directly', await visibleText('Who is attending?'));

// ——— Error and retry (both steps) ———
await page.goto(`${BASE}/booking/beginner-calisthenics?qa-fail=1`, { waitUntil: 'networkidle' });
await idle();
check('error: selection state renders', await visibleText('Can’t load activities right now'));
await shot('17-booking-error-390');
await visibleLabel('Retry').click();
await idle();
check('error: retry recovers to the selection step', await visibleText('Choose a session'));
await page.goto(`${BASE}/booking/junior-swim-squad/participant?qa-fail=1`, { waitUntil: 'networkidle' });
await idle();
check('error: participant state renders', await visibleText('Can’t load activities right now'));
await visibleLabel('Retry').click();
await idle();
check('error: participant retry recovers', await visibleText('Who is attending?'));

check('390: no horizontal overflow', await noOverflow(390));

// ——— 360 × 780 pass: provisional rows + participant states + overflow ———
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
  ['booking/junior-karate?qa-scenario=me-only', '10-booking-participant-none-360', 'None of your profiles can join this program.'],
  ['booking/junior-swim-squad?qa-scenario=guest', '20-booking-guest-360', 'Sign in to book'],
  ['booking/does-not-exist', '18-booking-unknown-360', 'This program is no longer offered.'],
];
for (const [path, name, marker] of smallShots) {
  await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle' });
  await idle();
  check(`360 ${name}: renders`, await visibleText(marker));
  await shot(name);
}

// Participant change at 360 (row 11).
await page.goto(`${BASE}/booking/junior-swim-squad`, { waitUntil: 'networkidle' });
await idle();
await visibleLabel(/^Lina, age 12$/).click();
await idle(300);
check('360 participant change: booking for Lina', await visibleText('Booking for Lina'));
await shot('11-booking-participant-changed-360');

// Preselected + ineligible journeys at 360 (rows 08–09; in-app, no reloads).
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle();
await page.getByText('Adam', { exact: true }).locator('visible=true').first().click();
await idle(400);
await visibleLabel('Search activities, providers or classes').click();
await idle();
await page.keyboard.type('swim');
await page.keyboard.press('Enter');
await idle();
await page.getByText('Junior Swim Squad').locator('visible=true').first().click();
await idle();
await visibleLabel(/^Book: Junior Swim Squad/).click();
await idle();
check('360 preselect: booking for Adam', await visibleText('Booking for Adam'));
await shot('08-booking-participant-preselected-360');
await visibleLabel('Back').click();
await idle();
await visibleLabel(/^Blue Wave Swimming/).click();
await idle();
await page.getByText(/^Not for Adam’s age/).locator('visible=true').first().click();
await idle(300);
await page.getByText('Adult Swim Technique Clinic').locator('visible=true').first().click();
await idle();
await visibleLabel(/^Book: Adult Swim Technique Clinic/).click();
await idle();
check('360 ineligible: reason visible, nothing selected',
  (await visibleText('Ages 16+ — Adam is 8')) && (await visibleText('Choose who is attending')));
await shot('09-booking-participant-ineligible-360');

check('360: no horizontal overflow', await noOverflow(360));

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
