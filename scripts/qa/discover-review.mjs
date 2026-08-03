/**
 * Commit 5 QA — Discover feed, quick filters, collections, filter-sheet
 * handoff, Home entry activation, 360 price fix, Home regression.
 * Run: node scripts/qa/discover-review.mjs (Expo web on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/discover-review';
mkdirSync(OUT, { recursive: true });
mkdirSync('artifacts/home-regression', { recursive: true });

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
const shot = (name, dir = OUT) => page.screenshot({ path: `${dir}/${name}.png` });
const idle = (ms = 700) => page.waitForTimeout(ms);
const clearDevOverlay = () =>
  page.evaluate(() => document.getElementById('error-toast')?.remove());
const visible = (locator) => locator.isVisible().catch(() => false);
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

// ——— Discover default hierarchy ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
check('discover title header', await visible(page.getByRole('heading', { name: 'Discover' })));
check('shared location chip', await visible(page.getByLabel(/Change area. Current area Khalifa City/)));
check('search entry announced as button', await visible(page.getByRole('button', { name: 'Search activities, providers or classes' })));
check('participant chips present', await visible(page.getByRole('button', { name: 'Everyone' })));
check('Filters action present', await visible(page.getByRole('button', { name: 'Filters', exact: true })));
check('browse categories section', await visible(page.getByRole('heading', { name: 'Browse categories' })));
check('dock shows Discover active', (await page.getByRole('tab', { name: 'Discover' }).getAttribute('aria-selected')) === 'true');
check('no horizontal overflow (discover 390)', await noHorizontalOverflow());
await shot('01-discover-top-390');

// ——— Mid feed: collections + trending ———
await scrollTo(560);
await idle(300);
check('collections rail present', await visible(page.getByRole('heading', { name: 'Collections' })));
check('collection card labeled with count', await visible(page.getByLabel(/Ladies only collection, \d+ activities/)));
check('thin collection present', await visible(page.getByLabel(/Try something new collection/)));
check('trending section present', await visible(page.getByRole('heading', { name: 'Trending near you' })));
await shot('02-discover-mid-390');

// ——— Bottom: providers, offers, map entry ———
await scrollTo(99999);
await idle(300);
check('popular providers section', await visible(page.getByRole('heading', { name: 'Popular providers' })));
check('offers section', await visible(page.getByRole('heading', { name: 'Offers & trials' })));
check('map entry card', await visible(page.getByLabel(/Explore on the map/)));
await shot('discover-bottom-390');

// ——— Map entry → /map → back ———
await clearDevOverlay();
await page.getByLabel(/Explore on the map/).click();
await idle(800);
check('map route opened', page.url().includes('/map'));
await clearDevOverlay();
await page.getByLabel('Back').click();
await idle(800);
check('back returns to discover from map', page.url().endsWith('/discover'));

// ——— Search entry → /search → back ———
await scrollTo(0);
await idle(200);
await page.getByRole('button', { name: 'Search activities, providers or classes' }).click();
await idle(800);
check('search route opened from discover', page.url().includes('/search'));
await page.getByLabel('Cancel search').click();
await idle(800);
check('cancel returns to discover origin', page.url().endsWith('/discover'));

// ——— Quick filters: Ladies only ———
await page.getByRole('button', { name: 'Ladies only', exact: true }).click();
await idle(1000);
check('ladies-only chip selected state', (await page.getByRole('button', { name: 'Ladies only', exact: true }).getAttribute('aria-selected')) === 'true');
check('ladies-only context line', await visible(page.getByText('Showing ladies-only activities')));
check('ladies-only feed content', await visible(page.getByLabel(/Ladies Strength Circuit by/).first()));
check('non-ladies program filtered out', !(await visible(page.getByLabel(/Beginner Calisthenics by/).first())));
check('filters badge reflects active chip', await visible(page.getByLabel('Filters, 1 active')));
await shot('03-discover-ladies-only-390');

// ——— Filter sheet seeded from active chip; cancel leaves Discover unchanged ———
await page.getByLabel('Filters, 1 active').click();
await idle(500);
check('sheet seeded: Ladies only checked', (await page.getByRole('checkbox', { name: 'Ladies only' }).last().getAttribute('aria-checked')) === 'true');
check('live Show N count present', await visible(page.locator('[aria-label^="Show "]')));
await shot('discover-filter-sheet-390');
await page.getByLabel('Close filters').click({ position: { x: 12, y: 12 } });
await idle(500);
check('cancel keeps discover url', page.url().endsWith('/discover'));
check('cancel keeps quick chip active', (await page.getByRole('button', { name: 'Ladies only', exact: true }).getAttribute('aria-selected')) === 'true');

// ——— Filter sheet apply → new Results session ———
await page.getByLabel('Filters, 1 active').click();
await idle(500);
await clearDevOverlay();
await page.locator('[aria-label^="Show "]').click();
await idle(1200);
check('apply lands on results', page.url().includes('/discover/results'));
check('applied filter visible on results', await visible(page.getByLabel('Remove filter Ladies only')));
await clearDevOverlay();
await page.getByLabel('Back').click();
await idle(800);
check('back returns to discover after apply', page.url().endsWith('/discover'));
check('discover chip state preserved after handoff', (await page.getByRole('button', { name: 'Ladies only', exact: true }).getAttribute('aria-selected')) === 'true');

// ——— Clear chip; Today / Camps states ———
await page.getByRole('button', { name: 'Ladies only', exact: true }).click();
await idle(900);
await page.getByRole('button', { name: 'Today', exact: true }).click();
await idle(1000);
check('today context line', await visible(page.getByText('Showing activities available today')));
check('today feed time-led', await visible(page.getByText(/Today, \d/).first()));
await shot('discover-today-390');
await page.getByRole('button', { name: 'Today', exact: true }).click();
await idle(600);
await page.getByRole('button', { name: 'Camps', exact: true }).click();
await idle(1000);
check('camps context line', await visible(page.getByText('Showing camps')));
check('camps feed content', await visible(page.getByLabel(/Holiday Swim Camp by/).first()));
await shot('discover-camps-390');
await page.getByRole('button', { name: 'Camps', exact: true }).click();
await idle(600);

// ——— Participant: Adam (age badges, exclusions, collections trimmed) ———
await page.getByRole('button', { name: 'Adam' }).click();
await idle(1000);
check('adam: age range badge visible', await visible(page.getByLabel('Ages 6 to 12').first()));
check('adam: adult-only program excluded', !(await visible(page.getByLabel(/Beginner Calisthenics by/).first())));
check('adam: ladies-only collection hidden', !(await visible(page.getByLabel(/Ladies only collection/))));
check('adam: after-school collection present', await visible(page.getByLabel(/After school collection/)));
await shot('04-discover-adam-390');
await scrollTo(760);
await idle(300);
await shot('04-discover-adam-badges-390');
await scrollTo(0);
await idle(200);

// ——— Whole-feed no-match recovery (Lina + Today) ———
await page.getByRole('button', { name: 'Lina' }).click();
await idle(900);
await page.getByRole('button', { name: 'Today', exact: true }).click();
await idle(1000);
check('whole-feed recovery card', await visible(page.getByText('No matches right now')));
check('recovery action offered', await visible(page.getByLabel('Clear filter', { exact: true })));
await shot('discover-empty-recovery-390');
await page.getByLabel('Clear filter', { exact: true }).click();
await idle(1000);
check('recovery clears back to content', await visible(page.getByRole('heading', { name: 'Trending near you' })));
await page.getByRole('button', { name: 'Everyone' }).click();
await idle(900);

// ——— Favourite on Discover persists to Home ———
await scrollTo(700);
await idle(300);
await clearDevOverlay();
await page.getByLabel(/Add Ladies Strength Circuit to favourites/).first().click();
await idle(400);
check('favourite toggled on discover', await visible(page.getByLabel(/Remove Ladies Strength Circuit from favourites/).first()));

// ——— Collection → preset Results → back ———
await scrollTo(560);
await idle(300);
await clearDevOverlay();
await page.getByLabel(/Ladies only collection, \d+ activities/).click();
await idle(1200);
check('collection opens results', page.url().includes('/discover/results'));
check('collection preset active on results', await visible(page.getByLabel('Remove filter Ladies only')));
check('preset results content matches', await visible(page.getByLabel(/Ladies Boxing Fitness by/).last()));
await shot('discover-collection-results-390');
await clearDevOverlay();
await page.getByLabel('Back').click();
await idle(800);
check('back returns to discover from collection results', page.url().endsWith('/discover'));

// ——— Area change on Discover shared with Home ———
await scrollTo(0);
await idle(200);
await page.getByLabel(/Change area. Current area Khalifa City/).click();
await idle(500);
await page.getByRole('radio', { name: 'Yas Island' }).click();
await idle(900);
check('discover header shows new area', await visible(page.getByLabel(/Change area. Current area Yas Island/)));
await clearDevOverlay();
await page.getByRole('tab', { name: 'Home' }).click();
await idle(900);
check('home shares the changed area', await visible(page.getByLabel(/Change area. Current area Yas Island/).first()));
check('home favourite persisted from discover', await visible(page.getByLabel(/Remove Ladies Strength Circuit from favourites/).first()));

// ——— Home quick filters remain local ———
await page.getByRole('button', { name: 'Ladies only', exact: true }).click();
await idle(900);
check('home ladies chip active', (await page.getByRole('button', { name: 'Ladies only', exact: true }).getAttribute('aria-selected')) === 'true');
await clearDevOverlay();
await page.getByRole('tab', { name: 'Discover' }).click();
await idle(900);
check('discover quick chip independent of home', (await page.getByRole('button', { name: 'Ladies only', exact: true }).getAttribute('aria-selected')) !== 'true');
await clearDevOverlay();
await page.getByRole('tab', { name: 'Home' }).click();
await idle(700);
await page.getByRole('button', { name: 'Ladies only', exact: true }).click();
await idle(700);

// ——— Home entry activation: search bar + hero CTA ———
await page.getByRole('button', { name: 'Search activities, providers or classes' }).click();
await idle(800);
check('home search bar opens search', page.url().includes('/search'));
await page.getByLabel('Cancel search').click();
await idle(800);
await clearDevOverlay();
await page.getByLabel('Explore summer picks').click();
await idle(1200);
check('hero CTA opens preset results', page.url().includes('/discover/results'));
check('summer preset applied (indoor)', await visible(page.getByLabel('Remove filter Indoor')));
await shot('home-hero-results-390');

// ——— Error state via deterministic QA flag + retry ———
await page.goto(`${BASE}/discover?qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('discover error state shows recovery', await visible(page.getByLabel('Retry')));
await shot('discover-error-390');
await clearDevOverlay();
await page.getByLabel('Retry').click();
await idle(1000);
check('discover retry recovers feed', await visible(page.getByRole('heading', { name: 'Browse categories' })));

// ——— Home regression captures (390) ———
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await idle(1200);
await shot('16-home-top-390');
await shot('home-top-390', 'artifacts/home-regression');
await scrollTo(850);
await idle(300);
await shot('16-home-mid-390');
await shot('home-mid-390', 'artifacts/home-regression');
await scrollTo(99999);
await idle(300);
await shot('16-home-bottom-390');
await shot('home-bottom-390', 'artifacts/home-regression');
check('no horizontal overflow (home 390)', await noHorizontalOverflow());

// ——— 360 width: Discover + Results price fix ———
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
check('no horizontal overflow (discover 360)', await noHorizontalOverflow());
await shot('15-discover-top-360');
await page.goto(`${BASE}/discover/results?q=swimming&tab=programs`, { waitUntil: 'networkidle' });
await idle(1200);
check('no horizontal overflow (results 360)', await noHorizontalOverflow());
check('package price renders in full at 360', await visible(page.getByText('for 6 sessions').first()));
await shot('15-results-programs-360');

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log('console errors:', consoleErrors.slice(0, 5));

await browser.close();
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);
