import { accountScenarios, bookingFixtures, planFixtures } from '@/data/mock/schedule';
import { activityTypes, collections, participants, programs } from '@/data/mock/catalogue';
import { dayLabelForOffset, resolveAccountScenario } from '@/services/mock/mock-schedule-service';
import { describe, expect, test } from '@jest/globals';

const programById = new Map(programs.map((program) => [program.id, program]));
const participantIds = new Set(participants.map((participant) => participant.id));
const activityTypeIds = new Set(activityTypes.map((activityType) => activityType.id));

/** Weekday index for a day offset from MOCK_TODAY (2026-08-02, a Sunday). */
const weekdayOf = (offset: number) => offset % 7; // 0 = Sunday … 6 = Saturday

describe('Schedule fixtures — data invariants (docs/19 §4)', () => {
  test('every booking references an existing catalogue program and participant', () => {
    for (const booking of bookingFixtures) {
      expect(programById.has(booking.programId)).toBe(true);
      expect(participantIds.has(booking.participantId)).toBe(true);
    }
  });

  test('every plan references an existing catalogue program and participant', () => {
    for (const plan of planFixtures) {
      expect(programById.has(plan.programId)).toBe(true);
      expect(participantIds.has(plan.participantId)).toBe(true);
    }
  });

  test('day offsets are small non-negative integers pinned to MOCK_TODAY', () => {
    for (const booking of bookingFixtures) {
      expect(Number.isInteger(booking.dayOffset)).toBe(true);
      expect(booking.dayOffset).toBeGreaterThanOrEqual(0);
      expect(booking.dayOffset).toBeLessThanOrEqual(13);
    }
  });

  test('booked days stay consistent with each program catalogue schedule label', () => {
    for (const booking of bookingFixtures) {
      const weekday = weekdayOf(booking.dayOffset);
      switch (booking.programId) {
        case 'junior-swim-squad': // 'Sat & Sun · 10:00 AM'
          expect([0, 6]).toContain(weekday);
          expect(booking.timeLabel).toBe('10:00 AM');
          break;
        case 'reformer-pilates': // 'Mon & Wed · 6:30 PM'
          expect([1, 3]).toContain(weekday);
          expect(booking.timeLabel).toBe('6:30 PM');
          break;
        case 'teen-coding-camp': // '10–14 August · 9 AM–1 PM' → offsets 8–12
          expect(booking.dayOffset).toBeGreaterThanOrEqual(8);
          expect(booking.dayOffset).toBeLessThanOrEqual(12);
          break;
        default:
          throw new Error(`Unexpected booking program ${booking.programId}`);
      }
    }
  });
});

describe('Catalogue — child-focused collection classification (docs/18 §6)', () => {
  test('camps, after-school, and kids-teens are child-focused; adult/general are not', () => {
    const byId = new Map(collections.map((collection) => [collection.id, collection]));
    expect(byId.get('camps')?.childFocused).toBe(true);
    expect(byId.get('after-school')?.childFocused).toBe(true);
    expect(byId.get('kids-teens')?.childFocused).toBe(true);
    expect(byId.get('ladies-only')?.childFocused).toBe(false);
    expect(byId.get('beat-the-heat')?.childFocused).toBe(false);
    expect(byId.get('try-something-new')?.childFocused).toBe(false);
  });
});

describe('Catalogue — declared interests (docs/09 §18.3)', () => {
  test('demo participants carry declared interests referencing real activity types', () => {
    for (const id of ['me', 'adam', 'lina']) {
      const participant = participants.find((p) => p.id === id);
      expect(participant?.interests?.length).toBeGreaterThan(0);
      for (const interest of participant?.interests ?? []) {
        expect(activityTypeIds.has(interest)).toBe(true);
      }
    }
  });
});

describe('resolveAccountScenario — fixture resolution (docs/19 §3 data flow)', () => {
  test('household resolves three participants, primary first', () => {
    const resolved = resolveAccountScenario('household');
    expect(resolved.account).toEqual({ primaryParticipantId: 'me' });
    expect(resolved.participants.map((p) => p.id)).toEqual(['me', 'adam', 'lina']);
    expect(resolved.childParticipants.map((p) => p.id)).toEqual(['adam', 'lina']);
    expect(resolved.credit).toEqual({ availableCredit: 65 });
  });

  test('household schedule entries are enriched, sorted, and pinned to MOCK_TODAY', () => {
    const resolved = resolveAccountScenario('household');
    const [first] = resolved.scheduleEntries;
    // Upcoming activity: Adam's Junior Swim Squad, today at 10:00 AM.
    expect(first.programId).toBe('junior-swim-squad');
    expect(first.dayLabel).toBe('Today');
    expect(first.timeLabel).toBe('10:00 AM');
    expect(first.participantLabel).toBe('Adam');
    expect(first.providerName).toBe('Blue Wave Swimming');
    expect(first.areaLabel).toBe('Al Raha');

    const offsets = resolved.scheduleEntries.map((entry) => entry.dayOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  test('primary participant entries are labelled "You", never an internal name', () => {
    const resolved = resolveAccountScenario('me-active');
    expect(resolved.scheduleEntries.length).toBeGreaterThan(0);
    for (const entry of resolved.scheduleEntries) {
      expect(entry.participantLabel).toBe('You');
    }
  });

  test('active plan carries progress and next-session labels', () => {
    const resolved = resolveAccountScenario('me-active');
    expect(resolved.activePlans).toHaveLength(1);
    const [plan] = resolved.activePlans;
    expect(plan.programTitle).toBe('Reformer Pilates Foundations');
    expect(plan.progressLabel).toBe('6 of 10 sessions left');
    expect(plan.nextSessionLabel).toBe('Mon, 6:30 PM');
    expect(plan.participantLabel).toBe('You');
  });

  test('me-only resolves a signed-in account with no bookings and no plans', () => {
    const resolved = resolveAccountScenario('me-only');
    expect(resolved.account).toEqual({ primaryParticipantId: 'me' });
    expect(resolved.participants.map((p) => p.id)).toEqual(['me']);
    expect(resolved.childParticipants).toEqual([]);
    expect(resolved.scheduleEntries).toEqual([]);
    expect(resolved.activePlans).toEqual([]);
    expect(resolved.credit).toEqual({ availableCredit: 65 });
  });

  test('guest resolves a null account with nothing fabricated', () => {
    const resolved = resolveAccountScenario('guest');
    expect(resolved.account).toBeNull();
    expect(resolved.participants).toEqual([]);
    expect(resolved.childParticipants).toEqual([]);
    expect(resolved.scheduleEntries).toEqual([]);
    expect(resolved.activePlans).toEqual([]);
    expect(resolved.credit).toBeUndefined();
  });

  test('resolution is deterministic', () => {
    expect(resolveAccountScenario('household')).toEqual(resolveAccountScenario('household'));
  });

  test('every scenario id has a fixture', () => {
    expect(Object.keys(accountScenarios).sort()).toEqual([
      'guest',
      'household',
      'me-active',
      'me-only',
    ]);
  });
});

describe('dayLabelForOffset — labels derive from MOCK_TODAY, never the device clock', () => {
  test('labels for the demo week', () => {
    expect(dayLabelForOffset(0)).toBe('Today');
    expect(dayLabelForOffset(1)).toBe('Mon 3');
    expect(dayLabelForOffset(3)).toBe('Wed 5');
    expect(dayLabelForOffset(6)).toBe('Sat 8');
    expect(dayLabelForOffset(8)).toBe('Mon 10');
  });
});
