import type { AccountScenarioId, AccountSnapshot } from '@/services/contracts/schedule';

/**
 * Deterministic demo bookings, active plans, and account scenarios —
 * docs/18 §10, docs/19 §4. Every booking references an existing catalogue
 * program and stays consistent with that program's schedule label. All day
 * offsets are relative to MOCK_TODAY (Sunday 2026-08-02) — never the device
 * clock. These exist only for Home (and future Bookings) demonstration; no
 * booking, payment, or capacity logic.
 */

export interface BookingFixture {
  id: string;
  programId: string;
  participantId: string;
  /** Days after MOCK_TODAY; 0 = today. */
  dayOffset: number;
  timeLabel: string;
}

export interface PlanFixture {
  id: string;
  programId: string;
  participantId: string;
  kind: 'package' | 'membership' | 'recurring';
  sessionsRemaining: number;
  sessionsTotal: number;
  nextDayOffset: number;
  nextTimeLabel: string;
}

export const bookingFixtures: BookingFixture[] = [
  // Adam — Junior Swim Squad, 'Sat & Sun · 10:00 AM'. The Sunday session is
  // today: the household's Upcoming activity (docs/19 §4).
  { id: 'adam-swim-sun', programId: 'junior-swim-squad', participantId: 'adam', dayOffset: 0, timeLabel: '10:00 AM' },
  { id: 'adam-swim-sat', programId: 'junior-swim-squad', participantId: 'adam', dayOffset: 6, timeLabel: '10:00 AM' },
  // Sarah — Reformer Pilates Foundations, 'Mon & Wed · 6:30 PM'.
  { id: 'sarah-pilates-mon', programId: 'reformer-pilates', participantId: 'me', dayOffset: 1, timeLabel: '6:30 PM' },
  { id: 'sarah-pilates-wed', programId: 'reformer-pilates', participantId: 'me', dayOffset: 3, timeLabel: '6:30 PM' },
  // Lina — Teen Coding Summer Camp, '10–14 August · 9 AM–1 PM'. The camp runs
  // Mon–Fri NEXT week (offsets 8–12), so it never appears in the 7-day strip —
  // the data says so, honestly, rather than fabricating this-week sessions.
  ...[8, 9, 10, 11, 12].map((dayOffset) => ({
    id: `lina-coding-day-${dayOffset}`,
    programId: 'teen-coding-camp',
    participantId: 'lina',
    dayOffset,
    timeLabel: '9:00 AM',
  })),
];

export const planFixtures: PlanFixture[] = [
  // Sarah's active package — drives "Continue your routine" (docs/18 §4.5).
  {
    id: 'sarah-reformer-package',
    programId: 'reformer-pilates',
    participantId: 'me',
    kind: 'package',
    sessionsRemaining: 6,
    sessionsTotal: 10,
    nextDayOffset: 1,
    nextTimeLabel: '6:30 PM',
  },
];

/**
 * Account scenarios — docs/18 §9 A–D. Fixture selection only: each id maps to
 * deterministic demo data that resolves into a HomeFeedBuildInput. No screen,
 * service, or builder branches on these ids (docs/19 §3).
 */
export interface AccountScenarioFixture {
  account: AccountSnapshot | null;
  /** Catalogue participant ids, primary first. Never includes 'everyone'. */
  participantIds: string[];
  bookingIds: string[];
  planIds: string[];
  creditAmount?: number;
}

export const accountScenarios: Record<AccountScenarioId, AccountScenarioFixture> = {
  guest: { account: null, participantIds: [], bookingIds: [], planIds: [] },
  'me-only': {
    account: { primaryParticipantId: 'me' },
    participantIds: ['me'],
    bookingIds: [],
    planIds: [],
    creditAmount: 65,
  },
  'me-active': {
    account: { primaryParticipantId: 'me' },
    participantIds: ['me'],
    bookingIds: ['sarah-pilates-mon', 'sarah-pilates-wed'],
    planIds: ['sarah-reformer-package'],
    creditAmount: 65,
  },
  household: {
    account: { primaryParticipantId: 'me' },
    participantIds: ['me', 'adam', 'lina'],
    bookingIds: bookingFixtures.map((booking) => booking.id),
    planIds: planFixtures.map((plan) => plan.id),
    creditAmount: 65,
  },
};

export const DEFAULT_ACCOUNT_SCENARIO: AccountScenarioId = 'household';

export function isAccountScenarioId(value: string): value is AccountScenarioId {
  return value in accountScenarios;
}
