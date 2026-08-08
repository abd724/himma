import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const noor = fixtureOrganizations.noor;
const falcon = fixtureOrganizations.falcon;
const coral = fixtureOrganizations.coral;
const sunrise = fixtureOrganizations.sunrise;

const listingsPath = (ref: { organizationId: string }) => `/o/${ref.organizationId}/listings`;

/** Marketplace truths the backend does not own yet — the index must never
 *  fabricate them (task §28). `sessions` appears only as package metadata
 *  on the DETAIL, never on the index. */
const PROHIBITED_INDEX_VOCABULARY =
  /\b(booked|bookings|capacity|available spots|next session|attendance|customers|revenue|sales|conversion|rating|reviews|popular|payout|payment)\b/i;

describe('listings index (W2-7)', () => {
  test('an Owner sees the operational index: exact lifecycle labels, activity labels, one row per Program, no fabricated metrics', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath(blueWave)] });
    await screen.findByRole('heading', { level: 1, name: 'Listings' });

    const list = await screen.findByRole('list', { name: 'Listings' });
    const rows = within(list).getAllByRole('listitem');
    // The real list contract pages at the portal's chosen size (10).
    expect(rows).toHaveLength(10);
    expect(screen.getByText('10 listings loaded so far')).toBeInTheDocument();

    // One row per Program — a listing with three price options is ONE row.
    expect(within(list).getAllByText('Adult Beginner Swimming')).toHaveLength(1);

    // The exact provider-facing lifecycle vocabulary (docs/24 §5.3).
    expect(within(list).getAllByText('Published').length).toBeGreaterThan(0);
    expect(within(list).getByText('Approved — not published')).toBeInTheDocument();
    expect(within(list).getByText('Submitted for review')).toBeInTheDocument();
    expect(within(list).getByText('In review')).toBeInTheDocument();
    expect(within(list).getByText('Changes requested')).toBeInTheDocument();
    expect(within(list).getByText('Paused')).toBeInTheDocument();

    // Activity labels come from the public taxonomy read.
    expect(within(list).getAllByText(/Swimming ·/).length).toBeGreaterThan(0);

    // Nothing the backend does not own is displayed.
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(PROHIBITED_INDEX_VOCABULARY);
    expect(main.textContent).not.toMatch(/AED/);
  });

  test('cursor pagination: Load more appends the rest and then disappears', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath(blueWave)] });
    const list = await screen.findByRole('list', { name: 'Listings' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);

    await user.click(screen.getByRole('button', { name: 'Load more listings' }));
    await screen.findByText('12 listings');
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    expect(within(list).getByText('Aqua Fitness Express')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more listings' })).not.toBeInTheDocument();
  });

  test('status filtering and title search are honestly client-side over the loaded rows', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath(blueWave)] });
    const list = await screen.findByRole('list', { name: 'Listings' });

    // Filter while a further page exists: the honesty note appears.
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'published');
    expect(
      screen.getByText(
        'Filters apply to the listings loaded so far — load more below to include the rest.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 10 loaded listings/)).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);

    // Search composes with the filter.
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'all');
    await user.type(screen.getByLabelText('Search by title'), 'aqua');
    const filtered = within(list).getAllByRole('listitem');
    expect(filtered).toHaveLength(2);
    expect(within(list).getByText('Ladies Aqua Fitness')).toBeInTheDocument();
    expect(within(list).getByText('Aqua Therapy Sessions')).toBeInTheDocument();

    // A filter with no loaded matches states so without pretending emptiness.
    await user.clear(screen.getByLabelText('Search by title'));
    await user.type(screen.getByLabelText('Search by title'), 'zumba');
    expect(screen.getByText('No loaded listings match your filters.')).toBeInTheDocument();
    expect(screen.queryByText('No listings yet')).not.toBeInTheDocument();
  });

  test.each([
    ['assistant@coral.demo', coral],
    ['frontdesk@bluewave.demo', blueWave],
    ['finance@bluewave.demo', blueWave],
  ])('%s (no catalogue.read) gets the truthful no-access surface and NO listing data is fetched', async (email, org) => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession(email);
    const listSpy = jest.spyOn(runtime.listingsPort, 'listListings');
    renderPortal({ runtime, asIdentity: email, initialEntries: [listingsPath(org)] });

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Listings are managed by your catalogue team',
      }),
    ).toBeInTheDocument();
    expect(listSpy).not.toHaveBeenCalled();
    // No listing titles or lifecycle chips of any kind reached the page.
    expect(screen.queryByRole('list', { name: 'Listings' })).not.toBeInTheDocument();
    // The capability-aware navigation hides the section for these roles.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    await within(nav).findByRole('link', { name: 'Branches' });
    expect(within(nav).queryByRole('link', { name: 'Listings' })).not.toBeInTheDocument();
  });

  test('a branch-scoped Branch Manager sees only reachable listings, with the scope explained', async () => {
    renderPortal({ asIdentity: 'manager@bluewave.demo', initialEntries: [listingsPath(blueWave)] });
    const list = await screen.findByRole('list', { name: 'Listings' });
    expect(
      screen.getByText(
        'You see the listings that run at your assigned branches, plus drafts that aren’t placed at a branch yet.',
      ),
    ).toBeInTheDocument();

    // Reachable: Marina-associated listings + the branchless draft — ALL of
    // them, because scope participates before the pagination window.
    for (const title of [
      'Adult Beginner Swimming',
      'Ladies Aqua Fitness',
      'Holiday Swim Camp',
      'Stroke Development Clinic',
      'Aqua Therapy Sessions',
      'Masters Training',
      'Synchro Performance Squad',
      'Aqua Fitness Express',
    ]) {
      expect(within(list).getByText(title)).toBeInTheDocument();
    }
    // Out of scope (Bay-only or deactivated-branch-only): never listed,
    // not even as counts or status totals.
    for (const title of [
      'Junior Swim Squad',
      'Private Swim Coaching',
      'School Term Program',
      'Sunset Open Water Program',
    ]) {
      expect(within(list).queryByText(title)).not.toBeInTheDocument();
    }
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.queryByRole('button', { name: 'Load more listings' })).not.toBeInTheDocument();
  });

  test('an Organization Manager and a Listings Editor get the full index', async () => {
    renderPortal({ asIdentity: 'director@himma.demo', initialEntries: [listingsPath(blueWave)] });
    expect(await screen.findByRole('list', { name: 'Listings' })).toBeInTheDocument();

    renderPortal({ asIdentity: 'flaky@bluewave.demo', initialEntries: [listingsPath(blueWave)] });
    const lists = await screen.findAllByRole('list', { name: 'Listings' });
    expect(lists.length).toBeGreaterThan(0);
  });

  test('an organization with no listings gets a truthful empty state with the REAL Create entry point (W2-8)', async () => {
    renderPortal({ asIdentity: 'stages@himma.demo', initialEntries: [listingsPath(sunrise)] });
    expect(await screen.findByRole('heading', { level: 2, name: 'No listings yet' })).toBeInTheDocument();
    // W2-8: creation is real — the empty state links to the create route.
    expect(screen.getByRole('link', { name: 'Create listing' })).toHaveAttribute(
      'href',
      `/o/${sunrise.organizationId}/listings/new`,
    );
  });

  test('a suspended organization still reads its catalogue, prominently marked, with no mutation affordances', async () => {
    renderPortal({ asIdentity: 'director@himma.demo', initialEntries: [listingsPath(falcon)] });
    const list = await screen.findByRole('list', { name: 'Listings' });
    expect(within(list).getByText('Teen Kickboxing Fundamentals')).toBeInTheDocument();
    expect(
      screen.getAllByText('This organization is currently suspended. Changes are unavailable.')
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /create|edit|publish|pause|archive/i })).not.toBeInTheDocument();
  });

  test('a transient list failure renders a retryable error, and retry recovers', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    runtime.controls.failNextListingsLoad(blueWave.organizationId);
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath(blueWave)] });

    expect(
      await screen.findByText("We couldn’t load your listings. Try again in a moment."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Listings' })).toBeInTheDocument();
  });

  test('organization switching never leaks another organization’s catalogue', async () => {
    renderPortal({ asIdentity: 'director@himma.demo', initialEntries: [listingsPath(noor)] });
    const list = await screen.findByRole('list', { name: 'Listings' });
    expect(within(list).getByText('After-School Learning Support')).toBeInTheDocument();
    expect(within(list).getByText('Exam Prep Intensive')).toBeInTheDocument();
    expect(within(list).queryByText('Adult Beginner Swimming')).not.toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  test('index rows navigate to the listing detail', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [listingsPath(blueWave)] });
    const list = await screen.findByRole('list', { name: 'Listings' });
    await user.click(within(list).getByText('Adult Beginner Swimming'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Adult Beginner Swimming' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to listings/ })).toBeInTheDocument();
  });
});
