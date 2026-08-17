import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, isMobile, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-7 Listings index & detail (read) over the production build (fixture
 * opt-in), across the three viewport projects. All post-sign-in navigation
 * stays client-side (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-7');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const FALCON_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e03';
const SUNRISE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e05';

const JUNIOR_SQUAD_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f02';
const SUNSET_OPEN_WATER_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f10';
const FALCON_KICKBOXING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f31';

const consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(String(error));
  });
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

async function clientGoto(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function openListings(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('link', { name: 'Listings' })
      .click();
  } else {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Listings' })
      .click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
}

test('owner journey: populated index → filters → pagination → multi-option detail → revision/archived states → safe not-found', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await openListings(page);

  // Populated index with the exact lifecycle vocabulary.
  const list = page.getByRole('list', { name: 'Listings' });
  await expect(list.getByText('Adult Beginner Swimming')).toBeVisible();
  await expect(list.getByText('Approved — not published')).toBeVisible();
  await expect(list.getByText('Changes requested')).toBeVisible();
  await expect(list.getByText('In review')).toBeVisible();
  await expect(page.getByText('10 listings loaded so far')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listings-index.png`),
    fullPage: true,
  });

  // AUTHORITATIVE server-side filtering (W2-12C1 final correction): the
  // draft filter returns the COMPLETE matching set — including listings
  // beyond the first unfiltered page — with no partial-page disclaimer.
  await page.getByLabel('Filter by status').selectOption('draft');
  await expect(page.getByText('3 matching listings')).toBeVisible();
  await expect(list.getByText('Aqua Fitness Express')).toBeVisible();
  await expect(list.getByText('Synchro Performance Squad')).toBeVisible();
  await expect(page.getByText(/loaded so far — load more below/)).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listings-filtered.png`),
    fullPage: true,
  });
  // Authoritative search finds a second-page listing directly, and an
  // unmatched search is the truthful empty state.
  await page.getByLabel('Filter by status').selectOption('all');
  await page.getByLabel('Search by title').fill('aqua');
  await expect(page.getByText('3 matching listings')).toBeVisible();
  await expect(list.getByText('Aqua Fitness Express')).toBeVisible();
  await page.getByLabel('Search by title').fill('zumba');
  await expect(page.getByText('No listings match your filters.')).toBeVisible();
  await page.getByLabel('Search by title').fill('');
  await expect(page.getByText('10 listings loaded so far')).toBeVisible();

  // Opaque-cursor pagination.
  await page.getByRole('button', { name: 'Load more listings' }).click();
  await expect(page.getByText('12 listings', { exact: true })).toBeVisible();
  await expect(list.getByText('Aqua Fitness Express')).toBeVisible();

  // Multi-option detail: ONE listing, options underneath, offers apart.
  await list.getByText('Adult Beginner Swimming').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Adult Beginner Swimming' }),
  ).toBeVisible();
  await expect(page.getByText('Customers can find this listing on Himma.')).toBeVisible();
  const pricing = page.getByRole('list', { name: 'Pricing options' });
  await expect(pricing.getByText('AED 450')).toBeVisible();
  await expect(pricing.getByText('3 months')).toBeVisible();
  await expect(pricing.getByText('Archived')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Offers' }).getByText('Free trial session')).toBeVisible();
  await expect(page.getByText('Al Sufouh training pool')).toBeVisible();
  await expect(page.getByText('No longer offered here')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listing-detail-multioption.png`),
    fullPage: true,
  });

  // Pending-revision read-only state.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${JUNIOR_SQUAD_ID}`);
  await expect(page.getByText('Changes pending Himma review.')).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listing-revision-pending.png`),
    fullPage: true,
  });

  // Archived is terminal and says so.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${SUNSET_OPEN_WATER_ID}`);
  await expect(page.getByText(/Archiving is final/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listing-archived.png`),
    fullPage: true,
  });

  // Unknown id: the one safe not-found surface.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/0198a2f0-5b7a-7000-8000-000000000000`);
  await expect(page.getByRole('heading', { level: 2, name: 'Listing not found' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listing-not-found.png`),
    fullPage: true,
  });
});

test('branch-scoped manager: reachable listings only, out-of-scope detail safely not found', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  await openListings(page);

  await expect(
    page.getByText(
      'You see the listings that run at your assigned branches, plus drafts that aren’t placed at a branch yet.',
    ),
  ).toBeVisible();
  const list = page.getByRole('list', { name: 'Listings' });
  await expect(list.getByText('Ladies Aqua Fitness')).toBeVisible();
  await expect(list.getByText('Holiday Swim Camp')).toBeVisible();
  await expect(list.getByText('Aqua Fitness Express')).toBeVisible();
  await expect(list.getByText('Junior Swim Squad')).not.toBeVisible();
  await expect(list.getByText('School Term Program')).not.toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listings-scoped.png`),
    fullPage: true,
  });

  // The detail shares the list's reachability rule: a direct URL to an
  // out-of-scope in-organization listing gets the SAME safe not-found
  // surface as an unknown id — no title, state, or existence leak.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${JUNIOR_SQUAD_ID}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Listing not found' })).toBeVisible();
  await expect(page.getByText('Junior Swim Squad')).not.toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listing-out-of-scope.png`),
    fullPage: true,
  });
});

test('a role without catalogue.read: no navigation entry, truthful no-access surface by direct URL', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'frontdesk@bluewave.demo');

  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer.getByRole('link', { name: 'Branches' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Listings' })).not.toBeVisible();
    await page.keyboard.press('Escape');
  } else {
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Branches' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Listings' })).not.toBeVisible();
  }

  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Listings are managed by your catalogue team' }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listings-no-access.png`),
    fullPage: true,
  });
});

test('empty catalogue: truthful empty state with the real Create entry (W2-8)', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'stages@himma.demo');
  await clientGoto(page, `/o/${SUNRISE_ID}/listings`);
  await expect(page.getByRole('heading', { level: 2, name: 'No listings yet' })).toBeVisible();
  // W2-8: creation is real — the empty state links to the create route.
  await expect(page.getByRole('link', { name: 'Create listing' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listings-empty.png`),
    fullPage: true,
  });
});

test('suspended organization: catalogue reads stay, prominently marked; published listing not claimed customer-visible', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'director@himma.demo');
  await clientGoto(page, `/o/${FALCON_ID}/listings`);
  const list = page.getByRole('list', { name: 'Listings' });
  await expect(list.getByText('Teen Kickboxing Fundamentals')).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByText('This organization is currently suspended. Changes are unavailable.'),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listings-suspended.png`),
    fullPage: true,
  });

  await clientGoto(page, `/o/${FALCON_ID}/listings/${FALCON_KICKBOXING_ID}`);
  await expect(page.getByText('Customers can’t see this listing yet.')).toBeVisible();
  await expect(page.getByText(/Not met — the organization is live on Himma/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-listing-suspended-visibility.png`),
    fullPage: true,
  });
});
