import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureAdminRuntime } from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * W3-2 Provider Directory / Review Queue / Detail over the deterministic
 * fixture runtime (task §36): real DTO mapping, SERVER-driven search and
 * filters (spied at the port — the page never filters client-side),
 * cursor-reset semantics, truthful empty/error states with no fixture
 * fallback, the state-derived review queue, the read-only detail sections,
 * and capability guarding.
 */

function opsRuntime() {
  const runtime = createFixtureAdminRuntime();
  runtime.seedSession('ops@himma.demo');
  const listSpy = jest.spyOn(runtime.providersPort, 'listOrganizations');
  const detailSpy = jest.spyOn(runtime.providersPort, 'getOrganization');
  return { runtime, listSpy, detailSpy };
}

describe('provider directory (task §22)', () => {
  test('renders the real fixture directory with truthful state, review, storefront, and branch columns', async () => {
    const { runtime } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    await screen.findByRole('link', { name: 'Marina Ace Tennis' });

    const table = screen.getByRole('table');
    const marina = within(table).getByRole('link', { name: 'Marina Ace Tennis' }).closest('tr')!;
    expect(within(marina).getByText('Live')).toBeInTheDocument();
    expect(within(marina).getByText('Public')).toBeInTheDocument();
    expect(within(marina).getByText('2')).toBeInTheDocument(); // 3 branches, 1 inactive

    const aquava = within(table).getByRole('link', { name: 'Aquava Swim School' }).closest('tr')!;
    expect(within(aquava).getByText('Submitted')).toBeInTheDocument();
    expect(within(aquava).getByText('Awaiting review')).toBeInTheDocument();
    expect(within(aquava).getByText('Hidden')).toBeInTheDocument();

    // No fabricated metrics anywhere: no revenue/score/SLA vocabulary.
    expect(document.body.textContent).not.toMatch(/revenue|risk|score|SLA|overdue|urgent/i);
    // Read-only: no lifecycle controls exist on the directory.
    for (const forbidden of ['Verify', 'Reject', 'Go live', 'Suspend', 'Start review']) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });

  test('search drives the SERVER query (q parameter), resets pagination, and shows a truthful filtered-empty state', async () => {
    const user = userEvent.setup();
    const { runtime, listSpy } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    await screen.findByRole('link', { name: 'Marina Ace Tennis' });

    await user.type(screen.getByLabelText('Search providers'), 'aquava');
    await screen.findByRole('link', { name: 'Aquava Swim School' });
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Marina Ace Tennis' })).toBeNull(),
    );
    // The port received the search — with NO cursor (fresh pagination).
    const call = listSpy.mock.calls.at(-1)![0];
    expect(call.q).toBe('aquava');
    expect(call.cursor).toBeUndefined();

    await user.clear(screen.getByLabelText('Search providers'));
    await user.type(screen.getByLabelText('Search providers'), 'zz-no-such-provider');
    await screen.findByText('No providers match your search or filters.');
  });

  test('the state filter drives the SERVER query and composes with the view', async () => {
    const user = userEvent.setup();
    const { runtime, listSpy } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    await screen.findByRole('link', { name: 'Marina Ace Tennis' });

    await user.selectOptions(screen.getByLabelText('Organization state'), 'in_review');
    await screen.findByRole('link', { name: 'Crestpeak Climbing' });
    expect(screen.queryByRole('link', { name: 'Marina Ace Tennis' })).toBeNull();
    const call = listSpy.mock.calls.at(-1)![0];
    expect(call.state).toBe('in_review');
    expect(call.cursor).toBeUndefined();
  });

  test('pagination: Load more continues the SAME filtered set with a cursor; rows accumulate without duplicates', async () => {
    const user = userEvent.setup();
    const { runtime, listSpy } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    // 12 fixture organizations, page size 10 → a second page exists.
    await screen.findByRole('link', { name: 'Marina Ace Tennis' });
    expect(screen.queryByRole('link', { name: 'Skyjump Trampoline Park' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Load more providers' }));
    await screen.findByRole('link', { name: 'Skyjump Trampoline Park' });
    const call = listSpy.mock.calls.at(-1)![0];
    expect(call.cursor).toBeDefined(); // keyset continuation…
    expect(call.q).toBeUndefined(); // …holding the (empty) filters constant

    const rows = screen.getAllByRole('link', { name: /./ });
    const names = rows.map((row) => row.textContent);
    expect(new Set(names).size).toBe(names.length);
    // The full set is now visible and the button is gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more providers' })).toBeNull(),
    );
  });

  test('an outage shows the error state with retry — never fixture rows during failure', async () => {
    const user = userEvent.setup();
    const { runtime } = opsRuntime();
    runtime.controls.setProvidersOutage(true);
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    // The query layer retries once before surfacing the failure.
    await screen.findByText('We couldn’t load the provider directory.', undefined, {
      timeout: 4000,
    });
    expect(screen.queryByRole('table')).toBeNull();
    runtime.controls.setProvidersOutage(false);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: 'Marina Ace Tennis' });
  });
});

