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
import {
  refreshClientIdOf,
  assertCompleteConfig,
  type CognitoAdapterConfig,
} from './config';

/** Injectable subset of the Cognito IdP surface used by the refresh flow:
 *  `InitiateAuth` with `AuthFlow: REFRESH_TOKEN_AUTH`. The CONCRETE
 *  production implementation is `CognitoRefreshHttpClient` below; tests
 *  may stub this interface directly. */
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

/**
 * CONCRETE production CognitoRefreshClient (W2-12A final correction).
 *
 * Performs the real `InitiateAuth` / `AuthFlow: REFRESH_TOKEN_AUTH` call
 * against the pool's regional endpoint (derived from the configured
 * issuer) for the designated PUBLIC portal app client. This is the same
 * unauthenticated Cognito Identity Provider JSON API the approved D1
 * architecture already uses browser-side for USER_PASSWORD_AUTH — the
 * operation is unsigned for public app clients, so no AWS credential, no
 * client secret, and no AWS SDK dependency is required (matching the
 * repository's concrete-adapter style: jose for JWKS verification,
 * platform HTTP for provider calls, injectable seams for tests).
 *
 * A confidential app client (SECRET_HASH) is deliberately NOT supported:
 * the docs/26 D1 portal flow has the browser authenticate against the
 * SAME app client directly, which is only possible for a public client —
 * introducing a secret here would contradict the approved architecture.
 *
 * Error handling: Cognito error `__type`s are re-thrown as Error objects
 * whose `name` is the bare exception type and whose message is a fixed
 * safe phrase — no AWS payloads, request ids, or token material ever
 * propagate; `CognitoTokenRefresher` then normalizes names into the
 * semantic port vocabulary (invalid-credential set vs providerUnavailable).
 */
export type RefreshFetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class CognitoRefreshHttpClient implements CognitoRefreshClient {
  private readonly endpoint: string;
  private readonly clientId: string;
  private readonly fetchImpl: RefreshFetchLike;

  constructor(
    config: CognitoAdapterConfig,
    options: { fetchImpl?: RefreshFetchLike } = {},
  ) {
    assertCompleteConfig(config);
    this.endpoint = `${new URL(config.issuer).origin}/`;
    this.clientId = refreshClientIdOf(config);
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => globalThis.fetch(input, init) as ReturnType<RefreshFetchLike>);
  }

  async initiateRefreshAuth(input: { refreshToken: string }): Promise<{
    accessToken?: string;
    idToken?: string;
    refreshToken?: string;
  }> {
    let response: Awaited<ReturnType<RefreshFetchLike>>;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
        body: JSON.stringify({
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          ClientId: this.clientId,
          AuthParameters: { REFRESH_TOKEN: input.refreshToken },
        }),
      });
    } catch {
      throw named('CognitoUnavailableError');
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      if (response.status >= 500) throw named('CognitoUnavailableError');
      const rawType =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { __type?: unknown }).__type === 'string'
          ? (body as { __type: string }).__type
          : '';
      throw named(rawType.split('#').pop() ?? 'CognitoRefreshError');
    }
    const result =
      typeof body === 'object' && body !== null
        ? (body as { AuthenticationResult?: Record<string, unknown> }).AuthenticationResult
        : undefined;
    const raw = typeof result === 'object' && result !== null ? result : {};
    return {
      ...(typeof raw.AccessToken === 'string' ? { accessToken: raw.AccessToken } : {}),
      ...(typeof raw.IdToken === 'string' ? { idToken: raw.IdToken } : {}),
      // Cognito returns a NEW refresh token only when the pool has
      // rotation enabled — mapped only when actually present, never
      // fabricated (the server cookie keeps the original otherwise).
      ...(typeof raw.RefreshToken === 'string' ? { refreshToken: raw.RefreshToken } : {}),
    };
  }
}

/** Safe, name-only error: no provider payloads, no token material. */
function named(name: string): Error {
  const error = new Error('Cognito refresh refused.');
  error.name = name === '' ? 'CognitoRefreshError' : name;
  return error;
}

/** The production ProviderTokenRefresher over the concrete HTTP client. */
export function createCognitoTokenRefresher(
  config: CognitoAdapterConfig,
  options: { fetchImpl?: RefreshFetchLike } = {},
): CognitoTokenRefresher {
  return new CognitoTokenRefresher(new CognitoRefreshHttpClient(config, options));
}
