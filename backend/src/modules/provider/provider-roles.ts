/**
 * Provider role vocabulary (docs/23 §7; docs/24 §10.2; docs/27 §6).
 *
 * Exactly the seven owner-approved roles — no additions (a read-only role or
 * any other extension is an owner decision, not an engineering one). The
 * database CHECK constraints repeat this list verbatim; this module is the
 * canonical code-side mapping between the normalized enum codes stored in
 * PostgreSQL and the approved display vocabulary.
 *
 * Roles here carry NO capability semantics yet: the typed capability
 * registry and its route policies are S3-3. Nothing in S3-2 grants listing,
 * attendance, finance, or booking behavior merely because a role name
 * anticipates it.
 */

export const PROVIDER_ROLES = [
  'owner',
  'org_manager',
  'branch_manager',
  'listings_editor',
  'coach',
  'front_desk',
  'finance',
] as const;

export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/** Normalized code → approved display vocabulary (docs/27 §6). */
export const PROVIDER_ROLE_LABELS: Record<ProviderRole, string> = {
  owner: 'Owner',
  org_manager: 'Organization Manager',
  branch_manager: 'Branch Manager',
  listings_editor: 'Listings Editor / Scheduler',
  coach: 'Coach / Instructor',
  front_desk: 'Front Desk / Booking Employee',
  finance: 'Finance',
};

/**
 * Roles whose reach is organization-wide by definition (docs/27 §5): they
 * always carry branch_scope_kind 'all'; a branch-scoped variant is
 * unrepresentable (CHECK-enforced in the schema as well).
 */
export const ORG_WIDE_ONLY_ROLES: readonly ProviderRole[] = [
  'owner',
  'org_manager',
  'finance',
];

export type BranchScope =
  | { kind: 'all' }
  | { kind: 'branches'; branchIds: string[] };

export function isProviderRole(value: string): value is ProviderRole {
  return (PROVIDER_ROLES as readonly string[]).includes(value);
}
