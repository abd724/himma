/**
 * RI-1 — deterministic DEVELOPMENT email/password identity provider.
 *
 * A Cognito STAND-IN for local/dev composition only (the certified
 * deterministic-double pattern: D1/D2 fake adapters, the deterministic
 * payment provider): it implements the SAME certified ports the Cognito
 * implementations satisfy — `AuthProviderAdapter` (ID-token evidence),
 * `AccessTokenVerifier` (API bearer verification), and
 * `ProviderTokenRefresher` (cookie-channel refresh) — so the ENTIRE Himma
 * identity core (first login, account + self-participant creation, session
 * establishment/liveness/revocation, bearer auth) runs for real against
 * PostgreSQL. Only the external identity provider is a double.
 *
 * Structural boundaries (D-RI-3):
 * - NEVER available in production: `buildApp` refuses the dev-identity
 *   composition outright when `nodeEnv === 'production'` (test-pinned).
 * - Tokens are opaque in-process handles — no JWT mechanics to confuse
 *   with real provider material; the store is per-process and volatile
 *   (a server restart signs everyone out of token acquisition; Himma
 *   sessions themselves live in PostgreSQL as always).
 * - Passwords are salted-scrypt-hashed in memory and never logged; this
 *   is still DEV-ONLY material — no durability, no rotation, no policy
 *   beyond a minimum length, deliberately.
 * - Swapping to the real pool later changes ONLY composition: the app's
 *   token-acquisition gateway calls Cognito instead of the /dev/identity
 *   routes; every Himma contract stays identical.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { AuthProviderAdapter, TokenValidationResult } from '../adapter';
import type {
  AccessTokenEvidence,
  AccessTokenVerificationResult,
  AccessTokenVerifier,
} from '../access-token';
import type { ProviderEvidence } from '../evidence';
import type { ProviderRefreshResult, ProviderTokenRefresher } from '../refresh';

export const DEV_IDENTITY_ISSUER = 'https://dev-identity.himma.local';
const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DevIssuedTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** Access-token expiry — the client refreshes before/at this instant. */
  expiresAt: Date;
}

export type DevSignUpResult =
  | { kind: 'signedUp'; tokens: DevIssuedTokens }
  | { kind: 'emailTaken' }
  | { kind: 'invalidEmail' }
  | { kind: 'weakPassword' };

export type DevSignInResult =
  | { kind: 'signedIn'; tokens: DevIssuedTokens }
  | { kind: 'invalidCredentials' };

export type DevRefreshResult =
  | { kind: 'refreshed'; accessToken: string; expiresAt: Date }
  | { kind: 'invalidRefreshToken' };

interface DevUser {
  subject: string;
  email: string;
  displayName?: string;
  salt: Buffer;
  passwordHash: Buffer;
}

interface DevProviderSession {
  subject: string;
  originJti: string;
}

export interface DevPasswordIdentityOptions {
  accessTokenTtlSeconds?: number;
  now?: () => Date;
}

