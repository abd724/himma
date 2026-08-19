/**
 * Admin access contract — mirrors the REAL `GET /admin/me` bootstrap
 * (backend/src/modules/identity/http/admin-routes.ts) field for field.
 *
 * Authority model (docs/31 §6, docs/26 §7): a valid Cognito identity means
 * NOTHING here — admin access exists only while PostgreSQL holds at least
 * one ACTIVE admin role for the user, resolved fresh by the backend's
 * `admin` policy (live session + Himma MFA assurance + a sufficiently
 * RECENT MFA-verified factor). The capability list is the backend's
 * centralized projection of the authority its services already enforce
 * (admin-capabilities.ts) — navigation/UX input ONLY; every admin route
 * keeps checking the specific role server-side.
 */

/** The exact five canonical internal roles (docs/26 §7) — never extended
 *  frontend-side; no superadmin exists anywhere. */
export const ADMIN_ROLES = ['operations', 'support', 'finance', 'access_admin', 'auditor'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** The backend's safe capability projection vocabulary — exact. */
export const ADMIN_CAPABILITIES = [
  'providers.operate',
  'catalogue.moderate',
  'taxonomy.manage',
  'roles.administer',
  'roles.view',
  'audit.read',
] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export interface AdminAccess {
  readonly user: { readonly id: string; readonly displayName: string };
  readonly roles: readonly AdminRole[];
  readonly capabilities: readonly AdminCapability[];
}

export type AdminAccessOutcome =
  | { readonly kind: 'resolved'; readonly access: AdminAccess }
  /** Authenticated, but NO active admin role — the portal is not for them. */
  | { readonly kind: 'noAccess' }
  /** The `admin` policy wants a RECENT factor — re-verify TOTP, then retry. */
  | { readonly kind: 'stepUpRequired' }
  | { readonly kind: 'unavailable' };

export interface AdminAccessPort {
  resolveAccess(): Promise<AdminAccessOutcome>;
}
