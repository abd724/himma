import type { PortalAuthAdapter } from './adapter';
import type { BranchPort } from '../branches/contract';
import type { ListingsReadPort } from '../catalogue/contract';
import type { ListingEditorPort } from '../catalogue/editor-contract';
import type { InvitationPort } from '../invitations/contract';
import type { OnboardingPort } from '../onboarding/contract';
import type { OrganizationProfilePort } from '../profile/contract';
import type { ProviderAccessPort } from '../provider-access/contract';
import type { ActivityTypeReadPort, AreaReadPort } from '../taxonomy/contract';
import type { TeamPort } from '../team/contract';

/**
 * FAIL-CLOSED default (task §25): a production build with no configured
 * authentication renders the safe unavailable state and can never grant
 * access. Every operation resolves to the least-capable outcome.
 */
export function createUnconfiguredAuthAdapter(): PortalAuthAdapter {
  return {
    bootstrap: async () => ({ kind: 'unavailable' }),
    signIn: async () => ({ kind: 'failure' }),
    completeMfaChallenge: async () => ({ kind: 'failure' }),
    cancelMfaChallenge: async () => {},
    completeStepUpTotp: async () => ({ kind: 'failure' }),
    completeStepUpRecoveryCode: async () => ({ kind: 'failure' }),
    signOut: async () => {},
    subscribe: () => () => {},
  };
}

export function createUnconfiguredAccessPort(): ProviderAccessPort {
  return {
    resolveAccess: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredInvitationPort(): InvitationPort {
  return {
    accept: async () => ({ kind: 'providerUnavailable' }),
  };
}

export function createUnconfiguredOnboardingPort(): OnboardingPort {
  return {
    loadSnapshot: async () => ({ kind: 'unavailable' }),
    submitForVerification: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredProfilePort(): OrganizationProfilePort {
  return {
    loadOrganizationView: async () => ({ kind: 'unavailable' }),
    updateProfile: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredBranchPort(): BranchPort {
  return {
    createBranch: async () => ({ kind: 'unavailable' }),
    updateBranch: async () => ({ kind: 'unavailable' }),
    deactivateBranch: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredAreaPort(): AreaReadPort {
  return {
    listAreas: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredTeamPort(): TeamPort {
  return {
    loadStaff: async () => ({ kind: 'unavailable' }),
    issueInvitation: async () => ({ kind: 'unavailable' }),
    revokeInvitation: async () => ({ kind: 'unavailable' }),
    revokeMembership: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredListingsPort(): ListingsReadPort {
  return {
    listListings: async () => ({ kind: 'unavailable' }),
    loadListing: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredActivityTypePort(): ActivityTypeReadPort {
  return {
    listActivityTypes: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredListingEditorPort(): ListingEditorPort {
  return {
    createProgram: async () => ({ kind: 'unavailable' }),
    updateProgram: async () => ({ kind: 'unavailable' }),
    addPriceOption: async () => ({ kind: 'unavailable' }),
    updatePriceOption: async () => ({ kind: 'unavailable' }),
    archivePriceOption: async () => ({ kind: 'unavailable' }),
    addBranchAssociation: async () => ({ kind: 'unavailable' }),
    removeBranchAssociation: async () => ({ kind: 'unavailable' }),
    addMedia: async () => ({ kind: 'unavailable' }),
    updateMedia: async () => ({ kind: 'unavailable' }),
    archiveMedia: async () => ({ kind: 'unavailable' }),
    addOffer: async () => ({ kind: 'unavailable' }),
    updateOffer: async () => ({ kind: 'unavailable' }),
    endOffer: async () => ({ kind: 'unavailable' }),
  };
}
