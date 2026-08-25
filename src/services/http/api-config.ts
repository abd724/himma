/**
 * RI-1 — API environment configuration. The base URL comes from
 * `EXPO_PUBLIC_API_URL` (Expo inlines `EXPO_PUBLIC_*` at build time); dev
 * builds fall back to the local dev server. NO secret of any kind lives
 * here or anywhere in the app bundle — the only credential the app ever
 * holds is the signed-in user's own token material.
 */

const DEV_DEFAULT_API_URL = 'http://localhost:3101';

export function apiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured !== undefined && configured.length > 0) {
    return configured.replace(/\/+$/, '');
  }
  if (__DEV__) return DEV_DEFAULT_API_URL;
  throw new Error('EXPO_PUBLIC_API_URL is not configured for this build.');
}