describe('review queue (task §23, §9)', () => {
  test('the queue view asks the server for needsReview=true and shows EXACTLY the states needing Himma action', async () => {
    const user = userEvent.setup();
    const { runtime, listSpy } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    await screen.findByRole('link', { name: 'Marina Ace Tennis' });

    await user.click(screen.getByRole('button', { name: 'Review queue' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Marina Ace Tennis' })).toBeNull(),
    );
    expect(listSpy.mock.calls.at(-1)![0].needsReview).toBe(true);

    // In: submitted, in_review, verified.
    for (const queued of [
      'Aquava Swim School',
      'Crestpeak Climbing',
      'Desert Padel Hub',
      'Falcon Kick Karate',
      'Little Kicks Football',
      'Skyjump Trampoline Park',
    ]) {
      expect(screen.getByRole('link', { name: queued })).toBeInTheDocument();
    }
    // Out: draft/rejected (provider action), live/suspended/offboarded.
    for (const excluded of [
      'Pearl Dive Centre',
      'Oasis Flow Yoga',
      'Marina Ace Tennis',
      'Sunridge Riding School',
      'Former Gym Co',
    ]) {
      expect(screen.queryByRole('link', { name: excluded })).toBeNull();
    }
    // The verified org is truthfully awaiting the go-live decision.
    const falcon = screen.getByRole('link', { name: 'Falcon Kick Karate' }).closest('tr')!;
    expect(within(falcon).getByText('Awaiting go-live')).toBeInTheDocument();
  });
});

describe('provider detail (task §24)', () => {
  test('renders the real internal record: overview, branches, team, catalogue counts — and NO lifecycle controls', async () => {
    const { runtime } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers/org-marina-ace'] });
    await screen.findByRole('heading', { name: 'Marina Ace Tennis' });

    // Overview truth.
    const overview = screen.getByRole('region', { name: 'Overview' });
    expect(within(overview).getByText('Marina Ace Sports Academy LLC')).toBeInTheDocument();
    expect(
      within(overview).getByText('Publicly visible (live and published)'),
    ).toBeInTheDocument();

    // Branches, including the inactive one, truthfully labelled.
    const branches = screen.getByRole('region', { name: /Branches/ });
    expect(within(branches).getByText('Old Town Courts')).toBeInTheDocument();
    expect(within(branches).getByText('Inactive')).toBeInTheDocument();

    // Team with the safe display identity.
    const team = screen.getByRole('region', { name: /Team/ });
    expect(within(team).getByText('Rania Aboud')).toBeInTheDocument();
    expect(within(team).getByText(/Listings editor/)).toBeInTheDocument();

    // Catalogue counts from the real aggregate (4 published, 1 paused, 2 draft).
    const catalogue = screen.getByRole('region', { name: /Catalogue/ });
    expect(within(catalogue).getByText('4')).toBeInTheDocument();
    expect(within(catalogue).getByText('Published')).toBeInTheDocument();

    // READ-ONLY: none of the existing backend transitions surface here.
    for (const forbidden of [
      'Start review',
      'Verify',
      'Reject',
      'Go live',
      'Suspend',
      'Reinstate',
      'Offboard',
    ]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
  });

  test('the verification section shows the CURRENT state only, with the truthful evidence-capability note', async () => {
    const { runtime } = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers/org-crestpeak'] });
    await screen.findByRole('heading', { name: 'Crestpeak Climbing' });
    const verification = screen.getByRole('region', { name: 'Verification' });
    expect(within(verification).getByText('In review')).toBeInTheDocument();
    expect(
      within(verification).getByText(/Evidence review isn’t available yet/),
    ).toBeInTheDocument();
    // No fabricated evidence artifacts (the truthful note itself is the
    // only mention of the future workflow).
    expect(document.body.textContent).not.toMatch(/checklist|score|overdue|urgent|uploaded/i);
  });

  test('a nonexistent provider is a truthful not-found, and a suspended provider shows its suspension', async () => {
    const first = opsRuntime();
    renderAdmin({ runtime: first.runtime, initialEntries: ['/providers/org-does-not-exist'] });
    await screen.findByRole('heading', { name: 'Provider not found' });

    const second = opsRuntime();
    renderAdmin({ runtime: second.runtime, initialEntries: ['/providers/org-sunridge'] });
    const overview = await screen.findByRole('region', { name: 'Overview' });
    expect(within(overview).getByText('Suspended', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('capability guarding (task §28)', () => {
  test('an auditor is refused the directory AND the detail route — the page never mounts, the port is never called', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('audit@himma.demo');
    const listSpy = jest.spyOn(runtime.providersPort, 'listOrganizations');
    renderAdmin({ runtime, initialEntries: ['/providers'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    expect(listSpy).not.toHaveBeenCalled();

    const detailRuntime = createFixtureAdminRuntime();
    detailRuntime.seedSession('audit@himma.demo');
    const detailSpy = jest.spyOn(detailRuntime.providersPort, 'getOrganization');
    renderAdmin({ runtime: detailRuntime, initialEntries: ['/providers/org-marina-ace'] });
    await screen.findAllByRole('heading', { name: 'This area isn’t part of your role' });
    expect(detailSpy).not.toHaveBeenCalled();
  });

  test('the fixture port itself also refuses a capability-less identity (defense in depth, mirroring the backend)', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('support@himma.demo');
    await expect(runtime.providersPort.listOrganizations({ limit: 10 })).resolves.toEqual({
      kind: 'forbidden',
    });
    await expect(runtime.providersPort.getOrganization('org-marina-ace')).resolves.toEqual({
      kind: 'forbidden',
    });
  });
});
