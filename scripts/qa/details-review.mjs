/**
 * Commits 9–11 QA — Program Details (HMA-015) + Provider Storefront
 * (HMA-014): states, activation, navigation, cross-links, and the full
 * milestone screenshot matrix (390 × 844 + 360 × 780, flow proofs).
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
/**
 * Deterministic absolute scroll of the visible screen's scroller.
 * `mouse.wheel` is position-dependent (a wheel over the header overlay never
 * reaches the ScrollView) and produced duplicate captures — never use it here.
 */
const scrollToY = async (y) => {
  await page.evaluate((top) => {
    const scrollers = [...document.querySelectorAll('div')].filter(
      (el) =>
        el.scrollHeight > el.clientHeight + 40 &&
        ['auto', 'scroll'].includes(getComputedStyle(el).overflowY) &&
        el.checkVisibility({ checkVisibilityCSS: true }),
    );
    const target = scrollers[scrollers.length - 1] ?? document.scrollingElement;
    // Direct assignment: RN-web swallows Element.scrollTo on its ScrollView.
    if (target) target.scrollTop = top;
  }, y);
  await page.waitForTimeout(500);
};

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
await scrollToY(1400);
await shot('01-program-adult-mid-390');
check('policy preset shown', await visibleText('Free cancellation up to 24 hours before the session.'));
await scrollToY(99999);
await shot('01-program-adult-bottom-390');
check('more-from-provider listed', await visibleText('More from Gravity Movement Studio'));
check('support contract shown', await visibleText('Something wrong with this listing?'));
// Distinct sticky-CTA proof: content mid-scroll beneath the pinned bar.
await scrollToY(700);
await shot('07-program-sticky-cta-390');
await scrollToY(0);

// ——— Save persists across navigation (session favourites) ———
await visibleLabel('Save Beginner Calisthenics to favourites').click();
await idle(300);
check('save toggles to checked', await visible(visibleLabel('Remove Beginner Calisthenics from favourites')));
await shot('01-program-adult-saved-390');
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
await scrollToY(3600);
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
// Flow proof: Results → Program → back with the session intact.
await shot('16-results-after-program-back-390');

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

// ═══════ Provider Storefront (HMA-014, Commit 10) ═══════

// ——— Default storefront from a Discover provider card (activation) ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Blue Wave Swimming, verified provider/).locator('visible=true').first().click();
await idle(1000);
check('discover provider card opens storefront', page.url().includes('/provider/blue-wave'));
await visibleLabel('Back').click();
await idle(800);
check('storefront back returns to Discover (exact origin)', page.url().includes('/discover'));

// ——— Default storefront (falcon): hierarchy, no offers, save persistence ———
await page.goto(`${BASE}/provider/falcon`, { waitUntil: 'networkidle' });
await idle(1200);
check('storefront title shown', await visibleText('Falcon Combat Academy'));
check('verification labelled, not color-only', await visibleText('Verified provider'));
check('storefront review summary shown', await visibleText('(312 reviews)'));
check('storefront description shown', await visibleText(/combat sports academy/));
check('taxonomy chips joined from programs', await visibleText('Martial arts & combat'));
check('single-branch shows location row, no selector', await visibleText(/Sports District, Warehouse 12/));
check('programs immediately visible with count', await visibleText('5 programs'));
check('no dock on storefront route', !(await visible(page.getByRole('tab', { name: 'Home' }))));
check('no offers section when provider has none', !(await visibleText('Offers & trials')));
await shot('08-storefront-default-top-390');
await scrollToY(800);
await shot('08-storefront-default-mid-390');
await scrollToY(99999);
check('facilities shown', await visibleText('Facilities & amenities'));
check('team shown', await visibleText('Khalid Mansour'));
check('policy preset shown on storefront', await visibleText('Free cancellation up to 24 hours before the session.'));
check('map entry labelled with area', await visible(visibleLabel('See Khalifa City on the map')));
check('storefront support contract shown', await visibleText('Something wrong with this listing?'));
await shot('08-storefront-default-bottom-390');

