import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createFixtureAuthRuntime,
  FIXTURE_INVITATIONS,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

const onboardingPath = (ref: { organizationId: string }) => `/o/${ref.organizationId}/onboarding`;

function itemRow(name: string) {
  const heading = screen.getByText(name, { selector: 'p *, p' });
  const row = heading.closest('li');
  if (!row) {
    throw new Error(`no checklist row for ${name}`);
  }
  return within(row);
}

describe('onboarding hub (readiness orchestration over canonical states)', () => {
  test('a fresh draft organization shows provider-actionable steps and a completeness-gated submit', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
    renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.coral)],
    });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Set up your workspace' }),
    ).toBeInTheDocument();
    expect(itemRow('Business profile').getByText('To do')).toBeInTheDocument();
    expect(itemRow('Branches').getByText('To do')).toBeInTheDocument();
    expect(itemRow('Himma review').getByText('Waiting')).toBeInTheDocument();
    expect(itemRow('Go live').getByText('Waiting')).toBeInTheDocument();

    // Submit is inert while incomplete, with the reason stated.
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByText(/complete your business profile and add an active branch/),
    ).toBeInTheDocument();

    // Actionable steps link to their future workspaces (no forms here).
    expect(
      itemRow('Business profile').getByRole('link', { name: 'Open Business Profile' }),
    ).toHaveAttribute('href', `/o/${fixtureOrganizations.coral.organizationId}/profile`);
  });

  test('submitted and in-review organizations hold with Himma, with no provider submit', async () => {
    for (const [ref, badge] of [
      [fixtureOrganizations.sunrise, 'Submitted'],
      [fixtureOrganizations.marina, 'In review'],
    ] as const) {
      const view = renderPortal({
        asIdentity: 'stages@himma.demo',
        initialEntries: [onboardingPath(ref)],
      });
      expect(await screen.findByText(badge)).toBeInTheDocument();
      expect(itemRow('Himma review').getByText('With Himma')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  test('a rejected organization can resubmit, and the hub reflects the new submitted state', async () => {
    renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.desertBloom)],
    });
    expect(await screen.findByText('Changes needed')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Submit again' }));
    expect(await screen.findByText('Submitted for review')).toBeInTheDocument();
  });

  test('a verified organization shows go-live with Himma and never offers a provider go-live control', async () => {
    renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.pearl)],
    });
    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(itemRow('Go live').getByText('With Himma')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /go live/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
  });

  test('a live organization is not trapped in onboarding: operational handoff with dashboard link', async () => {
    renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.blueWave)],
    });
    expect(await screen.findByText(/You’re live on Himma/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute(
      'href',
      `/o/${fixtureOrganizations.blueWave.organizationId}`,
    );
    expect(itemRow('Create your first listing').getByText('Done')).toBeInTheDocument();
  });

  test('a suspended organization gets no go-live path and no submission', async () => {
    renderPortal({
      asIdentity: 'director@himma.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.falcon)],
    });
    expect(
      await screen.findByRole('heading', { level: 2, name: /currently suspended/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
    expect(itemRow('Go live').getByText('Waiting')).toBeInTheDocument();
  });

  test('role-aware presentation: a coach sees status without authority-implying controls', async () => {
    renderPortal({
      asIdentity: 'assistant@coral.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 2, name: 'Set up your workspace' });

    expect(
      screen.getByText('Your organization’s owner submits it for review when setup is complete.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Open Business Profile' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText('An owner or organization manager completes this step.').length,
    ).toBeGreaterThan(0);
  });

  test('the shell carries a setup bar for non-live organizations, but never for live ones or on the hub itself', async () => {
    const nonLive = renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [`/o/${fixtureOrganizations.sunrise.organizationId}`],
    });
    expect(await screen.findByText(/isn’t live on Himma yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View your setup status' })).toHaveAttribute(
      'href',
      onboardingPath(fixtureOrganizations.sunrise),
    );
    nonLive.unmount();

    const live = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/o/${fixtureOrganizations.blueWave.organizationId}`],
    });
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(screen.queryByText(/isn’t live on Himma yet/)).not.toBeInTheDocument();
    live.unmount();

    renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.sunrise)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Getting started' });
    expect(screen.queryByText(/isn’t live on Himma yet/)).not.toBeInTheDocument();
  });

  test('W2-3 pulls no later workflow forward: no forms, no uploads, no staff management, no self-registration', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('newowner@coral.demo');
    await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
    const hub = renderPortal({
      runtime,
      asIdentity: 'newowner@coral.demo',
      initialEntries: [onboardingPath(fixtureOrganizations.coral)],
    });
    await screen.findByRole('heading', { level: 1, name: 'Getting started' });
    // No fake verification upload of any kind.
    expect(hub.container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    hub.unmount();

    // Team (W2-6) remains an honest placeholder (Business Profile became the
    // real W2-4 experience, Branches the real W2-5 experience).
    for (const segment of ['team']) {
      const view = renderPortal({
        asIdentity: 'assistant@coral.demo',
        initialEntries: [`/o/${fixtureOrganizations.coral.organizationId}/${segment}`],
      });
      expect(await screen.findByText('Arriving in an upcoming portal update.')).toBeInTheDocument();
      expect(view.container.querySelector('input, textarea, select')).toBeNull();
      expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
      view.unmount();
    }

    // The real W2-5 Branches surface stays equally honest for a role
    // without branch authority: no form controls, no invite affordance.
    const branchesView = renderPortal({
      asIdentity: 'assistant@coral.demo',
      initialEntries: [`/o/${fixtureOrganizations.coral.organizationId}/branches`],
    });
    await screen.findByRole('heading', { level: 2, name: 'No branches yet' });
    expect(branchesView.container.querySelector('input, textarea, select')).toBeNull();
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
    branchesView.unmount();

    // No self-registration affordance exists on sign-in.
    renderPortal({ authenticated: false });
    await screen.findByRole('heading', { level: 1, name: 'Sign in' });
    expect(screen.queryByText(/create.*account/i)).not.toBeInTheDocument();
    expect(screen.getByText(/by invitation from Himma/)).toBeInTheDocument();
  });
});
