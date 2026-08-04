import { describe, expect, test } from '@jest/globals';
import { bookingExtras } from '@/data/mock/booking-extras';
import { programs } from '@/data/mock/catalogue';
import { programDetailExtras } from '@/data/mock/program-details';
import type { BookingOptionsInput } from '@/services/contracts/booking';
import { MockBookingService } from '@/services/mock/mock-booking-service';
import { buildUpcomingSessions, MockDetailsService } from '@/services/mock/mock-details-service';
import type { Participant } from '@/types/domain';

const service = new MockBookingService(0);
const detailsService = new MockDetailsService(0);

const me: Participant = { id: 'me', label: 'Me', kind: 'self' };
const adam: Participant = { id: 'adam', label: 'Adam', kind: 'child', dateOfBirth: '2018-03-14' }; // 8
const lina: Participant = { id: 'lina', label: 'Lina', kind: 'child', dateOfBirth: '2013-11-02' }; // 12
const everyone: Participant = { id: 'everyone', label: 'Everyone', kind: 'everyone' };
const household = [everyone, me, adam, lina];

function input(overrides: Partial<BookingOptionsInput>): BookingOptionsInput {
  return {
    programId: 'beginner-calisthenics',
    participantId: 'everyone',
    participants: household,
    areaId: 'khalifa-city',
    ...overrides,
  };
}

function pageFor(programId: string, participantId = 'everyone') {
  const page = service.buildBookingOptions(input({ programId, participantId }));
  expect(page).toBeDefined();
  return page!;
}

describe('Booking options per program type (docs/21 §5, docs/09 §21.7)', () => {
  test('drop-in yields one session-requiring option with dated sessions', () => {
    const page = pageFor('beginner-calisthenics');
    expect(page.availability.status).toBe('bookable');
    expect(page.options).toHaveLength(1);
    expect(page.options[0]).toMatchObject({
      kind: 'single-session',
      title: 'Single session',
      priceLabel: 'AED 85 per session',
      requiresSession: true,
    });
    expect(page.options[0].sessions.length).toBeGreaterThan(0);
    expect(page.skipSelectionStep).toBe(false);
  });

  test('free program yields a free session option priced "Free"', () => {
    const page = pageFor('community-park-football');
    expect(page.options).toHaveLength(1);
    expect(page.options[0]).toMatchObject({
      kind: 'free-session',
      title: 'Free session',
      priceLabel: 'Free',
      requiresSession: true,
    });
  });

  test('monthly enrolment is dateless, cadence-labelled, and skips selection', () => {
    const page = pageFor('junior-swim-squad');
    expect(page.options).toHaveLength(1);
    const option = page.options[0];
    expect(option).toMatchObject({
      kind: 'recurring',
      title: 'Monthly enrolment',
      priceLabel: 'AED 380 per month',
      requiresSession: false,
    });
    expect(option.sessions).toHaveLength(0);
    expect(option.detailLines[0]).toBe('Sat & Sun · 10:00 AM');
    expect(option.detailLines[1]).toMatch(/^Starts with the next session — /);
    expect(page.skipSelectionStep).toBe(true);
  });

  test('term enrolment mirrors recurring with term cadence', () => {
    const page = pageFor('junior-karate');
    expect(page.options[0]).toMatchObject({
      kind: 'term',
      title: 'Term enrolment',
      priceLabel: 'AED 1,800 per term',
      requiresSession: false,
    });
    expect(page.skipSelectionStep).toBe(true);
  });

  test('package shows size and price only — no expiry or redemption rules', () => {
    const page = pageFor('adult-swim-technique');
    const option = page.options[0];
    expect(option).toMatchObject({
      kind: 'package',
      title: 'Package of 6 sessions',
      priceLabel: 'AED 480 for 6 sessions',
      requiresSession: false,
    });
    // Schedule orientation only.
    expect(option.detailLines).toEqual(['Tue & Thu · 8:00 PM']);
    expect(page.skipSelectionStep).toBe(true);
  });

  test('a package needs no sessions: public-speaking books despite sessions "none"', () => {
    const page = pageFor('public-speaking');
    expect(page.availability.status).toBe('bookable');
    expect(page.options[0].kind).toBe('package');
    expect(page.skipSelectionStep).toBe(true);
  });

  test('camp books at week granularity with the derived single week', () => {
    const page = pageFor('holiday-swim-camp');
    const option = page.options[0];
    expect(option).toMatchObject({
      kind: 'camp-week',
      title: 'Camp week',
      priceLabel: 'AED 850 per week',
      requiresSession: true,
    });
    expect(option.sessions).toEqual([
      {
        id: 'holiday-swim-camp-week-15',
        dayOffset: 15,
        dayLabel: 'Week of 17–21 Aug',
        timeLabel: '9 AM–12 PM',
        branchLabel: undefined,
        availability: 'available',
        spotsLeft: undefined,
      },
    ]);
    expect(page.skipSelectionStep).toBe(false);
  });

  test('a multi-week camp offers every override week', () => {
    const page = pageFor('active-summer-camp');
    const weeks = page.options[0].sessions;
    expect(weeks.map((week) => week.dayLabel)).toEqual([
      'Week of 10–14 Aug',
      'Week of 17–21 Aug',
      'Week of 24–28 Aug',
    ]);
    expect(weeks.every((week) => week.timeLabel === '8:30 AM–1 PM')).toBe(true);
  });

  test('free-trial program offers trial first, then the full enrolment', () => {
    const page = pageFor('ladies-strength');
    expect(page.options.map((option) => option.kind)).toEqual(['trial', 'recurring']);
    expect(page.options[0]).toMatchObject({
      title: 'Free trial session',
      priceLabel: 'Free',
      requiresSession: true,
    });
    expect(page.options[1].priceLabel).toBe('AED 450 per month');
    expect(page.skipSelectionStep).toBe(false);
  });

  test('paid trial price comes from structured booking extras, never label parsing', () => {
    const page = pageFor('junior-football-u10');
    expect(page.options[0]).toMatchObject({
      kind: 'trial',
      title: 'Trial session',
      priceLabel: 'AED 35',
      requiresSession: true,
    });
    expect(bookingExtras['junior-football-u10'].trialAmount).toBe(35);
  });
});

