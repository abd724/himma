import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  attentionItems,
  awaitingHimmaItems,
} from '../src/pages/dashboard/dashboard-domain';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const sunrise = fixtureOrganizations.sunrise;
const desertBloom = fixtureOrganizations.desertBloom;

const dashboardPath = (ref: { organizationId: string }) => `/o/${ref.organizationId}`;

/** Future-only metrics that must never exist until their backends do. */
const FAKE_METRICS =
  /revenue|GMV|payout|booking|participant|attendance|occupancy|utilization|conversion|rating|review score|\d+ customers|goal|target|vs last|% (up|down)|chart/i;

async function findKpi(label: string) {
  const kpis = await screen.findByRole('list', { name: 'Key numbers' });
  const item = (await within(kpis).findByText(label)).closest('li')!;
  return item;
}

async function kpiValue(label: string): Promise<string> {
  const item = await findKpi(label);
  return item.querySelector('span')!.textContent ?? '';
}

async function waitForAttentionLoaded() {
  const section = (await screen.findByRole('heading', { name: 'Needs your attention' })).closest(
    'section',
  )!;
  await waitFor(() =>
    expect(within(section).queryByText('Checking your catalogue…')).not.toBeInTheDocument(),
  );
  return section;
}

describe('provider dashboard (W2-11 owner correction)', () => {
  test('Owner KPIs derive from real scoped fixture truth: published 3 · needs attention 4 (exact rule) · branches 2 · team 8', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await waitForAttentionLoaded();
    // Published listings from the caller's reachable catalogue.
    await waitFor(async () => expect(await kpiValue('Published listings')).toBe('3'));
    // Needs attention — EXACTLY: 1 changes_requested + 1 approved (owner
    // holds listings.publish) + 2 provably-incomplete drafts (no branch /
    // no price option via the card projection). Not drafts in general, not
    // submitted/in_review, not archived.
    expect(await kpiValue('Needs attention')).toBe('4');
    // Active branches (Sufouh is deactivated).
    expect(await kpiValue('Active branches')).toBe('2');
    // Active team members (staff.read is Owner-only).
    expect(await kpiValue('Team members')).toBe('8');
  });

  test('W2-12D: an exhausted catalogue walk is honestly UNAVAILABLE — never a silently truncated count presented as complete', async () => {
    const { loadCatalogueSummary } = await import('../src/pages/dashboard/dashboard-domain');
    const endless = {
      listListings: async () => ({
        kind: 'loaded' as const,
        page: { programs: [], nextCursor: 'always-more' },
      }),
      loadListing: async () => ({ kind: 'unavailable' as const }),
    };
    await expect(loadCatalogueSummary(endless, 'org')).resolves.toEqual({ kind: 'unavailable' });
  });

  test('the needs-attention rule is exact and role-aware (domain-level lock)', () => {
    // Since W2-12C1 each summary row carries its own card projection.
    const completeCard = {
      priceSummary: { kind: 'from', amountFils: 100 },
      branchSummary: { firstLabel: 'B', activeCount: 1 },
      thumbnailUrl: null,
    } as const;
    const activityType = { id: 't', labelEn: 'Type', active: true } as const;
    const base = { activityType, version: 1, createdAt: '1', updatedAt: '1', ...completeCard } as const;
    const rows = [
      { ...base, id: 'a', titleEn: 'CR', listingState: 'changes_requested' },
      { ...base, id: 'b', titleEn: 'Approved', listingState: 'approved' },
      {
        ...base,
        id: 'c',
        titleEn: 'Draft incomplete',
        listingState: 'draft',
        priceSummary: { kind: 'none' } as const,
        branchSummary: { firstLabel: null, activeCount: 0 },
      },
      { ...base, id: 'd', titleEn: 'Draft complete', listingState: 'draft' },
      { ...base, id: 'e', titleEn: 'Submitted', listingState: 'submitted' },
      { ...base, id: 'f', titleEn: 'Archived', listingState: 'archived' },
      { ...base, id: 'g', titleEn: 'Published', listingState: 'published' },
    ] as const;

    const publisher = attentionItems({ rows, canPublish: true, organizationVerificationState: 'live' });
    expect(publisher.map((item) => item.kind)).toEqual([
      'changesRequested',
      'approvedReadyToPublish',
      'draftIncomplete',
    ]);

    // Without publication authority, approved is NOT the caller's action.
    const editor = attentionItems({ rows, canPublish: false, organizationVerificationState: 'live' });
    expect(editor.map((item) => item.kind)).toEqual(['changesRequested', 'draftIncomplete']);

    // Organization setup counts once for draft/rejected states only.
    expect(
      attentionItems({ rows: [], canPublish: true, organizationVerificationState: 'rejected' })[0],
    ).toEqual({ kind: 'organizationSetup', verificationState: 'rejected' });
    expect(
      attentionItems({ rows: [], canPublish: true, organizationVerificationState: 'submitted' }),
    ).toHaveLength(0);

    // Awaiting Himma: submitted/in_review listings + org verification.
    const awaiting = awaitingHimmaItems({ rows, organizationVerificationState: 'submitted' });
    expect(awaiting.map((item) => item.kind)).toEqual(['organizationVerification', 'listing']);
  });

  test('attention rows link to the right surfaces; submitted/in-review sit under "Awaiting Himma", never as provider actions', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    const section = await waitForAttentionLoaded();

    const changesRow = await within(section).findByRole('link', { name: /Aqua Therapy Sessions/ });
    expect(changesRow).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings/${fixtureListings.aquaTherapy}`,
    );
    expect(within(section).getByText(/make the corrections, then resubmit/)).toBeInTheDocument();
    const approvedRow = within(section).getByRole('link', { name: /Private Swim Coaching/ });
    expect(within(approvedRow).getByText(/publish when you’re ready/)).toBeInTheDocument();
    expect(within(section).getByText(/needs a price option before it can be submitted/)).toBeInTheDocument();
    expect(within(section).getByText(/needs a branch before it can be submitted/)).toBeInTheDocument();

    // Awaiting Himma is separate and carries no action framing.
    const awaiting = within(section).getByRole('heading', { name: 'Awaiting Himma' }).closest('div')!;
    expect(within(awaiting).getByRole('link', { name: 'School Term Program' })).toBeInTheDocument();
    expect(within(awaiting).getByRole('link', { name: 'Stroke Development Clinic' })).toBeInTheDocument();
    expect(within(awaiting).getByText(/nothing you need to do/)).toBeInTheDocument();
    // Neither appears in the provider-action list.
    expect(within(section).queryByText(/School Term Program.*resubmit/)).not.toBeInTheDocument();
  });

  test('a Listings Editor sees the approved listing as awaiting SOMEONE ELSE’S publication — not as their own action, and gains no publication control', async () => {
    renderPortal({ asIdentity: 'flaky@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    const section = await waitForAttentionLoaded();
    // 1 CR + 2 incomplete drafts; approved NOT counted for a non-publisher.
    expect(await kpiValue('Needs attention')).toBe('3');
    expect(within(section).queryByRole('link', { name: /Private Swim Coaching/ })).not.toBeInTheDocument();
    expect(screen.getByRole('main').textContent).not.toMatch(/publish when you’re ready/i);
    // No Team KPI without staff.read.
    const kpis = screen.getByRole('list', { name: 'Key numbers' });
    expect(within(kpis).queryByText('Team members')).not.toBeInTheDocument();
  });

  test('a Branch Manager gets scoped truth only: scoped KPI wording, no org-wide counts, no out-of-scope rows', async () => {
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    const section = await waitForAttentionLoaded();
    expect(
      screen.getByText(/Listing numbers cover the listings you can access/),
    ).toBeInTheDocument();
    expect(await findKpi('Published (your scope)')).toBeInTheDocument();

    // Scoped totals equal the port's reachable set, never the org's 12.
    runtime.seedSession('manager@bluewave.demo');
    const scoped = await runtime.listingsPort.listListings(blueWave.organizationId, { limit: 100 });
    if (scoped.kind !== 'loaded') throw new Error(scoped.kind);
    const scopedPublished = scoped.page.programs.filter((row) => row.listingState === 'published').length;
    await waitFor(async () => expect(await kpiValue('Published (your scope)')).toBe(String(scopedPublished)));

    // The Bay-only approved listing is invisible in every dashboard area.
    expect(screen.getByRole('main').textContent).not.toMatch(/Private Swim Coaching/);
    expect(within(section).queryByRole('link', { name: /School Term Program/ })).not.toBeInTheDocument();
  });

  test('the dashboard reflects lifecycle mutations immediately (shared truth)', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const published = await runtime.listingLifecyclePort.publishProgram(
      blueWave.organizationId,
      fixtureListings.privateCoaching,
      2,
    );
    expect(published.kind).toBe('programPublished');

    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    await waitForAttentionLoaded();
    await waitFor(async () => expect(await kpiValue('Published listings')).toBe('4'));
    // The approved item left the attention set (3 = CR + 2 drafts).
    expect(await kpiValue('Needs attention')).toBe('3');
  });

  test('an organization still being verified prioritizes setup truth: rejected → attention action; submitted → Awaiting Himma; empty catalogue stays useful', async () => {
    const first = renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [dashboardPath(desertBloom)],
    });
    let section = await waitForAttentionLoaded();
    const setupRow = within(section).getByRole('link', { name: /Finish setting up your organization/ });
    expect(setupRow).toHaveAttribute('href', `/o/${desertBloom.organizationId}/onboarding`);
    expect(within(section).getByText(/review and resubmit/)).toBeInTheDocument();
    first.unmount();

    renderPortal({ asIdentity: 'stages@himma.demo', initialEntries: [dashboardPath(sunrise)] });
    section = await waitForAttentionLoaded();
    // Submitted verification is Himma's step — never a provider action row.
    expect(within(section).getByText(/You’re up to date/)).toBeInTheDocument();
    const awaiting = within(section).getByRole('heading', { name: 'Awaiting Himma' }).closest('div')!;
    expect(within(awaiting).getByText('Organization verification')).toBeInTheDocument();
    // Empty catalogue keeps the useful creation entry.
    const catalogue = screen.getByRole('heading', { name: 'Catalogue' }).closest('section')!;
    expect(within(catalogue).getByText('No listings yet.')).toBeInTheDocument();
    expect(within(catalogue).getByRole('link', { name: 'Create your first listing' })).toBeInTheDocument();
  });

  test('the compact catalogue overview shows the exact lifecycle vocabulary with counts, scope-aware', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    await waitForAttentionLoaded();
    const overview = await screen.findByRole('list', { name: 'Listings by status' });
    const cell = (label: string) =>
      within(overview)
        .getAllByRole('listitem')
        .find((item) => item.textContent?.includes(label))!;
    expect(within(cell('Published')).getByText('3')).toBeInTheDocument();
    expect(within(cell('Draft')).getByText('3')).toBeInTheDocument();
    expect(within(cell('Changes requested')).getByText('1')).toBeInTheDocument();
    expect(within(cell('Approved — not published')).getByText('1')).toBeInTheDocument();
  });

  test('recently updated lists the newest reachable listings with thumbnails from the card projection', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    await waitForAttentionLoaded();
    const recent = (await screen.findByRole('heading', { name: 'Recently updated' })).closest('section')!;
    // Junior Swim Squad (updated 1 Aug) leads with its resolved thumbnail.
    const rows = within(recent).getAllByRole('link');
    expect(rows[0]).toHaveAccessibleName(/Junior Swim Squad/);
    await waitFor(() =>
      expect(rows[0]!.querySelector('img')).toHaveAttribute('src', '/fixture-media/swim-race.jpg'),
    );
    expect(rows.length).toBeLessThanOrEqual(4);
  });

  test('no fabricated business metrics anywhere: no bookings, participants, revenue, growth %, charts, or goals', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    await waitForAttentionLoaded();
    await screen.findByRole('heading', { name: 'Recently updated' });
    expect(screen.getByRole('main').textContent).not.toMatch(FAKE_METRICS);
    expect(screen.getByRole('main').querySelector('canvas, svg[class*="chart"]')).toBeNull();
  });

  test('KPI cards navigate: published → listings, branches → branches, team → team, attention → the attention section anchor', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    await waitForAttentionLoaded();
    expect(within(await findKpi('Published listings')).getByRole('link')).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings`,
    );
    expect(within(await findKpi('Active branches')).getByRole('link')).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/branches`,
    );
    expect(within(await findKpi('Team members')).getByRole('link')).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/team`,
    );
    expect(within(await findKpi('Needs attention')).getByRole('link')).toHaveAttribute(
      'href',
      '#dashboard-attention',
    );
  });

  test('roles without catalogue access get the org-status dashboard with no listing/staff fetch', async () => {
    const runtime = createFixtureAuthRuntime();
    const listingsSpy = jest.spyOn(runtime.listingsPort, 'listListings');
    const staffSpy = jest.spyOn(runtime.teamPort, 'loadStaff');
    renderPortal({
      runtime,
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    await screen.findByRole('heading', { name: 'Organization' });
    expect(
      await screen.findByText(/Your role’s dashboard covers organization status/),
    ).toBeInTheDocument();
    const kpis = screen.getByRole('list', { name: 'Key numbers' });
    expect(within(kpis).queryByText(/Published/)).not.toBeInTheDocument();
    expect(within(kpis).getByText('Active branches')).toBeInTheDocument();
    expect(listingsSpy).not.toHaveBeenCalled();
    expect(staffSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('main').textContent).not.toMatch(FAKE_METRICS);
  });

  test('a catalogue failure degrades the attention area with retry while the rest stands', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.controls.failNextListingsLoad(blueWave.organizationId);
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [dashboardPath(blueWave)] });
    const orgCard = (await screen.findByRole('heading', { name: 'Organization' })).closest('section')!;
    expect(within(orgCard).getByText('Live on Himma')).toBeInTheDocument();
    const section = (await screen.findByRole('heading', { name: 'Needs your attention' })).closest('section')!;
    expect(await within(section).findByText(/We couldn’t check your catalogue/)).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Try again' }));
    await waitFor(async () => expect(await kpiValue('Needs attention')).toBe('4'));
  });
});
