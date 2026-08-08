import type { InviteFormValues } from './invite-form';

/**
 * IN-MEMORY carrier for a staff operation interrupted by the canonical
 * `stepUpRequired` refusal (task §8): the intended operation is preserved
 * here, the user is routed through the existing W2-2 `/step-up`
 * interstitial, and the originating page rehydrates the intent on return —
 * the user re-confirms EXPLICITLY, so the operation can never run twice
 * from one gesture (the refused attempt executed nothing).
 *
 * Deliberately module-scope memory only: nothing here may touch any
 * browser storage API (invitation details are personal data and no staff
 * intent may outlive the tab — task §9's no-browser-storage rule; the
 * fixture-safety suite greps the whole source tree for storage tokens).
 * A full reload simply drops the intent; the user starts the action again.
 */
export type TeamPendingIntent =
  | { readonly kind: 'invite'; readonly organizationId: string; readonly values: InviteFormValues }
  | {
      readonly kind: 'revokeInvitation';
      readonly organizationId: string;
      readonly invitationId: string;
    }
  | {
      readonly kind: 'revokeMembership';
      readonly organizationId: string;
      readonly membershipId: string;
    };

let pending: TeamPendingIntent | null = null;

export function saveTeamIntent(intent: TeamPendingIntent): void {
  pending = intent;
}

/** Single consumption: the intent is cleared as it is read. */
export function takeTeamIntent(): TeamPendingIntent | null {
  const taken = pending;
  pending = null;
  return taken;
}

/** Test-only reset between renders. */
export function clearTeamIntent(): void {
  pending = null;
}
