/**
 * Provider-access contract seam — mirrors the REAL `GET /provider/me`
 * response (backend/src/modules/provider/http/provider-routes.ts) field for
 * field. W2-12 implements this port over the live API; W2-2 feeds it from
 * the isolated fixture. Nothing here may invent fields the real contract
 * does not return (capabilities, for example, are exposed per-organization
 * by `GET /provider/organizations/:organizationId`, not here).
 */

/** backend/src/modules/provider/provider-roles.ts — PROVIDER_ROLES. */
export type ProviderRole =
  | 'owner'
  | 'org_manager'
  | 'branch_manager'
  | 'listings_editor'
  | 'coach'
  | 'front_desk'
  | 'finance';

/**
 * Normalized code → the approved display vocabulary, byte-identical to the
 * backend's `PROVIDER_ROLE_LABELS` (backend/src/modules/provider/
 * provider-roles.ts; docs/27 §6). docs/29 §16 requires the seven-role
 * vocabulary EXACT — no shortened variants.
 */
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
 * always carry branch scope `'all'`; a branch-scoped variant is
 * CHECK-unrepresentable in the backend schema. Mirrored here so scope
 * editors never offer meaningless branch selection for these roles.
 */
export const ORG_WIDE_ONLY_ROLES: readonly ProviderRole[] = [
  'owner',
  'org_manager',
  'finance',
];

export const PROVIDER_ROLES: readonly ProviderRole[] = [
  'owner',
  'org_manager',
  'branch_manager',
  'listings_editor',
  'coach',
  'front_desk',
  'finance',
];

/** `'all'` or an explicit branch-id list — BranchScopeView in the backend. */
export type BranchScope = 'all' | readonly string[];

/**
 * organization.verification_state values a membership row can carry.
 * The backend schema types this as a plain string and never returns
 * `offboarded` memberships; keep the known values named without narrowing
 * the transport type.
 */
export const ORGANIZATION_STATES = [
  'draft',
  'submitted',
  'in_review',
  'verified',
  'rejected',
  'live',
  'suspended',
] as const;

export interface ProviderMembership {
  readonly organizationId: string;
  readonly displayName: string;
  readonly role: ProviderRole;
  readonly branchScope: BranchScope;
  readonly organizationState: string;
}

export type ProviderAccessOutcome =
  | { readonly kind: 'resolved'; readonly memberships: readonly ProviderMembership[] }
  /** Transient failure (network/backend); the UI offers retry. */
  | { readonly kind: 'unavailable' };

/** The future authoritative access bootstrap (`GET /provider/me`). */
export interface ProviderAccessPort {
  resolveAccess(): Promise<ProviderAccessOutcome>;
}

/**
 * KNOWN REAL-CONTRACT GAP (recorded per task §18, for W2-12): no read
 * endpoint exposes the caller's MFA-enrollment status or session assurance
 * (`GET /me` returns user/account/participants only; `mfaEnrolled` exists
 * on the server-side principal but never serializes). Until the backend
 * exposes it, a live portal can only learn enrollment status reactively
 * from `mfaRequired` outcomes. The fixture adapter reports assurance at
 * sign-in, which the real Cognito flow also knows client-side.
 */
