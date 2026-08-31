/**
 * RI-6 — auth lifecycle signals (the bookings-events subscribe pattern).
 *
 * `authReset` fires whenever local auth state is forgotten (logout, an
 * authoritative 401, a rejected restore) so account-scoped device state —
 * the pending checkout record, the stashed check-in secret, recent
 * searches — clears before another account can sign in on this device.
 *
 * `sessionInvalidated` fires when the server authoritatively rejects the
 * CURRENT bearer mid-session (the HTTP client's 401 hook); the auth
 * context reacts by clearing local auth state — no stale authenticated
 * UI survives a dead session.
 */
type Listener = () => void;

const authResetListeners = new Set<Listener>();
const invalidatedListeners = new Set<Listener>();

export function subscribeAuthReset(listener: Listener): () => void {
  authResetListeners.add(listener);
  return () => authResetListeners.delete(listener);
}

export function notifyAuthReset(): void {
  for (const listener of [...authResetListeners]) listener();
}

export function subscribeSessionInvalidated(listener: Listener): () => void {
  invalidatedListeners.add(listener);
  return () => invalidatedListeners.delete(listener);
}

export function notifySessionInvalidated(): void {
  for (const listener of [...invalidatedListeners]) listener();
}
