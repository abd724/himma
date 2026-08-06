/**
 * AuthProviderAdapter port (docs/26 §2, Amendment A1.1).
 *
 * The application core is provider-independent: it consumes this port and
 * the normalized `ProviderEvidence` shape only. Provider SDK types, token
 * formats, JWKS mechanics, and provider error objects never cross this
 * boundary — implementations normalize every failure into the typed result
 * below. Implementations perform network I/O and are therefore called
 * strictly OUTSIDE PostgreSQL transactions (docs/25 §4).
 *
 * B2-2 surface: token validation → normalized evidence. Sign-in/refresh/
 * revocation mediation and session liveness are B2-3 (docs/26 §13).
 */
import type { ProviderEvidence } from './evidence';

export type TokenValidationFailure = 'invalidProviderEvidence' | 'providerUnavailable';

export type TokenValidationResult =
  | { ok: true; evidence: ProviderEvidence }
  | { ok: false; reason: TokenValidationFailure };

export interface AuthProviderAdapter {
  /**
   * Validates provider token material and returns normalized evidence.
   * Never throws for token-shaped problems: malformed, forged, expired, or
   * mis-audienced material is `invalidProviderEvidence`; provider outage or
   * key-source failure is `providerUnavailable`.
   */
  validateToken(rawToken: string): Promise<TokenValidationResult>;
}
