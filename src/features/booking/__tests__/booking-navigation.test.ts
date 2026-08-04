import { describe, expect, test } from '@jest/globals';
import {
  bookingHref,
  bookingStepHref,
  checkoutStepAccess,
  participantSelectionValid,
  participantStepAccess,
  summaryStepAccess,
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
    expect(bookingStepHref('beginner-calisthenics', 'checkout')).toBe(
      '/booking/beginner-calisthenics/checkout',
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

describe('summaryStepAccess (docs/21 §3.2, §11)', () => {
  const datedDraft = () => {
    const page = pageFor('beginner-calisthenics');
    return {
      page,
      draft: {
        programId: 'beginner-calisthenics',
        optionId: page.options[0].id,
        sessionId: page.options[0].sessions[0].id,
        participantId: 'me',
      },
    };
  };

  test('a complete, eligible dated draft renders', () => {
    const { page, draft } = datedDraft();
    expect(summaryStepAccess(page, draft)).toBe('render');
  });

  test('a cold link’s empty draft returns to the flow start', () => {
    expect(
      summaryStepAccess(pageFor('beginner-calisthenics'), { programId: 'beginner-calisthenics' }),
    ).toBe('redirect-selection');
    // Skip-rule flows included: their auto-selected option only exists once
    // the flow has actually been entered.
    expect(
      summaryStepAccess(pageFor('junior-swim-squad'), { programId: 'junior-swim-squad' }),
    ).toBe('redirect-selection');
  });

  test('a missing or full session returns to the flow start', () => {
    const { page, draft } = datedDraft();
    expect(summaryStepAccess(page, { ...draft, sessionId: undefined })).toBe('redirect-selection');
    const yoga = pageFor('morning-yoga');
    const full = yoga.options[0].sessions.find((session) => session.availability === 'full')!;
    expect(
      summaryStepAccess(yoga, {
        programId: 'morning-yoga',
        optionId: yoga.options[0].id,
        sessionId: full.id,
        participantId: 'me',
      }),
    ).toBe('redirect-selection');
  });

  test('a missing or ineligible participant returns to the participant step', () => {
    const { page, draft } = datedDraft();
    expect(summaryStepAccess(page, { ...draft, participantId: undefined })).toBe(
      'redirect-participant',
    );
    expect(summaryStepAccess(page, { ...draft, participantId: 'adam' })).toBe(
      'redirect-participant',
    );
  });

  test('a guest household never reaches the summary', () => {
    const guestPage = service.buildBookingOptions({
      programId: 'beginner-calisthenics',
      participantId: 'everyone',
      participants: [],
      areaId: 'khalifa-city',
    })!;
    expect(
      summaryStepAccess(guestPage, {
        programId: 'beginner-calisthenics',
        optionId: guestPage.options[0].id,
        sessionId: guestPage.options[0].sessions[0].id,
        participantId: 'me',
      }),
    ).toBe('redirect-participant');
  });

  test('non-bookable entry states are owned by the selection route', () => {
    expect(
      summaryStepAccess(pageFor('teen-arabic-summer'), {
        programId: 'teen-arabic-summer',
        optionId: 'x',
        participantId: 'me',
      }),
    ).toBe('redirect-selection');
  });
});

describe('checkoutStepAccess (docs/22 §3.3)', () => {
  test('checkout requires exactly the summary-valid draft — the policies agree', () => {
    const page = pageFor('beginner-calisthenics');
    const option = page.options[0];
    const drafts = [
      { programId: 'beginner-calisthenics' }, // cold link, empty draft
      { programId: 'beginner-calisthenics', optionId: option.id }, // no session
      {
        programId: 'beginner-calisthenics',
        optionId: option.id,
        sessionId: option.sessions[0].id,
      }, // no participant
      {
        programId: 'beginner-calisthenics',
        optionId: option.id,
        sessionId: option.sessions[0].id,
        participantId: 'me',
      }, // fully valid
    ];
    for (const draft of drafts) {
      expect(checkoutStepAccess(page, draft)).toBe(summaryStepAccess(page, draft));
    }
    expect(checkoutStepAccess(page, drafts[0])).toBe('redirect-selection');
    expect(checkoutStepAccess(page, drafts[2])).toBe('redirect-participant');
    expect(checkoutStepAccess(page, drafts[3])).toBe('render');
  });

  test('non-bookable entry states redirect to the flow start', () => {
    expect(
      checkoutStepAccess(pageFor('teen-arabic-summer'), {
        programId: 'teen-arabic-summer',
        optionId: 'x',
        participantId: 'me',
      }),
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
