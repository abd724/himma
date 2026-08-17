/**
 * Cognito ProviderTokenRefresher (docs/26 §2, §4.7; A1.1) — W2-12A
 * session-continuity correction.
 *
 * Mediated behind an INJECTED client interface exactly like the other
 * Cognito adapters: nothing here provisions, names, or contacts a real
 * user pool — the concrete AWS-SDK/HTTP client (REFRESH_TOKEN_AUTH against
 * the configured app client) belongs to the §14.E′ real-pool task, and the
 * real-pool refresh smoke remains pending until that pool exists.
 *
 * Provider exception objects never escape; refresh-token material is
 * in-memory pass-through only and never logged.
 */
import type {
  ProviderRefreshResult,
  ProviderTokenRefresher,
} from '../refresh';

/** Injectable subset of the Cognito IdP surface used by the refresh flow:
 *  `InitiateAuth` with `AuthFlow: REFRESH_TOKEN_AUTH`. */
export interface CognitoRefreshClient {
  initiateRefreshAuth(input: { refreshToken: string }): Promise<{
    accessToken?: string;
    idToken?: string;
    /** Present when the pool has refresh-token rotation enabled. */
    refreshToken?: string;
  }>;
}

/** Cognito exception names that mean the refresh credential itself is
 *  unusable (revoked, expired, reused after rotation, disabled user). */
const INVALID_REFRESH_ERRORS = [
  'NotAuthorizedException',
  'UserNotFoundException',
  'PasswordResetRequiredException',
  'UserNotConfirmedException',
  'InvalidParameterException',
  'ResourceNotFoundException',
];

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export class CognitoTokenRefresher implements ProviderTokenRefresher {
  constructor(private readonly client: CognitoRefreshClient) {}

  async refreshTokens(input: { refreshToken: string }): Promise<ProviderRefreshResult> {
    let result: Awaited<ReturnType<CognitoRefreshClient['initiateRefreshAuth']>>;
    try {
      result = await this.client.initiateRefreshAuth({ refreshToken: input.refreshToken });
    } catch (error) {
      return INVALID_REFRESH_ERRORS.includes(errorName(error))
        ? { ok: false, reason: 'invalidRefreshToken' }
        : { ok: false, reason: 'providerUnavailable' };
    }
    if (typeof result.accessToken !== 'string' || result.accessToken.length === 0) {
      return { ok: false, reason: 'invalidRefreshToken' };
    }
    return {
      ok: true,
      tokens: {
        accessToken: result.accessToken,
        ...(result.idToken !== undefined ? { idToken: result.idToken } : {}),
        ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
      },
    };
  }
}
