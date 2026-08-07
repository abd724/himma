import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../src/app/app';
import { portalRoutes } from '../src/app/routes';
import {
  createFixtureAuthRuntime,
  FIXTURE_INVITATIONS,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';
import { renderPortal } from './support/render-portal';

describe('invitation & onboarding accessibility (jest-axe)', () => {
  test('invitation surfaces: signed-out, ready-to-accept, refused', async () => {
    const signedOut = renderPortal({
      authenticated: false,
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    await screen.findByRole('button', { name: 'Sign in to continue' });
    expect(await axe(signedOut.container)).toHaveNoViolations();
    signedOut.unmount();

    const ready = renderPortal({
      asIdentity: 'newowner@coral.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    await screen.findByRole('button', { name: 'Accept invitation' });
    expect(await axe(ready.container)).toHaveNoViolations();
    ready.unmount();

    const refused = renderPortal({
      asIdentity: 'owner@bluewave.demo',
      initialEntries: [`/invitation/${FIXTURE_INVITATIONS.foundingOwner}`],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await screen.findByRole('alert');
    expect(await axe(refused.container)).toHaveNoViolations();
  });

  test('onboarding hub: setup, rejected, verified, live, and suspended states', async () => {
    const scenarios: Array<[string, string]> = [
      ['assistant@coral.demo', fixtureOrganizations.coral.organizationId],
      ['stages@himma.demo', fixtureOrganizations.desertBloom.organizationId],
      ['stages@himma.demo', fixtureOrganizations.pearl.organizationId],
      ['owner@bluewave.demo', fixtureOrganizations.blueWave.organizationId],
      ['director@himma.demo', fixtureOrganizations.falcon.organizationId],
    ];
    for (const [email, organizationId] of scenarios) {
      const view = renderPortal({
        asIdentity: email,
        initialEntries: [`/o/${organizationId}/onboarding`],
      });
      await screen.findByRole('heading', { level: 1, name: 'Getting started' });
      await screen.findByRole('heading', { level: 2, name: 'Your setup steps' });
      expect(await axe(view.container)).toHaveNoViolations();
      view.unmount();
    }
  });

  test('the shell setup bar is accessible', async () => {
    const view = renderPortal({
      asIdentity: 'stages@himma.demo',
      initialEntries: [`/o/${fixtureOrganizations.sunrise.organizationId}`],
    });
    await screen.findByText(/isn’t live on Himma yet/);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  test('an unconfigured build keeps the invitation route fail-closed', async () => {
    const router = createMemoryRouter(portalRoutes, {
      initialEntries: ['/invitation/SOME-INVITE-TOKEN-123'],
    });
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: "Sign-in isn't available yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });

  test('acceptance without any authenticated session cannot succeed at the port (fail-closed seam)', async () => {
    const runtime = createFixtureAuthRuntime();
    const outcome = await runtime.invitationPort.accept(FIXTURE_INVITATIONS.foundingOwner);
    expect(outcome.kind).toBe('failure');
  });
});
