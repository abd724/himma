import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearTeamIntent } from '../src/pages/team/team-pending-intent';
import {
  createFixtureAuthRuntime,
  fixtureBranches,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const blueWave = fixtureOrganizations.blueWave;
const falcon = fixtureOrganizations.falcon;

const invitePath = `/o/${blueWave.organizationId}/team/invite`;

beforeEach(() => clearTeamIntent());

function ownerRuntime() {
  const runtime = createFixtureAuthRuntime();
  runtime.seedSession('owner@bluewave.demo');
  return runtime;
}

describe('invite workflow (W2-6)', () => {
  test('the role picker offers EXACTLY the seven canonical roles with the approved labels', async () => {
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    const roleSelect = await screen.findByLabelText('Role');
    expect(
      within(roleSelect as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Owner',
      'Organization Manager',
      'Branch Manager',
      'Listings Editor / Scheduler',
      'Coach / Instructor',
      'Front Desk / Booking Employee',
      'Finance',
    ]);
  });

  test('client validation mirrors the contract: email required and well-formed', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const issueSpy = jest.spyOn(runtime.teamPort, 'issueInvitation');
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    await screen.findByLabelText('Email address');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter their email address.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email address'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(issueSpy).not.toHaveBeenCalled();
  });

  test('org-wide-only roles lock the scope to all branches — no meaningless checkboxes', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    const roleSelect = await screen.findByLabelText('Role');
    for (const label of ['Owner', 'Organization Manager', 'Finance']) {
      await user.selectOptions(roleSelect, label);
      expect(screen.getByText(/always covers the whole organization/)).toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    }
  });

  test('branch-scoped roles choose all-or-specific; the checklist offers ONLY this org’s ACTIVE branches', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    const roleSelect = await screen.findByLabelText('Role');
    await user.selectOptions(roleSelect, 'Branch Manager');
    await user.click(screen.getByRole('radio', { name: /Specific branches/ }));

    const group = await screen.findByRole('group', { name: 'Branches' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    // Active branches only — the deactivated Al Sufouh pool is NOT a valid
    // grant target and is never offered; foreign branches can't appear by
    // construction (the list renders from this organization's view).
    expect(within(group).getByText('Dubai Marina pool')).toBeInTheDocument();
    expect(within(group).getByText('Business Bay pool')).toBeInTheDocument();
    expect(within(group).queryByText(/Al Sufouh/)).not.toBeInTheDocument();
    for (const box of boxes) {
      expect([fixtureBranches.blueWaveMarina, fixtureBranches.blueWaveBay]).toContain(
        (box as HTMLInputElement).value,
      );
    }
  });

  test('specific-branches with nothing selected is refused client-side', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const issueSpy = jest.spyOn(runtime.teamPort, 'issueInvitation');
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    await user.type(await screen.findByLabelText('Email address'), 'someone@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'Coach / Instructor');
    await user.click(screen.getByRole('radio', { name: /Specific branches/ }));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(
      await screen.findByText('Choose at least one branch, or switch to all branches.'),
    ).toBeInTheDocument();
    expect(issueSpy).not.toHaveBeenCalled();
  });

  test('a valid invitation sends EXACTLY one port call with the wire scope, then shows the truthful success panel', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const issueSpy = jest.spyOn(runtime.teamPort, 'issueInvitation');
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    await user.type(await screen.findByLabelText('Email address'), 'lead.coach@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'Branch Manager');
    await user.click(screen.getByRole('radio', { name: /Specific branches/ }));
    await user.click(
      within(await screen.findByRole('group', { name: 'Branches' })).getByRole('checkbox', {
        name: /Dubai Marina pool/,
      }),
    );
    // Rapid double-submit executes ONE mutation.
    const send = screen.getByRole('button', { name: 'Send invitation' });
    await user.dblClick(send);

    expect(
      await screen.findByRole('heading', { name: 'Invitation sent' }),
    ).toBeInTheDocument();
    expect(issueSpy).toHaveBeenCalledTimes(1);
    expect(issueSpy).toHaveBeenCalledWith(blueWave.organizationId, {
      email: 'lead.coach@example.com',
      role: 'branch_manager',
      branchScope: [fixtureBranches.blueWaveMarina],
    });
    expect(screen.getByText(/lead.coach@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/They get access when they accept it/)).toBeInTheDocument();
    // No token, code, or acceptance link is EVER rendered after issuance.
    expect(document.body.textContent).not.toContain('HIMMA-INVITE');
    expect(document.body.textContent).not.toMatch(/invitation code|acceptance link/i);
  });

  test('inviting an address with a still-open invitation explains the supersede truthfully', async () => {
    const user = userEvent.setup();
    renderPortal({ asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    await user.type(await screen.findByLabelText('Email address'), 'newcoach@bluewave.demo');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByRole('heading', { name: 'Invitation sent' });
    expect(
      screen.getByText(/replaces the earlier open invitation for this address/),
    ).toBeInTheDocument();
  });

  test('a failed email delivery is reported honestly: invitation created, retry = a NEW invitation', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    await screen.findByLabelText('Email address');
    runtime.controls.failNextInvitationMail(blueWave.organizationId);
    await user.type(screen.getByLabelText('Email address'), 'unreachable@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByRole('heading', { name: 'Invitation sent' });
    expect(
      screen.getByText(/the email couldn’t be delivered/),
    ).toBeInTheDocument();
    expect(screen.getByText(/send a new invitation to the same address/)).toBeInTheDocument();
  });

  test('a stale branch selection surfaces the canonical invalidBranchScope refusal', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    renderPortal({ runtime, asIdentity: 'owner@bluewave.demo', initialEntries: [invitePath] });
    await user.type(await screen.findByLabelText('Email address'), 'someone@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'Coach / Instructor');
    await user.click(screen.getByRole('radio', { name: /Specific branches/ }));
    await user.click(
      within(await screen.findByRole('group', { name: 'Branches' })).getByRole('checkbox', {
        name: /Business Bay pool/,
      }),
    );
    // Another manager deactivates the branch while the form is open.
    await runtime.branchPort.deactivateBranch(
      blueWave.organizationId,
      fixtureBranches.blueWaveBay,
      1,
    );
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(
      await screen.findByText(/That branch selection isn’t valid any more/),
    ).toBeInTheDocument();
  });

  test('a lapsed step-up window preserves the WHOLE intent through /step-up and resends only on explicit click', async () => {
    const user = userEvent.setup();
    const runtime = ownerRuntime();
    const issueSpy = jest.spyOn(runtime.teamPort, 'issueInvitation');
    const { router } = renderPortal({
      runtime,
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [invitePath],
    });
    await user.type(await screen.findByLabelText('Email address'), 'stepup.case@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'Front Desk / Booking Employee');
    // The window lapses while the owner fills the form.
    runtime.controls.expireStepUpWindow();
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    await screen.findByRole('heading', { name: 'Confirm it’s you' });
    expect(router.state.location.pathname).toBe('/step-up');
    expect(issueSpy).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    // Back on the invite form with every field preserved + the notice.
    expect(await screen.findByText(/Thanks for confirming it’s you/)).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveValue('stepup.case@example.com');
    expect(screen.getByLabelText('Role')).toHaveValue('front_desk');
    // Nothing auto-retried; the explicit click sends exactly once more.
    expect(issueSpy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByRole('heading', { name: 'Invitation sent' });
    expect(issueSpy).toHaveBeenCalledTimes(2);
  });

  test('roles without staff.manage get a truthful explanation, never a disabled form', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [invitePath],
    });
    expect(
      await screen.findByText(/Your role can’t invite people/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).not.toBeInTheDocument();
  });

  test('a suspended organization renders the canonical banner instead of the form', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [`/o/${falcon.organizationId}/team/invite`],
    });
    expect(
      await screen.findByText(
        'This organization is currently suspended. Changes are unavailable.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
  });
});
