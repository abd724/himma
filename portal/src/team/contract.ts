import type { BranchScope, ProviderRole } from '../provider-access/contract';

/**
 * Team/staff seam — mirrors the four REAL provider-private staff routes
 * (backend/src/modules/provider/http/provider-routes.ts) field for field.
 * W2-12 implements this port over the live API; until then the semantic
 * fixture stands behind the same contract.
 *
 * - `loadStaff`        ⇄ `GET  /provider/organizations/:orgId/staff`
 *   (policy `provider`, capability `staff.read` — OWNER ONLY in the
 *   canonical registry; docs/24 §1.3, docs/27 §6). ONE composed read: all
 *   membership rows (active AND revoked history) plus all invitation rows
 *   (every lifecycle state), each ordered by creation.
 * - `issueInvitation`  ⇄ `POST .../staff/invitations`
 *   (policy `providerStepUp`, capability `staff.manage` — owner only).
 *   Issuing to an address that already holds a still-`sent` invitation for
 *   this organization SUPERSEDES it server-side (the old row is revoked in
 *   the same transaction — the approved resend policy). The response NEVER
 *   carries the invitation token or an acceptance link; the token travels
 *   only inside the invitation email. `mailDelivery: 'failed'` means the
 *   invitation was still created — retrying = issuing a NEW invitation.
 * - `revokeInvitation` ⇄ `POST .../staff/invitations/:invitationId/revoke`
 *   (policy `providerStepUp`, capability `staff.manage`). Idempotent on an
 *   already-revoked invitation; an accepted or expired invitation is
 *   finalized and yields `lifecycleConflict`. No `expectedVersion` — the
 *   real operation is a state CAS, not a version CAS.
 * - `revokeMembership` ⇄ `POST .../staff/memberships/:membershipId/revoke`
 *   (policy `providerStepUp`, capability `staff.manage`). Carries the
 *   membership row's REQUIRED `expectedVersion`; idempotent on an
 *   already-revoked membership; refusing to remove the last ACTIVE Owner is
 *   the backend's own invariant (`lastOwnerProtected` — a database-level
 *   guarantee, never re-derived client-side as authority).
 *
 * Every mutation here is step-up-gated by the REAL route policy
 * (`providerStepUp`): the port attempts the operation and surfaces the
 * canonical `stepUpRequired` refusal; the UI then routes through the
 * existing W2-2 `/step-up` interstitial and retries explicitly. The port
 * never demands step-up for reads.
 *
 * Deliberately absent because the real backend has no such operation:
 * - no member GET/detail route and no standalone invitation list — the
 *   `/team/:membershipId` page composes over the ONE staff read.
 * - no role/scope CHANGE operation — memberships are append-only history;
 *   the canonical change is revoke current membership + issue a NEW
 *   invitation the person accepts again with their verified email
 *   (docs/27 §5; docs/29 §16 W2-6 "role-change = revoke+re-invite").
 * - no "resend"/"remind"/"extend" operation — re-issuing IS a new
 *   invitation (which supersedes a still-`sent` one).
 * - no invitation acceptance here — acceptance is the signed-in target
 *   user's own `POST /provider/invitations/accept` (invitations/contract.ts).
 * - no delete anywhere: staff removal is REVOCATION; history is preserved.
 *
 * KNOWN REAL-CONTRACT GAP (recorded for W2-12/backend planning, task §33
 * class B): membership rows expose `userId` only — no provider-safe display
 * name or email for accepted members exists in any provider read. The UI
 * can label the caller's own row ("You", via the org view's membership id)
 * but renders other members from role/scope/joined-date truth only, and
 * never invents identities or correlates invitations to memberships
 * heuristically (no linking field exists).
 */

/** staff_membership.state — exact backend vocabulary. */
export type StaffMembershipState = 'active' | 'revoked';

/** staff_invitation.state — exact backend vocabulary (docs/24 §5.2). */
export type StaffInvitationState = 'sent' | 'accepted' | 'revoked' | 'expired';

/** `StaffMembershipView` from the real staff read — field for field. */
export interface StaffMembershipRecord {
  readonly id: string;
  /** Himma user id — the ONLY member identity the real contract returns. */
  readonly userId: string;
  readonly role: ProviderRole;
  readonly branchScopeKind: 'all' | 'branches';
  readonly branchIds: readonly string[];
  readonly state: StaffMembershipState;
  readonly createdAt: string;
  readonly version: number;
}

/** `StaffInvitationView` from the real staff read — field for field. The
 *  invitation token/digest is NEVER part of any read payload. */
export interface StaffInvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly role: ProviderRole;
  readonly branchScopeKind: 'all' | 'branches';
  readonly branchIds: readonly string[];
  readonly state: StaffInvitationState;
  readonly expiresAt: string;
  readonly version: number;
}

export interface StaffListView {
  readonly memberships: readonly StaffMembershipRecord[];
  readonly invitations: readonly StaffInvitationRecord[];
}

/** Exact TypeBox limits from the real invitation route body. */
export const INVITATION_FIELD_LIMITS = {
  email: 320,
  branchScopeMax: 50,
} as const;

export type StaffLoadOutcome =
  | { readonly kind: 'loaded'; readonly staff: StaffListView }
  /** Right organization, no `staff.read` capability. */
  | { readonly kind: 'forbidden' }
  /** Unknown org OR no membership — canonically not-found-shaped. */
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type IssueInvitationOutcome =
  | {
      readonly kind: 'invitationIssued';
      readonly invitationId: string;
      readonly expiresAt: string;
      /** The invitation exists either way; 'failed' = the email did not go
       *  out and re-delivery means issuing a NEW invitation. */
      readonly mailDelivery: 'delivered' | 'failed';
    }
  /** The route policy wants a recent step-up — nothing was executed. */
  | { readonly kind: 'stepUpRequired' }
  /** Scope refused: foreign/unknown/inactive branch, empty selection, or a
   *  branch scope on an org-wide-only role (owner/org_manager/finance). */
  | { readonly kind: 'invalidBranchScope' }
  /** Server-side schema refusal (422) — e.g. a malformed email. */
  | { readonly kind: 'validationError' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type RevokeInvitationOutcome =
  | { readonly kind: 'invitationRevoked' }
  | { readonly kind: 'stepUpRequired' }
  /** Already accepted or expired — finalized states never re-label. */
  | { readonly kind: 'lifecycleConflict' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export type RevokeMembershipOutcome =
  | { readonly kind: 'membershipRevoked' }
  | { readonly kind: 'stepUpRequired' }
  /** The backend's last-active-owner invariant refused the operation. */
  | { readonly kind: 'lastOwnerProtected' }
  /** Another writer changed the membership first (version CAS refusal). */
  | { readonly kind: 'staleVersion' }
  | { readonly kind: 'organizationSuspended' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

export interface TeamPort {
  loadStaff(organizationId: string): Promise<StaffLoadOutcome>;
  issueInvitation(
    organizationId: string,
    input: {
      readonly email: string;
      readonly role: ProviderRole;
      readonly branchScope: BranchScope;
    },
  ): Promise<IssueInvitationOutcome>;
  revokeInvitation(
    organizationId: string,
    invitationId: string,
  ): Promise<RevokeInvitationOutcome>;
  revokeMembership(
    organizationId: string,
    membershipId: string,
    expectedVersion: number,
  ): Promise<RevokeMembershipOutcome>;
}
