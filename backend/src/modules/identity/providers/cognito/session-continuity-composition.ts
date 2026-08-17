/**
 * PRODUCTION composition of the §14.E session-continuity channel (W2-12A
 * final correction) — the one factory a live/production startup uses to
 * wire `buildApp`'s `sessionContinuity` + `providerRevoker` identity deps
 * from environment configuration.
 *
 * Fail-closed rules (docs/25 §5, docs/26 §14.E):
 * - No Cognito configuration (COGNITO_ISSUER absent) → `undefined`: the
 *   continuity routes simply do not register (404) and nothing pretends.
 * - Cognito configured but incomplete/ambiguous (missing client ids, an
 *   undesignated refresh client among several) → throws at startup.
 * - Insecure production cookie/origin configuration → throws at startup
 *   (parseAuthCookieConfig), and a production channel with NO declared
 *   portal origin throws too — a channel no browser could safely use is
 *   misconfiguration, not a fallback.
 *
 * Only CONCRETE providers are constructed here — no fake implementation is
 * imported or reachable from this module; deterministic fakes live in
 * `providers/fake/*` and enter ONLY through explicit test composition.
 */
import type { NodeEnv } from '../../../../config/env';
import {
  parseAuthCookieConfig,
  AuthCookieConfigError,
  type AuthCookieConfig,
} from '../../http/auth-session-cookies';
import type { ProviderTokenRefresher } from '../refresh';
import type { ProviderSessionRevoker } from '../revocation';
import { parseCognitoConfig, refreshClientIdOf } from './config';
import { createCognitoTokenRefresher } from './cognito-token-refresher';
import { CognitoSessionRevoker } from './cognito-session-revoker';

export interface CognitoSessionContinuity {
  sessionContinuity: {
    cookieConfig: AuthCookieConfig;
    tokenRefresher: ProviderTokenRefresher;
  };
  providerRevoker: ProviderSessionRevoker;
}

export function createCognitoSessionContinuity(
  nodeEnv: NodeEnv,
  env: Record<string, string | undefined>,
): CognitoSessionContinuity | undefined {
  const cognito = parseCognitoConfig(env);
  if (cognito === undefined) {
    return undefined;
  }
  // Resolves (or refuses) the designated portal app client up front so a
  // misconfigured production start fails at composition, not first use.
  refreshClientIdOf(cognito);
  const cookieConfig = parseAuthCookieConfig(nodeEnv, env);
  if (nodeEnv === 'production' && cookieConfig.allowedOrigins.length === 0) {
    throw new AuthCookieConfigError(
      'PORTAL_ALLOWED_ORIGINS must declare the portal origin(s) for the production session-continuity channel.',
    );
  }
  return {
    sessionContinuity: {
      cookieConfig,
      tokenRefresher: createCognitoTokenRefresher(cognito),
    },
    providerRevoker: new CognitoSessionRevoker(cognito),
  };
}
