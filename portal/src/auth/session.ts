/**
 * Auth boundary skeleton — the structural seam where W2-2 implements session
 * bootstrap, the Cognito adapter, MFA enrollment/challenge, step-up
 * reauthentication, organization-access resolution (`GET /provider/me`), and
 * sign-out (docs/29 §13).
 *
 * Binding rules for the future implementation (docs/26 D1, docs/29 §13):
 * - All token acquisition lives inside this module; the rest of the portal
 *   sees only the typed session facade below.
 * - No raw tokens in localStorage; no passwords, TOTP secrets, or recovery
 *   secrets are ever stored client-side.
 * - Cognito groups grant nothing; UI authority derives only from the
 *   backend's capability resolution. The frontend is never the security
 *   boundary.
 *
 * W2-1 deliberately ships NO session state — the shell renders without any
 * authenticated identity, and nothing here pretends otherwise.
 */

/** Lifecycle a real portal session moves through (implemented in W2-2). */
export type SessionStatus = 'unknown' | 'signedOut' | 'mfaRequired' | 'active';

/**
 * The typed facade W2-2 will provide to the rest of the application.
 * Declared now so guards, layouts, and queries build against the seam —
 * intentionally without an implementation.
 */
export interface SessionFacade {
  readonly status: SessionStatus;
}
