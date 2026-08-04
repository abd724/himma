import type {
  BookingDraft,
  BookingOptionsPage,
  ParticipantEligibility,
} from '@/services/contracts/booking';
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

/**
 * Whether the participant step may render for a draft, or must send the
 * user back to the flow start (docs/21 §3.2: cold links with an incomplete
 * draft redirect; entry states are owned by the selection route).
 */
export function participantStepAccess(
  page: BookingOptionsPage,
  draft: BookingDraft,
): 'render' | 'redirect-selection' {
  if (page.availability.status !== 'bookable') return 'redirect-selection';
  // Skip-rule flows have nothing to select; the step stands on its own.
  if (page.skipSelectionStep) return 'render';
  const option = page.options.find((entry) => entry.id === draft.optionId);
  if (option === undefined) return 'redirect-selection';
  if (option.requiresSession) {
    const session = option.sessions.find((entry) => entry.id === draft.sessionId);
    if (session === undefined || session.availability === 'full') return 'redirect-selection';
  }
  return 'render';
}

/** A booking may continue only with an explicitly chosen eligible participant. */
export function participantSelectionValid(
  eligibility: ParticipantEligibility[],
  participantId: string | undefined,
): boolean {
  if (participantId === undefined) return false;
  return eligibility.some((entry) => entry.participantId === participantId && entry.suitable);
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
