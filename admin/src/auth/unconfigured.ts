import type { AdminAuthAdapter } from './adapter';
import type { AdminAccessPort } from '../access/contract';
import type { AdminProvidersReadPort } from '../providers/contract';
import type { AdminVerificationPort } from '../verification/contract';
import type { AdminModerationPort } from '../moderation/contract';
import type { AdminTaxonomyPort } from '../taxonomy/contract';
import type { AdminRolesPort } from '../roles/contract';
import type { AdminAuditPort } from '../audit/contract';

/**
 * FAIL-CLOSED default: a production build with no configured authentication
 * renders the safe unavailable state and can never grant admin access.
 * Every operation resolves to the least-capable outcome — an unconfigured
 * production deployment cannot become a fake administrator.
 */
export function createUnconfiguredAuthAdapter(): AdminAuthAdapter {
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

export function createUnconfiguredAccessPort(): AdminAccessPort {
  return {
    resolveAccess: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredProvidersPort(): AdminProvidersReadPort {
  return {
    listOrganizations: async () => ({ kind: 'unavailable' }),
    getOrganization: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredModerationPort(): AdminModerationPort {
  return {
    listListings: async () => ({ kind: 'unavailable' }),
    listRevisions: async () => ({ kind: 'unavailable' }),
    getListing: async () => ({ kind: 'unavailable' }),
    reviewListing: async () => ({ kind: 'unavailable' }),
    startRevisionReview: async () => ({ kind: 'unavailable' }),
    decideRevision: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredTaxonomyPort(): AdminTaxonomyPort {
  return {
    getTaxonomy: async () => ({ kind: 'unavailable' }),
    createArea: async () => ({ kind: 'unavailable' }),
    updateArea: async () => ({ kind: 'unavailable' }),
    createCategory: async () => ({ kind: 'unavailable' }),
    updateCategory: async () => ({ kind: 'unavailable' }),
    createActivityType: async () => ({ kind: 'unavailable' }),
    updateActivityType: async () => ({ kind: 'unavailable' }),
    createCollection: async () => ({ kind: 'unavailable' }),
    updateCollection: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredRolesPort(): AdminRolesPort {
  return {
    listAssignments: async () => ({ kind: 'unavailable' }),
    requestRole: async () => ({ kind: 'unavailable' }),
    approveRequest: async () => ({ kind: 'unavailable' }),
    denyRequest: async () => ({ kind: 'unavailable' }),
    revokeAssignment: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredAuditPort(): AdminAuditPort {
  return {
    listEvents: async () => ({ kind: 'unavailable' }),
  };
}

export function createUnconfiguredVerificationPort(): AdminVerificationPort {
  return {
    getVerification: async () => ({ kind: 'unavailable' }),
    openCase: async () => ({ kind: 'unavailable' }),
    startReview: async () => ({ kind: 'unavailable' }),
    decide: async () => ({ kind: 'unavailable' }),
    goLive: async () => ({ kind: 'unavailable' }),
    downloadEvidence: async () => ({ kind: 'unavailable' }),
  };
}