export class DevPasswordIdentityProvider
  implements AuthProviderAdapter, AccessTokenVerifier, ProviderTokenRefresher
{
  private readonly usersByEmail = new Map<string, DevUser>();
  private readonly accessTokens = new Map<string, AccessTokenEvidence>();
  private readonly idTokens = new Map<string, ProviderEvidence>();
  private readonly refreshStore = new Map<string, DevProviderSession>();
  private readonly ttlSeconds: number;
  private readonly now: () => Date;
  private serial = 0;

  constructor(options: DevPasswordIdentityOptions = {}) {
    this.ttlSeconds = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  // -- token acquisition (the Cognito-client stand-in surface) -------------

  signUp(input: { email: string; password: string; displayName?: string }): DevSignUpResult {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || email.length > 320) return { kind: 'invalidEmail' };
    if (input.password.length < MIN_PASSWORD_LENGTH) return { kind: 'weakPassword' };
    if (this.usersByEmail.has(email)) return { kind: 'emailTaken' };
    const salt = randomBytes(16);
    const displayName = input.displayName?.trim();
    const user: DevUser = {
      subject: `dev-sub-${(this.serial += 1)}`,
      email,
      ...(displayName !== undefined && displayName.length > 0 ? { displayName } : {}),
      salt,
      passwordHash: scryptSync(input.password, salt, 32),
    };
    this.usersByEmail.set(email, user);
    return { kind: 'signedUp', tokens: this.issueSession(user) };
  }

  signIn(input: { email: string; password: string }): DevSignInResult {
    const user = this.usersByEmail.get(input.email.trim().toLowerCase());
    if (user === undefined) return { kind: 'invalidCredentials' };
    const presented = scryptSync(input.password, user.salt, 32);
    if (!timingSafeEqual(presented, user.passwordHash)) {
      return { kind: 'invalidCredentials' };
    }
    return { kind: 'signedIn', tokens: this.issueSession(user) };
  }

  /** Bearer-channel refresh (the app's own path — same provider session). */
  refresh(refreshToken: string): DevRefreshResult {
    const session = this.refreshStore.get(refreshToken);
    if (session === undefined) return { kind: 'invalidRefreshToken' };
    const user = [...this.usersByEmail.values()].find(
      (candidate) => candidate.subject === session.subject,
    );
    if (user === undefined) return { kind: 'invalidRefreshToken' };
    const issued = this.issueAccessToken(user, session.originJti);
    return { kind: 'refreshed', accessToken: issued.token, expiresAt: issued.expiresAt };
  }

  // -- certified ports ------------------------------------------------------

  async validateToken(rawToken: string): Promise<TokenValidationResult> {
    const evidence = this.idTokens.get(rawToken);
    if (evidence === undefined) return { ok: false, reason: 'invalidProviderEvidence' };
    return { ok: true, evidence };
  }

  async verifyAccessToken(rawToken: string): Promise<AccessTokenVerificationResult> {
    const evidence = this.accessTokens.get(rawToken);
    if (evidence === undefined) return { ok: false, reason: 'invalidAccessToken' };
    if (evidence.expiresAt.getTime() <= this.now().getTime()) {
      return { ok: false, reason: 'invalidAccessToken' };
    }
    return { ok: true, evidence };
  }

  /** ProviderTokenRefresher (cookie channel) — same semantics as `refresh`. */
  async refreshTokens(input: { refreshToken: string }): Promise<ProviderRefreshResult> {
    const refreshed = this.refresh(input.refreshToken);
    if (refreshed.kind !== 'refreshed') {
      return { ok: false, reason: 'invalidRefreshToken' };
    }
    return { ok: true, tokens: { accessToken: refreshed.accessToken } };
  }

  // -- internals ------------------------------------------------------------

  private issueSession(user: DevUser): DevIssuedTokens {
    // A fresh provider session per sign-in/sign-up: new originJti (a revoked
    // Himma session permanently retires its originJti — logout is final for
    // that provider session, exactly the certified semantics).
    const originJti = `dev-origin-${(this.serial += 1)}`;
    const authTime = this.now();
    const access = this.issueAccessToken(user, originJti, authTime);
    const idToken = `dev-id-${(this.serial += 1)}`;
    this.idTokens.set(idToken, {
      provider: 'email',
      issuer: DEV_IDENTITY_ISSUER,
      subject: user.subject,
      email: user.email,
      emailVerified: true,
      isPrivateRelay: false,
      assurance: 'single_factor',
      ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
    });
    const refreshToken = `dev-refresh-${(this.serial += 1)}`;
    this.refreshStore.set(refreshToken, { subject: user.subject, originJti });
    return { accessToken: access.token, idToken, refreshToken, expiresAt: access.expiresAt };
  }

  private issueAccessToken(
    user: DevUser,
    originJti: string,
    authTime?: Date,
  ): { token: string; expiresAt: Date } {
    const token = `dev-access-${(this.serial += 1)}`;
    const expiresAt = new Date(this.now().getTime() + this.ttlSeconds * 1000);
    this.accessTokens.set(token, {
      issuer: DEV_IDENTITY_ISSUER,
      subject: user.subject,
      originJti,
      scopes: [],
      assurance: 'single_factor',
      expiresAt,
      ...(authTime !== undefined ? { authTime } : {}),
    });
    return { token, expiresAt };
  }
}
