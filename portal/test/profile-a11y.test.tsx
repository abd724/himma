import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { fixtureOrganizations } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const profilePath = (ref: { organizationId: string }) => `/o/${ref.organizationId}/profile`;

describe('business profile accessibility (jest-axe)', () => {
  test('editable page: business, storefront (form + preview), and publication tabs', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    expect(await axe(view.container)).toHaveNoViolations();

    await user.click(await screen.findByRole('tab', { name: 'Public storefront' }));
    await screen.findByLabelText('Display name');
    expect(await axe(view.container)).toHaveNoViolations();

    await user.click(screen.getByRole('tab', { name: 'Publication' }));
    await screen.findByRole('button', { name: 'Unpublish storefront' });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('read-only page for a role without profile.edit', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'assistant@coral.demo',
      initialEntries: [profilePath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await user.click(await screen.findByRole('tab', { name: 'Public storefront' }));
    await screen.findByText(/an owner or organization manager makes these changes/i);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('validation error, stale-version conflict, and unsaved-changes dialog states', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [profilePath(fixtureOrganizations.blueWave)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await user.click(await screen.findByRole('tab', { name: 'Public storefront' }));

    // Client validation error state.
    await user.clear(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Enter the name customers will see.');
    expect(await axe(view.container)).toHaveNoViolations();

    // Stale-version conflict state.
    await user.type(screen.getByLabelText('Display name'), 'Blue Wave Swimming');
    view.fixture.controls.simulateConcurrentProfileEdit(
      fixtureOrganizations.blueWave.organizationId,
    );
    await user.type(screen.getByLabelText('Public phone'), '9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText(/Someone else updated the storefront/);
    expect(await axe(view.container)).toHaveNoViolations();

    // Unsaved-changes confirmation dialog.
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    expect(await axe(view.container)).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
  });

  test('suspended organization read-only state', async () => {
    const user = userEvent.setup();
    const view = renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [profilePath(fixtureOrganizations.falcon)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Business Profile' });
    await user.click(await screen.findByRole('tab', { name: 'Public storefront' }));
    await screen.findAllByText(
      'This organization is currently suspended. Changes are unavailable.',
    );
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
