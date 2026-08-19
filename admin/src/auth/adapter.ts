/**
 * Admin Portal auth adapter contract — the ONE seam that will own Cognito
 * interaction and Himma session establishment at W2-12 (docs/26 §4, docs/29
 * §13). The rest of the admin portal sees only these semantic outcomes:
 *
 * - No token material crosses this boundary in either direction: no raw
 *   JWTs, no refresh tokens, no Cognito challenge session strings. The real
 *   implementation holds access tokens in memory and refresh tokens in the
 *   Secure/HttpOnly cookie channel decided by docs/26 §4.9.
 * - Outcome names follow the backend's typed vocabulary
 *   (http-outcomes.ts): `invalidCredentials`, `accountSuspended`,
 *   `sessionExpired` (canon collapses revocation into this one code),
 *   `rateLimited`, `providerUnavailable`, `challengeInvalid`.
 * - Assurance naming follows canon (`ProviderAssurance`):
 *   `'single_factor' | 'mfa'`. A Cognito account with TOTP configured is
 *   always challenged at login, so `single_factor` ⇔ not yet enrolled.
 * - Recovery codes are Himma STEP-UP credentials
 *   (`POST /auth/step-up/recovery-code`); they are NOT a login-challenge
 *   alternative and deliberately do not appear in the sign-in flow.
 */

export type SessionAssurance = 'single_factor' | 'mfa';

/** Semantic identity display data (never token claims). */
export interface SessionIdentity {
  readonly email: string;
  readonly displayName: string;
}

export type BootstrapOutcome =
  | { readonly kind: 'noSession' }
  | { readonly kind: 'session'; readonly assurance: SessionAssurance; readonly identity: SessionIdentity }
  /** Auth is not configured/available in this environment — fail closed. */
  | { readonly kind: 'unavailable' };

export type SignInOutcome =
  | { readonly kind: 'signedIn'; readonly assurance: SessionAssurance; readonly identity: SessionIdentity }
  /** Credentials accepted; a TOTP code must complete the sign-in. */
  | { readonly kind: 'mfaChallenge' }
  | { readonly kind: 'invalidCredentials' }
  | { readonly kind: 'accountSuspended' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'providerUnavailable' }
  | { readonly kind: 'failure' };

export type MfaChallengeOutcome =
  | { readonly kind: 'signedIn'; readonly assurance: 'mfa'; readonly identity: SessionIdentity }
  | { readonly kind: 'invalidCode' }
  /** The challenge lapsed; sign-in must restart from credentials. */
  | { readonly kind: 'challengeExpired' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'failure' };

export type StepUpOutcome =
  | { readonly kind: 'completed'; readonly expiresAt: string }
  | { readonly kind: 'invalidCode' }
  | { readonly kind: 'challengeExpired' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'failure' };

/** Pushed when the session becomes unusable mid-use (canon: one code). */
export type SessionInterrupt =
  | { readonly kind: 'sessionExpired' }
  /** Provider access changed (membership revocation etc.) — re-resolve. */
  | { readonly kind: 'accessChanged' };

export interface AdminAuthAdapter {
  /** Establish what session, if any, exists when the app loads. */
  bootstrap(): Promise<BootstrapOutcome>;
  signIn(input: { email: string; password: string }): Promise<SignInOutcome>;
  /** Answer the login TOTP challenge (`SOFTWARE_TOKEN_MFA` semantics). */
  completeMfaChallenge(code: string): Promise<MfaChallengeOutcome>;
  /** Abandon a pending login challenge and return to signed-out. */
  cancelMfaChallenge(): Promise<void>;
  /** `/auth/step-up/totp/begin` + `/complete` semantics. */
  completeStepUpTotp(code: string): Promise<StepUpOutcome>;
  /** `/auth/step-up/recovery-code` semantics (single-use codes). */
  completeStepUpRecoveryCode(code: string): Promise<StepUpOutcome>;
  /** `/auth/logout` semantics; always lands signed-out locally. */
  signOut(): Promise<void>;
  /** Session interrupts pushed from outside the UI (expiry, revocation). */
  subscribe(listener: (interrupt: SessionInterrupt) => void): () => void;
}
