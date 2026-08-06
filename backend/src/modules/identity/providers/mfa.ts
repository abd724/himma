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

export type TotpEnrollmentStartResult =
  | { kind: 'enrollmentStarted'; material: TotpEnrollmentMaterial }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

export type TotpVerificationResult =
  | { kind: 'verificationSucceeded' }
  | { kind: 'invalidCode' }
  | { kind: 'challengeExpired' }
  | { kind: 'providerUnavailable' }
  | { kind: 'invalidProviderState' };

export interface MfaProviderPort {
  /** Starts provider-side TOTP enrollment for the authenticated provider user. */
  beginTotpEnrollment(input: {
    providerAccessToken: string;
  }): Promise<TotpEnrollmentStartResult>;

  /** Confirms provider-side enrollment with a code from the new authenticator. */
  verifyTotpEnrollment(input: {
    providerAccessToken: string;
    code: string;
  }): Promise<TotpVerificationResult>;

  /** Verifies a TOTP code for step-up on an already-enrolled user. */
  verifyTotpChallenge(input: {
    providerAccessToken: string;
    code: string;
  }): Promise<TotpVerificationResult>;
}
