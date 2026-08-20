import type { AdminAuthAdapter } from './adapter';
import type { AdminAccessPort } from '../access/contract';
import type { AdminProvidersReadPort } from '../providers/contract';
import type { AdminVerificationPort } from '../verification/contract';
import type { AdminModerationPort } from '../moderation/contract';

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
