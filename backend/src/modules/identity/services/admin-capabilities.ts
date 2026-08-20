/**
 * Safe admin-capability PROJECTION for the Admin Portal bootstrap (W3-1).
 *
 * This is NOT a new authorization model: it is a single, centralized
 * projection of the authority the backend services ALREADY enforce, so the
 * Admin frontend can drive navigation/route UX from one authoritative
 * source instead of duplicating role matrices across components. Every
 * admin route keeps checking the specific PostgreSQL role itself —
 * deny-by-default holds regardless of what this projection claims.
 *
 * Grounding (the exact service checks, W3-0 reconciliation):
 * - `operations` is the sole role accepted by the organization-lifecycle
 *   services (organization-admin.ts), Program/ProgramRevision moderation
 *   (moderation.ts `hasOperationsRole`), and taxonomy administration
 *   (taxonomy-admin.ts) → providers.operate · catalogue.moderate ·
 *   taxonomy.manage.
 * - `access_admin` manages role assignments; `auditor` reads them
 *   (admin-roles.ts `gateReader`) → roles.administer / roles.view.
 * - the AD-18 audit explorer read (audit-read.ts, W3-9) is role-gated
 *   auditor + operations per docs/31 §8 → audit.read for both (auditor
 *   remains the designated dedicated audit role, docs/26 §7).
 * - `support` and `finance` hold NO capability in the current W3 phase —
 *   their domains (support cases, refunds/payouts) do not exist yet
 *   (docs/31 §2.4). Nothing is projected for them, truthfully.
 *
 * No wildcard/superadmin capability exists or may be added here.
 */
import type { AdminRole } from '../persistence/admin-role-repository';

export const ADMIN_CAPABILITIES = [
  'providers.operate',
  'catalogue.moderate',
  'taxonomy.manage',
  'roles.administer',
  'roles.view',
  'audit.read',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
  operations: ['providers.operate', 'catalogue.moderate', 'taxonomy.manage', 'audit.read'],
  access_admin: ['roles.administer', 'roles.view'],
  auditor: ['roles.view', 'audit.read'],
  support: [],
  finance: [],
};

/** Deduplicated union over the caller's ACTIVE roles, in canonical order. */
export function capabilitiesForAdminRoles(
  roles: readonly AdminRole[],
): readonly AdminCapability[] {
  const granted = new Set<AdminCapability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role]) {
      granted.add(capability);
    }
  }
  return ADMIN_CAPABILITIES.filter((capability) => granted.has(capability));
}
