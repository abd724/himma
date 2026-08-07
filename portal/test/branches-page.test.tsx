import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FIXTURE_INVITATIONS,
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const branchesPath = (ref: { organizationId: string }) => `/o/${ref.organizationId}/branches`;

describe('branch list (W2-5)', () => {
  test('an Owner sees every branch in creation order with truthful status and the create action', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchesPath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Branches' });

    const list = await screen.findByRole('list', { name: 'Branches' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByText(/pool/).textContent)).toEqual([
      'Dubai Marina pool',
      'Business Bay pool',
      'Al Sufouh training pool',
    ]);
    // Status is words, not colour: Active ×2, Deactivated ×1.
    expect(within(list).getAllByText('Active')).toHaveLength(2);
    expect(within(list).getAllByText('Deactivated')).toHaveLength(1);
    expect(screen.getByText('2 active branches · 1 deactivated branch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add branch' })).toBeInTheDocument();
  });

  test('an Organization Manager holds the same org-wide branch authority', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [branchesPath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('list', { name: 'Branches' });
    expect(screen.getByRole('link', { name: 'Add branch' })).toBeInTheDocument();
  });

  test('a branch-scoped Branch Manager reads every branch, sees assignment marked, and gets no create action', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [branchesPath(fixtureOrganizations.blueWave)],
    });
    const list = await screen.findByRole('list', { name: 'Branches' });
    // The real org.read serves EVERY branch — scope limits mutation, not reads.
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByText('Assigned to you')).toHaveLength(1);
    const marina = within(list).getByText('Dubai Marina pool').closest('li');
    expect(within(marina as HTMLElement).getByText('Assigned to you')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add branch' })).not.toBeInTheDocument();
    expect(screen.getByText(/you manage your assigned branches/i)).toBeInTheDocument();
  });

  test.each(['frontdesk@bluewave.demo', 'finance@bluewave.demo', 'flaky@bluewave.demo'])(
    '%s gets a truthful read-only list: no create, no assignment chips, no mutation controls',
    async (email) => {
      const runtime = createFixtureAuthRuntime();
      if (email === 'flaky@bluewave.demo') {
        // Burn the scripted first-resolution failure before rendering.
        runtime.seedSession(email);
        await runtime.accessPort.resolveAccess();
      }
      renderPortal({
        runtime,
        asIdentity: email,
        initialEntries: [branchesPath(fixtureOrganizations.blueWave)],
      });
      const list = await screen.findByRole('list', { name: 'Branches' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(3);
      expect(screen.queryByRole('link', { name: 'Add branch' })).not.toBeInTheDocument();
      expect(screen.queryByText('Assigned to you')).not.toBeInTheDocument();
      expect(
        screen.getByText(/an owner or organization manager makes changes here/i),
      ).toBeInTheDocument();
    },
  );

  test('a coach with no branches sees the empty state WITHOUT a fake create action', async () => {
    renderPortal({
      asIdentity: 'assistant@coral.demo',
      initialEntries: [branchesPath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 2, name: 'No branches yet' });
    expect(screen.queryByRole('link', { name: /add/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/an owner or organization manager adds branches/i),
    ).toBeInTheDocument();
  });

  test('an authorized Owner with no branches is directed toward creation with the onboarding truth', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [branchesPath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 2, name: 'No branches yet' });
    expect(screen.getByRole('link', { name: 'Add your first branch' })).toBeInTheDocument();
    expect(screen.getByText(/at least one active branch/i)).toBeInTheDocument();
  });

  test('a suspended organization keeps reads but loses every mutation affordance', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [branchesPath(fixtureOrganizations.falcon)],
    });
    const list = await screen.findByRole('list', { name: 'Branches' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByText(/currently suspended/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('link', { name: 'Add branch' })).not.toBeInTheDocument();
  });

  test('a transient load failure renders the error state and retry recovers', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.controls.failNextProfileLoad(fixtureOrganizations.blueWave.organizationId);
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchesPath(fixtureOrganizations.blueWave)],
    });
    await screen.findByText(/couldn’t load your branches/i);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Branches' })).toBeInTheDocument();
  });

  test('no fabricated operational data appears anywhere on the index', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [branchesPath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('list', { name: 'Branches' });
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(
      /booking|staff|revenue|occupancy|session|class|upcoming|open now|closed now|rating/i,
    );
  });
});
