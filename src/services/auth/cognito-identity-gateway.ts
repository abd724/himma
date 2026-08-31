/**
 * RI-6 — the REAL Cognito token-acquisition gateway for the Customer App
 * (the production half of the RI-1 `IdentityGateway` seam; the dev
 * identity stand-in remains the development half and is structurally
 * excluded from production composition).
 *
 * Speaks the public Cognito Identity Provider JSON API directly against a
 * PUBLIC app client — no client secret exists or is ever sent (the same
 * one-replaceable-boundary discipline as `portal/src/auth/live/cognito-api.ts`
 * and the backend's `modules/identity/providers/cognito/*`). Only the
 * flows the certified customer architecture needs:
 *
 * - `SignUp` + immediate `InitiateAuth` (USER_PASSWORD_AUTH) — sign-up;
 * - `InitiateAuth` (USER_PASSWORD_AUTH) — sign-in;
 * - `InitiateAuth` (REFRESH_TOKEN_AUTH) — cold-start refresh.
 *
 * Error discipline: provider failures are normalized to the app's typed
 * error vocabulary (`ApiError` for authoritative rejections — the same
 * shape the dev gateway produces through the HTTP client — and
 * `NetworkError` for transient transport failures, which `AuthSession`
 * treats as retry-later, never sign-out). Raw Cognito exception objects
 * never leave this module and no credential/token material is ever
 * logged.
 *
 * Operational constraints (recorded, not hidden): the app client must
 * allow `ALLOW_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`, and the
 * pool must auto-confirm email sign-ups (or an email-confirmation step
 * must be added at operational enablement — `UserNotConfirmed` surfaces
 * as a typed refusal rather than a fake session). MFA challenges are not
 * a customer V1 flow and refuse safely.
 */
import type { IdentityGateway, IdentityTokens } from '@/services/contracts/identity';
import { ApiError, NetworkError } from '@/services/http/http-client';

export interface CognitoGatewayConfig {
  /** Pool issuer URL (the backend's COGNITO_ISSUER); the regional service
   *  endpoint derives from its origin. */
  issuer: string;
  /** PUBLIC app-client id — configuration, not a secret. */
  clientId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface CognitoCallOk {
  ok: true;
  payload: Record<string, unknown>;
}
interface CognitoCallFailed {
  ok: false;
  /** The final segment of the Cognito __type, or '' when absent. */
  type: string;
  transient: boolean;
}

const INVALID_CREDENTIAL_TYPES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'PasswordResetRequiredException',
  'InvalidParameterException',
]);

async function cognitoCall(
  config: CognitoGatewayConfig,
  action: string,
  payload: Record<string, unknown>,
): Promise<CognitoCallOk | CognitoCallFailed> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = new URL(config.issuer).origin + '/';
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new NetworkError(error);
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
  if (response.status >= 500) return { ok: false, type: '', transient: true };
  const rawType =
    typeof body === 'object' && body !== null && typeof (body as { __type?: unknown }).__type === 'string'
      ? (body as { __type: string }).__type
      : '';
  return { ok: false, type: rawType.split('#').pop() ?? '', transient: false };
}

function failure(call: CognitoCallFailed): never {
  if (call.transient) throw new NetworkError(new Error('identity provider unavailable'));
  if (call.type === 'TooManyRequestsException' || call.type === 'LimitExceededException') {
    throw new ApiError(429, 'rateLimited', 'Too many attempts — try again shortly.');
  }
  if (call.type === 'UserNotConfirmedException') {
    // Recorded operational constraint: the customer pool must auto-confirm
    // (or a confirmation step ships at enablement) — never a fake session.
    throw new ApiError(409, 'accountNotConfirmed', 'This account needs email confirmation.');
  }
  if (call.type === 'UsernameExistsException') {
    throw new ApiError(409, 'emailInUse', 'An account with this email already exists.');
  }
  if (INVALID_CREDENTIAL_TYPES.has(call.type)) {
    throw new ApiError(401, 'invalidCredentials', 'Email or password is incorrect.');
  }
  if (call.type === 'InvalidPasswordException') {
    throw new ApiError(422, 'invalidPassword', 'That password does not meet the requirements.');
  }
  throw new ApiError(400, 'identityProviderRefused', 'Sign-in could not be completed.');
}

function tokensFrom(
  payload: Record<string, unknown>,
  now: Date,
  fallbackRefreshToken?: string,
): IdentityTokens {
  const result = payload.AuthenticationResult;
  if (typeof result !== 'object' || result === null) {
    // An unexpected challenge (MFA, NEW_PASSWORD_REQUIRED, …) — not a V1
    // customer flow; refuse safely rather than half-implementing it.
    throw new ApiError(409, 'identityChallengeUnsupported', 'This account needs extra sign-in steps.');
  }
  const raw = result as Record<string, unknown>;
  if (typeof raw.AccessToken !== 'string' || raw.AccessToken.length === 0) {
    throw new ApiError(502, 'identityProviderRefused', 'Sign-in could not be completed.');
  }
  const expiresInSeconds = typeof raw.ExpiresIn === 'number' ? raw.ExpiresIn : 3600;
  const refreshToken =
    typeof raw.RefreshToken === 'string' && raw.RefreshToken.length > 0
      ? raw.RefreshToken
      : fallbackRefreshToken;
  return {
    accessToken: raw.AccessToken,
    ...(typeof raw.IdToken === 'string' && raw.IdToken.length > 0 ? { idToken: raw.IdToken } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
  };
}

export function createCognitoIdentityGateway(config: CognitoGatewayConfig): IdentityGateway {
  const now = config.now ?? (() => new Date());

  async function passwordAuth(email: string, password: string): Promise<IdentityTokens> {
    const call = await cognitoCall(config, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    if (!call.ok) failure(call);
    return tokensFrom(call.payload, now());
  }

  return {
    async signUp(input) {
      const call = await cognitoCall(config, 'SignUp', {
        ClientId: config.clientId,
        Username: input.email,
        Password: input.password,
        UserAttributes: [
          { Name: 'email', Value: input.email },
          ...(input.displayName !== undefined && input.displayName !== ''
            ? [{ Name: 'name', Value: input.displayName }]
            : []),
        ],
      });
      if (!call.ok) failure(call);
      // Token acquisition follows immediately (auto-confirmed pools); an
      // unconfirmed account surfaces the typed refusal above.
      return passwordAuth(input.email, input.password);
    },

    async signIn(input) {
      return passwordAuth(input.email, input.password);
    },

    async refresh(refreshToken) {
      const call = await cognitoCall(config, 'InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: config.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      if (!call.ok) {
        if (!call.transient && (call.type === 'NotAuthorizedException' || call.type === '')) {
          // The refresh authority is dead — an AUTHORITATIVE rejection
          // (AuthSession forgets the stored session).
          throw new ApiError(401, 'sessionExpired', 'Your session has expired.');
        }
        failure(call);
      }
      const tokens = tokensFrom(call.payload, now(), refreshToken);
      return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
    },
  };
}
