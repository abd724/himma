import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../src/app/app';
import { portalRoutes } from '../src/app/routes';
import type { AuthRuntime } from '../src/app/auth-runtime';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
} from '../src/services/mock/fixture-auth';

/**
 * Session end clears cached domain state (W2-12A §10/§11, security §19.10):
 * no organization/provider data loaded under a session may survive that
 * session — deliberate sign-out and expiry/revocation both clear the
 * TanStack cache, in fixture and live mode alike (the behavior lives in
 * the shared SessionProvider, not in either adapter).
 */

const blueWave = fixtureOrganizations.blueWave;

function renderWithClient(runtime: ReturnType<typeof createFixtureAuthRuntime>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const authRuntime: AuthRuntime = {
    mode: 'fixture',
    adapter: runtime.adapter,
    accessPort: runtime.accessPort,
    invitationPort: runtime.invitationPort,
    onboardingPort: runtime.onboardingPort,
    profilePort: runtime.profilePort,
    branchPort: runtime.branchPort,
    areaPort: runtime.areaPort,
    teamPort: runtime.teamPort,
    listingsPort: runtime.listingsPort,
    listingEditorPort: runtime.listingEditorPort,
    listingLifecyclePort: runtime.listingLifecyclePort,
    bulkImportPort: runtime.bulkImportPort,
    activityTypePort: runtime.activityTypePort,
    categoryPort: runtime.categoryPort,
    fulfillmentPort: runtime.fulfillmentPort,
    checkinPort: runtime.checkinPort,
  };
  const seeded = runtime.sessionStateFor('owner@bluewave.demo');
  if (!seeded || seeded.memberships.length === 0) throw new Error('fixture identity missing');
  const router = createMemoryRouter(portalRoutes, {
    initialEntries: [`/o/${blueWave.organizationId}/listings`],
  });
  render(
    <AppProviders
      authRuntime={authRuntime}
      queryClient={queryClient}
      initialSessionState={{
        status: 'active',
        assurance: seeded.assurance,
        identity: seeded.identity,
        memberships: seeded.memberships,
        stepUpExpiresAt: null,
      }}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { queryClient };
}

describe('session end clears cached provider state', () => {
  test('deliberate sign-out empties the query cache and lands on the signed-out surface', async () => {
    const user = userEvent.setup();
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const { queryClient } = renderWithClient(runtime);

    // Domain reads populated the cache while signed in.
    await screen.findByRole('list', { name: 'Listings' });
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /^Account — / }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    await screen.findByRole('heading', { level: 1, name: /signed out/i });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Listings' })).not.toBeInTheDocument();
  });

  test('server-side session expiry clears the cache with the protected shell', async () => {
    const runtime = createFixtureAuthRuntime();
    runtime.seedSession('owner@bluewave.demo');
    const { queryClient } = renderWithClient(runtime);
    await screen.findByRole('list', { name: 'Listings' });
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    act(() => {
      runtime.controls.expireSession();
    });

    await waitFor(() => {
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
    await screen.findByLabelText('Email address'); // back at sign-in
    expect(screen.queryByRole('list', { name: 'Listings' })).not.toBeInTheDocument();
  });
});
