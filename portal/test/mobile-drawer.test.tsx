import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { org1, renderPortal } from './support/render-portal';

// jsdom has no viewport CSS, so the trigger and drawer are always in the DOM;
// these tests exercise the narrow-viewport behavior contract (open, focus,
// dismiss, navigate). Visual breakpoint behavior is covered by Playwright.
describe('mobile navigation drawer', () => {
  test('opens from the navigation trigger and moves focus inside', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    const trigger = await screen.findByRole('button', { name: 'Open navigation' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', drawer.id);
    expect(within(drawer).getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();
  });

  test('Escape closes the drawer and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    const trigger = await screen.findByRole('button', { name: 'Open navigation' });

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('the close button closes the drawer', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));

    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });

  test('clicking the backdrop dismisses the drawer', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    screen.getByRole('dialog', { name: 'Navigation' });

    const backdrop = container.querySelector('.backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });

  test('Tab cycles within the open drawer (focus trap)', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));

    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    const focusable = within(drawer).getAllByRole('link').concat();
    const lastLink = focusable[focusable.length - 1]!;

    lastLink.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus();

    await user.tab({ shift: true });
    expect(lastLink).toHaveFocus();
  });

  test('navigating from the drawer closes it and changes the page', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: [`/o/${org1.id}`] });
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));

    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    await user.click(within(drawer).getByRole('link', { name: 'Branches' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Branches' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });
});
