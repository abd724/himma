/** Provider-facing lifecycle language (canonical verification_state values). */
export const ORGANIZATION_STATE_LABEL: Record<string, string> = {
  draft: 'Setting up',
  submitted: 'Submitted for review',
  in_review: 'In review with Himma',
  rejected: 'Changes needed',
  verified: 'Verified — Himma completes go-live',
  live: 'Live on Himma',
  suspended: 'Suspended',
};

/** States where the onboarding hub is still the natural home. */
export function isStillOnboarding(verificationState: string): boolean {
  return ['draft', 'submitted', 'in_review', 'rejected', 'verified'].includes(verificationState);
}
