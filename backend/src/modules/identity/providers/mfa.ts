/**
 * MfaProviderPort (docs/26 §2, §5.8, Amendment A1.1) — B2-6B.
 *
 * Cognito is authoritative for TOTP shared-secret generation, provider-side
 * enrollment, and challenge verification; this port is the ONLY way the
 * application core reaches those operations. Implementations perform network
 * I/O and are called strictly OUTSIDE PostgreSQL transactions (docs/25 §4),
 * normalize every provider outcome into the typed results below, and never
 * let provider SDK/exception objects cross the boundary.
 *
 * `TotpEnrollmentMaterial` is EPHEMERAL: it exists in memory between the
 * provider call and the service result, is returned once for the future
 * B2-6C route (which renders the QR), and is never persisted, logged,
 * audited, or embedded in events or errors.
 */

export interface TotpEnrollmentMaterial {
  /** Provider-issued TOTP shared secret (base32) — ephemeral, never stored. */
  sharedSecret: string;
}

/**
 * Provider-issued challenge session for an in-flight TOTP challenge —
 * ephemeral SECRET material (Cognito's `Session` string). It travels only
 * through the bounded begin→complete challenge flow (service result →
 * client → completion input) and is never persisted, logged, audited, or
 * embedded in events.
 */
export interface TotpChallengeSession {
  providerChallengeSession: string;
}

export type TotpEnrollmentStartResult =
  | { kind: 'enrollmentStarted'; material: TotpEnrollmentMaterial }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

export type TotpChallengeStartResult =
  | { kind: 'challengeIssued'; challenge: TotpChallengeSession }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

export type TotpVerificationResult =
  | { kind: 'verificationSucceeded' }
  | { kind: 'invalidCode' }
  | { kind: 'challengeExpired' }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

/**
 * Cognito TOTP semantics (binding): enrollment uses the registration
 * operations (AssociateSoftwareToken / VerifySoftwareToken) ONLY; an
 * already-enrolled user's ordinary TOTP verification is the provider's
 * SOFTWARE_TOKEN_MFA challenge flow — a FRESH reauthentication challenge
 * with a provider-issued Session, answered via RespondToAuthChallenge.
 * The enrollment-verification operation is never a generic step-up
 * verifier; there is no provider operation that checks a bare code
 * against an access token, and this port does not pretend one exists.
 */
export interface MfaProviderPort {
  /** Starts provider-side TOTP enrollment for the authenticated provider user. */
  beginTotpEnrollment(input: {
    providerAccessToken: string;
  }): Promise<TotpEnrollmentStartResult>;

  /** Confirms provider-side ENROLLMENT with a code from the new authenticator. */
  verifyTotpEnrollment(input: {
    providerAccessToken: string;
    code: string;
  }): Promise<TotpVerificationResult>;

  /**
   * Begins a fresh provider reauthentication challenge (SOFTWARE_TOKEN_MFA)
   * for step-up, yielding the ephemeral provider challenge session.
   */
  beginTotpStepUpChallenge(input: {
    providerUserRef: string;
  }): Promise<TotpChallengeStartResult>;

  /** Answers the provider challenge (RespondToAuthChallenge semantics). */
  respondToTotpStepUpChallenge(input: {
    providerUserRef: string;
    challenge: TotpChallengeSession;
    code: string;
  }): Promise<TotpVerificationResult>;
}
