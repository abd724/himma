import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../src/app/app';
import { adminRoutes } from '../../src/app/routes';
import type { AuthRuntime } from '../../src/app/auth-runtime';
import {
  createFixtureAdminRuntime,
  type FixtureAdminRuntime,
} from '../../src/services/mock/fixture-admin';

/**
 * Test harness: the full admin route tree over the deterministic fixture
 * runtime (or a supplied runtime). `asIdentity` seeds a signed-in fixture
 * session; without it the flow starts at the sign-in surface.
 */
export function renderAdmin(options: {
  runtime?: FixtureAdminRuntime;
  asIdentity?: string;
  initialEntries?: string[];
} = {}) {
  const fixture = options.runtime ?? createFixtureAdminRuntime();
  if (options.asIdentity !== undefined) {
    fixture.seedSession(options.asIdentity);
  }
  const authRuntime: AuthRuntime = {
    mode: 'fixture',
    adapter: fixture.adapter,
    accessPort: fixture.accessPort,
    providersPort: fixture.providersPort,
  };
  const router = createMemoryRouter(adminRoutes, {
    initialEntries: options.initialEntries ?? ['/'],
  });
  const view = render(
    <AppProviders authRuntime={authRuntime}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...view, fixture, router };
}
