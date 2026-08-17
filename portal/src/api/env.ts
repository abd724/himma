/**
 * Environment-config boundary. All runtime configuration enters the portal
 * here — components never read import.meta.env directly.
 * No production URL is hardcoded anywhere (docs/29 §19): the API base URL,
 * Cognito issuer, and Cognito app-client id are per-environment
 * configuration, absent until deployment configuration exists. The Cognito
 * values are PUBLIC browser-safe identifiers (docs/26 §2) — configuration,
 * never secrets; no confidential client secret ever enters this bundle.
 */
export interface PortalEnv {
  /** Base URL of the Himma backend API; null until an environment provides it. */
  readonly apiBaseUrl: string | null;
  /** Raw auth-mode configuration; resolved fail-closed by resolveAuthMode. */
  readonly authModeSetting: string | undefined;
  readonly isProduction: boolean;
  /** Cognito pool issuer URL (mirrors backend COGNITO_ISSUER semantics). */
  readonly cognitoIssuer: string | null;
  /** The portal's Cognito app-client id (public identifier). */
  readonly cognitoClientId: string | null;
}

export function readPortalEnv(
  raw: Record<string, string | undefined>,
  isProduction: boolean,
): PortalEnv {
  const apiBaseUrl = raw['VITE_API_BASE_URL']?.trim();
  const cognitoIssuer = raw['VITE_COGNITO_ISSUER']?.trim();
  const cognitoClientId = raw['VITE_COGNITO_CLIENT_ID']?.trim();
  return {
    apiBaseUrl: apiBaseUrl ? apiBaseUrl : null,
    authModeSetting: raw['VITE_PORTAL_AUTH_MODE'],
    isProduction,
    cognitoIssuer: cognitoIssuer ? cognitoIssuer : null,
    cognitoClientId: cognitoClientId ? cognitoClientId : null,
  };
}

export function portalEnv(): PortalEnv {
  return readPortalEnv(
    import.meta.env as unknown as Record<string, string | undefined>,
    import.meta.env.PROD,
  );
}