// Map entry opens the schematic map with the provider origin.
await visibleLabel('See Khalifa City on the map').click();
await idle(1000);
check('map entry opens schematic map', page.url().includes('/map') && page.url().includes('origin=provider'));
await visibleLabel('Back').click();
await idle(800);
check('map back returns to storefront', page.url().includes('/provider/falcon'));

// Provider save persists across navigation (typed provider: key).
await visibleLabel('Save Falcon Combat Academy to favourites').click();
await idle(300);
check('provider save toggles to checked', await visible(visibleLabel('Remove Falcon Combat Academy from favourites')));
await visibleLabel('Back').click();
await idle(800);
await page.goto(`${BASE}/provider/falcon`, { waitUntil: 'networkidle' }).catch(() => {});
await idle(1200);
// Full reload resets session favourites; re-test persistence within the app.
await visibleLabel('Save Falcon Combat Academy to favourites').click();
await idle(300);
await page.getByLabel(/^Boxing Fundamentals by/).locator('visible=true').first().click();
await idle(1000);
await visibleLabel('Back').click();
await idle(800);
check('provider save survives program round-trip', await visible(visibleLabel('Remove Falcon Combat Academy from favourites')));
await shot('08-storefront-saved-390');
await visibleLabel('Remove Falcon Combat Academy from favourites').click();
await idle(200);

// Program favourite from the storefront list shares the one favourites system.
await page.getByLabel('Add Boxing Fundamentals to favourites').locator('visible=true').first().click();
await idle(300);
check('program save from storefront works', await visible(page.getByLabel('Remove Boxing Fundamentals from favourites').locator('visible=true').first()));
await page.getByLabel('Remove Boxing Fundamentals from favourites').locator('visible=true').first().click();
await idle(200);

// ——— Multi-branch (blue-wave) via Results + session preservation ———
await page.goto(`${BASE}/discover/results?q=swimming`, { waitUntil: 'networkidle' });
await idle(1400);
await page.getByRole('tab', { name: 'Providers' }).click();
await idle(800);
await page.getByLabel(/^Blue Wave Swimming, verified provider/).locator('visible=true').first().click();
await idle(1000);
check('results provider row opens storefront', page.url().includes('/provider/blue-wave'));
check('branch selector shown for multi-branch', await visible(page.getByRole('radio', { name: 'Al Raha Gardens' })));
check('default branch is the first (Beach)', await visibleText(/Marina Promenade, Building 4/));
check('branch-aware program count', await visibleText('3 programs at Al Raha Beach'));
await shot('09-storefront-multibranch-390');
await page.getByRole('radio', { name: 'Al Raha Gardens' }).click();
await idle(1000);
check('branch switch updates details', await visibleText(/Gardens Plaza, Pool Hall 2/));
check('branch switch filters programs', await visibleText('1 program at Al Raha Gardens'));
check('gardens lists only its program', await visible(page.getByLabel(/^Ladies Aqua Fitness by/).locator('visible=true').first()));
await shot('09-storefront-branch-switched-390');
await visibleLabel('Back').click();
await idle(900);
check('back returns to Results providers tab', page.url().includes('/discover/results'));
check(
  'results session preserved after storefront (Providers tab selected)',
  (await page.getByRole('tab', { name: 'Providers' }).getAttribute('aria-selected')) === 'true',
);

// ——— Program → Provider → Program cross-links (docs/20 §2.3) ———
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Beginner Calisthenics by/).locator('visible=true').first().click();
await idle(1000);
const providerRow = page.getByLabel('Gravity Movement Studio, verified provider').locator('visible=true').first();
await providerRow.click();
await providerRow.click().catch(() => {});
await idle(1000);
check('program provider row opens storefront (single push)', page.url().includes('/provider/gravity'));
await shot('14-storefront-from-program-390');
await page.getByLabel(/^Ladies Strength Circuit by/).locator('visible=true').first().click();
await idle(1000);
check('storefront program card opens details', page.url().includes('/program/ladies-strength'));
// Flow proof: Provider → Program (scrolled so the frame is distinct from 04).
await scrollToY(400);
await shot('14-program-from-storefront-390');
await page.getByLabel('Gravity Movement Studio, verified provider').locator('visible=true').first().click();
await idle(1000);
check('provider round-trip resolves as back (no third route)', page.url().includes('/provider/gravity'));
// Flow proof: Program A → Provider A → Program X → Provider A resolved by
// back/reuse — the storefront beneath, not a third route.
await shot('18-crosslink-reuse-390');
await visibleLabel('Back').click();
await idle(900);
check('back returns to the originating program', page.url().includes('/program/beginner-calisthenics'));
await visibleLabel('Back').click();
await idle(900);
check('back chain lands on Home (exact origin)', !page.url().includes('/program/') && !page.url().includes('/provider/'));

