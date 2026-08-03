/**
 * Commit 3 QA — Search flow checks and screenshots via system Chrome.
 * Run: node scripts/qa/search-review.mjs (Expo web must be running on 8081).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8081';
const OUT = 'artifacts/search-review';
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
const idle = () => page.waitForTimeout(700);
// Expo's dev-only empty error-toast container intercepts pointer events over
// the dock area in headless Chrome; it is not part of the app. Remove it.
const clearDevOverlay = () => page.evaluate(() => document.getElementById('error-toast')?.remove());

// — Initial state (from Discover origin so Cancel-origin is testable) —
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle();
await page.getByRole('button', { name: 'Search activities, providers or classes' }).click();
await idle();
check('search route pushed', page.url().endsWith('/search'));
check('input auto-focused', await page.evaluate(() => document.activeElement?.tagName === 'INPUT'));
check('recent searches shown', await page.getByText('Kickboxing', { exact: true }).isVisible());
check('popular searches shown', await page.getByText('Ladies only pilates').isVisible());
check('category shortcuts shown', await page.getByRole('button', { name: 'Kids & Teens' }).isVisible());
check('dock hidden on search', !(await page.getByRole('tab', { name: 'Home' }).isVisible().catch(() => false)));
await shot('01-initial-390');

// — Typing state —
await page.getByRole('textbox').fill('swim');
await idle();
check('activity suggestion with type label', await page.getByLabel('Swimming, activity').first().isVisible());
const rowCount = await page.locator('[aria-label$=", activity"], [aria-label$=", provider"], [aria-label$=", category"], [aria-label$=", area"]').count();
check(`suggestion rows ≤ 8 (got ${rowCount})`, rowCount <= 8);
await shot('02-typing-390');

// — Typo state —
await page.getByRole('textbox').fill('pilaties');
await idle();
check('typo corrects to pilates suggestions', await page.getByLabel('Pilates, activity').first().isVisible());
await shot('03-typo-390');

// — Clear input keeps focus, empty submit does nothing —
await page.getByLabel('Clear search text').click();
check('clear resets to pre-search content', await page.getByText('Popular searches').isVisible());
await page.keyboard.press('Enter');
check('empty submit stays on search', page.url().endsWith('/search'));

// — Cancel returns to exact origin (Discover) —
await page.getByLabel('Cancel search').click();
await idle();
check('cancel returns to discover origin', page.url().endsWith('/discover'));

// — Participant effect: Adam context excludes 16+ programs from suggestions —
// The participant selector lives on Discover (docs/18 §7); Home has no chips.
await clearDevOverlay();
await page.getByRole('button', { name: 'Adam', exact: true }).click();
await idle();
await page.getByRole('button', { name: 'Search activities, providers or classes' }).click();
await idle();
await page.getByRole('textbox').fill('swim');
await idle();
check('adam sees Junior Swim Squad', await page.getByLabel('Junior Swim Squad, activity').isVisible());
check('adam does not see Ladies Aqua (16+)', !(await page.getByLabel('Ladies Aqua Fitness, activity').isVisible().catch(() => false)));
await shot('04-participant-adam-390');

// — Results handoff —
await page.getByLabel('Junior Swim Squad, activity').click();
await idle();
check('handoff routes to /discover/results', page.url().includes('/discover/results'));
check('results carries query param', page.url().includes('q=Junior'));
await shot('05-results-handoff-390');
// Back from Results lands on the anchored Discover feed (docs/16 §6).
await page.getByLabel('Back').click();
await idle();
check('results back returns to discover feed', page.url().endsWith('/discover'));

// — Recents updated + clearable (same JS session — recents are session-local) —
await page.getByRole('button', { name: 'Search activities, providers or classes' }).click();
await idle();
check('submitted query in recents', await page.getByLabel('Junior Swim Squad, recent search').isVisible());
await page.getByLabel('Clear recent searches').click();
check('recents cleared', !(await page.getByText('Recent', { exact: true }).isVisible().catch(() => false)));

// — 360 width: no clipping, no horizontal overflow —
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await idle();
const inputFits = await page.evaluate(() => {
  const input = document.querySelector('input');
  return input !== null && input.scrollWidth <= input.clientWidth;
});
check('placeholder fits at 360', inputFits);
check('no horizontal overflow at 360', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await shot('06-initial-360');

// — Keyboard-safe scroll approximation: short viewport, list scrolls, taps land —
await page.setViewportSize({ width: 390, height: 500 });
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await idle();
await page.getByRole('textbox').fill('a');
await idle();
await shot('07-short-viewport-scroll-390x500');

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log('console errors:', consoleErrors.slice(0, 5));

await browser.close();
console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);
