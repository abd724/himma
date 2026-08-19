import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureAdminRuntime } from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * W3-5 verification review panel over the deterministic fixture runtime:
 * the full review journey (open → start → decide → canonical org state
 * change), readiness-is-not-approval, the three-layer rejection form, the
 * W3-4 content-safety fail-close, the D-W3-5 step-up seam, and authorized
 * evidence download.
 */

function opsRuntime() {
  const runtime = createFixtureAdminRuntime();
  runtime.seedSession('ops@himma.demo');
  return runtime;
}

async function findVerification() {
  return await screen.findByRole('region', { name: 'Verification' });
}

describe('the review journey (fixture composition — content safety ready)', () => {
  test('a ready under-review case is APPROVED explicitly; the organization becomes verified, then goes live', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers/org-desert-padel'] });
    await screen.findByRole('heading', { name: 'Desert Padel Hub' });
    const verification = await findVerification();
    await within(verification).findByText(/Round 1 — under review/);
    expect(
      within(verification).getByText(/All required evidence is stored — ready for a decision/),
    ).toBeInTheDocument();

    // Readiness alone changed nothing: the org is still in review.
    expect(within(verification).getByText('In review')).toBeInTheDocument();

    await user.click(within(verification).getByRole('button', { name: 'Approve' }));
    // The decision + canonical transition surface everywhere.
    await within(verification).findByText('Verified');
    expect(within(verification).getByText('approved')).toBeInTheDocument();
    await within(verification).findByRole('button', { name: 'Go live' });

    await user.click(within(verification).getByRole('button', { name: 'Go live' }));
    await within(verification).findByText('Live');
  });

  test('rejection requires the machine + provider layers, then records all three (internal note labeled staff-only)', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers/org-crestpeak'] });
    const verification = await findVerification();
    await within(verification).findByText(/Round 1 — under review/);

    await user.click(within(verification).getByRole('button', { name: 'Reject…' }));
    // Submitting without the mandatory layers is refused truthfully.
    await user.click(within(verification).getByRole('button', { name: 'Record rejection' }));
    await screen.findByText(/A rejection needs a reason code and a provider-facing message/);

    await user.type(screen.getByLabelText('Reason code (machine)'), 'expired_document');
    await user.type(
      screen.getByLabelText('Provider-facing message'),
      'Please renew your operating licence.',
    );
    await user.type(
      screen.getByLabelText('Internal note (never shown to the provider)'),
      'Registry lookup failed twice.',
    );
    await user.click(within(verification).getByRole('button', { name: 'Record rejection' }));

    await within(verification).findByText('rejected');
    expect(within(verification).getByText('expired_document')).toBeInTheDocument();
    expect(
      within(verification).getByText('Please renew your operating licence.'),
    ).toBeInTheDocument();
    expect(within(verification).getByText('Internal note (staff-only)')).toBeInTheDocument();
    expect(within(verification).getByText('Registry lookup failed twice.')).toBeInTheDocument();
    // The canonical org transition happened (rejected, not verified).
    await within(verification).findByText('Rejected');
  });

  test('opening a round for a submitted org creates the requirement checklist; approval stays disabled until evidence is stored', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers/org-little-kicks'] });
    const verification = await findVerification();
    await within(verification).findByText('No review rounds yet.');

    await user.click(within(verification).getByRole('button', { name: 'Open review round' }));
    await within(verification).findByText(/Round 1 — open/);
    expect(within(verification).getByText('Business document')).toBeInTheDocument();
    expect(within(verification).getByText('Operating licence')).toBeInTheDocument();
    expect(within(verification).getByText('Optional reference')).toBeInTheDocument();

    // Start the review (org submitted → in_review), approval still gated.
    await user.click(within(verification).getByRole('button', { name: 'Start review' }));
    await within(verification).findByText(/Round 1 — under review/);
    expect(within(verification).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(
      within(verification).getByText(/Missing required evidence: Business document, Operating licence/),
    ).toBeInTheDocument();
  });

  test('stored evidence downloads through the authorized port', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    const downloadSpy = jest.spyOn(runtime.verificationPort, 'downloadEvidence');
    renderAdmin({ runtime, initialEntries: ['/providers/org-desert-padel'] });
    const verification = await findVerification();
    await within(verification).findByText(/Round 1 — under review/);
    const downloads = within(verification).getAllByRole('button', { name: 'Download' });
    expect(downloads.length).toBe(2);
    await user.click(downloads[0]!);
    await waitFor(() =>
      expect(downloadSpy).toHaveBeenCalledWith('evidence-desert-padel-business_document'),
    );
  });
});

describe('fail-closed truths', () => {
  test('content safety unavailable: banner shown, review/decide disabled, download refused with the typed reason', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    runtime.controls.setContentSafetyReady(false);
    renderAdmin({ runtime, initialEntries: ['/providers/org-desert-padel'] });
    const verification = await findVerification();
    await within(verification).findByText(/content-safety capability is not active/);
    expect(within(verification).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(verification).getByRole('button', { name: 'Reject…' })).toBeDisabled();

    await user.click(within(verification).getAllByRole('button', { name: 'Download' })[0]!);
    await screen.findByText(/documents can’t be opened and decisions can’t be recorded/i);
  });

  test('the D-W3-5 step-up seam: a demanded step-up interrupts the action, re-verification clears it, and the action then succeeds', async () => {
    const user = userEvent.setup();
    const runtime = opsRuntime();
    renderAdmin({ runtime, initialEntries: ['/providers/org-desert-padel'] });
    const verification = await findVerification();
    await within(verification).findByText(/Round 1 — under review/);

    // The step-up window lapses AFTER the shell is up (action-level seam).
    runtime.controls.demandStepUp();
    await user.click(within(verification).getByRole('button', { name: 'Approve' }));
    await screen.findByText(/needs a fresh verification of your identity/);

    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Confirm identity' }));
    await screen.findByText(/Identity re-verified/);

    await user.click(within(verification).getByRole('button', { name: 'Approve' }));
    await within(verification).findByText('Verified');
  });

  test('an auditor cannot reach the verification workspace at all (capability guard, port untouched)', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('audit@himma.demo');
    const spy = jest.spyOn(runtime.verificationPort, 'getVerification');
    renderAdmin({ runtime, initialEntries: ['/providers/org-desert-padel'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    expect(spy).not.toHaveBeenCalled();
  });
});
