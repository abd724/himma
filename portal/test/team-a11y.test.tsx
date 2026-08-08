import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { clearTeamIntent } from '../src/pages/team/team-pending-intent';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import type { StaffMembershipRecord } from '../src/team/contract';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const falcon = fixtureOrganizations.falcon;

beforeEach(() => clearTeamIntent());

async function membershipWhere(
  runtime: ReturnType<typeof createFixtureAuthRuntime>,
  orgId: string,
  predicate: (row: StaffMembershipRecord) => boolean,
) {
  const outcome = await runtime.teamPort.loadStaff(orgId);
  if (outcome.kind !== 'loaded') {
    throw new Error('expected loaded staff');
  }
  const row = outcome.staff.memberships.find(predicate);
  if (!row) {
    throw new Error('fixture row not found');
  }
  return row;
}

describe('team accessibility (jest-axe, W2-6)', () => {
  test('populated directory with open + past invitations and history (owner)', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/team`],
    });
    await screen.findByRole('list', { name: 'Team members' });
    // Exercise the disclosures too.
    await user.click(screen.getByText('Former members (1)'));
    await user.click(screen.getByText('Past invitations (3)'));
    await screen.findByRole('list', { name: 'Former members' });
    await screen.findByRole('list', { name: 'Past invitations' });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('no-access surface (coach) and suspended read-only directory', async () => {
    const noAccess = renderPortal({
      asIdentity: 'frontdesk@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/team`],
    });
    await screen.findByRole('heading', { level: 2, name: 'Team is managed by the Owner' });
    expect(await axe(noAccess.container)).toHaveNoViolations();
    noAccess.unmount();

    const suspended = renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${falcon.organizationId}/team`],
    });
    await screen.findByRole('list', { name: 'Team members' });
    expect(await axe(suspended.container)).toHaveNoViolations();
  });

  test('invite form: role picker, scope radios, branch checklist, and a validation error', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/team/invite`],
    });
    await user.selectOptions(await screen.findByLabelText('Role'), 'Branch Manager');
    await user.click(screen.getByRole('radio', { name: /Specific branches/ }));
    await screen.findByRole('group', { name: 'Branches' });
    // Surface the empty-selection error state as well.
    await user.type(screen.getByLabelText('Email address'), 'a11y@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText('Choose at least one branch, or switch to all branches.');
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('member detail with the removal confirmation dialog open', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const coach = await membershipWhere(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'coach' && row.state === 'active',
    );
    const view = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/team/${coach.id}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Coach / Instructor' });
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await screen.findByRole('dialog');
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('stale-conflict alert and last-owner refusal are announced accessibly', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const coach = await membershipWhere(
      runtime,
      blueWave.organizationId,
      (row) => row.role === 'coach' && row.state === 'active',
    );
    const view = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/team/${coach.id}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Coach / Instructor' });
    runtime.controls.simulateConcurrentStaffChange(blueWave.organizationId, coach.id);
    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove access' }),
    );
    // The refusal is an alert (role=alert via InlineAlert error tone).
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/nothing was changed/);
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
