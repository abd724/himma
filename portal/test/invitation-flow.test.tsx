import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  FIXTURE_INVITATIONS,
  FIXTURE_PASSWORD,
  FIXTURE_TOTP_CODE,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const INVALID_COPY_FRAGMENT = 'This invitation can’t be used with this account';

async function signInOnPage(email: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email address'), email);
  await user.type(screen.getByLabelText('Password'), FIXTURE_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.type(await screen.findByLabelText('Verification code'), FIXTURE_TOTP_CODE);
  await user.click(screen.getByRole('button', { name: 'Verify' }));
  return user;
}

describe('invitation acceptance (docs/27 §9 canon over the fixture seam)', () => {
  test('a signed-out visitor is guided into sign-in and returns to the invitation', async () => {
    const { router } = renderPortal({
      authenticated: false,
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Provider invitation' }),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign in to continue' }));
    expect(router.state.location.pathname).toBe('/sign-in');

    await signInOnPage('newowner@coral.demo');
    // MFA composition brings the journey back to the invitation.
    expect(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/invitation/${FIXTURE_INVITATIONS.foundingOwner}`,
    );
  });

  test('a founding-Owner acceptance lands in onboarding for the not-yet-live organization', async () => {
    const { router } = renderPortal({
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Getting started' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/o/${fixtureOrganizations.coral.organizationId}/onboarding`,
    );
    // The token has left the URL.
    expect(router.state.location.pathname).not.toContain(FIXTURE_INVITATIONS.foundingOwner);
  });

  test('an ordinary staff acceptance into a LIVE organization goes to the workspace, not owner onboarding', async () => {
    const { router } = renderPortal({
      asIdentity: 'newcoach@bluewave.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.staff}`],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/o/${fixtureOrganizations.blueWave.organizationId}`,
    );
  });

  test('a wrong identity receives the single canonical refusal and can switch accounts', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(INVALID_COPY_FRAGMENT);

    await user.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(
      await screen.findByRole('button', { name: 'Sign in to continue' }),
    ).toBeInTheDocument();
  });

  test('expired, revoked, and unknown invitations are indistinguishable (no oracle)', async () => {
    const bodies: string[] = [];
    for (const token of [
      FIXTURE_INVITATIONS.expired,
      FIXTURE_INVITATIONS.revoked,
      'COMPLETELY-UNKNOWN-TOKEN',
    ]) {
      const view = renderPortal({
        asIdentity: 'newowner@coral.demo',
        initialEntries: [`/invitation/${token}`],
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
      const alert = await screen.findByRole('alert');
      bodies.push(alert.textContent ?? '');
      // Never echo the token into the page.
      expect(view.container.textContent).not.toContain(token);
      view.unmount();
    }
    expect(new Set(bodies).size).toBe(1);
  });

  test('an already-consumed invitation is refused with the same canonical outcome', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newcoach@bluewave.demo');
    const first = await runtime.invitationPort.accept(FIXTURE_INVITATIONS.staff);
    expect(first.kind).toBe('invitationAccepted');
    // A second acceptance attempt (any caller) hits the consumed state.
    const second = await runtime.invitationPort.accept(FIXTURE_INVITATIONS.staff);
    expect(second.kind).toBe('invitationInvalid');
  });

  test('a transient service failure is presented as retryable, not as a dead invitation', async () => {
    renderPortal({
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.unavailable}`],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invitations are temporarily unavailable',
    );
    // The accept action remains available for retry.
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
  });

  test('the invitation token never reaches web storage', async () => {
    renderPortal({
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await screen.findByRole('heading', { level: 1, name: 'Getting started' });

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
