import type { FetchLike } from '../../api/client';

/**
 * Minimal Amazon Cognito user-pool client for the portal's live auth
 * adapter — the ONE portal module that speaks Cognito wire semantics
 * (docs/26 §2: the provider stays behind one replaceable boundary; the
 * backend equivalent is `modules/identity/providers/cognito/*`).
 *
 * Uses the public Cognito Identity Provider JSON API directly (a PUBLIC
 * app client — no client secret exists or is ever sent). Only the flows
 * the approved architecture needs: `InitiateAuth` (USER_PASSWORD_AUTH),
 * `RespondToAuthChallenge` (SOFTWARE_TOKEN_MFA), and `RevokeToken`.
 * Provider errors are normalized to the portal's semantic vocabulary —
 * raw Cognito exception objects never leave this module, and no token or
 * credential material is ever logged.
 *
 * The auth-flow choice (USER_PASSWORD_AUTH; requires
 * `ALLOW_USER_PASSWORD_AUTH` on the app client) is the docs/26 §15
 * "challenge-producing auth-flow" selection — it remains subject to the
 * outstanding real-pool SOFTWARE_TOKEN_MFA smoke (§14.E′) before any
 * operational certification claim.
 */

export interface CognitoTokens {
  readonly accessToken: string;
  readonly idToken: string | null;
  readonly refreshToken: string | null;
}

export type CognitoAuthResult =
  | { readonly kind: 'tokens'; readonly tokens: CognitoTokens }
  /** SOFTWARE_TOKEN_MFA challenge — answer with a TOTP code. */
  | { readonly kind: 'mfaChallenge'; readonly session: string }
  | { readonly kind: 'invalidCredentials' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'providerUnavailable' }
  /** Anything the portal flow does not support (e.g. an unexpected
   *  challenge type) — surfaced as a safe generic failure. */
  | { readonly kind: 'failure' };

export type CognitoChallengeResult =
  | { readonly kind: 'tokens'; readonly tokens: CognitoTokens }
  | { readonly kind: 'invalidCode' }
  /** The challenge session lapsed/was consumed — restart from credentials
   *  (the documented `NotAuthorizedException → challengeExpired`
   *  respond-context mapping, docs/26 §15). */
  | { readonly kind: 'challengeExpired' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'failure' };

export interface CognitoClientConfig {
  /** Pool issuer URL (as the backend's COGNITO_ISSUER) — the regional
   *  service endpoint is derived from its origin. */
  readonly issuer: string;
  /** Public app-client id (configuration, not a secret). */
  readonly clientId: string;
  readonly fetchImpl: FetchLike;
}

interface CognitoErrorShape {
  readonly type: string;
}

type CognitoCallResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly error: CognitoErrorShape | 'network' | 'unavailable' };

async function cognitoCall(
  config: CognitoClientConfig,
  action: string,
  payload: Record<string, unknown>,
): Promise<CognitoCallResult> {
  const endpoint = new URL(config.issuer).origin + '/';
  let response: Response;
  try {
    response = await config.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    return {
      ok: true,
      payload: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
    };
  }
  if (response.status >= 500) {
    return { ok: false, error: 'unavailable' };
  }
  const rawType =
    typeof body === 'object' && body !== null && typeof (body as { __type?: unknown }).__type === 'string'
      ? (body as { __type: string }).__type
      : '';
  // Types arrive either bare or namespaced — keep the final segment.
  const type = rawType.split('#').pop() ?? '';
  return { ok: false, error: { type } };
}

function tokensFrom(payload: Record<string, unknown>): CognitoTokens | null {
  const result = payload.AuthenticationResult;
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const raw = result as Record<string, unknown>;
  if (typeof raw.AccessToken !== 'string' || raw.AccessToken.length === 0) {
    return null;
  }
  return {
    accessToken: raw.AccessToken,
    idToken: typeof raw.IdToken === 'string' ? raw.IdToken : null,
    refreshToken: typeof raw.RefreshToken === 'string' ? raw.RefreshToken : null,
  };
}

const RATE_LIMIT_TYPES = new Set(['TooManyRequestsException', 'LimitExceededException']);

/** USER_PASSWORD_AUTH sign-in against the public app client. */
export async function initiatePasswordAuth(
  config: CognitoClientConfig,
  input: { email: string; password: string },
): Promise<CognitoAuthResult> {
  const call = await cognitoCall(config, 'InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: config.clientId,
    AuthParameters: { USERNAME: input.email, PASSWORD: input.password },
  });
  if (!call.ok) {
    if (call.error === 'network' || call.error === 'unavailable') {
      return { kind: 'providerUnavailable' };
    }
    if (RATE_LIMIT_TYPES.has(call.error.type)) {
      return { kind: 'rateLimited' };
    }
    // NotAuthorized / UserNotFound / UserNotConfirmed / PasswordResetRequired
    // all collapse into the one safe credentials class (docs/26 §5.5).
    if (
      [
        'NotAuthorizedException',
        'UserNotFoundException',
        'UserNotConfirmedException',
        'PasswordResetRequiredException',
        'InvalidParameterException',
      ].includes(call.error.type)
    ) {
      return { kind: 'invalidCredentials' };
    }
    return { kind: 'failure' };
  }
  const challengeName = call.payload.ChallengeName;
  if (challengeName === 'SOFTWARE_TOKEN_MFA') {
    const session = call.payload.Session;
    if (typeof session !== 'string' || session.length === 0) {
      return { kind: 'failure' };
    }
    return { kind: 'mfaChallenge', session };
  }
  if (typeof challengeName === 'string') {
    // A challenge this portal flow does not support (NEW_PASSWORD_REQUIRED,
    // SMS_MFA, …) — refuse safely rather than half-implementing it.
    return { kind: 'failure' };
  }
  const tokens = tokensFrom(call.payload);
  return tokens === null ? { kind: 'failure' } : { kind: 'tokens', tokens };
}

/** Answer the SOFTWARE_TOKEN_MFA login challenge with a TOTP code. */
export async function respondToTotpChallenge(
  config: CognitoClientConfig,
  input: { session: string; email: string; code: string },
): Promise<CognitoChallengeResult> {
  const call = await cognitoCall(config, 'RespondToAuthChallenge', {
    ClientId: config.clientId,
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    Session: input.session,
    ChallengeResponses: {
      USERNAME: input.email,
      SOFTWARE_TOKEN_MFA_CODE: input.code,
    },
  });
  if (!call.ok) {
    if (call.error === 'network' || call.error === 'unavailable') {
      return { kind: 'failure' };
    }
    if (RATE_LIMIT_TYPES.has(call.error.type)) {
      return { kind: 'rateLimited' };
    }
    if (call.error.type === 'CodeMismatchException') {
      return { kind: 'invalidCode' };
    }
    if (
      call.error.type === 'NotAuthorizedException' ||
      call.error.type === 'ExpiredCodeException'
    ) {
      return { kind: 'challengeExpired' };
    }
    return { kind: 'failure' };
  }
  const tokens = tokensFrom(call.payload);
  return tokens === null ? { kind: 'failure' } : { kind: 'tokens', tokens };
}

/** Best-effort provider-side refresh-token revocation (public client). */
export async function revokeRefreshToken(
  config: CognitoClientConfig,
  refreshToken: string,
): Promise<void> {
  await cognitoCall(config, 'RevokeToken', {
    ClientId: config.clientId,
    Token: refreshToken,
  });
}