describe('Availability states (docs/21 §7, docs/09 §21.3–§21.5)', () => {
  test('weak availability maps to fewLeft with the real spots count', () => {
    // padel-beginners is the session-requiring weak-availability demo;
    // reformer-pilates (monthly, dateless) shows its 3-left only on details.
    const first = pageFor('padel-beginners').options[0].sessions[0];
    expect(first.availability).toBe('fewLeft');
    expect(first.spotsLeft).toBe(2);
  });

  test('a zero-spot occurrence is full — and Program Details shows the same', () => {
    const sessions = pageFor('morning-yoga').options[0].sessions;
    expect(sessions[0].availability).toBe('full');
    expect(sessions[0].spotsLeft).toBeUndefined();
    expect(sessions.slice(1).every((session) => session.availability === 'available')).toBe(true);

    const details = detailsService.buildProgramDetailPage({
      programId: 'morning-yoga',
      participantId: 'everyone',
      participants: household,
      areaId: 'khalifa-city',
    });
    expect(details?.sessions[0].spotsLeft).toBe(0);
  });

  test('full sessions stay visible in the list, never dropped', () => {
    const sessions = pageFor('morning-yoga').options[0].sessions;
    expect(sessions.length).toBeGreaterThan(1);
    expect(sessions.some((session) => session.availability === 'full')).toBe(true);
  });

  test('session-requiring program with no sessions resolves to noSessions on both surfaces', () => {
    const page = pageFor('sunrise-breathwork');
    expect(page.availability.status).toBe('noSessions');
    expect(page.options).toHaveLength(0);

    const details = detailsService.buildProgramDetailPage({
      programId: 'sunrise-breathwork',
      participantId: 'everyone',
      participants: household,
      areaId: 'khalifa-city',
    });
    expect(details?.sessions).toHaveLength(0);
  });

  test('registration-closed camp is an entry state with a customer reason', () => {
    const page = pageFor('teen-arabic-summer');
    expect(page.availability).toEqual({
      status: 'registrationClosed',
      reason: 'Registration for this camp has closed.',
    });
    expect(page.options).toHaveLength(0);
    expect(page.skipSelectionStep).toBe(false);
  });

  test('availability is deterministic — two builds are identical', () => {
    for (const program of programs) {
      expect(service.buildBookingOptions(input({ programId: program.id }))).toEqual(
        service.buildBookingOptions(input({ programId: program.id })),
      );
    }
  });
});

