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
  /** Accepted app-client ids (the id token `aud` claim). */
  clientIds: string[];
  /** Overrides the derived `<issuer>/.well-known/jwks.json` when set. */
  jwksUri?: string;
}

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
  const jwksUri = env.COGNITO_JWKS_URI?.trim();
  return {
    issuer,
    clientIds,
    ...(jwksUri !== undefined && jwksUri !== '' ? { jwksUri } : {}),
  };
}

export function jwksUriFor(config: CognitoAdapterConfig): string {
  return config.jwksUri ?? `${config.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
}
