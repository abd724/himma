import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../src/app/app';
import { portalRoutes } from '../../src/app/routes';
import type { ShellOrganization } from '../../src/organization/organization-context';
import { fixtureOrganizations } from '../../src/services/mock/fixture-organizations';

export const org1 = fixtureOrganizations[0]!;
export const org2 = fixtureOrganizations[1]!;

/** Renders the full application over a memory router. */
export function renderPortal({
  initialEntries = ['/'],
  organizations,
}: {
  initialEntries?: string[];
  organizations?: readonly ShellOrganization[];
} = {}) {
  const router = createMemoryRouter(portalRoutes, { initialEntries });
  const result = render(
    <AppProviders {...(organizations ? { organizations } : {})}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, router };
}
