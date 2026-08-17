/**
 * Browser session-continuity cookie channel (docs/26 §4.7(9), §14.E) —
 * W2-12A correction. The EXACT approved model:
 *
 * - The Cognito REFRESH token rides a `Secure; HttpOnly; SameSite=Strict`
 *   cookie scoped to the auth path — browser JavaScript can never read it,
 *   and it is sent only to `/auth/*` routes of the same site.
 * - ACCESS tokens stay in client memory (never cookies, never storage).
 * - CSRF: SameSite=Strict PLUS a double-submit check — a separate
 *   NON-HttpOnly `himma_csrf` cookie whose random value must be echoed in
 *   the `x-csrf-token` header of every cookie-authenticated operation
 *   (compared timing-safe). The CSRF value is random channel-binding
 *   material and NEVER an authentication credential.
 * - An Origin allowlist rejects any browser request from an origin the
 *   deployment did not declare (defense-in-depth over SameSite).
 *
 * Configuration follows docs/25 §5 (environment-configured, safe defaults,
 * no literals): production REFUSES to run the channel without `Secure`
 * cookies; a deliberate dev-only override exists for plain-HTTP localhost.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { NodeEnv } from '../../../config/env';

export const REFRESH_COOKIE_NAME = 'himma_refresh';
export const CSRF_COOKIE_NAME = 'himma_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
/** docs/26 §4.7(9): the cookie is scoped to the auth path. */
export const AUTH_COOKIE_PATH = '/auth';

/** Safe default matching Cognito's default refresh TTL (30 days). */
const DEFAULT_REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_REFRESH_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export class AuthCookieConfigError extends Error {}

export interface AuthCookieConfig {
  /** `Secure` attribute — production MUST be true (enforced at parse). */
  secure: boolean;
  /** Optional Domain attribute (same-site subdomain deployments). */
  domain?: string;
  refreshCookieMaxAgeSeconds: number;
  /** Browser origins allowed to use the cookie channel (exact matches). */
  allowedOrigins: string[];
}

export function parseAuthCookieConfig(
  nodeEnv: NodeEnv,
  env: Record<string, string | undefined>,
): AuthCookieConfig {
  const rawSecure = env.AUTH_COOKIE_SECURE?.trim();
  let secure = true;
  if (rawSecure !== undefined && rawSecure !== '') {
    if (rawSecure !== 'true' && rawSecure !== 'false') {
      throw new AuthCookieConfigError('AUTH_COOKIE_SECURE must be "true" or "false".');
    }
    secure = rawSecure === 'true';
  }
  if (nodeEnv === 'production' && !secure) {
    // Never weaken production cookie security for local convenience.
    throw new AuthCookieConfigError('AUTH_COOKIE_SECURE=false is refused in production.');
  }
  const domain = env.AUTH_COOKIE_DOMAIN?.trim();
  const rawMaxAge = env.AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS?.trim();
  let refreshCookieMaxAgeSeconds = DEFAULT_REFRESH_COOKIE_MAX_AGE_SECONDS;
  if (rawMaxAge !== undefined && rawMaxAge !== '') {
    refreshCookieMaxAgeSeconds = Number(rawMaxAge);
    if (
      !Number.isInteger(refreshCookieMaxAgeSeconds) ||
      refreshCookieMaxAgeSeconds <= 0 ||
      refreshCookieMaxAgeSeconds > MAX_REFRESH_COOKIE_MAX_AGE_SECONDS
    ) {
      throw new AuthCookieConfigError(
        'AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS must be a positive integer of seconds (≤ 1 year).',
      );
    }
  }
  const allowedOrigins = (env.PORTAL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
  for (const origin of allowedOrigins) {
    if (!/^https?:\/\/[^\s/]+$/.test(origin)) {
      throw new AuthCookieConfigError(
        `PORTAL_ALLOWED_ORIGINS entries must be bare origins (scheme://host[:port]); got "${origin}".`,
      );
    }
    if (nodeEnv === 'production' && origin.startsWith('http://')) {
      throw new AuthCookieConfigError(
        'PORTAL_ALLOWED_ORIGINS must be https origins in production.',
      );
    }
  }
  return {
    secure,
    ...(domain !== undefined && domain !== '' ? { domain } : {}),
    refreshCookieMaxAgeSeconds,
    allowedOrigins,
  };
}

/** Minimal, strict request-cookie parsing (no dependency). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length === 0 || value.length === 0) continue;
    cookies.set(name, value);
  }
  return cookies;
}

const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9\-._~+/=]+$/;

function serializeCookie(
  config: AuthCookieConfig,
  name: string,
  value: string,
  { httpOnly, maxAgeSeconds }: { httpOnly: boolean; maxAgeSeconds: number },
): string {
  if (!COOKIE_VALUE_PATTERN.test(value) && value !== '') {
    throw new AuthCookieConfigError(`Refusing to serialize an unsafe ${name} cookie value.`);
  }
  const attributes = [
    `${name}=${value}`,
    `Path=${AUTH_COOKIE_PATH}`,
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (httpOnly) attributes.push('HttpOnly');
  if (config.secure) attributes.push('Secure');
  if (config.domain !== undefined) attributes.push(`Domain=${config.domain}`);
  return attributes.join('; ');
}

/** The HttpOnly refresh cookie (docs/26 §4.7(9) attributes, exact). */
export function refreshCookie(config: AuthCookieConfig, refreshToken: string): string {
  return serializeCookie(config, REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    maxAgeSeconds: config.refreshCookieMaxAgeSeconds,
  });
}

/** The double-submit CSRF cookie — readable by same-origin JS, echoed via
 *  header; random channel binding, never a credential. */
export function csrfCookie(config: AuthCookieConfig, csrfToken: string): string {
  return serializeCookie(config, CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    maxAgeSeconds: config.refreshCookieMaxAgeSeconds,
  });
}

export function clearedAuthCookies(config: AuthCookieConfig): string[] {
  return [
    serializeCookie(config, REFRESH_COOKIE_NAME, '', { httpOnly: true, maxAgeSeconds: 0 }),
    serializeCookie(config, CSRF_COOKIE_NAME, '', { httpOnly: false, maxAgeSeconds: 0 }),
  ];
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Timing-safe double-submit comparison. */
export function csrfMatches(cookieValue: string | undefined, headerValue: unknown): boolean {
  if (typeof headerValue !== 'string' || cookieValue === undefined) return false;
  const cookieBuffer = Buffer.from(cookieValue);
  const headerBuffer = Buffer.from(headerValue);
  if (cookieBuffer.length !== headerBuffer.length || cookieBuffer.length === 0) return false;
  return timingSafeEqual(cookieBuffer, headerBuffer);
}

/**
 * Origin allowlist check for cookie-authenticated routes: a browser
 * request carrying an Origin outside the deployment's declared portal
 * origins is refused; requests without an Origin header (same-origin
 * navigations, non-browser clients — which cannot carry the cookie
 * anyway) pass through to the cookie/CSRF checks.
 */
export function originAllowed(config: AuthCookieConfig, origin: unknown): boolean {
  if (origin === undefined || origin === null || origin === '') return true;
  if (typeof origin !== 'string') return false;
  return config.allowedOrigins.includes(origin.replace(/\/+$/, ''));
}
