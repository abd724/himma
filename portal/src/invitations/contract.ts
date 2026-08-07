/**
 * Invitation-acceptance contract seam — mirrors the REAL
 * `POST /provider/invitations/accept` (backend provider-routes.ts):
 * body `{ token }`, success `{ status: 'invitationAccepted', organizationId,
 * membershipId }`.
 *
 * Binding canon (docs/27 §9, D-S3-1): every failure — unknown token, expired,
 * revoked, already used, suspended/offboarded organization, unverified or
 * mismatched email, already a member — collapses into the ONE
 * `invitationInvalid` outcome with no oracle distinguishing them. The
 * frontend must never pretend to know which case occurred.
 *
 * RECORDED REAL-CONTRACT GAPS (task §28, for W2-12/owner planning):
 * - Class B (missing provider read): there is NO invitation
 *   resolution/preview endpoint — a live UI cannot show "you've been invited
 *   to <organization> as <role>" before acceptance, and cannot show the
 *   invitation's target email. The pre-acceptance screen stays generic.
 * - Class A (frontend composition): the accept response carries no
 *   founding-owner flag and no role; distinguishing "founding Owner
 *   onboarding" from "ordinary staff join" is a composition — accept, then
 *   re-resolve `GET /provider/me` and route on the new membership's role +
 *   organizationState. No new backend flag is invented here.
 * - Class B (missing provider read): the organization view exposes no
 *   rejection reason to providers (admin transitions record a `reasonCode`,
 *   but no provider-facing read returns it), so the rejected state cannot
 *   display what needs attention.
 */
export type InvitationAcceptOutcome =
  | { readonly kind: 'invitationAccepted'; readonly organizationId: string; readonly membershipId: string }
  /** The single canonical refusal — cause deliberately indistinguishable. */
  | { readonly kind: 'invitationInvalid' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'providerUnavailable' }
  | { readonly kind: 'failure' };

export interface InvitationPort {
  accept(token: string): Promise<InvitationAcceptOutcome>;
}
