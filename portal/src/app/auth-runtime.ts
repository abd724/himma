import type { PortalAuthAdapter } from '../auth/adapter';
import { resolveAuthMode } from '../auth/auth-mode';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredAuthAdapter,
} from '../auth/unconfigured-adapter';
import type { PortalEnv } from '../api/env';
import type { ProviderAccessPort } from '../provider-access/contract';
import { createFixtureAuthRuntime, type FixtureAccessControls } from '../services/mock/fixture-auth';

export interface AuthRuntime {
  readonly mode: 'fixture' | 'unconfigured';
  readonly adapter: PortalAuthAdapter;
  readonly accessPort: ProviderAccessPort;
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
    return { mode, adapter: fixture.adapter, accessPort: fixture.accessPort };
  }

  return {
    mode,
    adapter: createUnconfiguredAuthAdapter(),
    accessPort: createUnconfiguredAccessPort(),
  };
}
