import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

/** Fixture files resolve relative to the portal package (Playwright's cwd). */
const FIXTURES = 'e2e/fixtures';
import { evidenceDir, isMobile, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-11 internal PREFLIGHT of the docs/30 design-partner walkthrough — the
 * facilitator script's tasks executed end-to-end against the production
 * fixture build, scenario by scenario. This is NOT the external §8.6 gate
 * (no human partner is involved); it proves the scripted tasks are
 * executable and that every mandatory comprehension state renders its
 * carrying copy. Kept as a standing suite so the walkthrough stays
 * executable as the portal evolves.
 */
const evidence = evidenceDir('portal-w2-11');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const PEARL_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e08';
const SUNRISE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e05';

const PRIVATE_COACHING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f04'; // approved
const ADULT_SWIMMING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f01'; // published
const JUNIOR_SQUAD_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f02'; // open revision
const MASTERS_TRAINING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f09'; // paused, Marina+Bay
const AQUA_THERAPY_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f08'; // changes_requested
const PEARL_FREEDIVING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f41'; // approved, org not live

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

async function openNav(page: Page, name: string) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name }).click();
  } else {
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name }).click();
  }
}

test('Scenario A (Owner, tasks 1–11): dashboard → branch → scoped invite → create/price/submit → publish → pause → protected edit → import → placeholders', async ({
  page,
}, testInfo) => {
  test.skip(isMobile(page) || testInfo.project.name === 'tablet', 'primary walkthrough runs at desktop; responsive spot-checks run separately');

  // Task 1 — sign in, read the dashboard as status.
  await signInAs(page, 'owner@bluewave.demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Live on Himma')).toBeVisible();
  await expect(page.getByText(/approved and not yet published/)).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a1-dashboard.png`), fullPage: true });

  // Task 2 — add the new Jumeirah branch.
  await openNav(page, 'Branches');
  await page.getByRole('link', { name: 'Add branch' }).click();
  await page.getByLabel('Branch name').fill('Jumeirah family pool');
  await page.getByLabel('Area').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Add branch' }).click();
  await expect(page.getByText('Jumeirah family pool').first()).toBeVisible();

  // Task 3 — invite a manager scoped to the new branch.
  await openNav(page, 'Team');
  await page.getByRole('link', { name: 'Invite someone' }).click();
  await page.getByLabel('Email address').fill('jumeirah.manager@bluewave.example');
  await page.getByLabel('Role').selectOption('branch_manager');
  await page.getByRole('radio', { name: /Specific branches/ }).click();
  await page.getByRole('checkbox', { name: /Jumeirah family pool/ }).click();
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Invitation sent' })).toBeVisible();

  // Task 4 — create the children's listing at the new branch.
  await openNav(page, 'Listings');
  await page.getByRole('link', { name: 'Create listing' }).click();
  await page.getByLabel('Title (English)').fill('Kids Jumeirah Swim Starters');
  await page.getByLabel('Activity type').selectOption({ label: 'Swimming' });
  await page.getByLabel('Youngest age (optional)').fill('5');
  await page.getByLabel('Oldest age (optional)').fill('10');
  await page.getByRole('button', { name: 'Create draft listing' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kids Jumeirah Swim Starters' })).toBeVisible();
  const locations = page.locator('section', { has: page.getByRole('heading', { name: 'Locations' }) });
  await locations.getByRole('listitem').filter({ hasText: 'Jumeirah family pool' }).getByRole('button', { name: 'Offer here' }).click();
  await expect(locations.getByText(/Offers this listing/).first()).toBeVisible();

  // Task 5 — monthly price option (+ a paid-trial offer).
  const pricing = page.locator('section', { has: page.getByRole('heading', { name: 'Pricing options' }) });
  await pricing.getByRole('button', { name: 'Add price option' }).click();
  await pricing.getByLabel('Price (AED)').fill('380');
  await pricing.getByRole('button', { name: 'Save option' }).click();
  await expect(pricing.getByText('AED 380')).toBeVisible();
  const offers = page.locator('section', { has: page.getByRole('heading', { name: 'Offers' }) });
  await offers.getByRole('button', { name: 'Add offer' }).click();
  await offers.getByLabel('Kind').selectOption({ label: 'Paid trial' });
  await offers.getByLabel('Label').fill('Taster session');
  await offers.getByLabel('Trial price (AED)').fill('50');
  await offers.getByRole('button', { name: 'Save offer' }).click();
  await expect(offers.getByText('Paid trial · AED 50')).toBeVisible();

  // Task 6 — the editor's readiness panel links to the listing page; submit there.
  await page.getByRole('link', { name: 'the listing page' }).click();
  await expect(page.getByText('This listing meets the submission requirements.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted to Himma for review.')).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a6-submitted.png`), fullPage: true });

  // Task 7 — approval ≠ publication, then publish.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}`);
  await expect(page.getByText(/approval and publication are separate steps/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish listing' }).click();
  await expect(page.getByText(/Published\. Customers can find it subject to the visibility checks/)).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a7-published.png`), fullPage: true });

  // Task 8 — pause (reversible), reading the confirmation.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${ADULT_SWIMMING_ID}`);
  await page.getByRole('button', { name: 'Pause listing' }).click();
  const pauseDialog = page.getByRole('dialog');
  await expect(pauseDialog.getByText(/You can resume publishing at any time/)).toBeVisible();
  await pauseDialog.getByRole('button', { name: 'Pause listing' }).click();
  await expect(page.getByRole('button', { name: 'Resume publishing' })).toBeVisible();

  // Task 9 — protected live edit: the pending-review truth carries itself.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${JUNIOR_SQUAD_ID}/edit`);
  await expect(page.getByText(/A change is already awaiting Himma review/).first()).toBeVisible();
  await page.getByRole('link', { name: 'View the pending review' }).click();
  await expect(page.getByText(/keep their current values until Himma finishes the review/)).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a9-pending-review.png`), fullPage: true });

  // Task 10 — import preview with the walkthrough sample file.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await page.getByLabel('Choose a CSV file').setInputFiles(join(FIXTURES, 'walkthrough-import-sample.csv'));
  await page.getByRole('button', { name: 'Run the validation preview' }).click();
  await expect(page.getByText(/nothing has been imported yet/)).toBeVisible();
  await expect(page.getByText('Autumn Swim Camp')).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a10-import.png`), fullPage: true });

  // Task 11 — placeholders read as future functionality.
  await openNav(page, 'Schedule');
  await expect(page.getByText('Coming in a later production milestone.')).toBeVisible();
  await noHorizontalOverflow(page);
});

