import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FIXTURE_RECOVERY_CODES,
  FIXTURE_TOTP_CODE,
} from '../src/services/mock/fixture-auth';
import { org1, renderPortal } from './support/render-portal';

/**
 * Step-up seam (task §8): a reusable additional-verification interstitial a
 * future sensitive action can send the user through — never globally
 * required by navigation.
 */
describe('step-up interstitial', () => {
  test('ordinary navigation never demands step-up', async () => {
    const { router } = renderPortal({ initialEntries: [`/o/${org1.id}/team`] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument();
    expect(router.state.location.pathname).not.toContain('step-up');
  });

  test('TOTP step-up completes and returns to the intended destination', async () => {
    const user = userEvent.setup();
    const { router } = renderPortal({
      initialEntries: [`/step-up?returnTo=${encodeURIComponent(`/o/${org1.id}/listings`)}`],
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: /Confirm it.s you/ }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Verification code'), FIXTURE_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Listings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org1.id}/listings`);
  });

  test('an invalid code stays on the interstitial with an explanation', async () => {
    const user = userEvent.setup();
    renderPortal({ initialEntries: ['/step-up'] });
    await screen.findByRole('heading', { level: 1, name: /Confirm it.s you/ });

    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText("That code didn't work. Try again.")).toBeInTheDocument();
  });

  test('a recovery code works exactly once', async () => {
    const user = userEvent.setup();
    const { router, fixture } = renderPortal({
      initialEntries: [`/step-up?returnTo=${encodeURIComponent(`/o/${org1.id}/team`)}`],
    });
    await screen.findByRole('heading', { level: 1, name: /Confirm it.s you/ });

    await user.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    await user.type(screen.getByLabelText('Recovery code'), FIXTURE_RECOVERY_CODES[0]!);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org1.id}/team`);

    // The same code is single-use at the adapter seam.
    const secondUse = await fixture.adapter.completeStepUpRecoveryCode(FIXTURE_RECOVERY_CODES[0]!);
    expect(secondUse.kind).toBe('invalidCode');
  });

  test('cancelling returns to the destination without a grant', async () => {
    const user = userEvent.setup();
    const { router } = renderPortal({
      initialEntries: [`/step-up?returnTo=${encodeURIComponent(`/o/${org1.id}`)}`],
    });
    await screen.findByRole('heading', { level: 1, name: /Confirm it.s you/ });

    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/o/${org1.id}`);
  });

  test('step-up requires an active session', async () => {
    renderPortal({ authenticated: false, initialEntries: ['/step-up'] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});
