import { screen, within } from '@testing-library/react';
import { org1, renderPortal } from './support/render-portal';

/**
 * Backend-later areas must never show invented operational data (docs/29 §5,
 * task §10): no schedules, bookings, revenues, payout totals, or KPIs.
 */
describe('honest placeholder pages', () => {
  test.each([
    ['schedule', 'Schedule'],
    ['bookings', 'Bookings'],
    ['finance', 'Finance'],
  ])('%s explains its later production milestone with no fabricated data', async (segment, heading) => {
    renderPortal({ initialEntries: [`/o/${org1.id}/${segment}`] });
    await screen.findByRole('heading', { level: 1, name: heading });

    const main = screen.getByRole('main');
    expect(within(main).getByText('Coming in a later production milestone.')).toBeInTheDocument();

    // No fake metrics of any kind: a backend-later placeholder has no reason
    // to contain a single digit or currency amount.
    expect(main.textContent).not.toMatch(/\d/);
    expect(main.textContent).not.toMatch(/AED/);
  });

  test.each([
    ['', 'Dashboard'],
    ['/listings', 'Listings'],
    ['/branches', 'Branches'],
    ['/team', 'Team'],
    ['/profile', 'Business Profile'],
    ['/settings', 'Settings & Support'],
    ['/support', 'Support'],
  ])('the %s placeholder names its later portal arrival without fake data', async (segment, heading) => {
    renderPortal({ initialEntries: [`/o/${org1.id}${segment}`] });
    await screen.findByRole('heading', { level: 1, name: heading });

    const main = screen.getByRole('main');
    expect(within(main).getByText('Arriving in an upcoming portal update.')).toBeInTheDocument();
    expect(main.textContent).not.toMatch(/\d/);
  });
});