test('Scenario A (Huda, tasks 12–13): organization-not-live publication gate and verification status comprehension', async ({
  page,
}, testInfo) => {
  test.skip(isMobile(page) || testInfo.project.name === 'tablet', 'primary walkthrough runs at desktop');

  await signInAs(page, 'stages@himma.demo');
  // Task 12 — the approved Pearl listing cannot go public: the block is the
  // ORGANIZATION's verification, linked to its status page.
  await clientGoto(page, `/o/${PEARL_ID}/listings/${PEARL_FREEDIVING_ID}`);
  await expect(page.getByText(/Your organization isn’t live on Himma yet/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish listing' })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a12-org-not-live.png`), fullPage: true });
  await page.getByRole('link', { name: 'Check your verification status' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();

  // Task 13 — Sunrise reads as submitted/awaiting Himma, not an error.
  await clientGoto(page, `/o/${SUNRISE_ID}/onboarding`);
  await expect(page.getByText(/Submitted for review|Himma is reviewing/).first()).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-a13-verification.png`), fullPage: true });
});

test('Scenario B (Listings Editor, tasks 14–17): workspace retry → changes-requested loop → approved-but-cannot-publish → dashboard wording', async ({
  page,
}, testInfo) => {
  test.skip(isMobile(page) || testInfo.project.name === 'tablet', 'primary walkthrough runs at desktop');

  // Task 14 — the deliberate one-time workspace hiccup recovers via its own copy.
  await signInAs(page, 'flaky@bluewave.demo');
  const retry = page.getByRole('button', { name: 'Try again' });
  if (await retry.isVisible().catch(() => false)) {
    await page.screenshot({ path: join(evidence, `${testInfo.project.name}-b14-retry.png`), fullPage: true });
    await retry.click();
  }
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  // Task 15 — handle the changes-requested listing and resubmit.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${AQUA_THERAPY_ID}/edit`);
  await expect(page.getByText(/Himma asked for changes before this listing can be approved/)).toBeVisible();
  await page.getByLabel('Title (English)').fill('Aqua Therapy Sessions Plus');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  await page.getByRole('link', { name: 'the listing page' }).click();
  await page.getByRole('button', { name: 'Resubmit for review' }).click();
  await expect(page.getByText('Resubmitted to Himma for review.')).toBeVisible();

  // Task 16 — approved listing: preparation done, publication is someone else's step.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}`);
  await expect(page.getByText(/Publishing is a separate step that an Owner or Organization Manager takes/)).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: /publish|pause|archive/i })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-b16-awaiting-publisher.png`), fullPage: true });

  // Task 17 — dashboard says who publishes.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}`);
  await expect(page.getByText(/an Owner or Organization Manager publishes them/)).toBeVisible();
});

