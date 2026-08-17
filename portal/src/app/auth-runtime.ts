import type { PortalAuthAdapter } from '../auth/adapter';
import { resolveAuthMode } from '../auth/auth-mode';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredActivityTypePort,
  createUnconfiguredAreaPort,
  createUnconfiguredAuthAdapter,
  createUnconfiguredBranchPort,
  createUnconfiguredBulkImportPort,
  createUnconfiguredCategoryPort,
  createUnconfiguredListingCardPort,
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
import type { ListingCardPort } from '../catalogue/card-contract';
import type { ListingLifecyclePort } from '../catalogue/lifecycle-contract';
import type { InvitationPort } from '../invitations/contract';
import type { OnboardingPort } from '../onboarding/contract';
import type { OrganizationProfilePort } from '../profile/contract';
import type { ProviderAccessPort } from '../provider-access/contract';
import type {
  ActivityTypeReadPort,
  AreaReadPort,
  CategoryReadPort,
} from '../taxonomy/contract';
import type { TeamPort } from '../team/contract';
import { createLiveAuthRuntime } from '../auth/live/live-auth-runtime';
import { createFixtureAuthRuntime, type FixtureAccessControls } from '../services/mock/fixture-auth';

export interface AuthRuntime {
  readonly mode: 'fixture' | 'live' | 'unconfigured';
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
  readonly listingCardPort: ListingCardPort;
  readonly activityTypePort: ActivityTypeReadPort;
  readonly categoryPort: CategoryReadPort;
}

declare global {
  interface Window {
    /** Fixture-mode-only demo/e2e controls; never installed otherwise. */
    __himmaPortalAccessFixture?: FixtureAccessControls;
  }
}

/**
 * Composes the auth adapter + provider-access port for this environment.
 * Fail-closed by construction (task §25 + W2-12A §4): anything but an
 * explicit, COMPLETE resolution yields the unconfigured pair, which can
 * never grant access. Live mode (explicit `VITE_PORTAL_AUTH_MODE=live`)
 * wires the real Cognito/Himma auth + provider-access bootstrap ONLY —
 * every domain port stays fail-closed until its own W2-12B+ integration,
 * and no fixture identity can ever appear in a live composition.
 */
export function createAuthRuntime(env: PortalEnv): AuthRuntime {
  const mode = resolveAuthMode({
    configuredMode: env.authModeSetting,
    isProduction: env.isProduction,
  });

  if (mode === 'live') {
    const liveConfig = resolveLiveConfig(env);
    if (liveConfig === null) {
      // Missing/invalid live configuration NEVER falls back to fixtures —
      // the portal renders the safe unavailable state instead.
      return unconfiguredRuntime();
    }
    const live = createLiveAuthRuntime(liveConfig);
    return {
      mode,
      adapter: live.adapter,
      accessPort: live.accessPort,
      // W2-12A integrates auth/session/provider-access ONLY (task §14):
      // every domain port stays the fail-closed unconfigured implementation
      // until its own W2-12B+ slice wires the real read/mutation contracts.
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
      listingCardPort: createUnconfiguredListingCardPort(),
      activityTypePort: createUnconfiguredActivityTypePort(),
      categoryPort: createUnconfiguredCategoryPort(),
    };
  }

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
      listingCardPort: fixture.listingCardPort,
      activityTypePort: fixture.activityTypePort,
      categoryPort: fixture.categoryPort,
    };
  }

  return unconfiguredRuntime();
}

/** Every value the live path requires, validated together — any gap fails
 *  the WHOLE composition closed (no partial live wiring). */
function resolveLiveConfig(env: PortalEnv): {
  apiBaseUrl: string;
  cognitoIssuer: string;
  cognitoClientId: string;
} | null {
  if (
    env.apiBaseUrl === null ||
    env.cognitoIssuer === null ||
    env.cognitoClientId === null ||
    !env.cognitoIssuer.startsWith('https://')
  ) {
    return null;
  }
  return {
    apiBaseUrl: env.apiBaseUrl,
    cognitoIssuer: env.cognitoIssuer,
    cognitoClientId: env.cognitoClientId,
  };
}

function unconfiguredRuntime(): AuthRuntime {
  return {
    mode: 'unconfigured',
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
    listingCardPort: createUnconfiguredListingCardPort(),
    activityTypePort: createUnconfiguredActivityTypePort(),
    categoryPort: createUnconfiguredCategoryPort(),
  };
}
