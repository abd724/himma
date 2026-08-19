import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { FIXTURE_PASSWORD } from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * jest-axe over the representative W3-1 states (task §27): sign-in, MFA
 * challenge, the authenticated shell (desktop nav), a placeholder area,
 * and the no-access surface.
 */

async function expectNoViolations(container: HTMLElement) {
  expect(await axe(container)).toHaveNoViolations();
}

describe('admin accessibility (jest-axe)', () => {
  test('sign-in surface', async () => {
    const { container } = renderAdmin();
    await screen.findByRole('heading', { name: 'Staff sign in' });
    await expectNoViolations(container);
  });

  test('MFA challenge surface', async () => {
    const user = userEvent.setup();
    const { container } = renderAdmin();
    await screen.findByRole('heading', { name: 'Staff sign in' });
    await user.type(screen.getByLabelText('Work email'), 'ops@himma.demo');
    await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Verify it’s you' });
    await expectNoViolations(container);
  });

  test('authenticated shell with capability navigation and dashboard', async () => {
    const { container } = renderAdmin({ asIdentity: 'ops@himma.demo' });
    await screen.findByRole('heading', { name: 'Welcome, Layla Operations' });
    await expectNoViolations(container);
  });

  test('truthful placeholder area', async () => {
    const { container } = renderAdmin({
      asIdentity: 'ops@himma.demo',
      initialEntries: ['/taxonomy'],
    });
    await screen.findByRole('heading', { name: 'Taxonomy' });
    await expectNoViolations(container);
  });

  test('no-admin-access surface', async () => {
    const { container } = renderAdmin({ asIdentity: 'none@himma.demo' });
    await screen.findByRole('heading', { name: 'This console is for Himma staff' });
    await expectNoViolations(container);
  });
});
