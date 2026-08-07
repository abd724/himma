import { screen } from '@testing-library/react';
import { org1, org2, renderPortal } from './support/render-portal';

describe('route foundation', () => {
  test.each([
    ['', 'Dashboard'],
    ['/listings', 'Listings'],
    ['/schedule', 'Schedule'],
    ['/bookings', 'Bookings'],
    ['/branches', 'Branches'],
    ['/team', 'Team'],
    ['/profile', 'Business Profile'],
    ['/finance', 'Finance'],
    ['/settings', 'Settings & Support'],
    ['/support', 'Support'],
  ])('organization-scoped route %s renders %s', async (segment, heading) => {
    renderPortal({ initialEntries: [`/o/${org1.id}${segment}`] });
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  test('routes are organization-scoped: the same section resolves under either organization', async () => {
    const { router } = renderPortal({ initialEntries: [`/o/${org2.id}/team`] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org2.id}/team`);
  });

  test('an unknown organization id renders the organization-missing surface', async () => {
    renderPortal({ initialEntries: ['/o/not-a-real-organization'] });
    expect(
      await screen.findByRole('heading', { level: 1, name: "We can't find that organization" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the portal' })).toBeInTheDocument();
  });

  test('an unknown section inside a valid organization renders the in-shell not-found surface', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}/payments-hub`] });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    // Still inside the shell: navigation remains available for recovery.
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toHaveAttribute(
      'href',
      `/o/${org1.id}`,
    );
  });

  test('an unknown top-level route renders the application not-found surface', async () => {
    renderPortal({ initialEntries: ['/completely/unknown'] });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  test('with no accessible organizations the entry route renders the missing surface instead of a blank screen', async () => {
    renderPortal({ organizations: [] });
    expect(
      await screen.findByRole('heading', { level: 1, name: "We can't find that organization" }),
    ).toBeInTheDocument();
  });
});
