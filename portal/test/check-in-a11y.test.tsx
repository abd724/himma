import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { fixtureOrganizations } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

/**
 * Check-in accessibility (jest-axe, W2-13) — every distinct desk state:
 * code entry, the preview card awaiting confirmation, the recorded
 * success, and a refusal. The success region is a `role="status"` live
 * region and the code input is a properly labelled numeric field.
 */

const checkInUrl = `/o/${fixtureOrganizations.blueWave.organizationId}/check-in`;

describe('check-in accessibility (jest-axe, W2-13)', () => {
  test('code entry state', async () => {
    const page = renderPortal({
      initialEntries: [checkInUrl],
      asIdentity: 'frontdesk@bluewave.demo',
    });
    await screen.findByLabelText('Customer’s check-in code');
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('preview, success, and refusal states', async () => {
    const user = userEvent.setup();
    const page = renderPortal({
      initialEntries: [checkInUrl],
      asIdentity: 'frontdesk@bluewave.demo',
    });
    const input = await screen.findByLabelText('Customer’s check-in code');
    await user.type(input, '11112222');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    await screen.findByRole('heading', { name: 'Confirm this check-in' });
    expect(await axe(page.container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Confirm Check-In' }));
    await screen.findByRole('heading', { name: 'Checked in' });
    expect(await axe(page.container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Check in the next customer' }));
    const entry = await screen.findByLabelText('Customer’s check-in code');
    await user.type(entry, '90000009');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));
    await screen.findByText(/doesn’t match a current check-in code/);
    expect(await axe(page.container)).toHaveNoViolations();
  });

  test('the no-access surface for a role without attendance.manage', async () => {
    const page = renderPortal({
      initialEntries: [checkInUrl],
      asIdentity: 'finance@bluewave.demo',
    });
    await screen.findByText(/Your role can’t check customers in/);
    expect(await axe(page.container)).toHaveNoViolations();
  });
});
