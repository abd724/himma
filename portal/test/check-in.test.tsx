import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHECK_IN_OPERATIONS } from '../src/checkin/contract';
import { FULFILLMENT_OPERATIONS } from '../src/catalogue/fulfillment-contract';
import { createFixtureAuthRuntime, fixtureOrganizations } from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

/**
 * Front-desk check-in page (W2-13 §8–17) over the semantic fixture:
 * numeric-first 8-digit entry, the pure-read preview, atomic confirm with
 * SERVER-confirmed success only, truthful race refusals that clear the
 * stale preview, rate-limit presentation, and role gating (front desk
 * reaches Check-In directly; roles without `attendance.manage` get the
 * truthful no-access surface).
 */

const BLUE_WAVE = fixtureOrganizations.blueWave.organizationId;
const checkInUrl = `/o/${BLUE_WAVE}/check-in`;

async function enterCode(code: string) {
  const user = userEvent.setup();
  const input = await screen.findByLabelText('Customer’s check-in code');
  await user.clear(input);
  await user.type(input, code);
  await user.click(screen.getByRole('button', { name: 'Verify code' }));
  // Wait for the verify round-trip to finish: either the preview replaced
  // the entry form, or the entry input is live again after a refusal.
  await waitFor(() => {
    const entry = screen.queryByLabelText('Customer’s check-in code');
    if (entry !== null && entry.hasAttribute('disabled')) {
      throw new Error('verify still in flight');
    }
  });
  return user;
}

describe('check-in page', () => {
  test('front desk walks a customer through: verify → preview card → confirm → server-confirmed success with remaining balance', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    const user = await enterCode('11112222');

    // The preview is a read: who, what, and the pass balance — no
    // attendance exists yet.
    await screen.findByRole('heading', { name: 'Confirm this check-in' });
    expect(screen.getByText('Maya')).toBeInTheDocument();
    expect(screen.getByText('Aqua Fitness 8-pack')).toBeInTheDocument();
    expect(screen.getByText('Walk-in visit')).toBeInTheDocument();
    expect(screen.getByText('6 of 8 visits left')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm Check-In' }));

    // Success renders ONLY from the server's recorded attendance.
    const success = await screen.findByRole('status');
    expect(within(success).getByRole('heading', { name: 'Checked in' })).toBeInTheDocument();
    expect(within(success).getByText('Maya')).toBeInTheDocument();
    expect(
      within(success).getByText(/5 visits left on this pass after this check-in/),
    ).toBeInTheDocument();

    // The desk resets for the next customer with a cleared code field.
    await user.click(screen.getByRole('button', { name: 'Check in the next customer' }));
    expect(await screen.findByLabelText('Customer’s check-in code')).toHaveValue('');
  });

  test('a scheduled-session credential previews its session time and branch', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    await enterCode('33334444');
    await screen.findByRole('heading', { name: 'Confirm this check-in' });
    expect(screen.getByText('Omar')).toBeInTheDocument();
    expect(screen.getByText('Scheduled session')).toBeInTheDocument();
    expect(screen.getByText('Marina Branch')).toBeInTheDocument();
  });

  test('the code field is numeric-first: non-digits are dropped, Verify stays disabled until 8 digits, and no QR scanner exists', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Customer’s check-in code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    await user.type(input, 'ab12x34!5678');
    expect(input).toHaveValue('12345678');
    await user.clear(input);
    await user.type(input, '1234');
    expect(screen.getByRole('button', { name: 'Verify code' })).toBeDisabled();
    expect(screen.queryByText(/scan|camera|QR/i)).not.toBeInTheDocument();
  });

  test('an unknown code gets the ONE generic refusal — no guessing whether it exists elsewhere', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    await enterCode('99990000');
    expect(
      await screen.findByText(/doesn’t match a current check-in code for this organization/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Confirm this check-in' })).not.toBeInTheDocument();
  });

  test('an expired code reads as expired with refresh guidance, not as unknown', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    await enterCode('55556666');
    expect(await screen.findByText(/That code has expired/)).toBeInTheDocument();
  });

  test('RACE: a code consumed between preview and confirm surfaces the truthful refusal, clears the stale preview, and never renders success', async () => {
    const runtime = createFixtureAuthRuntime();
    renderPortal({
      initialEntries: [checkInUrl],
      asIdentity: 'frontdesk@bluewave.demo',
      runtime,
    });
    const user = await enterCode('11112222');
    await screen.findByRole('heading', { name: 'Confirm this check-in' });

    // Another device consumes the credential while this desk is looking at
    // the preview.
    runtime.consumeCheckInCode(BLUE_WAVE, '11112222');

    await user.click(screen.getByRole('button', { name: 'Confirm Check-In' }));
    expect(
      await screen.findByText(/This check-in wasn’t recorded\..*already been used/),
    ).toBeInTheDocument();
    // The stale preview is gone; the desk is back at code entry.
    expect(screen.queryByRole('heading', { name: 'Confirm this check-in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Checked in' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Customer’s check-in code')).toHaveValue('');
  });

  test('repeated invalid attempts surface the cooldown copy — presentation of the BACKEND limiter, nothing client-enforced', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await enterCode('90000001');
      await screen.findByText(/doesn’t match a current check-in code/);
    }
    await enterCode('11112222');
    expect(
      await screen.findByText('Too many invalid attempts. Try again shortly.'),
    ).toBeInTheDocument();
  });

  test('a role without attendance.manage gets the truthful no-access surface — no code entry renders', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'finance@bluewave.demo' });
    expect(await screen.findByText(/Your role can’t check customers in/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Customer’s check-in code')).not.toBeInTheDocument();
  });

  test('navigation: the front desk sees Check-In (their working destination) but not Listings; owners see both', async () => {
    const desk = renderPortal({ initialEntries: [`/o/${BLUE_WAVE}`], asIdentity: 'frontdesk@bluewave.demo' });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    await within(nav).findByRole('link', { name: 'Check-In' });
    expect(within(nav).queryByRole('link', { name: 'Listings' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    desk.unmount();

    renderPortal({ initialEntries: [`/o/${BLUE_WAVE}`], asIdentity: 'owner@bluewave.demo' });
    const ownerNav = await screen.findByRole('navigation', { name: 'Primary' });
    await within(ownerNav).findByRole('link', { name: 'Check-In' });
    await within(ownerNav).findByRole('link', { name: 'Listings' });
  });
});

describe('contract locks', () => {
  test('the check-in and fulfillment seams stay exactly two operations each', () => {
    expect([...CHECK_IN_OPERATIONS]).toEqual(['previewCheckIn', 'redeemCheckIn']);
    expect([...FULFILLMENT_OPERATIONS]).toEqual(['loadFulfillment', 'setFulfillment']);
  });

  test('no manual balance/attendance mutation or code-less bypass exists on the page', async () => {
    renderPortal({ initialEntries: [checkInUrl], asIdentity: 'frontdesk@bluewave.demo' });
    await screen.findByLabelText('Customer’s check-in code');
    expect(screen.queryByText(/adjust|override|bypass|without a code|mark attended/i)).not.toBeInTheDocument();
  });
});