// ——— Child context via search provider suggestion (no reload, no silent switch) ———
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByRole('button', { name: 'Adam' }).click();
await idle(1000);
await visibleLabel('Search activities, providers or classes').click();
await idle(800);
await page.getByLabel('Search activities or providers').fill('blue');
await idle(600);
await page.getByLabel('Blue Wave Swimming, provider').locator('visible=true').first().click();
await idle(1200);
check('search provider suggestion opens storefront directly', page.url().includes('/provider/blue-wave'));
check('child-eligible grouping announced', await visibleText('Showing programs suitable for Adam (age 8)'));
check('eligible program listed first', await visible(page.getByLabel(/^Junior Swim Squad by/).locator('visible=true').first()));
check('ineligible group collapsed, never hidden', await visibleText(/Not for Adam’s age \(1\)/));
await page.getByText('Showing programs suitable for Adam (age 8)').locator('visible=true').first().scrollIntoViewIfNeeded();
await idle(400);
await shot('10-storefront-child-eligible-390');
await page.getByLabel(/^Not for Adam’s age/).locator('visible=true').first().click();
await idle(500);
check('expanded group explains the age reason', await visibleText(/Ages 16\+ — Adam is 8/));
await shot('10-storefront-child-ineligible-open-390');

// Child with no eligible programs — recovery keeps the provider visible.
await visibleLabel('Back').click();
await idle(900);
// Flow proof: Search provider suggestion → Storefront → back lands on the
// originating browsing surface with the child context intact.
check('storefront back lands on Discover (search flow)', page.url().includes('/discover'));
await shot('17-discover-after-storefront-back-390');
await visibleLabel('Search activities, providers or classes').click();
await idle(800);
await page.getByLabel('Search activities or providers').fill('restore');
await idle(600);
await page.getByLabel('Restore Wellness Studio, provider').locator('visible=true').first().click();
await idle(1200);
check('adult-only provider under child context shows recovery', await visibleText(/No programs for Adam’s age at this provider yet/));
check('provider identity stays visible in recovery', await visibleText('Restore Wellness Studio'));
check('recovery offers eligible participant chips', await visible(page.getByRole('button', { name: 'Me', exact: true }).locator('visible=true').first()));
check('recovery offers a browse action', await visible(visibleLabel('Browse activities for Adam')));
check('no silent switch: Adam context until chip tap', await visibleText(/No programs for Adam’s age/));
await shot('10-storefront-child-none-390');
await page.getByRole('button', { name: 'Me', exact: true }).locator('visible=true').first().click();
await idle(1200);
check('explicit chip switch reveals adult programs', await visibleText('2 programs'));

// ——— Weak supply + monogram fallback (coastal-tennis, no cover key) ———
await page.goto(`${BASE}/provider/coastal-tennis`, { waitUntil: 'networkidle' });
await idle(1200);
check('weak supply is an honest short list', await visibleText('1 program'));
check('monogram banner replaces missing cover', await visible(visibleLabel('Coastal Tennis Academy logo placeholder')));
await shot('12-storefront-monogram-390');
// Weak supply proof scrolls to the honest one-program list.
await scrollToY(500);
await shot('11-storefront-weak-supply-390');

