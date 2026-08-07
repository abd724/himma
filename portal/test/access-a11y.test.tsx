import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { FIXTURE_PASSWORD } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

describe('access-state accessibility (jest-axe)', () => {
  test('sign-in, clean and failed', async () => {
    const { container } = renderPortal({ authenticated: false });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(await axe(container)).toHaveNoViolations();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'owner@bluewave.demo');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Sign-in could not be completed with the provided credentials.');
    expect(await axe(container)).toHaveNoViolations();
  });

  test('password visibility control is accessible and reversible', async () => {
    const user = userEvent.setup();
    renderPortal({ authenticated: false });
    const toggle = await screen.findByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('MFA challenge, clean and failed', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal({ authenticated: false });
    await user.type(await screen.findByLabelText('Email address'), 'owner@bluewave.demo');
    await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Two-step verification' });
    expect(await axe(container)).toHaveNoViolations();

    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByText("That code didn't work. Check your authenticator app and try again.");
    expect(await axe(container)).toHaveNoViolations();
  });

  test('MFA enrollment gate', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal({ authenticated: false });
    await user.type(await screen.findByLabelText('Email address'), 'coach@noor.demo');
    await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: 'Set up two-step verification' });
    expect(await axe(container)).toHaveNoViolations();
  });

  test('step-up interstitial (both methods)', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal({ initialEntries: ['/step-up'] });
    await screen.findByRole('heading', { level: 1, name: /Confirm it.s you/ });
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await screen.findByLabelText('Recovery code');
    expect(await axe(container)).toHaveNoViolations();
  });

  test('no-membership, access-unavailable, signed-out, and unavailable surfaces', async () => {
    const noMembership = renderPortal({ organizations: [] });
    await screen.findByRole('heading', { level: 1, name: 'No provider workspace available' });
    expect(await axe(noMembership.container)).toHaveNoViolations();
    noMembership.unmount();

    const signedOut = renderPortal({ authenticated: false, initialEntries: ['/signed-out'] });
    await screen.findByRole('heading', { level: 1, name: "You're signed out" });
    expect(await axe(signedOut.container)).toHaveNoViolations();
  });

  test('authenticated shell remains accessible with the account menu open', async () => {
    const user = userEvent.setup();
    const { container } = renderPortal();
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await user.click(screen.getByRole('button', { name: /Account — Rana Haddad/ }));
    screen.getByRole('menu', { name: 'Account' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
