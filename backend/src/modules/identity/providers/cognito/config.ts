/**
 * Cognito adapter configuration TYPES (docs/26 §2, Amendment A1.1; §14.E′).
 *
 * Configuration only — nothing here (or anywhere in this slice) provisions,
 * names, or contacts a real user pool. The production region and identity DR
 * strategy remain OPEN under docs/23 §18.3; pool identifiers arrive as
 * environment configuration once a non-production development pool exists.
 * When the environment carries no pool, `parseCognitoConfig` returns
 * undefined and the application runs with the fake adapter (tests) or no
 * adapter at all (B2-2 has no auth routes).
 */

export interface CognitoAdapterConfig {
  /** Pool issuer URL, e.g. https://cognito-idp.<region>.amazonaws.com/<poolId>. */
  issuer: string;
  /** Accepted app-client ids (id token `aud` / access token `client_id`). */
  clientIds: string[];
  /**
   * The PUBLIC app client the browser portal authenticates with — the one
   * whose refresh tokens the §14.E server-mediated refresh presents
   * (REFRESH_TOKEN_AUTH is client-bound). Defaults to the sole clientIds
   * entry; REQUIRED explicitly (COGNITO_REFRESH_CLIENT_ID) when several
   * accepted clients exist. Always a member of `clientIds`.
   */
  refreshClientId?: string;
  /** Overrides the derived `<issuer>/.well-known/jwks.json` when set. */
  jwksUri?: string;
  /** Bounded exp/nbf clock-skew tolerance (0–300 s; verifier default 30 s). */
  clockToleranceSeconds?: number;
}

const MAX_CLOCK_TOLERANCE_SECONDS = 300;

export class CognitoConfigError extends Error {}

export function parseCognitoConfig(
  env: Record<string, string | undefined>,
): CognitoAdapterConfig | undefined {
  const issuer = env.COGNITO_ISSUER?.trim();
  const rawClientIds = env.COGNITO_CLIENT_IDS;
  if (issuer === undefined || issuer === '') {
    if (rawClientIds !== undefined && rawClientIds.trim() !== '') {
      throw new CognitoConfigError('COGNITO_CLIENT_IDS is set without COGNITO_ISSUER.');
    }
    return undefined;
  }
  if (!issuer.startsWith('https://')) {
    throw new CognitoConfigError('COGNITO_ISSUER must be an https URL.');
  }
  const clientIds = (rawClientIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (clientIds.length === 0) {
    throw new CognitoConfigError('COGNITO_CLIENT_IDS must list at least one app client id.');
  }
  const refreshClientId = env.COGNITO_REFRESH_CLIENT_ID?.trim();
  if (refreshClientId !== undefined && refreshClientId !== '' && !clientIds.includes(refreshClientId)) {
    throw new CognitoConfigError(
      'COGNITO_REFRESH_CLIENT_ID must be one of the accepted COGNITO_CLIENT_IDS.',
    );
  }
  const jwksUri = env.COGNITO_JWKS_URI?.trim();
  const rawTolerance = env.COGNITO_CLOCK_TOLERANCE_SECONDS?.trim();
  let clockToleranceSeconds: number | undefined;
  if (rawTolerance !== undefined && rawTolerance !== '') {
    clockToleranceSeconds = Number(rawTolerance);
    if (
      !Number.isInteger(clockToleranceSeconds) ||
      clockToleranceSeconds < 0 ||
      clockToleranceSeconds > MAX_CLOCK_TOLERANCE_SECONDS
    ) {
      throw new CognitoConfigError(
        `COGNITO_CLOCK_TOLERANCE_SECONDS must be an integer between 0 and ${MAX_CLOCK_TOLERANCE_SECONDS}.`,
      );
    }
  }
  return {
    issuer,
    clientIds,
    ...(refreshClientId !== undefined && refreshClientId !== ''
      ? { refreshClientId }
      : {}),
    ...(jwksUri !== undefined && jwksUri !== '' ? { jwksUri } : {}),
    ...(clockToleranceSeconds !== undefined ? { clockToleranceSeconds } : {}),
  };
}

/**
 * The app client id the server-mediated refresh presents to Cognito.
 * Fails closed when several accepted clients exist and none is explicitly
 * designated — never guesses.
 */
export function refreshClientIdOf(config: CognitoAdapterConfig): string {
  if (config.refreshClientId !== undefined) {
    return config.refreshClientId;
  }
  if (config.clientIds.length === 1 && config.clientIds[0] !== undefined) {
    return config.clientIds[0];
  }
  throw new CognitoConfigError(
    'COGNITO_REFRESH_CLIENT_ID is required when several app client ids are accepted.',
  );
}

/** Fails closed: a verifier can never be built without its trust anchors. */
export function assertCompleteConfig(config: CognitoAdapterConfig): void {
  if (config.issuer === '' || !config.issuer.startsWith('https://')) {
    throw new CognitoConfigError('Cognito config requires an https issuer.');
  }
  if (config.clientIds.length === 0) {
    throw new CognitoConfigError('Cognito config requires at least one app client id.');
  }
}

export function jwksUriFor(config: CognitoAdapterConfig): string {
  return config.jwksUri ?? `${config.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
}
