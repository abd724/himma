import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import {
  FIXTURE_PASSWORD,
  FIXTURE_TOTP_CODE,
  FIXTURE_TOTP_EXPIRED_CODE,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { org1, renderPortal } from './support/render-portal';

async function fillSignIn(email: string, password = FIXTURE_PASSWORD) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email address'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

async function completeMfa(user: ReturnType<typeof userEvent.setup>, code = FIXTURE_TOTP_CODE) {
  await user.type(await screen.findByLabelText('Verification code'), code);
  await user.click(screen.getByRole('button', { name: 'Verify' }));
}

describe('access & session flows (fixture adapter behind the production seams)', () => {
  test('signed-out bootstrap lands on sign-in, never on protected content', async () => {
    renderPortal({ authenticated: false });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  test('a protected deep link is blocked while signed out and preserved as returnTo', async () => {
    const { router } = renderPortal({
      authenticated: false,
      initialEntries: [`/o/${org1.id}/listings`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.search).toContain('returnTo=');

    const user = await fillSignIn('owner@bluewave.demo');
    await completeMfa(user);

    expect(await screen.findByRole('heading', { level: 1, name: 'Listings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org1.id}/listings`);
  });

  test('successful sign-in: credentials → TOTP challenge → workspace', async () => {
    const { router } = renderPortal({ authenticated: false });
    const user = await fillSignIn('owner@bluewave.demo');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Two-step verification' }),
    ).toBeInTheDocument();

    await completeMfa(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org1.id}`);
    // Single-membership session: the switcher collapses to a plain label.
    const banner = screen.getByRole('banner');
    expect(within(banner).getByText(org1.displayName)).toBeInTheDocument();
    expect(
      within(banner).queryByRole('button', { name: new RegExp(org1.displayName) }),
    ).not.toBeInTheDocument();
  });

  test('failed sign-in shows the safe canonical message and stays signed out', async () => {
    renderPortal({ authenticated: false });
    await fillSignIn('owner@bluewave.demo', 'wrong-password');

    expect(
      await screen.findByText('Sign-in could not be completed with the provided credentials.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  test('a suspended account is refused with the canonical non-specific message', async () => {
    renderPortal({ authenticated: false });
    await fillSignIn('suspended@himma.demo');
    expect(
      await screen.findByText('This account is currently unavailable. Contact support for help.'),
    ).toBeInTheDocument();
  });

  test('duplicate submission cannot double-invoke the adapter', async () => {
    const { fixture } = renderPortal({ authenticated: false });
    let release: () => void = () => {};
    const original = fixture.adapter.signIn.bind(fixture.adapter);
    const spy = jest.spyOn(fixture.adapter, 'signIn').mockImplementation(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(input);
    });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email address'), 'owner@bluewave.demo');
    await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
    const submit = screen.getByRole('button', { name: 'Sign in' });
    await user.click(submit);
    await screen.findByRole('button', { name: 'Signing in…' });
    await user.click(screen.getByRole('button', { name: 'Signing in…' }));
    await user.click(screen.getByRole('button', { name: 'Signing in…' }));

    expect(spy).toHaveBeenCalledTimes(1);
    release();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Two-step verification' }),
    ).toBeInTheDocument();
  });

  test('a wrong TOTP code explains itself; a lapsed challenge restarts sign-in', async () => {
    renderPortal({ authenticated: false });
    const user = await fillSignIn('owner@bluewave.demo');

    await completeMfa(user, '123456');
    expect(
      await screen.findByText("That code didn't work. Check your authenticator app and try again."),
    ).toBeInTheDocument();

    const codeField = screen.getByLabelText('Verification code');
    await user.clear(codeField);
    await user.type(codeField, FIXTURE_TOTP_EXPIRED_CODE);
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(
      screen.getByText('That verification code expired. Sign in again to get a new one.'),
    ).toBeInTheDocument();
  });

  test('cancelling the TOTP challenge returns to sign-in without a session', async () => {
    const { router } = renderPortal({ authenticated: false });
    const user = await fillSignIn('owner@bluewave.demo');
    await screen.findByRole('heading', { level: 1, name: 'Two-step verification' });

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  test('multi-org sign-in resolves every membership and allows switching', async () => {
    renderPortal({ authenticated: false });
    const user = await fillSignIn('director@himma.demo');
    await completeMfa(user);

    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await user.click(
      screen.getByRole('button', { name: new RegExp(fixtureOrganizations.blueWave.displayName) }),
    );
    const menu = screen.getByRole('menu', { name: 'Switch organization' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    await user.click(items[1]!);
    expect(
      await screen.findByRole('button', {
        name: new RegExp(fixtureOrganizations.noor.displayName),
      }),
    ).toBeInTheDocument();
  });

  test('an unenrolled sign-in cannot enter the workspace: the mandatory MFA enrollment gate appears', async () => {
    const { router } = renderPortal({ authenticated: false });
    await fillSignIn('coach@noor.demo');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up two-step verification' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/mfa/enroll');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  test('zero memberships resolves to the no-membership surface, not a workspace', async () => {
    renderPortal({ authenticated: false });
    const user = await fillSignIn('former@himma.demo');
    await completeMfa(user);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No provider workspace available' }),
    ).toBeInTheDocument();
  });

  test('a transient access failure is retryable without re-authenticating', async () => {
    renderPortal({ authenticated: false });
    const user = await fillSignIn('flaky@bluewave.demo');
    await completeMfa(user);

    expect(
      await screen.findByRole('heading', { level: 1, name: "We couldn't load your workspace" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  test('session expiry mid-use clears the workspace and explains it on sign-in', async () => {
    const { fixture } = renderPortal({ authenticated: false });
    const user = await fillSignIn('owner@bluewave.demo');
    await completeMfa(user);
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });

    act(() => {
      fixture.controls.expireSession();
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session has ended. Please sign in again.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
  });

  test('membership revocation mid-use removes the workspace', async () => {
    const { fixture } = renderPortal({ authenticated: false });
    const user = await fillSignIn('owner@bluewave.demo');
    await completeMfa(user);
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });

    act(() => {
      fixture.controls.revokeAccess();
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'No provider workspace available' }),
    ).toBeInTheDocument();
  });

  test('a suspended organization shows the canonical suspended banner in its shell', async () => {
    renderPortal({
      organizations: [
        {
          id: fixtureOrganizations.falcon.organizationId,
          displayName: fixtureOrganizations.falcon.displayName,
          organizationState: 'suspended',
        },
      ],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(
      screen.getByText('This organization is currently suspended. Changes are unavailable.'),
    ).toBeInTheDocument();
  });

  test('sign-out clears access context and protected routes are no longer reachable', async () => {
    const { router } = renderPortal({ authenticated: false });
    const user = await fillSignIn('owner@bluewave.demo');
    await completeMfa(user);
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });

    await user.click(screen.getByRole('button', { name: /Account — Rana Haddad/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: "You're signed out" }),
    ).toBeInTheDocument();

    // Returning to a protected URL (history Back / retyped link) must never
    // restore workspace content or the old organization context.
    await act(async () => {
      await router.navigate(`/o/${org1.id}`);
    });
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText(org1.displayName)).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: "You're signed out" }),
    ).toBeInTheDocument();
  });

  test('a malicious returnTo is discarded: sign-in lands on the default workspace', async () => {
    const { router } = renderPortal({
      authenticated: false,
      initialEntries: ['/sign-in?returnTo=https%3A%2F%2Fevil.example%2Fphish'],
    });
    const user = await fillSignIn('owner@bluewave.demo');
    await completeMfa(user);

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org1.id}`);
  });

  test('an authenticated deep link to an inaccessible organization is not honored after sign-in', async () => {
    renderPortal({
      authenticated: false,
      initialEntries: ['/o/11111111-2222-7000-8000-333333333333/listings'],
    });
    const user = await fillSignIn('owner@bluewave.demo');
    await completeMfa(user);

    expect(
      await screen.findByRole('heading', { level: 1, name: "This workspace isn't available" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/11111111/)).not.toBeInTheDocument();
  });
});
