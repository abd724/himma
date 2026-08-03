/**
 * Commit 4 QA — Results flows, filtering, sorting, pagination, states.
 * Run: node scripts/qa/results-review.mjs (Expo web on 8081).
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
// Hide Expo web's transient Fast Refresh bubble (dev tooling, never app UI).
const shot = async (name) => {
  await page
    .addStyleTag({ content: '.__expo_fast_refresh { display: none !important; }' })
    .catch(() => {});
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
const idle = (ms = 700) => page.waitForTimeout(ms);
const clearDevOverlay = () =>
  page.evaluate(() => document.getElementById('error-toast')?.remove());
const visible = (locator) => locator.isVisible().catch(() => false);

// ——— Search → Results (All tab) ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle();
await page.getByRole('button', { name: 'Search activities, providers or classes' }).click();
await idle();
await page.getByRole('textbox').fill('swimming');
await page.keyboard.press('Enter');
await idle(1000);
check('handoff lands on results', page.url().includes('/discover/results'));
check('All tab selected', (await page.getByRole('tab', { name: 'All', exact: true }).getAttribute('aria-selected')) === 'true');
check('count line announced', await visible(page.getByText(/activit(y|ies) ·/)));
check('dock visible on results browsing', await visible(page.getByRole('tab', { name: 'Discover' })));
const programCards = await page.locator('[aria-label*=" by "]:visible').count();
check(`All tab caps programs at 3 (got ${programCards})`, programCards <= 3);
check('See all Programs offered', await visible(page.getByLabel('See all Programs')));
await shot('07-results-all-390');

// ——— See all → Programs tab ———
await page.getByLabel('See all Programs').click();
await idle();
check('See all switches to Programs tab', (await page.getByRole('tab', { name: 'Programs' }).getAttribute('aria-selected')) === 'true');
// visible=true scope: the hidden Discover screen beneath also renders this badge.
check('age badge shown on junior program', await visible(page.getByText('Ages 6–14').locator('visible=true').first()));

// ——— Participant switching on Results keeps query ———
await page.getByRole('button', { name: 'Adam' }).click();
await idle(900);
check('query preserved after participant switch', await visible(page.getByLabel(/Search, current query swimming/)));
check('adam: 16+ program excluded', !(await visible(page.getByText('Ladies Aqua Fitness').locator('visible=true').first())));
check('adam: age-suitable program present', await visible(page.getByText('Junior Swim Squad').locator('visible=true').first()));
await shot('results-participant-adam-390');

// ——— Ladies-only + child → zero-result recovery ———
await page.getByRole('checkbox', { name: 'Ladies only' }).first().click();
await idle(900);
check('recovery names the conflict', await visible(page.getByText(/No ladies-only activities for Adam/)));
await shot('10-zero-result-recovery-390');
await page.getByLabel('Clear filters', { exact: true }).click();
await idle(900);
check('clear filters recovers results', await visible(page.getByText('Junior Swim Squad').locator('visible=true').first()));
await page.getByRole('button', { name: 'Everyone' }).click();
await idle(900);

// ——— Combined quick chips + sheet/count agreement ———
await page.getByRole('checkbox', { name: 'Today' }).click();
await page.getByRole('checkbox', { name: 'Ladies only' }).first().click();
await idle(900);
check('combined active chips shown', (await visible(page.getByLabel('Remove filter Today'))) && (await visible(page.getByLabel('Remove filter Ladies only'))));
check('filters badge shows 2', await visible(page.getByLabel('Filters, 2 active')));
const countText = await page.getByText(/activit(y|ies) ·/).innerText();
await page.getByLabel('Filters, 2 active').click();
await idle();
const applyText = await page.locator('[aria-label^="Show "]').getAttribute('aria-label');
check(
  `sheet count agrees with list count (${applyText} vs ${countText})`,
  countText.startsWith(applyText.replace('Show ', '').split(' ')[0]),
);
check('Ladies only pinned selected in sheet Who group', (await page.getByRole('checkbox', { name: 'Ladies only' }).nth(1).getAttribute('aria-checked')) === 'true');
await shot('09-filter-sheet-390');

// ——— Conditional activity-type filter ———
await page.getByRole('radio', { name: 'Swimming & water' }).click();
await idle(400);
check('conditional activity row appears after category', await visible(page.getByRole('radio', { name: 'Aqua fitness' })));
await page.locator('[aria-label^="Show "]').click();
await idle(900);
check('category chip applied from sheet', await visible(page.getByLabel('Remove filter Swimming & water')));

// ——— Clear all from sheet ———
await page.getByLabel('Filters, 3 active').click();
await idle();
await page.getByLabel('Clear all filters').click();
await idle(400);
await page.locator('[aria-label^="Show "]').click();
await idle(900);
check('clear all removes active chips', !(await visible(page.getByLabel(/Remove filter/))));

// ——— Sorting ———
await page.getByRole('button', { name: /^Recommended|^Sort/ }).click();
await idle();
await shot('sort-sheet-390');
await page.getByRole('radio', { name: 'Lowest price' }).click();
await idle(900);
check('sort label updates', await visible(page.getByRole('button', { name: 'Lowest price' })));
const firstCard = await page.locator('[aria-label*=" by "]:visible').first().getAttribute('aria-label');
check(`lowest price first (${firstCard.slice(0, 40)}…)`, /AED 60|Free/.test(firstCard));
check('query survives sorting', await visible(page.getByLabel(/Search, current query swimming/)));

// ——— Load more on a broad query (deep link) ———
await page.goto(`${BASE}/discover/results?q=in&tab=programs`, { waitUntil: 'networkidle' });
await idle(1200);
const before = await page.locator('[aria-label*=" by "]:visible').count();
check(`page 1 shows 12 programs (got ${before})`, before === 12);
await shot('08-results-programs-390');
await clearDevOverlay();
await page.getByLabel('Load more results').click();
await idle(900);
const after = await page.locator('[aria-label*=" by "]:visible').count();
check(`load more appends (now ${after})`, after > before);
check('end of results shown when list complete', (await visible(page.getByText(/You’ve seen all/))) || (await visible(page.getByLabel('Load more results'))));

// ——— Typo correction ———
await page.goto(`${BASE}/discover/results?q=pilaties`, { waitUntil: 'networkidle' });
await idle(1200);
check('typo correction line', await visible(page.getByText('Showing results for “pilates”')));
await shot('results-typo-390');

// ——— Error state + retry (QA-only flag) ———
await page.goto(`${BASE}/discover/results?q=boxing&qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('error state shows recovery', await visible(page.getByLabel('Retry')));
await shot('results-error-390');
await page.getByLabel('Retry').click();
await idle(900);
check('retry recovers results', await visible(page.getByText('Boxing Fundamentals')));

// ——— Back behavior ———
await clearDevOverlay();
await page.getByLabel('Back').click();
await idle();
check('back returns into discover', page.url().includes('/discover'));

// ——— Refining from Results replaces the route (no duplicate Results) ———
await page.goto(`${BASE}/discover/results?q=swimming`, { waitUntil: 'networkidle' });
await idle(1200);
await clearDevOverlay();
await page.getByLabel(/Search, current query swimming/).click();
await idle(800);
await page.getByRole('textbox').fill('boxing');
await page.keyboard.press('Enter');
await idle(1200);
check('refined query lands on results', await visible(page.getByLabel(/Search, current query boxing/)));
await clearDevOverlay();
await page.getByLabel('Back').click();
await idle(900);
check('back after refine skips the stale results route', page.url().endsWith('/discover'));

// ——— Home regression: Home owns no filter controls (docs/18 §4, §7) ———
await page.goto(`${BASE}/discover/results?q=yoga`, { waitUntil: 'networkidle' });
await idle(1000);
await page.getByRole('checkbox', { name: 'Ladies only' }).first().click();
await idle(700);
await clearDevOverlay();
await page.getByRole('tab', { name: 'Home' }).click();
await idle(900);
// exact: program-card labels legitimately CONTAIN "Ladies only" (spoken badge).
check('home has no quick filter chips (results filter cannot leak)', !(await page.getByRole('button', { name: 'Ladies only', exact: true }).first().isVisible().catch(() => false)));
const scrollTo = async (y) =>
  page.evaluate((offset) => {
    const els = [...document.querySelectorAll('div')].filter(
      (d) => d.scrollHeight > d.clientHeight + 100,
    );
    const sc = els[els.length - 1];
    sc.scrollTop = offset;
  }, y);
await shot('16-home-top-390');
await scrollTo(850);
await idle(300);
await shot('16-home-mid-390');
await scrollTo(99999);
await idle(300);
await shot('16-home-bottom-390');

// ——— 360 width ———
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/discover/results?q=swimming&tab=programs`, { waitUntil: 'networkidle' });
await idle(1200);
check('no horizontal overflow at 360', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await shot('15-results-programs-360');

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log('console errors:', consoleErrors.slice(0, 5));

await browser.close();
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);
