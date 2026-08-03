/**
 * feat(home) QA — the personalized activity hub (docs/18, docs/19 §8.8).
 * Walks the four account scenarios via the ?qa-scenario fixture selector,
 * asserts the docs/18 §4 hierarchy, the removals (no chips, no quick
 * filters, no categories grid, no providers rail, no hero on signed-in
 * Home), the child-visibility rules on Home AND the default Discover feed,
 * and captures the new Home screenshot baseline.
 * Run: node scripts/qa/home-review.mjs (Expo web on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/home-review';
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
// Expo web's Fast Refresh ⚡ bubble (.__expo_fast_refresh) pops in and out of
// the DOM during dev-server activity and can photobomb captures. Dev-only —
// never app UI — so a persistent CSS kill rule keeps every shot clean.
const shot = async (name) => {
  await page
    .addStyleTag({ content: '.__expo_fast_refresh { display: none !important; }' })
    .catch(() => {});
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
const idle = (ms = 700) => page.waitForTimeout(ms);
const visible = (locator) => locator.isVisible().catch(() => false);
const heading = (name) => page.getByRole('heading', { name, exact: true });
// Aligns the heading to the top of the scroller (scrollIntoViewIfNeeded is a
// no-op when the heading is already anywhere in the viewport, which framed
// section shots identically to the top shot).
const scrollToHeading = async (name) => {
  await heading(name).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await idle(300);
};
const scrollTo = async (y) =>
  page.evaluate((offset) => {
    const els = [...document.querySelectorAll('div')].filter(
      (d) => d.scrollHeight > d.clientHeight + 100,
    );
    const sc = els[els.length - 1];
    if (sc) sc.scrollTop = offset;
  }, y);
const noHorizontalOverflow = () =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** True when every visible element containing the text renders unclipped (no ellipsis/clamp). */
const textUnclipped = async (text) => {
  const els = await page.getByText(text).locator('visible=true').all();
  if (els.length === 0) return false;
  for (const el of els) {
    const ok = await el.evaluate(
      (node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
    );
    if (!ok) return false;
  }
  return true;
};
/** Gap in px between the lowest content element and the dock's top edge at full scroll. */
const bottomGapAboveDock = () =>
  page.evaluate(() => {
    const tablist = document.querySelector('[role="tablist"]');
    if (!tablist) return null;
    const dockTop = tablist.getBoundingClientRect().top;
    const scrollers = [...document.querySelectorAll('div')].filter(
      (d) => d.scrollHeight > d.clientHeight + 100,
    );
    const sc = scrollers[scrollers.length - 1];
    if (!sc) return null;
    const kids = [...sc.firstElementChild.children].filter(
      (k) => k.getBoundingClientRect().height > 0,
    );
    const last = kids[kids.length - 1];
    return last ? dockTop - last.getBoundingClientRect().bottom : null;
  });

// ═══ Scenario D — default demo household (Sarah, Adam 8, Lina 12) ═══
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await idle(1400);

check('household: wordmark header', await visible(page.getByText('Himma', { exact: true }).first()));
check('household: search entry', await visible(page.getByRole('button', { name: 'Search activities, providers or classes' })));

// Removals — docs/18 §4: nothing of the old marketplace shell remains.
check('household: NO participant chips', !(await visible(page.getByRole('button', { name: 'Everyone', exact: true }))));
check('household: NO quick filter chips', !(await visible(page.getByRole('button', { name: 'Ladies only', exact: true }))));
check('household: NO categories grid', !(await visible(heading('Popular categories'))));
check('household: NO providers rail', !(await visible(heading('Popular providers near you'))));
check('household: NO seasonal hero', !(await visible(page.getByText('Indoor this August'))));

// Hierarchy — docs/18 §4.
check('household: upcoming activity leads', await visible(heading('Upcoming activity')));
check('household: upcoming card content', await visible(page.getByLabel(/Upcoming activity: Junior Swim Squad for Adam, Today at 10:00 AM/)));
check('household: your week strip', await visible(heading('Your week')));
check('household: week has today swim row', await visible(page.getByLabel('Today, 10:00 AM: Junior Swim Squad for Adam')));
check('household: week has pilates row', await visible(page.getByLabel('Mon 3, 6:30 PM: Reformer Pilates Foundations for you')));
check('household: week pilates title not truncated', await textUnclipped('Reformer Pilates Foundations'));
check('household: no horizontal overflow 390', await noHorizontalOverflow());
await shot('01-home-household-top-390');

await scrollToHeading('Continue your routine');
check('household: routine progress', await visible(page.getByLabel(/6 of 10 sessions left. Next session Mon, 6:30 PM/)));
check('household: interests rail', await visible(heading('Based on your interests')));
await shot('02-home-household-routine-390');

await scrollToHeading('For Adam');
check('household: For Adam rail', await visible(heading('For Adam')));
check('household: age badge on child rail', await visible(page.getByLabel(/Ages 6 to 14/).first()));
await shot('03-home-household-adam-390');

await scrollToHeading('For Lina');
check('household: Camps for Adam rail', await visible(heading('Camps for Adam')));
check('household: For Lina rail', await visible(heading('For Lina')));
await scrollToHeading('Camps for Lina');
check('household: Camps for Lina rail', await visible(heading('Camps for Lina')));

await scrollToHeading('Available today for you');
check('household: available today personalized', await visible(heading('Available today for you')));
check('household: NO generic popular-near with bookings', !(await visible(heading('Popular near Khalifa City'))));
await scrollTo(99999);
await idle(400);
check('household: offers for you', await visible(heading('Offers for you')));
check('household: credit strip', await visible(page.getByLabel(/Marketplace credit. AED 65 available/)));
check('household: NO add-child prompt', !(await visible(page.getByText(/Add a child/i))));
await shot('04-home-household-bottom-390');

// ═══ Scenario B — signed-in, me-only, no bookings ═══
await page.goto(`${BASE}/?qa-scenario=me-only`, { waitUntil: 'networkidle' });
await idle(1400);
check('me-only: interests rail', await visible(heading('Based on your interests')));
check('me-only: popular near (no bookings)', await visible(heading('Popular near Khalifa City')));
check('me-only: NO upcoming', !(await visible(heading('Upcoming activity'))));
check('me-only: NO week', !(await visible(heading('Your week'))));
check('me-only: NO routine', !(await visible(heading('Continue your routine'))));
check('me-only: NO child rails', !(await visible(page.getByRole('heading', { name: /^For [A-Z]/ }))));
check('me-only: NO camps sections', !(await visible(page.getByRole('heading', { name: /Camps/ }))));
check('me-only: NO after-school sections', !(await visible(page.getByRole('heading', { name: /After school/ }))));
check('me-only: NO add-child card', !(await visible(page.getByText(/Add a child/i))));
await shot('05-home-me-only-390');
await scrollTo(99999);
await idle(400);
check('me-only: credit present', await visible(page.getByLabel(/Marketplace credit. AED 65 available/)));
check('me-only: offers for you', await visible(heading('Offers for you')));
await shot('06-home-me-only-bottom-390');

// ═══ Scenario C — signed-in, me-only, active bookings ═══
await page.goto(`${BASE}/?qa-scenario=me-active`, { waitUntil: 'networkidle' });
await idle(1400);
check('me-active: upcoming pilates', await visible(page.getByLabel(/Upcoming activity: Reformer Pilates Foundations for you, Mon 3 at 6:30 PM/)));
check('me-active: week present', await visible(heading('Your week')));
check('me-active: routine present', await visible(heading('Continue your routine')));
check('me-active: NO popular near (has bookings)', !(await visible(heading('Popular near Khalifa City'))));
check('me-active: NO child rails', !(await visible(page.getByRole('heading', { name: /^For [A-Z]/ }))));
check('me-active: NO camps sections', !(await visible(page.getByRole('heading', { name: /Camps/ }))));
check('me-active: NO add-child card', !(await visible(page.getByText(/Add a child/i))));
await shot('07-home-me-active-390');

// ═══ Scenario A — guest ═══
await page.goto(`${BASE}/?qa-scenario=guest`, { waitUntil: 'networkidle' });
await idle(1400);
check('guest: welcome card leads', await visible(page.getByText('Indoor this August')));
check('guest: popular near', await visible(heading('Popular near Khalifa City')));
check('guest: NO upcoming/week/routine', !(await visible(heading('Upcoming activity'))) && !(await visible(heading('Your week'))) && !(await visible(heading('Continue your routine'))));
await shot('08-home-guest-390');
await scrollTo(99999);
await idle(400);
check('guest: available today (generic title)', await visible(heading('Available today')));
check('guest: offers (generic title)', await visible(heading('Offers')));
check('guest: setup invitation', await visible(page.getByLabel(/Make Himma yours/)));
check('guest: NO credit strip', !(await visible(page.getByText(/credit available/))));
await shot('09-home-guest-bottom-390');

// ═══ Discover gate — docs/18 §6 on the default Discover feed ═══
await page.goto(`${BASE}/discover?qa-scenario=me-only`, { waitUntil: 'networkidle' });
await idle(1400);
check('discover me-only: chips are Everyone + Me only', (await visible(page.getByRole('button', { name: 'Me', exact: true }))) && !(await visible(page.getByRole('button', { name: 'Adam', exact: true }))));
await scrollToHeading('Collections');
check('discover me-only: camps collection hidden', !(await visible(page.getByLabel(/Camps & holidays collection/))));
check('discover me-only: after-school collection hidden', !(await visible(page.getByLabel(/After school collection/))));
check('discover me-only: ladies-only collection present', await visible(page.getByLabel(/Ladies only collection/)));
await shot('10-discover-me-only-collections-390');

await page.goto(`${BASE}/discover?qa-scenario=household`, { waitUntil: 'networkidle' });
await idle(1400);
await scrollToHeading('Collections');
check('discover household: camps collection present', await visible(page.getByLabel(/Camps & holidays collection/)));
check('discover household: after-school collection present', await visible(page.getByLabel(/After school collection/)));

await page.goto(`${BASE}/discover?qa-scenario=guest`, { waitUntil: 'networkidle' });
await idle(1400);
check('discover guest: no participant chips', !(await visible(page.getByRole('button', { name: 'Everyone', exact: true }))));
await scrollToHeading('Collections');
check('discover guest: broad rail unfiltered (docs/18 §18 assumption)', await visible(page.getByLabel(/Camps & holidays collection/)));

// ═══ 360 width ═══
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await idle(1400);
check('household 360: upcoming renders', await visible(heading('Upcoming activity')));
check('household 360: no horizontal overflow', await noHorizontalOverflow());
check('household 360: week pilates title not truncated', await textUnclipped('Reformer Pilates Foundations'));
await shot('11-home-household-top-360');

// ═══ Full scenario matrix — top/mid/bottom shots + dock clearance at both sizes ═══
for (const [width, height] of [[390, 844], [360, 780]]) {
  await page.setViewportSize({ width, height });
  for (const scenario of ['guest', 'me-only', 'me-active', 'household']) {
    await page.goto(`${BASE}/?qa-scenario=${scenario}`, { waitUntil: 'networkidle' });
    await idle(1400);
    await shot(`matrix-${scenario}-top-${width}`);
    await scrollTo(99999);
    await idle(500);
    const halfway = await page.evaluate(() => {
      const scrollers = [...document.querySelectorAll('div')].filter(
        (d) => d.scrollHeight > d.clientHeight + 100,
      );
      const sc = scrollers[scrollers.length - 1];
      return sc ? Math.floor((sc.scrollHeight - sc.clientHeight) / 2) : 0;
    });
    const gap = await bottomGapAboveDock();
    check(`matrix ${scenario} ${width}: final card clears dock (gap ${gap?.toFixed(0)}px ≥ 32)`, gap !== null && gap >= 32);
    check(`matrix ${scenario} ${width}: no horizontal overflow`, await noHorizontalOverflow());
    await shot(`matrix-${scenario}-bottom-${width}`);
    await scrollTo(halfway);
    await idle(400);
    await shot(`matrix-${scenario}-mid-${width}`);
  }
}

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log('console errors:', consoleErrors.slice(0, 5));

await browser.close();
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);
