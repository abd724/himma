/**
 * Cognito AuthProviderAdapter (docs/26 §2, Amendment A1.1).
 *
 * The ONLY module allowed to know Cognito token mechanics; provider types
 * and the jose JWT/JWKS machinery never leak past this directory (a guard
 * test enforces the import boundary). Validation: RS256 signature against
 * the pool JWKS (kid-rotation aware — the key source re-resolves per call),
 * issuer, audience, expiry, and `token_use: 'id'`; claims are then
 * normalized into `ProviderEvidence`.
 *
 * Cognito groups (`cognito:groups`) and custom role claims are read by
 * NOTHING here — they are never authorization authority (Amendment A1.1);
 * the principal context is built from Himma PostgreSQL alone.
 *
 * Network I/O (remote JWKS) happens inside `validateToken`, so callers
 * invoke it strictly OUTSIDE database transactions (docs/25 §4). Tests
 * inject a local key resolver; no AWS access is required anywhere.
 */
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

import type { AuthProviderAdapter, TokenValidationResult } from '../adapter';
import { validateProviderEvidence, type ProviderKind } from '../evidence';
import { jwksUriFor, type CognitoAdapterConfig } from './config';

const APPLE_PRIVATE_RELAY_SUFFIX = '@privaterelay.appleid.com';
const MFA_METHODS = ['mfa', 'software_token_mfa', 'otp', 'hwk'];

/** Cognito federated-identity records inside the `identities` claim. */
function providerKindOf(payload: JWTPayload): ProviderKind {
  const identities = payload.identities;
  if (Array.isArray(identities) && identities.length > 0) {
    const providerName = (identities[0] as { providerName?: unknown }).providerName;
    if (providerName === 'SignInWithApple') return 'apple';
    if (providerName === 'Google') return 'google';
  }
  return 'email';
}

function assuranceOf(payload: JWTPayload): 'single_factor' | 'mfa' {
  const amr = payload.amr;
  if (Array.isArray(amr) && amr.some((m) => MFA_METHODS.includes(String(m)))) return 'mfa';
  return 'single_factor';
}

/** JWKS transport/availability failures — everything else is token-shaped. */
function isProviderUnavailable(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout) return true;
  // A thrown non-jose error can only come from the key source (network,
  // DNS, injected resolver): the provider, not the token, is the problem.
  return !(error instanceof joseErrors.JOSEError);
}

export interface CognitoAdapterOptions {
  /** Injectable key source; defaults to the pool's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export class CognitoAuthProviderAdapter implements AuthProviderAdapter {
  private readonly getKey: JWTVerifyGetKey;

  constructor(
    private readonly config: CognitoAdapterConfig,
    options: CognitoAdapterOptions = {},
  ) {
    this.getKey = options.getKey ?? createRemoteJWKSet(new URL(jwksUriFor(config)));
  }

  async validateToken(rawToken: string): Promise<TokenValidationResult> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(rawToken, this.getKey, {
        issuer: this.config.issuer,
        audience: this.config.clientIds,
        algorithms: ['RS256'],
      });
      payload = verified.payload;
    } catch (error) {
      if (isProviderUnavailable(error)) return { ok: false, reason: 'providerUnavailable' };
      return { ok: false, reason: 'invalidProviderEvidence' };
    }

    // B2-2 validates identity tokens only; access-token/session flows are B2-3.
    if (payload.token_use !== 'id') return { ok: false, reason: 'invalidProviderEvidence' };
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return { ok: false, reason: 'invalidProviderEvidence' };
    }

    const email = typeof payload.email === 'string' ? payload.email : undefined;
    // Cognito emits email_verified as boolean or the string 'true' depending
    // on the identity source; both mean verified.
    const emailVerified =
      email !== undefined &&
      (payload.email_verified === true || payload.email_verified === 'true');
    const displayName = typeof payload.name === 'string' ? payload.name : undefined;

    const validation = validateProviderEvidence({
      provider: providerKindOf(payload),
      issuer: this.config.issuer,
      subject: payload.sub,
      email,
      emailVerified,
      isPrivateRelay: email?.toLowerCase().endsWith(APPLE_PRIVATE_RELAY_SUFFIX) === true,
      assurance: assuranceOf(payload),
      displayName,
    });
    if (!validation.ok) return { ok: false, reason: 'invalidProviderEvidence' };
    return { ok: true, evidence: validation.evidence };
  }
}
