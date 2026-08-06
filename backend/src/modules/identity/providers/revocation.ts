/**
 * Provider-side session revocation port (docs/26 §4.5–4.6, §9.6) — B2-3.
 *
 * Local Himma revocation is authoritative for API denial; provider-side
 * token-chain revocation is best-effort follow-up that runs strictly AFTER
 * the local transaction commits. A delivery failure never reactivates the
 * locally revoked session — the typed status below is returned/recorded so
 * later retry processing (async infrastructure) can re-attempt.
 *
 * `ephemeralToken`: some provider operations (Cognito one-device
 * /oauth2/revoke) require client-held refresh-token material. It is passed
 * through at call time by the future route layer, and is NEVER persisted,
 * logged, audited, or echoed — Himma stores no refresh tokens (A1.1).
 */

export interface ProviderRevocationTarget {
  scope: 'session' | 'allSessions';
  issuer: string;
  subject: string;
  /** The provider session identifier for single-session scope. */
  originJti?: string;
  /** Ephemeral client-supplied token material; never stored or logged. */
  ephemeralToken?: string;
}

export type ProviderRevocationOutcome =
  | { delivered: true }
  | { delivered: false; reason: 'providerUnavailable' | 'notSupported' };

/** Post-commit delivery status, suitable for later retry processing. */
export type ProviderRevocationDelivery =
  | { attempted: false }
  | ({ attempted: true } & ProviderRevocationOutcome);

export interface ProviderSessionRevoker {
  /** Network I/O — called strictly OUTSIDE database transactions. */
  revokeProviderSessions(target: ProviderRevocationTarget): Promise<ProviderRevocationOutcome>;
}
