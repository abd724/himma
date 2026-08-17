/**
 * Auth-mode resolution (task §25 — production is FAIL-CLOSED).
 *
 * - Development builds default to the fixture adapter so the portal is
 *   workable without live resources.
 * - `live` is an EXPLICIT selection (`VITE_PORTAL_AUTH_MODE=live`) in every
 *   environment — real Cognito/API integration is never implied.
 * - Production builds default to `unconfigured`: the portal renders a safe
 *   "sign-in unavailable" state and no fixture access can be granted by
 *   forgetting configuration. Fixture mode in a production build requires
 *   the explicit `VITE_PORTAL_AUTH_MODE=fixture` opt-in (owner demo hosting).
 * - Unknown values fail closed everywhere.
 */
export type PortalAuthMode = 'fixture' | 'live' | 'unconfigured';

export function resolveAuthMode({
  configuredMode,
  isProduction,
}: {
  configuredMode: string | undefined;
  isProduction: boolean;
}): PortalAuthMode {
  const mode = configuredMode?.trim();
  if (mode === 'fixture') {
    return 'fixture';
  }
  if (mode === 'live') {
    return 'live';
  }
  if (!mode) {
    return isProduction ? 'unconfigured' : 'fixture';
  }
  return 'unconfigured';
}
