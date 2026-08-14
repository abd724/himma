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
 * suites), `asIdentity` to seed a specific fixture identity (its CURRENT
 * fixture memberships become the session state), or `runtime` to share a
 * fixture runtime across setup steps and the render.
 */
export function renderPortal({
  initialEntries = ['/'],
  organizations,
  authenticated = true,
  asIdentity,
  runtime,
}: {
  initialEntries?: string[];
  organizations?: readonly ShellOrganization[];
  authenticated?: boolean;
  asIdentity?: string;
  runtime?: FixtureAuthRuntime;
} = {}) {
  const fixture = runtime ?? createFixtureAuthRuntime();
  let seededState: PortalSessionState | undefined;
  if (asIdentity) {
    fixture.seedSession(asIdentity);
    const seeded = fixture.sessionStateFor(asIdentity);
    if (!seeded) {
      throw new Error(`unknown fixture identity ${asIdentity}`);
    }
    seededState =
      seeded.memberships.length > 0
        ? {
            status: 'active',
            assurance: seeded.assurance,
            identity: seeded.identity,
            memberships: seeded.memberships,
            stepUpExpiresAt: null,
          }
        : { status: 'noMembership', assurance: seeded.assurance, identity: seeded.identity };
  } else if (authenticated) {
    // Keep the fixture store consistent with the seeded session state.
    fixture.seedSession(testIdentity.email);
  }
  const authRuntime: AuthRuntime = {
    mode: 'fixture',
    adapter: fixture.adapter,
    accessPort: fixture.accessPort,
    invitationPort: fixture.invitationPort,
    onboardingPort: fixture.onboardingPort,
    profilePort: fixture.profilePort,
    branchPort: fixture.branchPort,
    areaPort: fixture.areaPort,
    teamPort: fixture.teamPort,
    listingsPort: fixture.listingsPort,
    listingEditorPort: fixture.listingEditorPort,
    listingLifecyclePort: fixture.listingLifecyclePort,
    activityTypePort: fixture.activityTypePort,
  };
  const router = createMemoryRouter(portalRoutes, { initialEntries });
  const initialSessionState =
    seededState ?? (authenticated ? activeSessionState(organizations) : undefined);
  const result = render(
    <AppProviders
      authRuntime={authRuntime}
      {...(initialSessionState ? { initialSessionState } : {})}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...result, router, fixture };
}
