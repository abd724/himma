import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, isMobile, noHorizontalOverflow, signInAs } from './support';

/**
 * W2-5 branches over the production build (fixture opt-in), across the three
 * viewport projects. All post-sign-in navigation stays client-side (fixture
 * sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-5');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const CORAL_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e04';
const FALCON_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e03';

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

/**
 * Client-side deep link: fixture sessions are memory-only, so a full
 * `page.goto` would sign the session out. React Router subscribes to
 * popstate — pushState + popstate performs an in-app navigation.
 */
async function clientGoto(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function openBranches(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('link', { name: 'Branches' })
      .click();
  } else {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Branches' })
      .click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Branches' })).toBeVisible();
}

test('owner journey: populated list → edit with facilities → save → deactivation confirmation', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await openBranches(page);

  // Populated index: creation order, status words, no fabricated metrics.
  const list = page.getByRole('list', { name: 'Branches' });
  await expect(list.getByText('Dubai Marina pool')).toBeVisible();
  await expect(list.getByText('Al Sufouh training pool')).toBeVisible();
  await expect(page.getByText('2 active branches · 1 deactivated branch')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-list.png`),
    fullPage: true,
  });

  // Detail/editor for an active branch.
  await list.getByText('Dubai Marina pool').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dubai Marina pool' })).toBeVisible();
  await expect(page.getByLabel('Branch name')).toHaveValue('Dubai Marina pool');
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-editor.png`),
    fullPage: true,
  });

  // Edit: add a facility and save the dirty-field patch.
  await page.getByLabel('Add a facility').fill('Café');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved — this branch is up to date/)).toBeVisible();

  // Deactivation flow: explicit confirmation, generic consequence, cancel.
  await page.getByRole('button', { name: 'Deactivate branch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Deactivate Dubai Marina pool?' });
  await expect(dialog.getByText(/can become unavailable/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-deactivate-confirmation.png`),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Keep branch active' }).click();
  await expect(dialog).toBeHidden();
});

test('deactivated branch shows the one-way truth and a historical area stays preserved', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/branches`);
  await page.getByRole('list', { name: 'Branches' }).getByText('Al Sufouh training pool').click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Al Sufouh training pool' }),
  ).toBeVisible();
  await expect(page.getByText(/can’t be reactivated from the portal/)).toBeVisible();
  // The historical area label renders as the current, non-reselectable value.
  await expect(page.getByLabel('Area')).toHaveValue('Al Sufouh');
  await expect(page.getByRole('button', { name: 'Deactivate branch' })).toBeHidden();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-deactivated.png`),
    fullPage: true,
  });
});

test('stale-version conflict: reload keeps edits, then the save succeeds', async ({ page }, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/branches`);
  await page.getByRole('list', { name: 'Branches' }).getByText('Business Bay pool').click();
  const nameField = page.getByLabel('Branch name');
  await nameField.fill('Business Bay flagship pool');

  // Another staff member saves first (fixture control on the same store).
  await page.evaluate(
    (target: { organizationId: string; branchId: string }) =>
      window.__himmaPortalAccessFixture?.simulateConcurrentBranchEdit(
        target.organizationId,
        target.branchId,
      ),
    { organizationId: BLUE_WAVE_ID, branchId: '0198a2f0-5b7a-7000-8000-2b6c3e8f7a02' },
  );
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Someone else updated this branch/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-stale-conflict.png`),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Load the latest branch' }).click();
  await expect(page.getByText(/your edits are kept below/)).toBeVisible();
  await expect(nameField).toHaveValue('Business Bay flagship pool');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Saved — this branch is up to date/)).toBeVisible();
});

test('branch-scoped manager: full read, marked assignment, scoped edit reach only', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'manager@bluewave.demo');
  await openBranches(page);
  const list = page.getByRole('list', { name: 'Branches' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByText('Assigned to you')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Add branch' })).toBeHidden();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-scoped-list.png`),
    fullPage: true,
  });

  // Assigned branch: editable, but no deactivation authority.
  await list.getByText('Dubai Marina pool').click();
  await expect(page.getByLabel('Branch name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deactivate branch' })).toBeHidden();

  // Unassigned branch: truthful read-only with the scope explained.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/branches/0198a2f0-5b7a-7000-8000-2b6c3e8f7a02`);
  await expect(page.getByText(/isn’t assigned to you/)).toBeVisible();
  await expect(page.getByLabel('Branch name')).toBeHidden();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-scoped-readonly.png`),
    fullPage: true,
  });

  // An unknown branch id renders the safe not-found shape.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/branches/0198a2f0-5b7a-7000-8000-2b6c3e8f7aff`);
  await expect(page.getByRole('heading', { level: 1, name: 'Branch not found' })).toBeVisible();
});

test('read-only role sees the record without mutation affordances', async ({ page }, testInfo) => {
  await signInAs(page, 'frontdesk@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/branches/0198a2f0-5b7a-7000-8000-2b6c3e8f7a01`);
  await expect(page.getByRole('heading', { level: 1, name: 'Dubai Marina pool' })).toBeVisible();
  await expect(page.getByText(/An owner or organization manager makes changes here/)).toBeVisible();
  await expect(page.getByLabel('Branch name')).toBeHidden();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-readonly-role.png`),
    fullPage: true,
  });
});

test('empty state directs an authorized owner into creation; create completes the onboarding requirement', async ({
  page,
}, testInfo) => {
  // Founding owner accepts the Coral invitation, then builds the first branch.
  await signInAs(page, 'newowner@coral.demo');
  await clientGoto(page, '/invitation/HIMMA-INVITE-OWNER-CORAL');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();

  await clientGoto(page, `/o/${CORAL_ID}/branches`);
  await expect(page.getByRole('heading', { level: 2, name: 'No branches yet' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-empty.png`),
    fullPage: true,
  });

  await page.getByRole('link', { name: 'Add your first branch' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add branch' })).toBeVisible();
  await page.getByLabel('Branch name').fill('Climbing hall');
  await page.getByLabel('Area').selectOption('Al Barsha');
  await page.getByLabel('Address line').fill('Wall Street Climbing, Unit 3');
  // Structured weekly hours.
  await page.getByLabel('Monday', { exact: true }).check();
  await page.getByLabel('Monday opens at').fill('06:00');
  await page.getByLabel('Monday closes at').fill('22:00');
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-create.png`),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Add branch' }).click();

  // Success lands on the list with the new branch present…
  await expect(
    page.getByRole('list', { name: 'Branches' }).getByText('Climbing hall'),
  ).toBeVisible();
  // …and the shared readiness truth reflects the first active branch: the
  // hub's Branches requirement reads Done (verification itself unmoved).
  await clientGoto(page, `/o/${CORAL_ID}/onboarding`);
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started' })).toBeVisible();
  const branchesRow = page.getByRole('listitem').filter({ hasText: 'Branches' });
  await expect(branchesRow.getByText('Done')).toBeVisible();
});

test('suspended organization: reads stay, mutations are gone', async ({ page }, testInfo) => {
  await signInAs(page, 'director@himma.demo');
  await clientGoto(page, `/o/${FALCON_ID}/branches`);
  await expect(page.getByRole('list', { name: 'Branches' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add branch' })).toBeHidden();
  await expect(page.getByText(/currently suspended/).first()).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-branch-suspended.png`),
    fullPage: true,
  });
});