// ——— Error + retry ———
await page.goto(`${BASE}/provider/falcon?qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('storefront error state shown', await visibleText('Can’t load activities right now'));
await shot('13-storefront-error-390');
await visibleLabel('Retry').click();
await idle(1200);
check('storefront retry recovers', await visibleText('Falcon Combat Academy'));

// ——— Unknown provider deep link ———
await page.goto(`${BASE}/provider/does-not-exist`, { waitUntil: 'networkidle' });
await idle(1200);
check('unknown provider recovery shown', await visibleText('This provider is no longer on Himma.'));
check('unknown provider recovery action offered', await visible(visibleLabel('Browse activities')));
await shot('13-storefront-unknown-390');
await visibleLabel('Browse activities').click();
await idle(1000);
check('provider recovery lands on Discover', page.url().includes('/discover'));

// ——— Category + activity-type provider-row activation ———
await page.goto(`${BASE}/discover/category/swimming`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Blue Wave Swimming, verified provider/).locator('visible=true').first().click();
await idle(1000);
check('category provider row opens storefront', page.url().includes('/provider/blue-wave'));
await visibleLabel('Back').click();
await idle(800);
check('back returns to category page', page.url().includes('/discover/category/swimming'));
await page.goto(`${BASE}/discover/activity/tennis`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByRole('tab', { name: 'Providers' }).click();
await idle(800);
await page.getByLabel(/^Coastal Tennis Academy, verified provider/).locator('visible=true').first().click();
await idle(1000);
check('activity-type provider row opens storefront', page.url().includes('/provider/coastal-tennis'));
await visibleLabel('Back').click();
await idle(800);
check('back returns to activity page', page.url().includes('/discover/activity/tennis'));

check('no horizontal overflow at 390', await noOverflow(390));

// ——— 360 × 780 pass ———
await page.setViewportSize({ width: 360, height: 780 });
await page.goto(`${BASE}/program/beginner-calisthenics`, { waitUntil: 'networkidle' });
await idle(1200);
check('adult page fits at 360', await noOverflow(360));
check('sticky CTA present at 360', await visible(page.getByLabel(/^Book: Beginner Calisthenics/)));
await shot('01-program-adult-top-360');
await scrollToY(1400);
await shot('01-program-adult-mid-360');
await scrollToY(99999);
await shot('01-program-adult-bottom-360');
await scrollToY(700);
await shot('07-program-sticky-cta-360');
await scrollToY(0);
await visibleLabel('Save Beginner Calisthenics to favourites').click();
await idle(300);
check('save toggles at 360', await visible(visibleLabel('Remove Beginner Calisthenics from favourites')));
await shot('01-program-adult-saved-360');
await visibleLabel('Remove Beginner Calisthenics from favourites').click();
await idle(200);
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
await page.goto(`${BASE}/program/beginner-calisthenics?qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('program error state at 360', await visibleText('Can’t load activities right now'));
await shot('13-program-error-360');

// Child flow at 360 (context via Discover, as at 390).
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByRole('button', { name: 'Adam' }).click();
await idle(1000);
await page.getByLabel(/^Junior Swim Squad by/).locator('visible=true').first().click();
await idle(1000);
await shot('02-program-child-eligible-360');
await scrollToY(3600);
await page.getByLabel(/^Ladies Aqua Fitness by/).locator('visible=true').first().click();
await idle(1000);
check('child-ineligible banner at 360', await visibleText(/Not suitable for Adam/));
await shot('03-program-child-ineligible-360');
check('child flow fits at 360', await noOverflow(360));

// ——— Storefront at 360 × 780 ———
await page.goto(`${BASE}/provider/falcon`, { waitUntil: 'networkidle' });
await idle(1200);
check('storefront fits at 360', await noOverflow(360));
await shot('08-storefront-default-top-360');
await scrollToY(800);
await shot('08-storefront-default-mid-360');
await scrollToY(99999);
await shot('08-storefront-default-bottom-360');
await scrollToY(0);
await visibleLabel('Save Falcon Combat Academy to favourites').click();
await idle(300);
check('provider save toggles at 360', await visible(visibleLabel('Remove Falcon Combat Academy from favourites')));
await shot('08-storefront-saved-360');
await visibleLabel('Remove Falcon Combat Academy from favourites').click();
await idle(200);
await page.goto(`${BASE}/provider/falcon?qa-fail=1`, { waitUntil: 'networkidle' });
await idle(1200);
check('storefront error state at 360', await visibleText('Can’t load activities right now'));
await shot('13-storefront-error-360');
await page.goto(`${BASE}/provider/blue-wave`, { waitUntil: 'networkidle' });
await idle(1200);
check('multi-branch fits at 360', await noOverflow(360));
await shot('09-storefront-multibranch-360');
await page.getByRole('radio', { name: 'Al Raha Gardens' }).click();
await idle(1000);
check('branch switch works at 360', await visibleText('1 program at Al Raha Gardens'));
await shot('09-storefront-branch-switched-360');
await page.goto(`${BASE}/provider/coastal-tennis`, { waitUntil: 'networkidle' });
await idle(1200);
check('monogram fallback fits at 360', await noOverflow(360));
await shot('12-storefront-monogram-360');
await scrollToY(500);
await shot('11-storefront-weak-supply-360');
await page.goto(`${BASE}/provider/does-not-exist`, { waitUntil: 'networkidle' });
await idle(1200);
await shot('13-storefront-unknown-360');
check('storefront recovery fits at 360', await noOverflow(360));

// Child storefront flow at 360 (context via Discover search, as at 390).
await page.goto(`${BASE}/discover`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByRole('button', { name: 'Adam' }).click();
await idle(1000);
await visibleLabel('Search activities, providers or classes').click();
await idle(800);
await page.getByLabel('Search activities or providers').fill('blue');
await idle(600);
await page.getByLabel('Blue Wave Swimming, provider').locator('visible=true').first().click();
await idle(1200);
check('child grouping renders at 360', await visibleText(/Not for Adam’s age \(1\)/));
await page.getByText('Showing programs suitable for Adam (age 8)').locator('visible=true').first().scrollIntoViewIfNeeded();
await idle(400);
await shot('10-storefront-child-eligible-360');
check('child storefront fits at 360', await noOverflow(360));
await page.getByLabel(/^Not for Adam’s age/).locator('visible=true').first().click();
await idle(500);
await shot('10-storefront-child-ineligible-open-360');

// Search provider → Storefront → back flow proof at 360.
await visibleLabel('Back').click();
await idle(900);
check('storefront back lands on Discover at 360', page.url().includes('/discover'));
await shot('17-discover-after-storefront-back-360');

// Child with no eligible programs at 360.
await visibleLabel('Search activities, providers or classes').click();
await idle(800);
await page.getByLabel('Search activities or providers').fill('restore');
await idle(600);
await page.getByLabel('Restore Wellness Studio, provider').locator('visible=true').first().click();
await idle(1200);
check('child no-eligible recovery at 360', await visibleText(/No programs for Adam’s age at this provider yet/));
await shot('10-storefront-child-none-360');

// Results → Program → back flow proof at 360.
await page.goto(`${BASE}/discover/results?q=swimming`, { waitUntil: 'networkidle' });
await idle(1400);
await page.getByRole('tab', { name: 'Programs' }).click();
await idle(800);
await page.getByLabel(/^Junior Swim Squad by/).locator('visible=true').first().click();
await idle(1000);
await visibleLabel('Back').click();
await idle(900);
check(
  'results session preserved at 360 (Programs tab still selected)',
  (await page.getByRole('tab', { name: 'Programs' }).getAttribute('aria-selected')) === 'true',
);
await shot('16-results-after-program-back-360');

// Program ↔ Provider cross-link flow proofs at 360.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await idle(1200);
await page.getByLabel(/^Beginner Calisthenics by/).locator('visible=true').first().click();
await idle(1000);
await page.getByLabel('Gravity Movement Studio, verified provider').locator('visible=true').first().click();
await idle(1000);
check('program provider row opens storefront at 360', page.url().includes('/provider/gravity'));
await shot('14-storefront-from-program-360');
await page.getByLabel(/^Ladies Strength Circuit by/).locator('visible=true').first().click();
await idle(1000);
check('storefront program card opens details at 360', page.url().includes('/program/ladies-strength'));
await scrollToY(400);
await shot('14-program-from-storefront-360');
await page.getByLabel('Gravity Movement Studio, verified provider').locator('visible=true').first().click();
await idle(1000);
check('cross-link resolves as back at 360 (no third route)', page.url().includes('/provider/gravity'));
await shot('18-crosslink-reuse-360');

check('zero console errors', consoleErrors.length === 0);
if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5));

await browser.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
