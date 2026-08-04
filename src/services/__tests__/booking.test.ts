import { describe, expect, test } from '@jest/globals';
import { bookingExtras } from '@/data/mock/booking-extras';
import { programs } from '@/data/mock/catalogue';
import { programDetailExtras } from '@/data/mock/program-details';
import type { BookingDraft, BookingOptionsInput } from '@/services/contracts/booking';
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

  test('the only eligible participant is never auto-selected (docs/09 §21)', () => {
    // me-only account on an adults-only program: exactly one eligible
    // participant, browsing as everyone — preselection must stay empty.
    const page = service.buildBookingOptions(
      input({ programId: 'beginner-calisthenics', participants: [everyone, me] }),
    )!;
    expect(page.householdEligibility.filter((entry) => entry.suitable)).toHaveLength(1);
    expect(page.preselectedParticipantId).toBeUndefined();
  });

  test('guest input yields empty eligibility and no preselection', () => {
    const page = service.buildBookingOptions(input({ participants: [] }))!;
    expect(page.householdEligibility).toEqual([]);
    expect(page.preselectedParticipantId).toBeUndefined();
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

});

/**
 * A valid draft for a program's option at `optionIndex`: first open session
 * where one is required, plus the given participant. Overrides then break
 * specific slices for the rejection matrix.
 */
function draftFor(
  programId: string,
  participantId: string,
  optionIndex = 0,
  overrides?: Partial<BookingDraft>,
): BookingDraft {
  const option = pageFor(programId).options[optionIndex];
  return {
    programId,
    optionId: option.id,
    sessionId: option.requiresSession
      ? option.sessions.find((session) => session.availability !== 'full')?.id
      : undefined,
    participantId,
    ...overrides,
  };
}

function summaryFor(
  programId: string,
  participantId: string,
  optionIndex = 0,
  overrides?: Partial<BookingDraft>,
) {
  return service.buildBookingSummary({
    draft: draftFor(programId, participantId, optionIndex, overrides),
    participants: household,
    areaId: 'khalifa-city',
  });
}

describe('Booking summary per program type (docs/21 §5, §8, §9; docs/09 §21.11)', () => {
  test('single session: dated selection line, per-session price, Booking price label', () => {
    const summary = summaryFor('beginner-calisthenics', 'me')!;
    expect(summary).toBeDefined();
    expect(summary.option.kind).toBe('single-session');
    expect(summary.session).toBeDefined();
    expect(summary.selectionLines).toEqual([
      `${summary.session!.dayLabel} · ${summary.session!.timeLabel}`,
    ]);
    expect(summary.priceLines).toEqual([{ label: '1 session', value: 'AED 85' }]);
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 85 per session');
  });

  test('recurring: cadence-labelled enrolment with schedule and start lines', () => {
    const summary = summaryFor('junior-swim-squad', 'adam')!;
    expect(summary.option.kind).toBe('recurring');
    expect(summary.session).toBeUndefined();
    expect(summary.selectionLines[0]).toBe('Sat & Sun · 10:00 AM');
    expect(summary.selectionLines[1]).toMatch(/^Starts with the next session — /);
    expect(summary.priceLines).toEqual([
      { label: 'Monthly enrolment', value: 'AED 380 per month' },
    ]);
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 380 per month');
  });

  test('term: term-cadence enrolment', () => {
    const summary = summaryFor('junior-karate', 'adam')!;
    expect(summary.option.kind).toBe('term');
    expect(summary.priceLines).toEqual([{ label: 'Term enrolment', value: 'AED 1,800 per term' }]);
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 1,800 per term');
  });

  test('camp: selected week range with daily time and per-week price', () => {
    const summary = summaryFor('holiday-swim-camp', 'adam')!;
    expect(summary.option.kind).toBe('camp-week');
    expect(summary.selectionLines).toEqual(['Week of 17–21 Aug · 9 AM–12 PM']);
    expect(summary.priceLines).toEqual([
      { label: '1 week · Week of 17–21 Aug', value: 'AED 850 per week' },
    ]);
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 850 per week');
  });

  test('package: size and price only — no expiry, redemption, or scheduling claims', () => {
    const summary = summaryFor('adult-swim-technique', 'me')!;
    expect(summary.option.kind).toBe('package');
    expect(summary.selectionLines).toEqual(['Tue & Thu · 8:00 PM']);
    expect(summary.priceLines).toEqual([{ label: 'Package of 6 sessions', value: 'AED 480' }]);
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 480');
    for (const text of [...summary.selectionLines, ...summary.priceLines.map((l) => l.label)]) {
      expect(text).not.toMatch(/expir|redeem|valid for/i);
    }
  });

  test('free activity: Free everywhere, never AED 0', () => {
    const summary = summaryFor('community-park-football', 'me')!;
    expect(summary.option.kind).toBe('free-session');
    expect(summary.priceLines).toEqual([{ label: 'Free activity', value: 'Free' }]);
    expect(summary.bookingPriceLabel).toBe('Booking price · Free');
    expect(JSON.stringify(summary.priceLines)).not.toContain('AED 0');
  });

  test('free trial: dated trial session priced Free', () => {
    const summary = summaryFor('ladies-strength', 'me')!;
    expect(summary.option.kind).toBe('trial');
    expect(summary.session).toBeDefined();
    expect(summary.priceLines).toEqual([{ label: 'Free trial session', value: 'Free' }]);
    expect(summary.bookingPriceLabel).toBe('Booking price · Free');
  });

  test('paid trial: structured trial amount, never the full-plan price', () => {
    const summary = summaryFor('junior-football-u10', 'adam')!;
    expect(summary.option.kind).toBe('trial');
    expect(summary.priceLines).toEqual([{ label: 'Trial session', value: 'AED 35' }]);
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 35');
  });

  test('trial program, full-plan option: summarized as its own enrolment', () => {
    const summary = summaryFor('ladies-strength', 'me', 1)!;
    expect(summary.option.kind).toBe('recurring');
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 450 per month');
  });

  test('discount offer is an informational line; the catalogue price is unchanged', () => {
    const summary = summaryFor('reformer-pilates', 'me')!;
    expect(summary.offerLine).toBe('20% off first month');
    expect(summary.bookingPriceLabel).toBe('Booking price · AED 650 per month');
    // No discounted arithmetic anywhere: 20% off 650 must not appear.
    expect(JSON.stringify(summary.priceLines)).not.toContain('520');
  });

  test('trial offers are options, not offer lines', () => {
    expect(summaryFor('ladies-strength', 'me')!.offerLine).toBeUndefined();
    expect(summaryFor('junior-football-u10', 'adam')!.offerLine).toBeUndefined();
  });

  test('participant eligibility is re-asserted and carried into the summary', () => {
    const summary = summaryFor('junior-swim-squad', 'adam')!;
    expect(summary.participant).toMatchObject({ participantId: 'adam', suitable: true });
  });

  test('branch and policy joins resolve', () => {
    const summary = summaryFor('junior-swim-squad', 'adam')!;
    expect(summary.branch?.label).toBeDefined();
    expect(summary.policy.summaryLines.length).toBeGreaterThan(0);
    expect(summaryFor('beginner-calisthenics', 'me')!.policy.id).toBeDefined();
  });

  test('every bookable program yields an honest summary for an eligible participant', () => {
    for (const program of programs) {
      const page = service.buildBookingOptions(input({ programId: program.id }))!;
      if (page.availability.status !== 'bookable') continue;
      const eligible = page.householdEligibility.find((entry) => entry.suitable);
      if (eligible === undefined) continue;
      page.options.forEach((_, index) => {
        const summary = summaryFor(program.id, eligible.participantId, index);
        expect(summary).toBeDefined();
        // Owner wording rules (docs/09 §21.10–§21.11): always Booking price,
        // never Total, VAT, fees, holds, or charged-today language.
        expect(summary!.bookingPriceLabel).toMatch(/^Booking price · /);
        const text = JSON.stringify([
          summary!.selectionLines,
          summary!.priceLines,
          summary!.bookingPriceLabel,
          summary!.offerLine ?? '',
        ]);
        expect(text).not.toMatch(/total|vat|\bfees?\b|reserv|\bhold\b|charged/i);
      });
    }
  });
});

