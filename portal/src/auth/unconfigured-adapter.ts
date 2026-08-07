import type { PortalAuthAdapter } from './adapter';
import type { ProviderAccessPort } from '../provider-access/contract';

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
