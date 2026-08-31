/**
 * RI-4 — the IN-MEMORY display store for the current check-in credential
 * (docs/35 §9; owner RI-4 §17).
 *
 * The 8-digit display code is CREDENTIAL SECRET MATERIAL: the server
 * returns it exactly once, and this module is the only place the app holds
 * it — plain process memory, for the credential screen to render. It is
 * NEVER persisted (no AsyncStorage/SecureStore/localStorage), never
 * logged, never sent to analytics, and never placed in a route param or
 * URL. Losing it (reload, app restart) is RECOVERED by explicit
 * regeneration — never by re-asking the server for the old secret (a
 * replay returns metadata only, by design).
 */

import { subscribeAuthReset } from '@/services/auth/auth-signals';

export interface StashedCredential {
  credentialId: string;
  /** The one-time secret — present only when THIS process minted it. */
  displayCode?: string;
  expiresAt: string;
}

let current: StashedCredential | null = null;

// RI-6 — the in-memory secret dies with the session: logout (or an
// authoritative 401) drops it immediately, so a signed-out device holds
// no live check-in material for the next account to find.
subscribeAuthReset(() => {
  current = null;
});

export function stashCredential(credential: StashedCredential): void {
  current = credential;
}

/** The stashed credential IF it matches — never clears on read (the
 *  screen re-renders); replaced on the next stash. */
export function stashedCredential(credentialId: string): StashedCredential | null {
  return current !== null && current.credentialId === credentialId ? current : null;
}

/** Drop the secret from memory (screen dismissed / credential terminal). */
export function clearStashedCredential(credentialId?: string): void {
  if (credentialId === undefined || current?.credentialId === credentialId) current = null;
}
