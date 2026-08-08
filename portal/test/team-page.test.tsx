import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearTeamIntent } from '../src/pages/team/team-pending-intent';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const noor = fixtureOrganizations.noor;
const falcon = fixtureOrganizations.falcon;
const coral = fixtureOrganizations.coral;

const teamPath = (ref: { organizationId: string }) => `/o/${ref.organizationId}/team`;

beforeEach(() => clearTeamIntent());

describe('team index (W2-6)', () => {
  test('an Owner sees the truthful directory: exact role labels, You marker, scope + joined dates, history apart', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [teamPath(blueWave)] });
    await screen.findByRole('heading', { level: 1, name: 'Team' });

    const members = await screen.findByRole('list', { name: 'Team members' });
    const rows = within(members).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    // Exact display vocabulary, creation order.
    expect(within(members).getAllByText('Owner')).toHaveLength(2);
    expect(within(members).getByText('Organization Manager')).toBeInTheDocument();
    expect(within(members).getByText('Branch Manager')).toBeInTheDocument();
    expect(within(members).getByText('Listings Editor / Scheduler')).toBeInTheDocument();
    expect(within(members).getByText('Coach / Instructor')).toBeInTheDocument();
    expect(within(members).getByText('Front Desk / Booking Employee')).toBeInTheDocument();
    expect(within(members).getByText('Finance')).toBeInTheDocument();
    // The caller's own row is recognizable; nobody else gets an identity
    // the real contract doesn't return.
    expect(within(members).getAllByText('You')).toHaveLength(1);
    // Branch scope + joined date render from real fields.
    expect(within(members).getByText(/Dubai Marina pool · Joined 1 Apr 2026/)).toBeInTheDocument();
    // Revoked history is present but SEPARATE from active access.
    expect(screen.getByText('Former members (1)')).toBeInTheDocument();
    expect(within(members).queryByText('Removed')).not.toBeInTheDocument();
  });

  test('invitations render apart from members with real lifecycle truth (awaiting/expired-by-time/past)', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [teamPath(blueWave)] });
    const open = await screen.findByRole('list', { name: 'Open invitations' });
    // A pending invitation is NEVER shown as someone with access.
    expect(within(open).getByText('newcoach@bluewave.demo')).toBeInTheDocument();
    expect(within(open).getByText('Awaiting response')).toBeInTheDocument();
    // Overdue-but-sent renders as expired TIME truth, still listed here.
    expect(within(open).getByText('weekend.coach@bluewave.example')).toBeInTheDocument();
    expect(within(open).getByText('Expired')).toBeInTheDocument();
    expect(within(open).getByText(/it can no longer be accepted/)).toBeInTheDocument();
    // Finalized rows live behind the history disclosure.
    expect(screen.getByText('Past invitations (3)')).toBeInTheDocument();
    const members = screen.getByRole('list', { name: 'Team members' });
    expect(within(members).queryByText('newcoach@bluewave.demo')).not.toBeInTheDocument();
  });

  test.each([
    ['director@himma.demo', blueWave, 'Organization Manager'],
    ['manager@bluewave.demo', blueWave, 'Branch Manager'],
    ['flaky@bluewave.demo', blueWave, 'Listings Editor / Scheduler'],
    ['assistant@coral.demo', coral, 'Coach / Instructor'],
    ['frontdesk@bluewave.demo', blueWave, 'Front Desk / Booking Employee'],
    ['finance@bluewave.demo', blueWave, 'Finance'],
  ])(
    '%s gets the truthful no-access surface and NO staff data is fetched (%s)',
    async (email, org, _label) => {
      const runtime = createFixtureAuthRuntime();
      runtime.seedSession(email);
      const loadSpy = jest.spyOn(runtime.teamPort, 'loadStaff');
      renderPortal({ runtime, asIdentity: email, initialEntries: [teamPath(org)] });
      expect(
        await screen.findByRole('heading', { level: 2, name: 'Team is managed by the Owner' }),
      ).toBeInTheDocument();
      // No staff read for a role without staff.read — and no controls.
      expect(loadSpy).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: 'Invite someone' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument();
      // No member or invitation data of any kind reached the page.
      expect(screen.queryByText(/@bluewave.demo/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Joined/)).not.toBeInTheDocument();
    },
  );

  test('a suspended organization still shows the directory but offers no mutations', async () => {
    renderPortal({ asIdentity: 'director@himma.demo', initialEntries: [teamPath(falcon)] });
    await screen.findByRole('list', { name: 'Team members' });
    expect(
      screen.getAllByText('This organization is currently suspended. Changes are unavailable.')
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Invite someone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument();
    // The pending invitation is still VISIBLE (reads work while suspended).
    expect(screen.getByText('coach@falcon.example')).toBeInTheDocument();
  });

  test('a transient staff failure renders a retryable error, and retry recovers', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    runtime.controls.failNextStaffLoad(blueWave.organizationId);
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [teamPath(blueWave)],
    });
    expect(
      await screen.findByText("We couldn’t load your team. Try again in a moment."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Team members' })).toBeInTheDocument();
  });

  test('organization switching never leaks another organization’s staff or invitations', async () => {
    renderPortal({ asIdentity: 'director@himma.demo', initialEntries: [teamPath(noor)] });
    const members = await screen.findByRole('list', { name: 'Team members' });
    // Noor has exactly its own two people…
    expect(within(members).getAllByRole('listitem')).toHaveLength(2);
    expect(within(members).getByText('Owner')).toBeInTheDocument();
    expect(within(members).getByText('Coach / Instructor')).toBeInTheDocument();
    // …and nothing of Blue Wave's team or invitations is present anywhere.
    expect(screen.queryByText(/bluewave/)).not.toBeInTheDocument();
    expect(screen.queryByText('Branch Manager')).not.toBeInTheDocument();
    expect(screen.queryByText('newcoach@bluewave.demo')).not.toBeInTheDocument();
  });

  test('withdrawing a pending invitation: consequence dialog → fixture refresh → success status', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const revokeSpy = jest.spyOn(runtime.teamPort, 'revokeInvitation');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [teamPath(blueWave)],
    });
    const open = await screen.findByRole('list', { name: 'Open invitations' });
    const row = within(open).getByText('newcoach@bluewave.demo').closest('li');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('dialog');
    // The consequence is explicit: codes die, accepted members are safe.
    expect(within(dialog).getByText(/never removes an existing team member/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw invitation' }));

    expect(
      await screen.findByText(/The invitation for newcoach@bluewave.demo has been withdrawn/),
    ).toBeInTheDocument();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    // The open list no longer offers it; it moved to past invitations.
    const openAfter = screen.getByRole('list', { name: 'Open invitations' });
    expect(within(openAfter).queryByText('newcoach@bluewave.demo')).not.toBeInTheDocument();
    expect(screen.getByText('Past invitations (4)')).toBeInTheDocument();
    // Team members unchanged — revoking an invitation never touches access.
    expect(within(screen.getByRole('list', { name: 'Team members' })).getAllByRole('listitem')).toHaveLength(8);
  });

  test('a lapsed step-up window routes the withdrawal through /step-up and re-confirms EXPLICITLY (once)', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const revokeSpy = jest.spyOn(runtime.teamPort, 'revokeInvitation');
    const { router } = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [teamPath(blueWave)],
    });
    // The recent-verification window lapses while the page is open.
    runtime.controls.expireStepUpWindow();
    const open = await screen.findByRole('list', { name: 'Open invitations' });
    const row = within(open).getByText('newcoach@bluewave.demo').closest('li');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Withdraw' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw invitation' }),
    );

    // The refused mutation executed nothing and we're at the interstitial.
    await screen.findByRole('heading', { name: 'Confirm it’s you' });
    expect(router.state.location.pathname).toBe('/step-up');
    expect(revokeSpy).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    // Back on Team: the SAME intent is rehydrated for explicit re-confirm.
    const dialog = await screen.findByRole('dialog');
    expect(
      screen.getByText(/Thanks for confirming it’s you/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw invitation' }));
    expect(
      await screen.findByText(/The invitation for newcoach@bluewave.demo has been withdrawn/),
    ).toBeInTheDocument();
    // Exactly one refused call + one executed call — never a double run.
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });

  test('the Team nav item renders only for memberships holding staff.read (usability, not authority)', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [teamPath(blueWave)] });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(await within(nav).findByRole('link', { name: 'Team' })).toBeInTheDocument();

    document.body.innerHTML = '';
    renderPortal({
      asIdentity: 'frontdesk@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}`],
    });
    const nav2 = await screen.findByRole('navigation', { name: 'Primary' });
    // Wait for capabilities to resolve, then confirm Team stays absent
    // while a peer capability-free item is present.
    await within(nav2).findByRole('link', { name: 'Branches' });
    await waitFor(() =>
      expect(within(nav2).queryByRole('link', { name: 'Team' })).not.toBeInTheDocument(),
    );
  });
});