describe('Participant preselection and eligibility (docs/21 §2, §6)', () => {
  test('browsing participant preselects only when real and eligible', () => {
    expect(pageFor('junior-swim-squad', 'adam').preselectedParticipantId).toBe('adam');
    expect(pageFor('beginner-calisthenics', 'me').preselectedParticipantId).toBe('me');
  });

  test('everyone browsing context preselects nothing', () => {
    expect(pageFor('junior-swim-squad', 'everyone').preselectedParticipantId).toBeUndefined();
  });

  test('an ineligible browsing participant is never preselected', () => {
    expect(pageFor('mens-strength-basics', 'adam').preselectedParticipantId).toBeUndefined();
    expect(pageFor('junior-karate', 'me').preselectedParticipantId).toBeUndefined();
  });

  test('household eligibility lists every real participant, primary first', () => {
    const page = pageFor('junior-swim-squad');
    expect(page.householdEligibility.map((entry) => entry.participantId)).toEqual([
      'me',
      'adam',
      'lina',
    ]);
    const byId = Object.fromEntries(
      page.householdEligibility.map((entry) => [entry.participantId, entry]),
    );
    expect(byId.adam.suitable).toBe(true);
    expect(byId.lina.suitable).toBe(true);
    expect(byId.me.suitable).toBe(false);
  });

  test('ladies-only programs never gender-exclude anyone (docs/05 §7)', () => {
    const page = pageFor('ladies-strength');
    expect(page.householdEligibility.find((entry) => entry.participantId === 'me')?.suitable).toBe(
      true,
    );
  });

  test('preselection derives from arbitrary participant data, not demo names', () => {
    const lena: Participant = {
      id: 'lena',
      label: 'Lena',
      kind: 'child',
      dateOfBirth: '2019-05-01', // 7 on MOCK_TODAY
    };
    const page = service.buildBookingOptions(
      input({
        programId: 'junior-swim-squad',
        participantId: 'lena',
        participants: [everyone, me, lena],
      }),
    )!;
    expect(page.preselectedParticipantId).toBe('lena');
    expect(page.householdEligibility.map((entry) => entry.label)).toEqual(['Me', 'Lena']);
  });
});

describe('Lookup, failure, and data invariants (docs/21 §12, §16)', () => {
  test('unknown program id resolves undefined for screen recovery', () => {
    expect(service.buildBookingOptions(input({ programId: 'does-not-exist' }))).toBeUndefined();
  });

  test('simulateFailure rejects with the QA-only error', async () => {
    await expect(
      service.getBookingOptions(input({ simulateFailure: true })),
    ).rejects.toThrow('Simulated network failure (QA only)');
  });

  test('every catalogue program builds a booking page with a coherent skip rule', () => {
    for (const program of programs) {
      const page = service.buildBookingOptions(input({ programId: program.id }));
      expect(page).toBeDefined();
      if (page!.availability.status === 'bookable') {
        expect(page!.options.length).toBeGreaterThan(0);
        expect(page!.skipSelectionStep).toBe(
          page!.options.length === 1 && !page!.options[0].requiresSession,
        );
        for (const option of page!.options) {
          expect(option.requiresSession ? option.sessions.length > 0 : option.sessions.length === 0).toBe(
            true,
          );
          expect(option.priceLabel.length).toBeGreaterThan(0);
          // No reservation or charged-today implication in any option copy.
          for (const text of [option.title, option.priceLabel, ...option.detailLines]) {
            expect(text).not.toMatch(/reserv|hold|charged/i);
          }
        }
      } else {
        expect(page!.options).toHaveLength(0);
      }
    }
  });

  test('every booking-extras key belongs to a catalogue program', () => {
    const ids = new Set(programs.map((program) => program.id));
    for (const key of Object.keys(bookingExtras)) {
      expect(ids.has(key)).toBe(true);
    }
  });

  test('every paid-trial program carries a structured trial amount', () => {
    for (const program of programs) {
      if (program.offer?.kind === 'paidTrial') {
        expect(bookingExtras[program.id]?.trialAmount).toBeGreaterThan(0);
      }
    }
  });

  test('sessionSpots indexes fall inside the derived session window', () => {
    for (const [programId, extras] of Object.entries(bookingExtras)) {
      if (extras.sessionSpots === undefined) continue;
      const program = programs.find((entry) => entry.id === programId)!;
      const derived = buildUpcomingSessions(program, programDetailExtras[programId], extras);
      for (const index of Object.keys(extras.sessionSpots)) {
        expect(Number(index)).toBeLessThan(derived.length);
      }
    }
  });

  test('campWeeks overrides only apply to camps and stay in the future', () => {
    for (const [programId, extras] of Object.entries(bookingExtras)) {
      if (extras.campWeeks === undefined) continue;
      const program = programs.find((entry) => entry.id === programId)!;
      expect(program.isCamp).toBe(true);
      for (const week of extras.campWeeks) {
        expect(week.startOffset).toBeGreaterThanOrEqual(0);
        expect(week.label).toMatch(/^Week of /);
      }
    }
  });

  test('every booking option kind is demonstrated by the catalogue', () => {
    const kinds = new Set(
      programs.flatMap(
        (program) =>
          service
            .buildBookingOptions(input({ programId: program.id }))
            ?.options.map((option) => option.kind) ?? [],
      ),
    );
    for (const kind of [
      'single-session',
      'free-session',
      'trial',
      'recurring',
      'term',
      'camp-week',
      'package',
    ]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  test('getBookingSummary is a Commit 14 contract: every draft resolves invalid for now', async () => {
    await expect(
      service.getBookingSummary({
        draft: { programId: 'beginner-calisthenics' },
        participants: household,
        areaId: 'khalifa-city',
      }),
    ).resolves.toBeUndefined();
  });
});