test('Scenario C (Branch Manager, tasks 18–21): scoped index → scope-limited detail → in-scope resubmit → scoped import validation', async ({
  page,
}, testInfo) => {
  test.skip(isMobile(page) || testInfo.project.name === 'tablet', 'primary walkthrough runs at desktop');

  await signInAs(page, 'manager@bluewave.demo');
  // Task 18 — the index explains the scoped view.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings`);
  await expect(page.getByText(/listings that run at your assigned branches/)).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-c18-scoped-index.png`), fullPage: true });

  // Task 19 — readable-but-not-editable explains itself (W2-11 preflight fix).
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${MASTERS_TRAINING_ID}`);
  await expect(
    page.getByText(/runs at branches outside your assigned branches, so it can’t be edited from your branch scope/),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Edit listing' })).toHaveCount(0);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-c19-scope-limit.png`), fullPage: true });

  // Task 20 — in-scope resubmission works.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${AQUA_THERAPY_ID}`);
  await page.getByRole('button', { name: 'Resubmit for review' }).click();
  await expect(page.getByText('Resubmitted to Himma for review.')).toBeVisible();

  // Task 21 — scoped import: the out-of-scope branch row reads as policy.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await expect(page.getByText(/Your branch scope: Dubai Marina pool/)).toBeVisible();
  await page.getByLabel('Choose a CSV file').setInputFiles(join(FIXTURES, 'walkthrough-import-scoped-sample.csv'));
  await page.getByRole('button', { name: 'Run the validation preview' }).click();
  await expect(page.getByText('“Business Bay pool” is outside your branch scope.')).toBeVisible();
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-c21-scoped-import.png`), fullPage: true });
});

test('responsive spot-check (mobile): lifecycle status area and import preview stay operable', async ({
  page,
}, testInfo) => {
  test.skip(!isMobile(page), 'mobile-only spot check');

  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}`);
  await expect(page.getByRole('button', { name: 'Publish listing' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-spot-lifecycle.png`), fullPage: true });

  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/import`);
  await page.getByLabel('Choose a CSV file').setInputFiles(join(FIXTURES, 'walkthrough-import-sample.csv'));
  await page.getByRole('button', { name: 'Run the validation preview' }).click();
  await expect(page.getByText(/nothing has been imported yet/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: join(evidence, `${testInfo.project.name}-spot-import.png`), fullPage: true });
});
