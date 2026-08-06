/**
 * Access-token verification boundary (docs/26 §4.1, Amendment A1.1) — B2-3.
 *
 * Deliberately SEPARATE from the B2-2 identity-evidence adapter: API
 * authentication consumes provider ACCESS tokens, and a provider identity
 * token is never an API bearer token (each verifier enforces the provider's
 * token-usage semantics inside the adapter directory).
 * The application core sees only this normalized evidence shape; raw tokens,
 * JWT mechanics, and provider errors stay inside the provider directory.
 * Implementations perform network I/O (JWKS) and are called strictly
 * OUTSIDE PostgreSQL transactions (docs/25 §4).
 */
import type { ProviderAssurance } from './evidence';

export interface AccessTokenEvidence {
  /** Normalized provider issuer (the pool issuer under Cognito). */
  issuer: string;
  /** Provider subject; with issuer, resolves the Himma AuthIdentity. */
  subject: string;
  /** Provider session identifier — the Himma login_session liveness key. */
  originJti: string;
  /** Token identifier where the provider supplies one. */
  jti?: string;
  /** Application client the token was issued to. */
  clientId?: string;
  /** OAuth scopes asserted by the provider (never Himma business roles). */
  scopes: string[];
  assurance: ProviderAssurance;
  /** Token expiry — sessions never outlive their provider session. */
  expiresAt: Date;
}

export type AccessTokenVerificationFailure = 'invalidAccessToken' | 'providerUnavailable';

export type AccessTokenVerificationResult =
  | { ok: true; evidence: AccessTokenEvidence }
  | { ok: false; reason: AccessTokenVerificationFailure };

export interface AccessTokenVerifier {
  /**
   * Verifies provider access-token material into normalized evidence. Never
   * throws for token-shaped problems; provider/key-source failure is
   * `providerUnavailable`.
   */
  verifyAccessToken(rawToken: string): Promise<AccessTokenVerificationResult>;
}

export type AccessTokenEvidenceValidation =
  | { ok: true; evidence: AccessTokenEvidence }
  | { ok: false };

const MAX_IDENTIFIER_LENGTH = 512;
/** Printable, no whitespace/control characters — opaque provider tokens. */
const IDENTIFIER_PATTERN = /^[!-~]+$/;
const ASSURANCES: readonly string[] = ['single_factor', 'mfa'];

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value.trim())
  );
}

/** Total structural validation; foreign input yields `{ok:false}`, never a throw. */
export function validateAccessTokenEvidence(input: unknown): AccessTokenEvidenceValidation {
  if (typeof input !== 'object' || input === null) return { ok: false };
  const raw = input as Record<string, unknown>;
  if (!isIdentifier(raw.issuer) || !isIdentifier(raw.subject) || !isIdentifier(raw.originJti)) {
    return { ok: false };
  }
  if (raw.jti !== undefined && !isIdentifier(raw.jti)) return { ok: false };
  if (raw.clientId !== undefined && !isIdentifier(raw.clientId)) return { ok: false };
  if (typeof raw.assurance !== 'string' || !ASSURANCES.includes(raw.assurance)) {
    return { ok: false };
  }
  if (!(raw.expiresAt instanceof Date) || Number.isNaN(raw.expiresAt.getTime())) {
    return { ok: false };
  }
  if (!Array.isArray(raw.scopes) || raw.scopes.some((s) => typeof s !== 'string')) {
    return { ok: false };
  }
  return {
    ok: true,
    evidence: {
      issuer: (raw.issuer as string).trim(),
      subject: (raw.subject as string).trim(),
      originJti: (raw.originJti as string).trim(),
      ...(raw.jti !== undefined ? { jti: (raw.jti as string).trim() } : {}),
      ...(raw.clientId !== undefined ? { clientId: (raw.clientId as string).trim() } : {}),
      scopes: raw.scopes as string[],
      assurance: raw.assurance as ProviderAssurance,
      expiresAt: raw.expiresAt,
    },
  };
}
