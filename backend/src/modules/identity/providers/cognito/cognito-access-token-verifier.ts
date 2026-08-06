/**
 * Cognito ACCESS-token verifier (docs/26 §4.1, Amendment A1.1) — B2-3.
 *
 * Separate from the ID-token identity adapter: this boundary authenticates
 * API requests. Cognito access tokens carry `client_id` (not `aud`) and
 * `token_use: 'access'`; an ID token presented as a bearer token fails the
 * `token_use` check by construction. Verification: RS256 signature against
 * the pool JWKS (kid-rotation aware, injectable key source), trusted
 * issuer, expected client id, exp/nbf with the bounded configured clock
 * tolerance, normalized subject and `origin_jti`. `cognito:groups` and
 * custom role claims are read by nothing — Himma permissions never come
 * from provider claims.
 *
 * Network I/O (remote JWKS) lives inside `verifyAccessToken`; callers
 * invoke it strictly OUTSIDE database transactions (docs/25 §4).
 */
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

import type {
  AccessTokenVerificationResult,
  AccessTokenVerifier,
} from '../access-token';
import { validateAccessTokenEvidence } from '../access-token';
import { assertCompleteConfig, jwksUriFor, type CognitoAdapterConfig } from './config';

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;
const MFA_METHODS = ['mfa', 'software_token_mfa', 'otp', 'hwk'];

function isProviderUnavailable(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout) return true;
  return !(error instanceof joseErrors.JOSEError);
}

function assuranceOf(payload: JWTPayload): 'single_factor' | 'mfa' {
  const amr = payload.amr;
  if (Array.isArray(amr) && amr.some((m) => MFA_METHODS.includes(String(m)))) return 'mfa';
  return 'single_factor';
}

export interface CognitoAccessTokenVerifierOptions {
  /** Injectable key source; defaults to the pool's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export class CognitoAccessTokenVerifier implements AccessTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly clockTolerance: number;

  constructor(
    private readonly config: CognitoAdapterConfig,
    options: CognitoAccessTokenVerifierOptions = {},
  ) {
    assertCompleteConfig(config);
    this.clockTolerance = config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
    this.getKey = options.getKey ?? createRemoteJWKSet(new URL(jwksUriFor(config)));
  }

  async verifyAccessToken(rawToken: string): Promise<AccessTokenVerificationResult> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(rawToken, this.getKey, {
        issuer: this.config.issuer,
        algorithms: ['RS256'],
        clockTolerance: this.clockTolerance,
      });
      payload = verified.payload;
    } catch (error) {
      if (isProviderUnavailable(error)) return { ok: false, reason: 'providerUnavailable' };
      return { ok: false, reason: 'invalidAccessToken' };
    }

    // Access-token semantics: an ID token is NEVER an API bearer token.
    if (payload.token_use !== 'access') return { ok: false, reason: 'invalidAccessToken' };
    // Cognito access tokens carry client_id, not aud.
    if (
      typeof payload.client_id !== 'string' ||
      !this.config.clientIds.includes(payload.client_id)
    ) {
      return { ok: false, reason: 'invalidAccessToken' };
    }
    if (typeof payload.exp !== 'number') return { ok: false, reason: 'invalidAccessToken' };

    const validation = validateAccessTokenEvidence({
      issuer: this.config.issuer,
      subject: payload.sub,
      originJti: payload.origin_jti,
      jti: payload.jti,
      clientId: payload.client_id,
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      assurance: assuranceOf(payload),
      expiresAt: new Date(payload.exp * 1000),
    });
    if (!validation.ok) return { ok: false, reason: 'invalidAccessToken' };
    return { ok: true, evidence: validation.evidence };
  }
}
