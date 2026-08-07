import { screen, within } from '@testing-library/react';
import { org1, renderPortal } from './support/render-portal';

describe('application shell', () => {
  test('the application renders: root entry lands on the first organization dashboard', async () => {
    renderPortal();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('banner')).getByText(org1.displayName),
    ).toBeInTheDocument();
  });

  test('desktop shell structure: landmarks, branding, navigation, content, account placeholder', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}`] });

    // Landmarks.
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('complementary')).toBeInTheDocument();

    // Branding area (provisional wordmark).
    expect(screen.getByText('Himma')).toBeInTheDocument();
    expect(screen.getByText('Provider Portal')).toBeInTheDocument();

    // Skip link is the way past the chrome.
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );

    // Organization context is visible.
    expect(
      within(screen.getByRole('banner')).getByText(org1.displayName),
    ).toBeInTheDocument();

    // Account/access affordance is an honest placeholder, not fake identity.
    const account = screen.getByRole('button', { name: 'Account' });
    expect(account).toHaveAttribute('aria-disabled', 'true');
    expect(account).toHaveAccessibleDescription(
      'Sign-in and account controls arrive in an upcoming portal update.',
    );
  });

  test('exactly one h1 per page', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}/listings`] });
    await screen.findByRole('heading', { level: 1, name: 'Listings' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  test('page titles follow the document-title pattern', async () => {
    renderPortal({ initialEntries: [`/o/${org1.id}/branches`] });
    await screen.findByRole('heading', { level: 1, name: 'Branches' });
    expect(document.title).toBe('Branches · Himma Provider Portal');
  });
});
