import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AppProviders } from '../../src/app/app';
import type { AuthRuntime } from '../../src/app/auth-runtime';
import { portalRoutes } from '../../src/app/routes';
import type { PortalSessionState } from '../../src/auth/session-machine';
import type { ShellOrganization } from '../../src/organization/organization-context';
import type { ProviderMembership } from '../../src/provider-access/contract';
import {
  createFixtureAuthRuntime,
  fixtureOrganizations,
  type FixtureAuthRuntime,
} from '../../src/services/mock/fixture-auth';

export const org1: ShellOrganization = {
  id: fixtureOrganizations.blueWave.organizationId,
  displayName: fixtureOrganizations.blueWave.displayName,
  organizationState: 'live',
};
export const org2: ShellOrganization = {
  id: fixtureOrganizations.noor.organizationId,
  displayName: fixtureOrganizations.noor.displayName,
  organizationState: 'live',
};

export const testIdentity = { email: 'owner@bluewave.demo', displayName: 'Rana Haddad' };

function membershipOf(organization: ShellOrganization): ProviderMembership {
  return {
    organizationId: organization.id,
    displayName: organization.displayName,
    role: 'owner',
    branchScope: 'all',
    organizationState: organization.organizationState,
  };
}

/** Prepared ACTIVE session state (test-only seam through AppProviders). */
export function activeSessionState(
  organizations: readonly ShellOrganization[] = [org1, org2],
): PortalSessionState {
  const memberships = organizations.map(membershipOf);
  if (memberships.length === 0) {
    return { status: 'noMembership', assurance: 'mfa', identity: testIdentity };
  }
  return {
    status: 'active',
    assurance: 'mfa',
    identity: testIdentity,
    memberships,
    stepUpExpiresAt: null,
  };
}

/**
 * Renders the full application over a memory router.
 * Default: an authenticated multi-org session (shell-focused suites).
 * Pass `authenticated: false` to start from the real bootstrap (access
 * suites), optionally with a shared fixture runtime for scenario control.
 */
export function renderPortal({
  initialEntries = ['/'],
  organizations,
  authenticated = true,
  runtime,
}: {
  initialEntries?: string[];
  organizations?: readonly ShellOrganization[];
  authenticated?: boolean;
  runtime?: FixtureAuthRuntime;
} = {}) {
  const fixture = runtime ?? createFixtureAuthRuntime();
  if (authenticated) {
    // Keep the fixture store consistent with the seeded session state.
    fixture.seedSession(testIdentity.email);
  }
  const authRuntime: AuthRuntime = {
    mode: 'fixture',
    adapter: fixture.adapter,
    accessPort: fixture.accessPort,
  };
  const router = createMemoryRouter(portalRoutes, { initialEntries });
  const result = render(
    <AppProviders
      authRuntime={authRuntime}
      {...(authenticated ? { initialSessionState: activeSessionState(organizations) } : {})}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, router, fixture };
}