describe('Summary invalid-draft rejection (docs/21 §11)', () => {
  test('missing option', () => {
    expect(summaryFor('beginner-calisthenics', 'me', 0, { optionId: undefined })).toBeUndefined();
  });

  test('unknown option', () => {
    expect(summaryFor('beginner-calisthenics', 'me', 0, { optionId: 'ghost' })).toBeUndefined();
  });

  test('missing required session', () => {
    expect(summaryFor('beginner-calisthenics', 'me', 0, { sessionId: undefined })).toBeUndefined();
    expect(summaryFor('beginner-calisthenics', 'me', 0, { sessionId: 'ghost' })).toBeUndefined();
  });

  test('full session', () => {
    const page = pageFor('morning-yoga');
    const full = page.options[0].sessions.find((session) => session.availability === 'full')!;
    expect(summaryFor('morning-yoga', 'me', 0, { sessionId: full.id })).toBeUndefined();
  });

  test('missing participant', () => {
    expect(summaryFor('beginner-calisthenics', 'me', 0, { participantId: undefined })).toBeUndefined();
  });

  test('unknown or ineligible participant', () => {
    expect(summaryFor('beginner-calisthenics', 'ghost')).toBeUndefined();
    // Adults-only program with a child participant.
    expect(summaryFor('beginner-calisthenics', 'adam')).toBeUndefined();
    // Child program with the adult.
    expect(summaryFor('junior-swim-squad', 'me')).toBeUndefined();
  });

  test('draft pointing at another program never resolves', () => {
    const foreign = draftFor('beginner-calisthenics', 'me');
    expect(
      service.buildBookingSummary({
        draft: { ...foreign, programId: 'junior-swim-squad' },
        participants: household,
        areaId: 'khalifa-city',
      }),
    ).toBeUndefined();
  });

  test('unknown program id', () => {
    expect(
      service.buildBookingSummary({
        draft: { programId: 'does-not-exist', optionId: 'x', participantId: 'me' },
        participants: household,
        areaId: 'khalifa-city',
      }),
    ).toBeUndefined();
  });

  test('non-bookable programs reject every draft', () => {
    for (const programId of ['teen-arabic-summer', 'sunrise-breathwork']) {
      expect(
        service.buildBookingSummary({
          draft: { programId, optionId: `${programId}-x`, participantId: 'me' },
          participants: household,
          areaId: 'khalifa-city',
        }),
      ).toBeUndefined();
    }
  });

  test('guest household rejects every draft', async () => {
    const draft = draftFor('beginner-calisthenics', 'me');
    expect(
      service.buildBookingSummary({ draft, participants: [], areaId: 'khalifa-city' }),
    ).toBeUndefined();
    // The async boundary behaves identically (screens call this one).
    await expect(
      service.getBookingSummary({ draft, participants: [], areaId: 'khalifa-city' }),
    ).resolves.toBeUndefined();
  });

  test('summary simulateFailure rejects with the QA-only error', async () => {
    await expect(
      service.getBookingSummary({
        draft: draftFor('beginner-calisthenics', 'me'),
        participants: household,
        areaId: 'khalifa-city',
        simulateFailure: true,
      }),
    ).rejects.toThrow('Simulated network failure (QA only)');
  });
});
