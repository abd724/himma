/**
 * RI-3 — a tiny invalidation signal for the customer's own bookings: a
 * confirmed booking (free or paid) bumps the version so Home's real
 * schedule and My Bookings re-read SERVER truth. Never carries data —
 * subscribers always re-fetch; nothing is optimistic.
 */
type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();

export function bookingsVersion(): number {
  return version;
}

export function notifyBookingsChanged(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeBookingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
