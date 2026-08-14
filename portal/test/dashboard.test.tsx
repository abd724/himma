import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  fixtureListings,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const sunrise = fixtureOrganizations.sunrise;

const dashboardPath = (ref: { organizationId: string }) => `/o/${ref.organizationId}`;

/** Fabricated-metric vocabulary that must never exist on the dashboard —
 *  none of these domains has a backend (docs/29 §10). */
const FAKE_METRICS =
  /revenue|GMV|payout|booking|attendance|occupancy|utilization|conversion|rating|review score|\d+ customers/i;

/** Resolves once the catalogue card's ASYNC summary has actually loaded. */
async function findCatalogueCard() {
  const heading = await screen.findByRole('heading', { name: 'Listings' });
  const card = heading.closest('section')!;
  await waitFor(() =>
    expect(within(card).queryByText('Loading your catalogue summary…')).not.toBeInTheDocument(),
  );
  return card;
}

describe('provider dashboard (W2-9)', () => {
  test('Owner: organization status, catalogue counts by REAL lifecycle state from the shared fixture truth, and the team summary', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });

    // Organization card — provider-language verification state + storefront.
    const orgCard = (await screen.findByRole('heading', { name: 'Organization' })).closest('section')!;
    expect(within(orgCard).getByText('Live on Himma')).toBeInTheDocument();
    expect(within(orgCard).getByText(/storefront is published/)).toBeInTheDocument();

    // Catalogue card — counts derive from the SAME fixture truth the index
    // serves (Blue Wave: 12 listings across all eight states).
    const catalogueCard = await findCatalogueCard();
    const counts = within(catalogueCard).getByRole('list', { name: 'Listings by status' });
    const row = (label: string) =>
      within(counts)
        .getAllByRole('listitem')
        .find((item) => item.textContent?.includes(label))!;
    expect(within(row('Draft')).getByText('3')).toBeInTheDocument();
    expect(within(row('Changes requested')).getByText('1')).toBeInTheDocument();
    expect(within(row('Submitted for review')).getByText('1')).toBeInTheDocument();
    expect(within(row('In review')).getByText('1')).toBeInTheDocument();
    expect(within(row('Approved — not published')).getByText('1')).toBeInTheDocument();
    expect(within(row('Published')).getByText('3')).toBeInTheDocument();
    expect(within(row('Paused')).getByText('1')).toBeInTheDocument();
    expect(within(row('Archived')).getByText('1')).toBeInTheDocument();

    // Actionable rows, role-aware for a publication-authorized viewer.
    expect(
      within(catalogueCard).getByText('1 listing needs changes before resubmission'),
    ).toBeInTheDocument();
    expect(
      within(catalogueCard).getByText('1 listing approved and not yet published'),
    ).toBeInTheDocument();
    expect(within(catalogueCard).getByText(/publish when you’re ready/)).toBeInTheDocument();
    expect(within(catalogueCard).getByText('3 listings still in draft')).toBeInTheDocument();

    // Team card (Owner-only staff read): 8 active members, 1 open invitation.
    const teamCard = (await screen.findByRole('heading', { name: 'Team' })).closest('section')!;
    expect(within(teamCard).getByText(/8 active members/)).toBeInTheDocument();
    expect(within(teamCard).getByText(/1 invitation awaiting a response/)).toBeInTheDocument();
  });

  test('no fabricated business metrics of any kind exist on the dashboard', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await findCatalogueCard();
    await screen.findByRole('heading', { name: 'Team' });
    expect(screen.getByRole('main').textContent).not.toMatch(FAKE_METRICS);
  });

  test('the dashboard reflects lifecycle mutations immediately (shared truth, no second source)', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    // Pause a published listing through the REAL lifecycle port first.
    const paused = await runtime.listingLifecyclePort.pauseProgram(
      blueWave.organizationId,
      fixtureListings.adultSwimming,
      2,
    );
    expect(paused.kind).toBe('programPaused');

    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    const catalogueCard = await findCatalogueCard();
    const counts = within(catalogueCard).getByRole('list', { name: 'Listings by status' });
    const row = (label: string) =>
      within(counts)
        .getAllByRole('listitem')
        .find((item) => item.textContent?.includes(label))!;
    expect(within(row('Published')).getByText('2')).toBeInTheDocument();
    expect(within(row('Paused')).getByText('2')).toBeInTheDocument();
  });

  test('a Branch Manager dashboard covers exactly the scoped reachable set — organization-wide counts never leak', async () => {
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      runtime,
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    const catalogueCard = await findCatalogueCard();
    expect(
      within(catalogueCard).getByText('These numbers cover the listings within your branch scope.'),
    ).toBeInTheDocument();

    // The rendered total equals the SCOPED list the real read serves.
    runtime.seedSession('manager@bluewave.demo');
    const scoped = await runtime.listingsPort.listListings(blueWave.organizationId, { limit: 100 });
    if (scoped.kind !== 'loaded') throw new Error(scoped.kind);
    const scopedTotal = scoped.page.programs.length;
    expect(scopedTotal).toBeLessThan(12); // strictly narrower than org-wide

    const counts = within(catalogueCard).getByRole('list', { name: 'Listings by status' });
    const renderedTotal = within(counts)
      .getAllByRole('listitem')
      .map((item) => Number(item.textContent?.match(/(\d+)$/)?.[1] ?? '0'))
      .reduce((sum, value) => sum + value, 0);
    expect(renderedTotal).toBe(scopedTotal);

    // The out-of-scope approved listing (Bay-only Private Swim Coaching)
    // must not surface an approved attention row for this viewer.
    expect(within(catalogueCard).queryByText(/approved and not yet published/)).not.toBeInTheDocument();
    // And no team card: staff.read is Owner-only.
    expect(screen.queryByRole('heading', { name: 'Team' })).not.toBeInTheDocument();
  });

  test('the Listings Editor sees the approved item with the truthful "an Owner or Organization Manager publishes" wording', async () => {
    renderPortal({
      asIdentity: 'flaky@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    const catalogueCard = await findCatalogueCard();
    expect(
      within(catalogueCard).getByText(/an Owner or Organization Manager publishes them/),
    ).toBeInTheDocument();
    expect(within(catalogueCard).queryByText(/publish when you’re ready/)).not.toBeInTheDocument();
  });

  test('roles without catalogue access get a scope-limited dashboard and NO listing fetch (no hidden data reaches their client)', async () => {
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
    expect(screen.queryByRole('heading', { name: 'Listings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Team' })).not.toBeInTheDocument();
    expect(listingsSpy).not.toHaveBeenCalled();
    expect(staffSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('main').textContent).not.toMatch(FAKE_METRICS);
  });

  test('empty catalogue: a truthful first-use state with the creation entry for authorized roles', async () => {
    renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [dashboardPath(sunrise)],
    });
    const orgCard = (await screen.findByRole('heading', { name: 'Organization' })).closest('section')!;
    // Sunrise is submitted-for-verification: the onboarding link is the home.
    expect(within(orgCard).getByText('Submitted for review')).toBeInTheDocument();
    expect(within(orgCard).getByRole('link', { name: 'Continue your onboarding' })).toBeInTheDocument();

    const catalogueCard = await findCatalogueCard();
    expect(within(catalogueCard).getByText('No listings yet.')).toBeInTheDocument();
    expect(
      within(catalogueCard).getByRole('link', { name: 'Create your first listing' }),
    ).toBeInTheDocument();
  });

  test('a catalogue load failure degrades to a retryable card while the rest of the dashboard stands (partial failure)', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.controls.failNextListingsLoad(blueWave.organizationId);
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    // The org card is intact…
    const orgCard = (await screen.findByRole('heading', { name: 'Organization' })).closest('section')!;
    expect(within(orgCard).getByText('Live on Himma')).toBeInTheDocument();
    // …while the catalogue card explains and retries.
    const catalogueCard = await findCatalogueCard();
    expect(
      await within(catalogueCard).findByText(/We couldn’t load your catalogue summary/),
    ).toBeInTheDocument();
    await user.click(within(catalogueCard).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(
        within(catalogueCard).getByRole('list', { name: 'Listings by status' }),
      ).toBeInTheDocument(),
    );
  });

  test('the catalogue attention rows link into the listings workspace', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [dashboardPath(blueWave)],
    });
    const catalogueCard = await findCatalogueCard();
    expect(within(catalogueCard).getByRole('link', { name: 'Go to your listings' })).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings`,
    );
    expect(within(catalogueCard).getByRole('link', { name: 'Create a listing' })).toHaveAttribute(
      'href',
      `/o/${blueWave.organizationId}/listings/new`,
    );
  });
});
