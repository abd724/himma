/**
 * RI-4 — the Passes & Memberships invalidation signal (the bookings-events
 * pattern): an acquisition, reservation, or server-confirmed check-in bumps
 * the version so Passes surfaces re-read SERVER truth. Never carries data —
 * subscribers always re-fetch; balances are never decremented optimistically.
 */
type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();

export function passesVersion(): number {
  return version;
}

export function notifyPassesChanged(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribePassesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
