import type { PortalAuthAdapter } from '../auth/adapter';
import { resolveAuthMode } from '../auth/auth-mode';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredActivityTypePort,
  createUnconfiguredAreaPort,
  createUnconfiguredAuthAdapter,
  createUnconfiguredBranchPort,
  createUnconfiguredBulkImportPort,
  createUnconfiguredInvitationPort,
  createUnconfiguredListingEditorPort,
  createUnconfiguredListingLifecyclePort,
  createUnconfiguredListingsPort,
  createUnconfiguredOnboardingPort,
  createUnconfiguredProfilePort,
  createUnconfiguredTeamPort,
} from '../auth/unconfigured-adapter';
import type { PortalEnv } from '../api/env';
import type { BranchPort } from '../branches/contract';
import type { ListingsReadPort } from '../catalogue/contract';
import type { ListingEditorPort } from '../catalogue/editor-contract';
import type { BulkImportPort } from '../catalogue/import-contract';
import type { ListingLifecyclePort } from '../catalogue/lifecycle-contract';
import type { InvitationPort } from '../invitations/contract';
import type { OnboardingPort } from '../onboarding/contract';
import type { OrganizationProfilePort } from '../profile/contract';
import type { ProviderAccessPort } from '../provider-access/contract';
import type { ActivityTypeReadPort, AreaReadPort } from '../taxonomy/contract';
import type { TeamPort } from '../team/contract';
import { createFixtureAuthRuntime, type FixtureAccessControls } from '../services/mock/fixture-auth';

export interface AuthRuntime {
  readonly mode: 'fixture' | 'unconfigured';
  readonly adapter: PortalAuthAdapter;
  readonly accessPort: ProviderAccessPort;
  readonly invitationPort: InvitationPort;
  readonly onboardingPort: OnboardingPort;
  readonly profilePort: OrganizationProfilePort;
  readonly branchPort: BranchPort;
  readonly areaPort: AreaReadPort;
  readonly teamPort: TeamPort;
  readonly listingsPort: ListingsReadPort;
  readonly listingEditorPort: ListingEditorPort;
  readonly listingLifecyclePort: ListingLifecyclePort;
  readonly bulkImportPort: BulkImportPort;
  readonly activityTypePort: ActivityTypeReadPort;
}

declare global {
  interface Window {
    /** Fixture-mode-only demo/e2e controls; never installed otherwise. */
    __himmaPortalAccessFixture?: FixtureAccessControls;
  }
}

/**
 * Composes the auth adapter + provider-access port for this environment.
 * Fail-closed by construction: anything but an explicit fixture resolution
 * yields the unconfigured pair, which can never grant access (task §25).
 */
export function createAuthRuntime(env: PortalEnv): AuthRuntime {
  const mode = resolveAuthMode({
    configuredMode: env.authModeSetting,
    isProduction: env.isProduction,
  });

  if (mode === 'fixture') {
    const fixture = createFixtureAuthRuntime();
    if (typeof window !== 'undefined') {
      window.__himmaPortalAccessFixture = fixture.controls;
    }
    return {
      mode,
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
      bulkImportPort: fixture.bulkImportPort,
      activityTypePort: fixture.activityTypePort,
    };
  }

  return {
    mode,
    adapter: createUnconfiguredAuthAdapter(),
    accessPort: createUnconfiguredAccessPort(),
    invitationPort: createUnconfiguredInvitationPort(),
    onboardingPort: createUnconfiguredOnboardingPort(),
    profilePort: createUnconfiguredProfilePort(),
    branchPort: createUnconfiguredBranchPort(),
    areaPort: createUnconfiguredAreaPort(),
    teamPort: createUnconfiguredTeamPort(),
    listingsPort: createUnconfiguredListingsPort(),
    listingEditorPort: createUnconfiguredListingEditorPort(),
    listingLifecyclePort: createUnconfiguredListingLifecyclePort(),
    bulkImportPort: createUnconfiguredBulkImportPort(),
    activityTypePort: createUnconfiguredActivityTypePort(),
  };
}
