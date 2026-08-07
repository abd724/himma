import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { org1, org2, renderPortal } from './support/render-portal';

describe('organization switcher shell', () => {
  test('shows the active organization and lists every accessible organization', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });

    const trigger = await screen.findByRole('button', { name: new RegExp(org1.displayName) });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Switch organization' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName(org1.displayName);
    expect(items[1]).toHaveAccessibleName(org2.displayName);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    expect(items[1]).toHaveAttribute('aria-checked', 'false');
  });

  test('switching organizations updates the route and context, preserving the section', async () => {
    const user = userEvent.setup();
    const { router } = renderPortal({ initialEntries: [`/o/${org1.id}/listings`] });

    await user.click(await screen.findByRole('button', { name: new RegExp(org1.displayName) }));
    await user.click(
      within(screen.getByRole('menu', { name: 'Switch organization' })).getByRole(
        'menuitemradio',
        { name: new RegExp(org2.displayName) },
      ),
    );

    expect(router.state.location.pathname).toBe(`/o/${org2.id}/listings`);
    expect(
      await screen.findByRole('button', { name: new RegExp(org2.displayName) }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('menu is keyboard operable: arrows move, Escape closes and restores focus', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });

    const trigger = await screen.findByRole('button', { name: new RegExp(org1.displayName) });
    await user.click(trigger);

    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio');
    expect(items[0]).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[1]).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('with a single accessible organization the switcher becomes a plain context label', async () => {
    renderPortal({
      initialEntries: [`/o/${org1.id}`],
      organizations: [org1],
    });

    const banner = await screen.findByRole('banner');
    expect(within(banner).getByText(org1.displayName)).toBeInTheDocument();
    expect(
      within(banner).queryByRole('button', { name: new RegExp(org1.displayName) }),
    ).not.toBeInTheDocument();
  });
});
