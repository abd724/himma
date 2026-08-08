import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearTeamIntent } from '../src/pages/team/team-pending-intent';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import type { StaffMembershipRecord } from '../src/team/contract';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const noor = fixtureOrganizations.noor;

const memberPath = (ref: { organizationId: string }, membershipId: string) =>
  `/o/${ref.organizationId}/team/${membershipId}`;

type Runtime = ReturnType<typeof createFixtureAuthRuntime>;

beforeEach(() => clearTeamIntent());

async function staffRow(
  runtime: Runtime,
  orgId: string,
  predicate: (row: StaffMembershipRecord) => boolean,
): Promise<StaffMembershipRecord> {
  const outcome = await runtime.teamPort.loadStaff(orgId);
  if (outcome.kind !== 'loaded') {
    throw new Error(`expected loaded staff, got ${outcome.kind}`);
  }
  const row = outcome.staff.memberships.find(predicate);
  if (!row) {
    throw new Error('fixture row not found');
  }
  return row;
}

function ownerRuntime(): Runtime {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession('owner@bluewave.demo');
  return runtime;
}

describe('team member detail (W2-6)', () => {
  test('a member detail composes from the staff read: role, scope, joined date, status — no invented identity', async () => {
    const runtime = ownerRuntime();
    const coach = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'coach' && row.state === 'active',
    );
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, coach.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Coach / Instructor' });
    const details = screen.getByRole('region', { name: 'Access details' });
    expect(within(details).getByText('Team member')).toBeInTheDocument();
    expect(within(details).getByText('Business Bay pool')).toBeInTheDocument();
    expect(within(details).getByText('6 May 2026')).toBeInTheDocument();
    expect(within(details).getByText('Active')).toBeInTheDocument();
    // No email or name is invented for members: the real contract has none.
    expect(document.body.textContent).not.toContain('@');
  });

  test("the caller's own row is recognized ('you') and self-removal carries the explicit warning", async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const own = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'owner' && row.createdAt === '2026-03-02T08:00:00.000Z',
    );
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, own.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Owner (you)' });
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This is your own access/)).toBeInTheDocument();
    expect(within(dialog).getByText(/signed out of this organization/)).toBeInTheDocument();
  });

  test('self-revocation with a co-owner succeeds and the portal reacts to the lost access instead of continuing stale', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const own = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'owner' && row.createdAt === '2026-03-02T08:00:00.000Z',
    );
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, own.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Owner (you)' });
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove access' }),
    );
    // Rana's only membership is Blue Wave: losing it ends the workspace.
    expect(
      await screen.findByRole('heading', { name: 'No provider workspace available' }),
    ).toBeInTheDocument();
  });

  test('a revoked (historical) membership renders read-only with re-invite guidance — never editable', async () => {
    const runtime = ownerRuntime();
    const revoked = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.state === 'revoked',
    );
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, revoked.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Front Desk / Booking Employee' });
    expect(screen.getByText('Access removed')).toBeInTheDocument();
    expect(screen.getByText(/send them a new invitation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove access' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change role or branches' }),
    ).not.toBeInTheDocument();
  });

  test('the SOLE active Owner gets the protection explanation instead of removal/change controls', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('director@himma.demo');
    const soleOwner = await staffRow(
      runtime,
      noor.organizationId,
      (row) => row.role === 'owner' && row.state === 'active',
    );
    renderPortal({
      runtime,
      asIdentity: 'director@himma.demo',
      initialEntries: [memberPath(noor, soleOwner.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Owner (you)' });
    expect(
      screen.getAllByText(/Every organization keeps at least one Owner with active access/),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Remove access' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change role or branches' }),
    ).not.toBeInTheDocument();
  });

  test('removing a non-last Owner: consequence dialog, one mutation, back to the refreshed directory', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const coOwner = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'owner' && row.createdAt === '2026-03-05T08:00:00.000Z',
    );
    const revokeSpy = jest.spyOn(runtime.teamPort, 'revokeMembership');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, coOwner.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Owner' });
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Owner · All branches/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove access' }));

    // Back on the directory with the change applied: 7 active, 2 former.
    await screen.findByRole('heading', { level: 1, name: 'Team' });
    expect(await screen.findByText('7 people have active access')).toBeInTheDocument();
    expect(screen.getByText('Former members (2)')).toBeInTheDocument();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith(
      blueWave.organizationId,
      coOwner.id,
      coOwner.version,
    );
  });

  test('a concurrent change surfaces the stale-conflict flow: refusal, reload, re-armed action succeeds', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const coach = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'coach' && row.state === 'active',
    );
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, coach.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Coach / Instructor' });
    // Another owner changes the row while this page is open.
    runtime.controls.simulateConcurrentStaffChange(blueWave.organizationId, coach.id);
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove access' }),
    );
    expect(
      await screen.findByText(/access changed since you loaded this page, so nothing was changed/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load the latest team' }));
    // Re-armed with the FRESH version: the retry succeeds.
    await user.click(await screen.findByRole('button', { name: 'Remove access' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove access' }),
    );
    await screen.findByRole('heading', { level: 1, name: 'Team' });
    expect(await screen.findByText('Former members (2)')).toBeInTheDocument();
  });

  test('losing the co-owner concurrently surfaces the backend last-owner refusal in provider words', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const own = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'owner' && row.createdAt === '2026-03-02T08:00:00.000Z',
    );
    const coOwner = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'owner' && row.createdAt === '2026-03-05T08:00:00.000Z',
    );
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, own.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Owner (you)' });
    // The co-owner is revoked elsewhere while this page believes removal
    // is possible — the backend invariant answers.
    runtime.controls.simulateConcurrentStaffRevocation(blueWave.organizationId, coOwner.id);
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove access' }),
    );
    // The refusal alert renders — and the refreshed page now also derives
    // the sole-owner protection notes, so the copy appears multiple times.
    expect(
      (await screen.findAllByText(/Every organization keeps at least one Owner with active access/))
        .length,
    ).toBeGreaterThanOrEqual(1);
    // No trigger/constraint vocabulary ever reaches the provider.
    expect(document.body.textContent).not.toMatch(/trigger|constraint|SQL|staff_membership/i);
  });

  test('the change-role flow follows the canonical revoke + re-invite semantics with an honest hand-off', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const coach = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'coach' && row.state === 'active',
    );
    const revokeSpy = jest.spyOn(runtime.teamPort, 'revokeMembership');
    renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, coach.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Coach / Instructor' });
    expect(screen.getByText(/Access history is never edited/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change role or branches' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/current access —/)).toBeInTheDocument();
    expect(within(dialog).getByText(/new access starts\s+only when they accept it/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove access and continue' }),
    );

    // Lands on the invite form with the previous role preselected and the
    // two-step explanation continuing.
    await screen.findByRole('heading', { level: 1, name: 'Invite someone' });
    expect(
      await screen.findByText(/Their previous access has been removed/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toHaveValue('coach');
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  test('unknown and foreign membership ids render ONE identical safe not-found surface', async () => {
    const runtime = ownerRuntime();
    // A REAL membership id from another organization (Noor's owner row).
    const noorRuntime = createFixtureAuthRuntime();
    noorRuntime.seedSession('director@himma.demo');
    const foreign = await staffRow(
      noorRuntime,
      noor.organizationId,
      (row) => row.role === 'owner',
    );
    const first = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, foreign.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Team member not found' });
    const foreignText = screen.getByRole('main').textContent;
    first.unmount();

    const second = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, 'completely-unknown-id')],
    });
    await screen.findByRole('heading', { level: 1, name: 'Team member not found' });
    // Byte-identical: no oracle distinguishes foreign from unknown.
    expect(screen.getByRole('main').textContent).toBe(foreignText);
    second.unmount();
  });

  test('a lapsed step-up window routes removal through /step-up and re-confirms explicitly', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const coach = await staffRow(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'coach' && row.state === 'active',
    );
    const revokeSpy = jest.spyOn(runtime.teamPort, 'revokeMembership');
    const { router } = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [memberPath(blueWave, coach.id)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Coach / Instructor' });
    runtime.controls.expireStepUpWindow();
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove access' }),
    );

    await screen.findByRole('heading', { name: 'Confirm it’s you' });
    expect(router.state.location.pathname).toBe('/step-up');
    expect(revokeSpy).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    // Back on the member page: the intent is rehydrated for an explicit
    // re-confirmation, never auto-executed.
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByText(/Thanks for confirming it’s you/)).toBeInTheDocument();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Remove access' }));
    await screen.findByRole('heading', { level: 1, name: 'Team' });
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });

  test('roles without staff.read never reach a member detail — the same truthful no-access surface renders', async () => {
    renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [memberPath(blueWave, 'any-id')],
    });
    expect(
      await screen.findByText(/Team access and roles are managed by the organization’s Owner/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Joined/)).not.toBeInTheDocument();
  });
});
