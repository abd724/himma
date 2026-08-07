/**
 * Auth-mode resolution (task §25 — production is FAIL-CLOSED).
 *
 * - Development builds default to the fixture adapter so the portal is
 *   workable before live integration (W2-12).
 * - Production builds default to `unconfigured`: the portal renders a safe
 *   "sign-in unavailable" state and no fixture access can be granted by
 *   forgetting configuration. Fixture mode in a production build requires
 *   the explicit `VITE_PORTAL_AUTH_MODE=fixture` opt-in (owner demo hosting).
 * - Unknown values fail closed everywhere.
 */
export type PortalAuthMode = 'fixture' | 'unconfigured';

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
  if (!mode) {
    return isProduction ? 'unconfigured' : 'fixture';
  }
  return 'unconfigured';
}
