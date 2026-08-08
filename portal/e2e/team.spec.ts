import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { evidenceDir, isMobile, noHorizontalOverflow, signInAs, FIXTURE_TOTP_CODE } from './support';

/**
 * W2-6 Team & Staff over the production build (fixture opt-in), across the
 * three viewport projects. All post-sign-in navigation stays client-side
 * (fixture sessions are memory-only).
 */
const evidence = evidenceDir('portal-w2-6');

const BLUE_WAVE_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e01';
const NOOR_ID = '0198a2f0-5b7a-7000-8000-1f4a2d9c6e02';
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

async function clientGoto(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function openTeam(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page
      .getByRole('dialog', { name: 'Navigation' })
      .getByRole('link', { name: 'Team' })
      .click();
  } else {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Team' })
      .click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
}

test('owner journey: directory → invite with branch scope → pending appears → withdraw invitation', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await openTeam(page);

  // Populated directory: exact vocabulary, You marker, history apart.
  const members = page.getByRole('list', { name: 'Team members' });
  await expect(members.getByText('Listings Editor / Scheduler')).toBeVisible();
  await expect(members.getByText('Front Desk / Booking Employee')).toBeVisible();
  await expect(members.getByText('You')).toBeVisible();
  await expect(page.getByText('8 people have active access')).toBeVisible();
  await expect(page.getByText('Former members (1)')).toBeVisible();
  // Invitations are a separate truth with real lifecycle words.
  await expect(page.getByText('Awaiting response')).toBeVisible();
  await expect(page.getByText(/it can no longer be accepted/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-team-directory.png`),
    fullPage: true,
  });

  // Invite flow with the responsive scope editor.
  await page.getByRole('link', { name: 'Invite someone' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Invite someone' })).toBeVisible();
  await page.getByLabel('Email address').fill('evening.coach@bluewave.example');
  await page.getByLabel('Role').selectOption('coach');
  await page.getByRole('radio', { name: /Specific branches/ }).click();
  await page.getByRole('checkbox', { name: /Business Bay pool/ }).click();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-invite-scope-editor.png`),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Invitation sent' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-invite-success.png`),
    fullPage: true,
  });

  // The pending invitation appears in the shared truth.
  await page.getByRole('link', { name: 'Back to Team' }).click();
  const open = page.getByRole('list', { name: 'Open invitations' });
  await expect(open.getByText('evening.coach@bluewave.example')).toBeVisible();

  // Withdraw it with the consequence dialog.
  const row = open.getByRole('listitem').filter({ hasText: 'evening.coach@bluewave.example' });
  await row.getByRole('button', { name: 'Withdraw' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/never removes an existing team member/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-withdraw-confirmation.png`),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Withdraw invitation' }).click();
  await expect(
    page.getByText(/The invitation for evening.coach@bluewave.example has been withdrawn/),
  ).toBeVisible();
});

test('member detail: branch-manager scope truth, change-access explanation, removal with step-up round trip', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/team`);
  const members = page.getByRole('list', { name: 'Team members' });
  await members.getByText('Branch Manager').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Branch Manager' })).toBeVisible();
  await expect(page.getByText('Dubai Marina pool')).toBeVisible();
  await expect(page.getByText(/Access history is never edited/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-member-detail-branch-manager.png`),
    fullPage: true,
  });

  // The recent-verification window lapses; removal routes through /step-up
  // and returns for an explicit re-confirmation.
  await page.evaluate(() => window.__himmaPortalAccessFixture?.expireStepUpWindow());
  await page.getByRole('button', { name: 'Remove access' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText(/Branch Manager · Dubai Marina pool/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-remove-access-confirmation.png`),
    fullPage: true,
  });
  await confirm.getByRole('button', { name: 'Remove access' }).click();

  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-step-up-interstitial.png`),
    fullPage: true,
  });
  await page.getByLabel('Verification code').fill(FIXTURE_TOTP_CODE);
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByText(/Thanks for confirming it’s you/)).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-step-up-reconfirm.png`),
    fullPage: true,
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Remove access' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
  await expect(page.getByText('7 people have active access')).toBeVisible();
  await expect(page.getByText('Former members (2)')).toBeVisible();
});

test('stale conflict: a concurrent change refuses the removal and the reload re-arms it', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'owner@bluewave.demo');
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/team`);
  await page.getByRole('list', { name: 'Team members' }).getByText('Coach / Instructor').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Coach / Instructor' })).toBeVisible();

  // Another owner changes this membership row first.
  await page.evaluate((orgId) => {
    const controls = window.__himmaPortalAccessFixture;
    // The coach row id is stable fixture data.
    controls?.simulateConcurrentStaffChange(orgId, '0198a2f0-5b7a-7000-8000-5e9f6a1b8d07');
  }, BLUE_WAVE_ID);

  await page.getByRole('button', { name: 'Remove access' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove access' }).click();
  await expect(page.getByText(/nothing was changed/)).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-stale-conflict.png`),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Load the latest team' }).click();
  await expect(page.getByRole('button', { name: 'Remove access' })).toBeVisible();
});

test('read-only roles: front desk gets the truthful no-access surface and no Team navigation item', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'frontdesk@bluewave.demo');
  // Team never renders in this role's navigation…
  if (!isMobile(page)) {
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Branches' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Team' })).toHaveCount(0);
  }
  // …and the direct URL renders the honest explanation with no staff data.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/team`);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Team is managed by the Owner' }),
  ).toBeVisible();
  await expect(page.getByText(/@bluewave.demo/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Invite someone' })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-team-no-access.png`),
    fullPage: true,
  });
});

test('last-owner protection: the sole active Owner cannot be removed and the page says why', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'director@himma.demo');
  // Switch to Noor (sole owner org) via deep link.
  await clientGoto(page, `/o/${NOOR_ID}/team`);
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
  await page.getByRole('list', { name: 'Team members' }).getByText('Owner').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Owner (you)' })).toBeVisible();
  await expect(
    page.getByText(/Every organization keeps at least one Owner with active access/).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove access' })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-last-owner-protection.png`),
    fullPage: true,
  });
});

test('suspended organization: directory readable, all team mutations unavailable', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'director@himma.demo');
  await clientGoto(page, `/o/${FALCON_ID}/team`);
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
  await expect(
    page.getByText('This organization is currently suspended. Changes are unavailable.').first(),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Team members' })).toBeVisible();
  await expect(page.getByText('coach@falcon.example')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invite someone' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: join(evidence, `${testInfo.project.name}-team-suspended.png`),
    fullPage: true,
  });
});

test('organization switching shows only the addressed organization’s team', async ({ page }) => {
  await signInAs(page, 'director@himma.demo');
  await clientGoto(page, `/o/${NOOR_ID}/team`);
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
  await expect(page.getByText('2 people have active access')).toBeVisible();
  await expect(page.getByText(/bluewave/)).toHaveCount(0);
  // At Blue Wave the same person is Organization Manager: no staff read.
  await clientGoto(page, `/o/${BLUE_WAVE_ID}/team`);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Team is managed by the Owner' }),
  ).toBeVisible();
  await expect(page.getByText('coach@falcon.example')).toHaveCount(0);
});
