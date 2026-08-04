import { describe, expect, test } from '@jest/globals';
import {
  bookingHref,
  bookingStepHref,
  participantSelectionValid,
  participantStepAccess,
} from '@/features/booking/booking-navigation';
import { MockBookingService } from '@/services/mock/mock-booking-service';
import type { Participant } from '@/types/domain';

/** Booking-route policy — docs/21 §3: one flow, one entry, no duplicates. */
describe('booking hrefs', () => {
  test('flow start', () => {
    expect(bookingHref('beginner-calisthenics')).toBe('/booking/beginner-calisthenics');
  });

  test('step routes', () => {
    expect(bookingStepHref('beginner-calisthenics', 'participant')).toBe(
      '/booking/beginner-calisthenics/participant',
    );
    expect(bookingStepHref('beginner-calisthenics', 'summary')).toBe(
      '/booking/beginner-calisthenics/summary',
    );
  });
});

const service = new MockBookingService(0);
const me: Participant = { id: 'me', label: 'Me', kind: 'self' };
const adam: Participant = { id: 'adam', label: 'Adam', kind: 'child', dateOfBirth: '2018-03-14' };

function pageFor(programId: string) {
  return service.buildBookingOptions({
    programId,
    participantId: 'everyone',
    participants: [me, adam],
    areaId: 'khalifa-city',
  })!;
}

describe('participantStepAccess (docs/21 §3.2)', () => {
  test('skip-rule flows render regardless of draft contents', () => {
    expect(participantStepAccess(pageFor('junior-swim-squad'), { programId: 'junior-swim-squad' })).toBe(
      'render',
    );
  });

  test('a dated program with an empty draft redirects to selection', () => {
    expect(
      participantStepAccess(pageFor('beginner-calisthenics'), { programId: 'beginner-calisthenics' }),
    ).toBe('redirect-selection');
  });

  test('a chosen option without its required session redirects', () => {
    const page = pageFor('beginner-calisthenics');
    expect(
      participantStepAccess(page, {
        programId: 'beginner-calisthenics',
        optionId: page.options[0].id,
      }),
    ).toBe('redirect-selection');
  });

  test('a complete dated draft renders', () => {
    const page = pageFor('beginner-calisthenics');
    expect(
      participantStepAccess(page, {
        programId: 'beginner-calisthenics',
        optionId: page.options[0].id,
        sessionId: page.options[0].sessions[0].id,
      }),
    ).toBe('render');
  });

  test('a full session never passes the guard', () => {
    const page = pageFor('morning-yoga');
    const fullSession = page.options[0].sessions.find(
      (session) => session.availability === 'full',
    )!;
    expect(
      participantStepAccess(page, {
        programId: 'morning-yoga',
        optionId: page.options[0].id,
        sessionId: fullSession.id,
      }),
    ).toBe('redirect-selection');
  });

  test('non-bookable entry states are owned by the selection route', () => {
    expect(
      participantStepAccess(pageFor('teen-arabic-summer'), { programId: 'teen-arabic-summer' }),
    ).toBe('redirect-selection');
    expect(
      participantStepAccess(pageFor('sunrise-breathwork'), { programId: 'sunrise-breathwork' }),
    ).toBe('redirect-selection');
  });
});

describe('participantSelectionValid (docs/21 §6)', () => {
  const eligibility = pageFor('junior-swim-squad').householdEligibility;

  test('an explicitly selected eligible participant is valid', () => {
    expect(participantSelectionValid(eligibility, 'adam')).toBe(true);
  });

  test('no selection is never valid — even with exactly one eligible participant', () => {
    expect(participantSelectionValid(eligibility, undefined)).toBe(false);
  });

  test('an ineligible or unknown participant is invalid', () => {
    expect(participantSelectionValid(eligibility, 'me')).toBe(false); // adults out of 6–14
    expect(participantSelectionValid(eligibility, 'ghost')).toBe(false);
  });
});
