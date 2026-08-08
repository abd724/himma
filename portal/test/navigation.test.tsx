import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { portalNavItems } from '../src/navigation/nav-items';
import { org1, renderPortal } from './support/render-portal';

describe('primary navigation', () => {
  test('renders the docs/29 §5 sidebar order with organization-scoped targets', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    // Team is capability-gated (staff.read, owner-only) and appears once
    // the membership capabilities resolve — the default identity is Owner.
    await within(nav).findByRole('link', { name: 'Team' });
    const links = within(nav).getAllByRole('link');

    expect(links.map((link) => link.textContent?.replace(/Soon|Coming soon/g, ''))).toEqual([
      'Dashboard',
      'Listings',
      'Schedule',
      'Bookings',
      'Branches',
      'Team',
      'Business Profile',
      'Finance',
      'Settings & Support',
    ]);
    expect(links[0]).toHaveAttribute('href', `/o/${org1.id}`);
    expect(links[1]).toHaveAttribute('href', `/o/${org1.id}/listings`);
    expect(links[8]).toHaveAttribute('href', `/o/${org1.id}/settings`);
  });

  test('active navigation state follows the route', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}/listings`] });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });

    expect(within(nav).getByRole('link', { name: 'Listings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  test('the dashboard item is active only on the dashboard itself', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('keyboard-driven navigation reaches every top-level section', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await within(nav).findByRole('link', { name: 'Team' });

    for (const item of portalNavItems.filter((navItem) => navItem.segment !== '')) {
      const link = within(nav).getByRole('link', {
        name: item.comingSoon ? `${item.label} Coming soon` : item.label,
      });
      await user.click(link);
      expect(
        await screen.findByRole('heading', { level: 1, name: item.label }),
      ).toBeInTheDocument();
      expect(link).toHaveAttribute('aria-current', 'page');
    }
  });

  test('sections without a backend yet carry an honest coming-soon marker', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await within(nav).findByRole('link', { name: 'Team' });

    for (const item of portalNavItems) {
      const link = within(nav).getByRole('link', {
        name: item.comingSoon ? `${item.label} Coming soon` : item.label,
      });
      if (item.comingSoon) {
        expect(within(link).getByText('Coming soon')).toBeInTheDocument();
      } else {
        expect(within(link).queryByText('Coming soon')).not.toBeInTheDocument();
      }
    }
  });

  test('navigation metadata carries EXACTLY the known capability truth (W2-6)', () => {
    // Only Team is capability-gated today: staff.read is owner-only in the
    // shipped registry. No other item may encode a permission guess —
    // future domain permissions stay unknown until their backends land.
    for (const item of portalNavItems) {
      expect(item.requiredCapability).toBe(item.id === 'team' ? 'staff.read' : null);
    }
  });
});
