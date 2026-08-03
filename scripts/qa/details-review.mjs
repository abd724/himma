/**
 * Commit 9 QA — Program Details (HMA-015): states, activation, navigation.
 * Run: node scripts/qa/details-review.mjs (Expo web on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/details-review';
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
const idle = (ms = 800) => page.waitForTimeout(ms);
const visible = (locator) => locator.isVisible().catch(() => false);
const visibleText = (text) => visible(page.getByText(text).locator('visible=true').first());
/** Screens beneath a root push stay mounted; always target the visible match. */
const visibleLabel = (label) => page.getByLabel(label).locator('visible=true').first();
const noOverflow = (width) =>
  page.evaluate((w) => document.documentElement.scrollWidth <= w, width);

// ——— Adult default page from Home (activation + exact-origin back) ———
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Beginner Calisthenics by/).locator('visible=true').first().click();
await idle(1000);
check('home program card opens details', page.url().includes('/program/beginner-calisthenics'));
check('title shown', await visibleText('Beginner Calisthenics'));
check('provider row shown', await visible(page.getByLabel('Gravity Movement Studio, verified provider')));
check('review summary shown', await visibleText('(124 reviews)'));
check('age fact shown', await visibleText('Ages 16+'));
check('price block shown', await visibleText('per session'));
check('sessions lead with Today', await visibleText('Today'));
check('sticky Book CTA present', await visible(page.getByLabel(/^Book: Beginner Calisthenics/)));
check('no dock on detail route', !(await visible(page.getByRole('tab', { name: 'Home' }))));
await shot('01-program-adult-top-390');
await page.mouse.wheel(0, 1400);
await idle(400);
await shot('01-program-adult-mid-390');
check('policy preset shown', await visibleText('Free cancellation up to 24 hours before the session.'));
await page.mouse.wheel(0, 2400);
await idle(400);
await shot('01-program-adult-bottom-390');
check('more-from-provider listed', await visibleText('More from Gravity Movement Studio'));
check('support contract shown', await visibleText('Something wrong with this listing?'));
await shot('07-program-sticky-cta-390');

// ——— Save persists across navigation (session favourites) ———
await visibleLabel('Save Beginner Calisthenics to favourites').click();
await idle(300);
check('save toggles to checked', await visible(visibleLabel('Remove Beginner Calisthenics from favourites')));
await visibleLabel('Back').click();
await idle(900);
check('back returns to Home (exact origin)', !page.url().includes('/program/'));
await page.getByLabel(/^Beginner Calisthenics by/).locator('visible=true').first().click();
await idle(1000);
check('save state persisted on return', await visible(visibleLabel('Remove Beginner Calisthenics from favourites')));
await visibleLabel('Remove Beginner Calisthenics from favourites').click();
await idle(200);
await visibleLabel('Back').click();
await idle(800);

// ——— Child-eligible and child-ineligible via Discover (context preserved) ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByRole('button', { name: 'Adam' }).click();
await idle(1000);
await page.getByLabel(/^Junior Swim Squad by/).locator('visible=true').first().click();
await idle(1000);
check('discover card opens details under child context', page.url().includes('/program/junior-swim-squad'));
check('child-eligible line shown', await visibleText(/Suitable for Adam/));
check('branch shown for multi-branch provider', await visibleText(/Al Raha · Al Raha Beach/));
await shot('02-program-child-eligible-390');
await page.mouse.wheel(0, 3600);
await idle(400);
await page.getByLabel(/^Ladies Aqua Fitness by/).locator('visible=true').first().click();
await idle(1000);
check('cross-link to sibling program', page.url().includes('/program/ladies-aqua'));
check('child-ineligible banner shown', await visibleText(/Not suitable for Adam/));
check('banner names the age reason', await visibleText(/Ages 16\+ — Adam is 8/));
check('recovery names eligible participants', await visibleText('Suitable for:'));
await shot('03-program-child-ineligible-390');
check('no silent switch: Adam still selected until chip tap', await visibleText(/Not suitable for Adam/));
await page.getByRole('button', { name: 'Me', exact: true }).click();
await idle(1000);
check('explicit recovery switches to Me', await visibleText(/Suitable for you/));

// ——— Ladies-only + offer program ———
await page.goto(`${BASE}/program/ladies-strength`, { waitUntil: 'networkidle' });
await idle(1200);
check('ladies-only badge shown', await visibleText('Ladies only'));
check('offer CTA label', await visible(page.getByLabel(/^Book free trial: Ladies Strength Circuit/)));
await shot('04-program-ladies-only-390');

// ——— Offer + weak availability ———
await page.goto(`${BASE}/program/reformer-pilates`, { waitUntil: 'networkidle' });
await idle(1200);
check('offer line shown', await visibleText('20% off first month'));
check('weak availability shown honestly', await visibleText('3 places left'));
await shot('05-program-offer-weak-availability-390');

