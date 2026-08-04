import { useRouter } from 'expo-router';
import { useRef } from 'react';

/**
 * Booking-flow navigation policy — docs/21 §3. The flow is a root-level
 * stack (dock hidden structurally, like /program and /provider) entered only
 * through the Program Details Book CTA; each step is its own route so the
 * route is the step (no separate step state to diverge).
 */
export type BookingStep = 'participant' | 'summary';

export function bookingHref(programId: string): `/booking/${string}` {
  return `/booking/${programId}`;
}

export function bookingStepHref(programId: string, step: BookingStep): `/booking/${string}` {
  return `/booking/${programId}/${step}`;
}

/** One press never pushes two copies of the booking flow (details precedent). */
const DOUBLE_TAP_WINDOW_MS = 700;

export function useBookingEntry() {
  const router = useRouter();
  const lastPushAt = useRef(0);

  return {
    openBooking: (programId: string) => {
      const now = Date.now();
      if (now - lastPushAt.current < DOUBLE_TAP_WINDOW_MS) return;
      lastPushAt.current = now;
      router.push(bookingHref(programId));
    },
  };
}
