import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFixtureAdminRuntime } from '../src/services/mock/fixture-admin';
import { renderAdmin } from './support/render-admin';

/**
 * W3-9 AD-17/AD-18 over the deterministic fixture runtime: role
 * administration with the CERTIFIED B2-5 semantics — five roles and no
 * superadmin, DUAL-CONTROL approval (the requester's own approval is the
 * distinct refusal), CAS staleness, auditor read-only truth — and the
 * read-only audit explorer with server-side filters. Plus the step-up
 * seam and capability guards.
 */

function accessRuntime() {
  const runtime = createFixtureAdminRuntime();
  runtime.seedSession('access@himma.demo');
  return runtime;
}

describe('AD-17 access administration', () => {
  test('lists assignments with dual-control identities; exactly the five canonical roles are offerable — no superadmin exists', async () => {
    renderAdmin({ runtime: accessRuntime(), initialEntries: ['/access'] });
    await screen.findByText('fixture-ops@himma.demo');
    expect(screen.getByText('fixture-newcomer@himma.demo')).toBeInTheDocument();
    const roleSelect = await screen.findByLabelText('Role');
    const options = within(roleSelect).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['operations', 'access_admin', 'auditor', 'support', 'finance']);
    expect(document.body.textContent).not.toMatch(/super\s?admin/i);
  });

  test('DUAL CONTROL: the requester approving their own request gets the distinct refusal; a DIFFERENT access admin approves it', async () => {
    const user = userEvent.setup();
    // The pending fixture request was requested BY access@himma.demo.
    const first = renderAdmin({
      runtime: accessRuntime(),
      initialEntries: ['/access?state=requested'],
    });
    await screen.findByText('fixture-newcomer@himma.demo');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText(/Dual control: the administrator who requested/);
    first.unmount();

    // A different access administrator (duo@himma.demo) can approve.
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('duo@himma.demo');
    renderAdmin({ runtime, initialEntries: ['/access?state=requested'] });
    await screen.findByText('fixture-newcomer@himma.demo');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('No role assignments match this view.');
    const approved = await runtime.rolesPort.listAssignments({ state: 'active' });
    if (approved.kind !== 'loaded') throw new Error(approved.kind);
    const activated = approved.assignments.find(
      (assignment) => assignment.id === 'assignment-pending-finance',
    );
    expect(activated?.approvedBy).toBe('fixture-duo@himma.demo');
    expect(activated?.requestedBy).toBe('fixture-access@himma.demo'); // two people, always
  });

  test('requesting a FINANCE-CAPABLE role creates a PENDING dual-control assignment, and duplicates refuse with the typed conflict', async () => {
    const user = userEvent.setup();
    const runtime = accessRuntime();
    const requestSpy = jest.spyOn(runtime.rolesPort, 'requestRole');
    renderAdmin({ runtime, initialEntries: ['/access'] });
    await screen.findByText('fixture-ops@himma.demo');
    await user.type(screen.getByLabelText('Target user id'), 'fixture-new-user');
    await user.selectOptions(screen.getByLabelText('Role'), 'finance');
    await user.click(screen.getByRole('button', { name: 'Request role' }));
    await screen.findByText('fixture-new-user');
    expect(requestSpy).toHaveBeenLastCalledWith({ targetUserId: 'fixture-new-user', role: 'finance' });
    const row = screen.getByText('fixture-new-user').closest('tr')!;
    expect(within(row).getByText('requested')).toBeInTheDocument();

    // Duplicate: the same pending pair refuses.
    await user.type(screen.getByLabelText('Target user id'), 'fixture-new-user');
    await user.selectOptions(screen.getByLabelText('Role'), 'finance');
    await user.click(screen.getByRole('button', { name: 'Request role' }));
    await screen.findByText(/already holds \(or is already requested for\)/);
  });

  test('stale/CAS and concurrently-finalized decisions refuse WITHOUT change and refresh to authoritative truth', async () => {
    const user = userEvent.setup();
    const runtime = accessRuntime();
    renderAdmin({ runtime, initialEntries: ['/access?state=active'] });
    await screen.findByText('fixture-ops@himma.demo');
    // Pure CAS at the port: a stale expectedVersion refuses with NO change.
    await expect(
      runtime.rolesPort.revokeAssignment('assignment-support', { expectedVersion: 99 }),
    ).resolves.toEqual({ kind: 'staleVersion' });
    // A concurrent administrator finalizes the row behind this view; the
    // UI's now-stale decision refuses with the distinct finalized truth.
    await runtime.rolesPort.revokeAssignment('assignment-support', { expectedVersion: 2 });
    const supportRow = screen.getByText('fixture-support@himma.demo').closest('tr')!;
    await user.click(within(supportRow).getByRole('button', { name: 'Revoke' }));
    await screen.findByText(/already decided/);
  });

  test('an AUDITOR reads assignments but has NO mutation controls — truthfully explained, ports never asked to mutate', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('audit@himma.demo');
    renderAdmin({ runtime, initialEntries: ['/access'] });
    await screen.findByText('fixture-ops@himma.demo');
    expect(
      screen.getByText(/reviewing assignments, not changing them/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve|Deny|Revoke|Request role/ })).toBeNull();
  });

  test('an OPERATIONS admin (no roles.view) is refused the area — the port is never called', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('ops@himma.demo');
    const spy = jest.spyOn(runtime.rolesPort, 'listAssignments');
    renderAdmin({ runtime, initialEntries: ['/access'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('an action-level step-up demand interrupts a mutation; re-verification clears it and the mutation then succeeds', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('duo@himma.demo');
    renderAdmin({ runtime, initialEntries: ['/access?state=requested'] });
    await screen.findByText('fixture-newcomer@himma.demo');

    runtime.controls.demandStepUp();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText(/needs a fresh verification of your identity/);
    await user.type(screen.getByLabelText('Verification code'), '246810');
    await user.click(screen.getByRole('button', { name: 'Confirm identity' }));
    await screen.findByText(/Identity re-verified/);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('No role assignments match this view.');
  });
});

describe('AD-18 audit explorer', () => {
  test('renders the real bounded trail read-only — no mutation control exists, nothing internal is even representable', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('audit@himma.demo');
    renderAdmin({ runtime, initialEntries: ['/audit'] });
    await screen.findByText('listing.approved');
    expect(screen.getByText('org.go_live')).toBeInTheDocument();
    const main = screen.getByRole('main');
    // Read-only: the only button the explorer may ever offer is pagination.
    const buttons = within(main).queryAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(
      buttons.length === 0 ? [] : ['Load more'],
    );
    expect(main.textContent).not.toMatch(/digest|principal|request id/i);
  });

  test('filters are applied server-side through the port', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('ops@himma.demo'); // operations reads audit too (docs/31 §8)
    const spy = jest.spyOn(runtime.auditPort, 'listEvents');
    renderAdmin({ runtime, initialEntries: ['/audit'] });
    await screen.findByText('listing.approved');
    await user.type(screen.getByLabelText('Entity type'), 'organization');
    await waitFor(() =>
      expect(spy.mock.calls.at(-1)![0]).toEqual({ entityType: 'organization' }),
    );
    await waitFor(() => expect(screen.queryByText('listing.approved')).toBeNull());
    expect(screen.getByText('org.verification_rejected')).toBeInTheDocument();
  });

  test('an access_admin (no audit.read) is refused the area — the port is never called', async () => {
    const runtime = createFixtureAdminRuntime();
    runtime.seedSession('access@himma.demo');
    const spy = jest.spyOn(runtime.auditPort, 'listEvents');
    renderAdmin({ runtime, initialEntries: ['/audit'] });
    await screen.findByRole('heading', { name: 'This area isn’t part of your role' });
    expect(spy).not.toHaveBeenCalled();
  });
});
