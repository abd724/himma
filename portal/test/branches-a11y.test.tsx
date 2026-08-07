import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  FIXTURE_INVITATIONS,
  createFixtureAuthRuntime,
  fixtureBranches,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;

describe('branches accessibility (jest-axe, W2-5)', () => {
  test('populated list (owner) and scoped list (branch manager)', async () => {
    const owner = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/branches`],
    });
    await screen.findByRole('list', { name: 'Branches' });
    expect(await axe(owner.container)).toHaveNoViolations();
    owner.unmount();

    const scoped = renderPortal({
      asIdentity: 'manager@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/branches`],
    });
    await screen.findByRole('list', { name: 'Branches' });
    await screen.findByText('Assigned to you');
    expect(await axe(scoped.container)).toHaveNoViolations();
  });

  test('empty state with the creation path (authorized owner)', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
    const view = renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/o/${fixtureOrganizations.coral.organizationId}/branches`],
    });
    await screen.findByRole('heading', { level: 2, name: 'No branches yet' });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('branch editor: full form incl. hours and facilities editors', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/branches/${fixtureBranches.blueWaveMarina}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    await screen.findByLabelText('Branch name');
    // Open one day's hours editor so the time inputs are exercised too.
    await user.click(screen.getByLabelText('Monday'));
    await screen.findByLabelText('Monday opens at');
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('read-only branch record for a role without branch.edit', async () => {
    const view = renderPortal({
      asIdentity: 'finance@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/branches/${fixtureBranches.blueWaveMarina}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    await screen.findByText(/an owner or organization manager makes changes here/i);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('stale-conflict alert, deactivation dialog, and not-found surface', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    const view = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${blueWave.organizationId}/branches/${fixtureBranches.blueWaveMarina}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dubai Marina pool' });
    const nameField = await screen.findByLabelText('Branch name');
    await user.type(nameField, ' East');
    runtime.controls.simulateConcurrentBranchEdit(
      blueWave.organizationId,
      fixtureBranches.blueWaveMarina,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/someone else updated this branch/i);
    expect(await axe(view.container)).toHaveNoViolations();

    // Deactivation confirmation dialog.
    await user.click(screen.getByRole('button', { name: 'Deactivate branch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Dubai Marina pool?' });
    expect(await axe(view.container)).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Keep branch active' }));
    view.unmount();

    const notFound = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [
        `/o/${blueWave.organizationId}/branches/0198a2f0-5b7a-7000-8000-2b6c3e8f7aff`,
      ],
    });
    await screen.findByRole('heading', { level: 1, name: 'Branch not found' });
    expect(await axe(notFound.container)).toHaveNoViolations();
  });
});
