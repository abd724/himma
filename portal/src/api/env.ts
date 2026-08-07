/**
 * Environment-config boundary. All runtime configuration enters the portal
 * here — components never read import.meta.env directly.
 * No production URL is hardcoded anywhere (docs/29 §19): the API base URL is
 * per-environment configuration, absent until deployment configuration exists.
 */
export interface PortalEnv {
  /** Base URL of the Himma backend API; null until an environment provides it. */
  readonly apiBaseUrl: string | null;
}

export function readPortalEnv(raw: Record<string, string | undefined>): PortalEnv {
  const apiBaseUrl = raw['VITE_API_BASE_URL']?.trim();
  return { apiBaseUrl: apiBaseUrl ? apiBaseUrl : null };
}

export function portalEnv(): PortalEnv {
  return readPortalEnv(import.meta.env as Record<string, string | undefined>);
}
