/**
 * Commit 7 QA — schematic map: nodes, selection, session preservation,
 * entry points, states. Run: node scripts/qa/map-review.mjs (Expo web on 8081).
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
const idle = (ms = 800) => page.waitForTimeout(ms);
const visible = (locator) => locator.isVisible().catch(() => false);
const visibleText = (text) => visible(page.getByText(text).locator('visible=true').first());
// react-native-screens keeps covered screens in the DOM, so every locator has
// to be scoped to what is actually on screen (see HANDOFF.md QA notes).
const byLabel = (name) => page.getByLabel(name).locator('visible=true').first();
const byRole = (role, name) => page.getByRole(role, { name, exact: true }).locator('visible=true').first();
const node = (name) => page.getByRole('checkbox', { name: new RegExp(`^${name}`) }).locator('visible=true').first();
const clearDevOverlay = () => page.evaluate(() => document.getElementById('error-toast')?.remove());
const path = () => page.evaluate(() => location.pathname + location.search);

// ——— Default map ———
await page.goto(`${BASE}/map?origin=discover`, { waitUntil: 'networkidle' });
await idle(1200);
check('map title shown', await visibleText('Map'));
check(
  'schematic notice prevents a geographic reading',
  await visibleText(/Schematic view\. Areas are arranged for browsing, not by real location or distance\./),
);
check('participant context visible', await visibleText('Browsing for Everyone'));
const nodes = await page.getByRole('checkbox').locator('visible=true').count();
check(`7 area nodes rendered, got ${nodes}`, nodes === 7);
check('node carries its count in the label', await visible(node('Khalifa City, 10 activities, 2 providers')));
check('zero-supply area stated honestly', await visible(node('Abu Dhabi Island, No activities yet')));
check('List action always visible', await visible(byLabel(/^Show the list/)));
check('dock hidden on the map', !(await visible(byRole('tab', 'Discover'))));
await shot('14-map-390');

// ——— Selected area writes to the shared session ———
await node('Al Raha').click();
await idle();
check('selection marks the node', (await node('Al Raha').getAttribute('aria-checked')) === 'true');
check('selection is announced in context', await visibleText(/Browsing for Everyone · Al Raha/));
check('selection sets one shared filter', await visible(byLabel('Filters, 1 active')));
check('list action reflects the area count', await visible(byLabel('Show the list, 6 activities')));
check('other nodes keep their own supply', await visible(node('Khalifa City, 10 activities')));
await shot('map-selected-area-390');

// ——— Map → List carries the session ———
await byLabel(/^Show the list/).click();
await idle(1200);
check('list opens from the map', (await path()).startsWith('/discover/results'));
check('area filter carried into the list', await visibleText('Al Raha'));
check('list count matches the map node', await visibleText(/6 activities/));

// ——— Discover entry point: card → map → list → back ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await clearDevOverlay();
await byLabel(/Explore on the map/).click();
await idle(1200);
check('discover map card opens the map', (await path()).startsWith('/map'));
check('broad discover session shows the whole catalogue', await visible(byLabel('Show the list, 36 activities')));
await byLabel('Back').click();
await idle(1000);
check('back from map returns to discover', (await path()).startsWith('/discover'));

await clearDevOverlay();
await byLabel(/Explore on the map/).click();
await idle(1200);
await byLabel(/^Show the list/).click();
await idle(1200);
check('discover map list opens results', (await path()).startsWith('/discover/results'));
await byLabel('Back').click();
await idle(1000);
check(
  'the map left no route behind: back from its list lands on discover',
  (await path()).startsWith('/discover') && !(await path()).includes('/results'),
);
check('discover feed is intact underneath', await visibleText('Browse categories'));

// ——— Results entry point: map returns to the same list ———
await byLabel('Search activities, providers or classes').click();
await idle();
await page.getByRole('textbox').locator('visible=true').first().fill('swimming');
await page.keyboard.press('Enter');
await idle(1200);
await byRole('tab', 'Programs').click();
await idle();
await byRole('button', 'Map').click();
await idle(1200);
check('results map keeps the query', await visibleText(/“swimming”/));
check('results map counts only matching supply', await visible(node('Al Raha, 4 activities')));
await shot('map-results-session-390');
await byLabel(/^Show the list/).click();
await idle(1200);
check('list returns to the same results screen', (await path()).startsWith('/discover/results'));
check('query preserved through the map round trip', await visible(byLabel(/Search, current query swimming/)));
check('tab preserved through the map round trip', (await byRole('tab', 'Programs').getAttribute('aria-selected')) === 'true');
await byLabel('Back').click();
await idle(1000);
check('no duplicate results route after map round trip', (await path()).startsWith('/discover') && !(await path()).includes('/results'));

// ——— Category entry point ———
await page.goto(`${BASE}/discover/category/martial-arts`, { waitUntil: 'networkidle' });
await idle(1200);
await byRole('button', 'Map').click();
await idle(1200);
check('category map scopes to the category', await visible(byLabel('Show the list, 5 activities')));
check('category map excludes unrelated areas', await visible(node('Saadiyat Island, No activities yet')));
await byLabel(/^Show the list/).click();
await idle(1200);
check('category map opens the category list', (await path()).startsWith('/discover/results'));
check('category filter chip present in the list', await visibleText('Martial arts & combat'));

// ——— Activity-type entry point ———
await page.goto(`${BASE}/discover/activity/karate`, { waitUntil: 'networkidle' });
await idle(1200);
await byRole('button', 'Map').click();
await idle(1200);
check('activity map scopes to the activity type', await visible(byLabel('Show the list, 2 activities')));
await byLabel('Back').click();
await idle(1000);
check('back from activity map returns to the activity page', (await path()).includes('/discover/activity/karate'));

// ——— Ladies only ———
await page.goto(`${BASE}/map?origin=discover`, { waitUntil: 'networkidle' });
await idle(1200);
await byLabel('Filters').click();
await idle();
await byRole('checkbox', 'Ladies only').click();
await idle();
await page.getByLabel(/^Show \d+ activit/).locator('visible=true').first().click();
await idle(1000);
check('ladies-only narrows every node', await visible(node('Mohammed Bin Zayed City, No activities yet')));
check('ladies-only keeps supplied areas', await visible(node('Khalifa City, 2 activities')));
await shot('map-ladies-only-390');

// ——— Child context + conflict recovery ———
await page.goto(`${BASE}/map?origin=discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1000);
await byRole('button', 'Adam').click();
await idle(900);
await clearDevOverlay();
await byLabel(/Explore on the map/).click();
await idle(1200);
check('child context shown on the map', await visibleText('Browsing for Adam'));
check('child context excludes out-of-range supply', await visible(node('Al Reem Island, No activities yet')));
check('child context keeps age-suitable supply', await visible(node('Khalifa City, 4 activities')));
await shot('map-adam-390');

// ——— Zero-result area ———
await node('Abu Dhabi Island').click();
await idle(900);
check('empty area states it honestly', await visibleText(/No activities in Abu Dhabi Island with these filters yet\./));
check('empty area offers recovery', await visible(byLabel('Show all areas')));
await shot('map-empty-area-390');
await byLabel('Show all areas').click();
await idle(900);
check('recovery clears the area selection', await visibleText('All areas'));

// ——— No matching areas at all ———
await byLabel('Filters').click();
await idle();
await byRole('checkbox', 'Ladies only').click();
await idle();
await page.getByLabel(/^Show \d+ activit/).locator('visible=true').first().click();
await idle(1000);
check('no matching areas names the conflict', await visibleText(/No ladies-only activities for Adam/));
check('no matching areas offers recovery', await visible(byLabel('Clear filters')));
await shot('map-no-areas-390');
await byLabel('Clear filters').click();
await idle(1000);
check('clearing filters restores the nodes', await visible(node('Khalifa City, 4 activities')));

// ——— Missing counts and error states ———
await page.goto(`${BASE}/map?origin=discover&qa-nocount=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('missing counts fall back honestly', await visibleText(/Activity counts aren’t available right now/));
check('missing counts keep the list reachable', await visible(byLabel('Show the list')));
await shot('map-missing-counts-390');

await page.goto(`${BASE}/map?origin=discover&qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('map error state shown', await visibleText(/Can’t load activities right now/));
await byLabel('Retry').click();
await idle(1200);
check('retry recovers the map', await visible(node('Khalifa City')));
await shot('map-error-390');

// ——— 360 width ———
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/map?origin=discover`, { waitUntil: 'networkidle' });
await idle(1200);
check(
  'no horizontal overflow at 360',
  await page.evaluate(() => document.documentElement.scrollWidth <= 360),
);
check('list action still visible at 360', await visible(byLabel(/^Show the list/)));
await shot('15-map-360');

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
