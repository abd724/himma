/**
 * Provider token-refresh port (docs/26 §4.7 items 2–3, §9.4; Amendment
 * A1.1) — W2-12A session-continuity correction.
 *
 * Refresh tokens are Cognito's credential and REMAIN client-channel
 * material: under §4.7(9) the browser holds them only inside the Secure,
 * HttpOnly, SameSite=Strict auth-path cookie, so the REFRESH exchange is
 * mediated server-side by this port — the route reads the cookie, asks the
 * provider for a rotated token pair, and Himma's own §9.4 transaction
 * (liveness + CAS `last_seen_at` on the `login_session` row) remains the
 * authority that can refuse a still-valid provider refresh token.
 *
 * No refresh token — raw or hashed — is ever stored, logged, audited, or
 * echoed (the §8.5 no-refresh-token schema guard stands). Provider errors
 * never escape: outcomes are the normalized vocabulary below.
 */

export interface RefreshedProviderTokens {
  /** The rotated provider ACCESS token (the only API bearer credential). */
  accessToken: string;
  /** Rotated ID token where the provider returns one (display claims). */
  idToken?: string;
  /** Present ONLY when the provider rotated the refresh token itself
   *  (Cognito rotation configuration); rides the cookie channel only. */
  refreshToken?: string;
}

export type ProviderRefreshResult =
  | { ok: true; tokens: RefreshedProviderTokens }
  /** Revoked/expired/reused/foreign refresh material — one class. */
  | { ok: false; reason: 'invalidRefreshToken' }
  | { ok: false; reason: 'providerUnavailable' };

export interface ProviderTokenRefresher {
  /** Network I/O — called strictly OUTSIDE database transactions. */
  refreshTokens(input: { refreshToken: string }): Promise<ProviderRefreshResult>;
}
