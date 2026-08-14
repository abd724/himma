import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-9 listing lifecycle over the production build (fixture opt-in), across
 * the three viewport projects: named actions only where the viewer truly
 * owns them (D-S4-2 publication authority), approval ≠ publication, pause/
 * archive confirmations, resubmission after changes-requested, the
 * organizationNotLive gate, the revision status page, and the Branch
 * Manager scoped truth. All post-sign-in navigation stays client-side
 * (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-9');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const NOOR_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e02';
const PEARL_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e08';

const NOOR_EXAM_PREP_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f22'; // complete draft
const PRIVATE_COACHING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f04'; // approved
const ADULT_SWIMMING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f01'; // published
const MASTERS_TRAINING_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f09'; // paused
const AQUA_THERAPY_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f08'; // changes_requested
const JUNIOR_SQUAD_ID = '0198a2f0-5b7a-7000-8000-7a1b8c3d9f02'; // open revision
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

test('complete draft → submit for review: success only after the port confirms, then Himma owns the next step', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'director@himma.demo');
  await clientGoto(page, `/o/${NOOR_ID}/listings/${NOOR_EXAM_PREP_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Exam Prep Intensive' })).toBeVisible();
  await expect(page.getByText('This listing meets the submission requirements.')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-draft-ready.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted to Himma for review.')).toBeVisible();
  await expect(page.getByText('Submitted for review').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /submit/i })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-draft-submitted.png`),
    fullPage: true,
  });
});

test('changes requested → resubmit through the same action, with the truthful generic state (no invented feedback)', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${AQUA_THERAPY_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Aqua Therapy Sessions' })).toBeVisible();
  await expect(page.getByText('Changes requested').first()).toBeVisible();
  await expect(page.getByText(/asked for changes before it can be approved|needs your attention and a new submission/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-changes-requested.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Resubmit for review' }).click();
  await expect(page.getByText('Resubmitted to Himma for review.')).toBeVisible();
  await expect(page.getByText('Submitted for review').first()).toBeVisible();
});

test('approved → publish as Owner: the separation is explicit, publication is a deliberate act, visibility gates follow', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Private Swim Coaching' })).toBeVisible();
  await expect(page.getByText('Approved — not published').first()).toBeVisible();
  await expect(page.getByText(/approval and publication are separate steps/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-approved-owner.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Publish listing' }).click();
  await expect(page.getByText(/Published\. Customers can find it subject to the visibility checks/)).toBeVisible();
  await expect(page.getByText('Customers can find this listing on Himma.')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-approved-published.png`),
    fullPage: true,
  });
});

test('approved as Listings Editor: NO publish control exists — only the truthful explanation', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'flaky@bluewave.demo');
  // The flaky identity's first access resolution fails by design — the
  // retry surface is part of the covered access UX.
  const retry = page.getByRole('button', { name: 'Try again' });
  if (await retry.isVisible().catch(() => false)) {
    await retry.click();
  }
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${PRIVATE_COACHING_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Private Swim Coaching' })).toBeVisible();
  await expect(
    page.getByText(/Publishing is a separate step that an Owner or Organization Manager takes/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /publish|pause|archive/i })).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-approved-listings-editor.png`),
    fullPage: true,
  });
});

test('published → pause (confirmed, visibility consequence named) → resume', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${ADULT_SWIMMING_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Adult Beginner Swimming' })).toBeVisible();

  await page.getByRole('button', { name: 'Pause listing' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Customers will no longer find it on Himma/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-pause-confirm.png`),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Pause listing' }).click();
  await expect(page.getByText(/Paused\. Customers can no longer find this listing/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume publishing' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-paused.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Resume publishing' }).click();
  await expect(page.getByText(/Publishing resumed/)).toBeVisible();
  await expect(page.getByText('Published').first()).toBeVisible();
});

test('archive is confirmed as permanent and lands in a terminal state with zero controls', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${MASTERS_TRAINING_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Masters Training' })).toBeVisible();

  await page.getByRole('button', { name: 'Archive listing' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/final and can’t be reversed/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-archive-confirm.png`),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Archive permanently' }).click();
  await expect(page.getByText(/Archived\. This listing is permanently retired\./)).toBeVisible();
  await expect(page.getByText(/Archiving is final/)).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('button', { name: /publish|pause|resume|archive|restore/i }),
  ).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-archived-terminal.png`),
    fullPage: true,
  });
});

test('open revision: the pending review page tells the live-values truth with no decision control', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${JUNIOR_SQUAD_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Junior Swim Squad' })).toBeVisible();
  await page.getByRole('link', { name: 'View the pending review' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pending review' })).toBeVisible();
  await expect(
    page.getByText('A protected change on this listing is with Himma for review.'),
  ).toBeVisible();
  await expect(
    page.getByText(/keep their current values until Himma finishes the review/),
  ).toBeVisible();
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-revision-pending.png`),
    fullPage: true,
  });
});

test('organizationNotLive: publication is gated by the ORGANIZATION, never mislabeled as listing incompleteness', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'stages@himma.demo');
  await clientGoto(page, `/o/${PEARL_ID}/listings/${PEARL_FREEDIVING_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Freediving Foundations' })).toBeVisible();
  await expect(
    page.getByText(/Your organization isn’t live on Himma yet, so listings can’t be published/),
  ).toBeVisible();
  await expect(page.getByText(/still needs/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish listing' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Check your verification status' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-organization-not-live.png`),
    fullPage: true,
  });
});

test('Branch Manager scoped truth: submit within scope, never publication authority', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  // Reachable paused listing: publication stays with Owner/Org Manager.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${MASTERS_TRAINING_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Masters Training' })).toBeVisible();
  await expect(
    page.getByText('An Owner or Organization Manager can resume publishing this listing.'),
  ).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('button', { name: /publish|pause|resume|archive/i }),
  ).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-manager-paused.png`),
    fullPage: true,
  });

  // A changes-requested listing fully inside the scope IS resubmittable.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/listings/${AQUA_THERAPY_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Aqua Therapy Sessions' })).toBeVisible();
  await page.getByRole('button', { name: 'Resubmit for review' }).click();
  await expect(page.getByText('Resubmitted to Himma for review.')).toBeVisible();
});
