/**
 * Return-destination safety (task §20, docs/29 access flow).
 *
 * A `returnTo` destination may only ever be an internal portal path: no
 * absolute/protocol URLs, no protocol-relative (`//host`) or backslash
 * variants, no encoded slash smuggling, and never a destination inside the
 * access zone itself (sign-in/MFA/step-up/signed-out), which would loop the
 * flow. Anything unsafe resolves to null and callers fall back to the
 * default landing.
 */
const ACCESS_ZONE_PREFIXES = ['/sign-in', '/mfa', '/step-up', '/signed-out', '/invitation'];

export function safeReturnTo(candidate: string | null | undefined): string | null {
  if (!candidate) {
    return null;
  }
  const value = candidate.trim();
  if (!value.startsWith('/')) {
    return null;
  }
  // Protocol-relative and backslash-smuggled hosts.
  if (value.startsWith('//') || value.includes('\\')) {
    return null;
  }
  // Encoded separators that could decode into a host jump downstream.
  if (/%2f|%5c/i.test(value)) {
    return null;
  }
  const path = value.split(/[?#]/)[0] ?? '';
  if (ACCESS_ZONE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return null;
  }
  return value;
}