// ——— Free program ———
await page.goto(`${BASE}/program/community-park-football`, { waitUntil: 'networkidle' });
await idle(1200);
check('free price shown', await visibleText('Free'));
check('free CTA label', await visible(page.getByLabel(/^Book free session: Community Park Football/)));
check('all-ages fact shown', await visibleText('All ages'));
await shot('06-program-free-390');

// ——— No available sessions ———
await page.goto(`${BASE}/program/public-speaking`, { waitUntil: 'networkidle' });
await idle(1200);
check('no-sessions state shown', await visibleText(/No upcoming sessions listed/));
await shot('06-program-no-sessions-390');

// ——— Error + retry (QA-only failure flag) ———
await page.goto(`${BASE}/program/beginner-calisthenics?qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('error state shown', await visibleText('Can’t load activities right now'));
await shot('13-program-error-390');
await visibleLabel('Retry').click();
await idle(1200);
check('retry recovers the page', await visibleText('Beginner Calisthenics'));

// ——— Unknown deep link ———
await page.goto(`${BASE}/program/does-not-exist`, { waitUntil: 'networkidle' });
await idle(1200);
check('unknown id recovery shown', await visibleText('This program is no longer offered.'));
check('recovery action offered', await visible(visibleLabel('Browse activities')));
await shot('13-program-unknown-390');
await visibleLabel('Browse activities').click();
await idle(1000);
check('recovery lands on Discover', page.url().includes('/discover'));

// ——— Results session preservation + duplicate-route protection ———
await page.goto(`${BASE}/discover/results?q=swimming`, { waitUntil: 'networkidle' });
await idle(1400);
await page.getByRole('tab', { name: 'Programs' }).click();
await idle(800);
const firstRow = page.getByLabel(/^Junior Swim Squad by/).locator('visible=true').first();
await firstRow.click();
await firstRow.click().catch(() => {});
await idle(1000);
check('results row opens details', page.url().includes('/program/'));
await visibleLabel('Back').click();
await idle(900);
check('single back returns to Results (no duplicate route)', page.url().includes('/discover/results'));
check(
  'results session preserved (Programs tab still selected)',
  (await page.getByRole('tab', { name: 'Programs' }).getAttribute('aria-selected')) === 'true',
);

// ——— Activation from category, activity-type, and search-linked surfaces ———
await page.goto(`${BASE}/discover/category/martial-arts`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Junior Karate Belts Programme by/).locator('visible=true').first().click();
await idle(1000);
check('category card opens details', page.url().includes('/program/junior-karate'));
await visibleLabel('Back').click();
await idle(800);
check('back returns to category page', page.url().includes('/discover/category/martial-arts'));
await page.goto(`${BASE}/discover/activity/karate`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Karate Foundations by/).locator('visible=true').first().click();
await idle(1000);
check('activity-type card opens details', page.url().includes('/program/karate-foundations'));
await visibleLabel('Back').click();
await idle(800);
check('back returns to activity page', page.url().includes('/discover/activity/karate'));

check('no horizontal overflow at 390', await noOverflow(390));

// ——— 360 × 780 pass ———
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/program/beginner-calisthenics`, { waitUntil: 'networkidle' });
await idle(1200);
check('adult page fits at 360', await noOverflow(360));
check('sticky CTA present at 360', await visible(page.getByLabel(/^Book: Beginner Calisthenics/)));
await shot('01-program-adult-top-360');
await page.mouse.wheel(0, 1400);
await idle(300);
await shot('01-program-adult-mid-360');
await page.goto(`${BASE}/program/ladies-strength`, { waitUntil: 'networkidle' });
await idle(1200);
check('ladies-only fits at 360', await noOverflow(360));
await shot('04-program-ladies-only-360');
await page.goto(`${BASE}/program/reformer-pilates`, { waitUntil: 'networkidle' });
await idle(1200);
await shot('05-program-offer-weak-availability-360');
await page.goto(`${BASE}/program/community-park-football`, { waitUntil: 'networkidle' });
await idle(1200);
await shot('06-program-free-360');
await page.goto(`${BASE}/program/public-speaking`, { waitUntil: 'networkidle' });
await idle(1200);
await shot('06-program-no-sessions-360');
await page.goto(`${BASE}/program/does-not-exist`, { waitUntil: 'networkidle' });
await idle(1200);
await shot('13-program-unknown-360');
check('recovery fits at 360', await noOverflow(360));

// Child flow at 360 (context via Discover, as at 390).
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByRole('button', { name: 'Adam' }).click();
await idle(1000);
await page.getByLabel(/^Junior Swim Squad by/).locator('visible=true').first().click();
await idle(1000);
await shot('02-program-child-eligible-360');
await page.mouse.wheel(0, 3600);
await idle(300);
await page.getByLabel(/^Ladies Aqua Fitness by/).locator('visible=true').first().click();
await idle(1000);
check('child-ineligible banner at 360', await visibleText(/Not suitable for Adam/));
await shot('03-program-child-ineligible-360');
check('child flow fits at 360', await noOverflow(360));

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
