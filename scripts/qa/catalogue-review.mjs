/**
 * Commit 6 QA — catalogue pages: All Categories, category, activity type.
 * Run: node scripts/qa/catalogue-review.mjs (Expo web on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/discover-review';
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
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const idle = (ms = 700) => page.waitForTimeout(ms);
const visible = (locator) => locator.isVisible().catch(() => false);
const visibleText = (text) => visible(page.getByText(text).locator('visible=true').first());

// ——— All Categories (HMA-011) ———
await page.goto(`${BASE}/discover/categories`, { waitUntil: 'networkidle' });
await idle(1000);
check('all categories title shown', await visibleText('All categories'));
const tiles = await page.locator('[aria-label$=" category"]:visible').count();
check(`13 browse tiles rendered (11 categories + 2 lenses), got ${tiles}`, tiles === 13);
check('supply-aware order leads with Fitness & gyms', await visibleText('Fitness & gyms'));
check('Kids & Teens lens present', await visible(page.getByLabel('Kids & Teens category').locator('visible=true').first()));
check('Camps & holidays lens present', await visible(page.getByLabel('Camps & holidays category')));
check('dock visible on All Categories', await visible(page.getByRole('tab', { name: 'Discover' })));
await shot('11-all-categories-390');

// ——— Category tile → category page ———
await page.getByLabel('Martial arts & combat category').click();
await idle(1000);
check('category page opens from tile', page.url().includes('/discover/category/martial-arts'));
check('category title shown', await visibleText('Martial arts & combat'));
check('activity-type chip shown', await visible(page.getByRole('button', { name: 'Karate', exact: true })));
check('toolbar Filter present', await visible(page.getByLabel('Filters, 1 active')));
check('toolbar Sort present', await visible(page.getByRole('button', { name: 'Sort' })));
check('toolbar Map present', await visible(page.getByRole('button', { name: 'Map' })));
check('participant chips on category page', await visible(page.getByRole('button', { name: 'Adam' })));
check('popular programs listed', await visibleText('Junior Karate Belts Programme'));
check('age badge on junior program', await visibleText('Ages 6–12'));
check('providers section listed', await visibleText('Falcon Combat Academy'));
check('View all opens preset results', await visible(page.getByLabel(/View all 5/)));
await shot('12-category-390');

// ——— Category page → activity-type page (single-catalogue proof) ———
await page.getByRole('button', { name: 'Karate', exact: true }).click();
await idle(1000);
check('activity page opens from chip', page.url().includes('/discover/activity/karate'));
check('activity title shown', await visibleText('Karate'));
check('category context shown', await visibleText('Martial arts & combat'));
check('junior variant listed', await visibleText('Junior Karate Belts Programme'));
check('adult variant listed', await visibleText('Karate Foundations'));
check('programs tab selected by default', (await page.getByRole('tab', { name: 'Programs' }).getAttribute('aria-selected')) === 'true');
await shot('13-activity-type-390');

// ——— Providers segment ———
await page.getByRole('tab', { name: 'Providers' }).click();
await idle();
check('providers segment lists operator', await visibleText('Falcon Combat Academy'));
check('provider count line shown', await visibleText('1 provider'));

// ——— Child context hard-exclusion on activity page ———
await page.getByRole('tab', { name: 'Programs' }).click();
await idle();
await page.getByRole('button', { name: 'Adam' }).click();
await idle(900);
check('adam: adult karate excluded', !(await visibleText('Karate Foundations')));
check('adam: junior karate retained', await visibleText('Junior Karate Belts Programme'));
await page.getByRole('button', { name: 'Everyone' }).click();
await idle(900);

// ——— Weak supply honest state (docs/16 §2) ———
await page.goto(`${BASE}/discover/category/wellness`, { waitUntil: 'networkidle' });
await idle(1000);
check('weak supply message shown', await visibleText(/Only 2 activities near Khalifa City/));
check('weak supply area action', await visible(page.getByLabel('Change area').locator('visible=true').first()));
await shot('12-category-weak-supply-390');

// ——— Child context empties a category honestly ———
await page.getByRole('button', { name: 'Adam' }).click();
await idle(900);
check('adam wellness empty names the reason', await visibleText(/No Wellness & recovery activities for Adam/));
check('empty recovery action offered', await visible(page.getByLabel('Browse as Everyone')));
await page.getByLabel('Browse as Everyone').click();
await idle(900);
check('recovery restores the list', await visibleText('Sports Recovery Massage'));

// ——— Unknown id recovery ———
await page.goto(`${BASE}/discover/category/not-real`, { waitUntil: 'networkidle' });
await idle(1000);
check('unknown category recovers', await visible(page.getByLabel('Browse all categories')));

// ——— 360 width ———
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/discover/categories`, { waitUntil: 'networkidle' });
await idle(1000);
check(
  'no horizontal overflow at 360',
  await page.evaluate(() => document.documentElement.scrollWidth <= 360),
);
await page.goto(`${BASE}/discover/category/martial-arts`, { waitUntil: 'networkidle' });
await idle(1000);
check(
  'category page fits at 360',
  await page.evaluate(() => document.documentElement.scrollWidth <= 360),
);

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
