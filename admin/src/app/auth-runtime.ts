import type { AdminAuthAdapter } from '../auth/adapter';
import { resolveAuthMode } from '../auth/auth-mode';
import {
  createUnconfiguredAccessPort,
  createUnconfiguredAuthAdapter,
  createUnconfiguredModerationPort,
  createUnconfiguredProvidersPort,
  createUnconfiguredTaxonomyPort,
  createUnconfiguredVerificationPort,
} from '../auth/unconfigured';
import type { AdminEnv } from '../api/env';
import type { AdminAccessPort } from '../access/contract';
import type { AdminProvidersReadPort } from '../providers/contract';
import type { AdminVerificationPort } from '../verification/contract';
import type { AdminModerationPort } from '../moderation/contract';
import type { AdminTaxonomyPort } from '../taxonomy/contract';
import { createLiveAuthRuntime } from '../auth/live/live-auth-runtime';
import { createLiveProvidersReadPort } from '../services/live/live-providers-port';
import { createLiveVerificationPort } from '../services/live/live-verification-port';
import { createLiveModerationPort } from '../services/live/live-moderation-port';
import { createLiveTaxonomyPort } from '../services/live/live-taxonomy-port';
import {
  createFixtureAdminRuntime,
  type FixtureAdminControls,
} from '../services/mock/fixture-admin';

export interface AuthRuntime {
  readonly mode: 'fixture' | 'live' | 'unconfigured';
  readonly adapter: AdminAuthAdapter;
  readonly accessPort: AdminAccessPort;
  readonly providersPort: AdminProvidersReadPort;
  readonly verificationPort: AdminVerificationPort;
  readonly moderationPort: AdminModerationPort;
  readonly taxonomyPort: AdminTaxonomyPort;
}

declare global {
  interface Window {
    /** Fixture-mode-only demo/e2e controls; never installed otherwise. */
    __himmaAdminAccessFixture?: FixtureAdminControls & { seedSession(email: string): void };
  }
}

/**
 * Composes the admin auth adapter + access port for this environment —
 * fail-closed by construction, the exact W2-12A discipline: anything but
 * an explicit, COMPLETE resolution yields the unconfigured pair, which can
 * never grant access. Live mode (explicit `VITE_ADMIN_AUTH_MODE=live`)
 * wires the real Cognito/Himma auth + the real `GET /admin/me` bootstrap;
 * missing/invalid live configuration NEVER falls back to fixtures, and no
 * fixture identity can ever appear in a live composition.
 */
export function createAuthRuntime(env: AdminEnv): AuthRuntime {
  const mode = resolveAuthMode({
    configuredMode: env.authModeSetting,
    isProduction: env.isProduction,
  });

  if (mode === 'live') {
    const liveConfig = resolveLiveConfig(env);
    if (liveConfig === null) {
      return unconfiguredRuntime();
    }
    const live = createLiveAuthRuntime(liveConfig);
    return {
      mode,
      adapter: live.adapter,
      accessPort: live.accessPort,
      providersPort: createLiveProvidersReadPort(live.transport),
      verificationPort: createLiveVerificationPort(live.transport),
      moderationPort: createLiveModerationPort(live.transport),
      taxonomyPort: createLiveTaxonomyPort(live.transport),
    };
  }

  if (mode === 'fixture') {
    const fixture = createFixtureAdminRuntime();
    if (typeof window !== 'undefined') {
      window.__himmaAdminAccessFixture = {
        ...fixture.controls,
        seedSession: fixture.seedSession,
      };
    }
    return {
      mode,
      adapter: fixture.adapter,
      accessPort: fixture.accessPort,
      providersPort: fixture.providersPort,
      verificationPort: fixture.verificationPort,
      moderationPort: fixture.moderationPort,
      taxonomyPort: fixture.taxonomyPort,
    };
  }

  return unconfiguredRuntime();
}

/** Every value the live path requires, validated together — any gap fails
 *  the WHOLE composition closed (no partial live wiring). */
function resolveLiveConfig(env: AdminEnv): {
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
    providersPort: createUnconfiguredProvidersPort(),
    verificationPort: createUnconfiguredVerificationPort(),
    moderationPort: createUnconfiguredModerationPort(),
    taxonomyPort: createUnconfiguredTaxonomyPort(),
  };
}
