import { participants as catalogueParticipants } from '@/data/mock/catalogue';
import {
  toHomeFeedBuildInput,
  type HomeFeedBuildInput,
  type HomeSection,
} from '@/services/contracts/home-feed';
import type { ScheduleEntry } from '@/services/contracts/schedule';
import { buildHomeFeed } from '@/services/mock/mock-home-feed-service';
import { resolveAccountScenario } from '@/services/mock/mock-schedule-service';
import { suitsAdult, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';
import type { Participant } from '@/types/domain';

const me = catalogueParticipants.find((p) => p.id === 'me') as Participant;
const adam = catalogueParticipants.find((p) => p.id === 'adam') as Participant;
const lina = catalogueParticipants.find((p) => p.id === 'lina') as Participant;

/**
 * Every test here calls the pure builder directly with a hand-built
 * HomeFeedBuildInput — never through scenario ids (docs/19 §7). The fixture
 * resolver is exercised separately at the end through the same single path.
 */
const input = (overrides: Partial<HomeFeedBuildInput>): HomeFeedBuildInput => ({
  areaId: 'khalifa-city',
  account: { primaryParticipantId: 'me' },
  participants: [me],
  scheduleEntries: [],
  activePlans: [],
  credit: { availableCredit: 65 },
  ...overrides,
});

const entry = (overrides: Partial<ScheduleEntry>): ScheduleEntry => ({
  id: 'entry',
  programId: 'reformer-pilates',
  dayOffset: 1,
  dayLabel: 'Mon 3',
  timeLabel: '6:30 PM',
  participantId: 'me',
  participantLabel: 'You',
  programTitle: 'Reformer Pilates Foundations',
  providerName: 'Core Pilates House',
  areaLabel: 'Al Reem Island',
  imageKey: 'yogaPose',
  ...overrides,
});

const plan = {
  id: 'plan',
  programId: 'reformer-pilates',
  participantId: 'me',
  participantLabel: 'You',
  kind: 'package' as const,
  programTitle: 'Reformer Pilates Foundations',
  providerName: 'Core Pilates House',
  progressLabel: '6 of 10 sessions left',
  nextSessionLabel: 'Mon, 6:30 PM',
};

const kinds = (sections: HomeSection[]) => sections.map((section) => section.kind);
const programSections = (sections: HomeSection[]) =>
  sections.filter((section): section is Extract<HomeSection, { kind: 'programs' }> => section.kind === 'programs');
const programIds = (sections: HomeSection[]) => programSections(sections).map((section) => section.id);

const CHILD_SECTION = /^(for|camps|after-school)-/;

describe('buildHomeFeed — household input (docs/18 §4 order)', () => {
  const household = input({
    participants: [me, adam, lina],
    scheduleEntries: [entry({ id: 'e1', dayOffset: 0, dayLabel: 'Today' }), entry({ id: 'e2' })],
    activePlans: [plan],
  });

  test('section kinds follow the approved hierarchy', () => {
    const feed = buildHomeFeed(household);
    const observed = kinds(feed.sections);
    expect(observed[0]).toBe('upcoming');
    expect(observed[1]).toBe('week');
    expect(observed[2]).toBe('plans');
    expect(observed[observed.length - 1]).toBe('credit');
    expect(observed).not.toContain('welcome');
    expect(observed).not.toContain('action');
  });

  test('participant rails generate from the participant array, primary first', () => {
    const ids = programIds(buildHomeFeed(household).sections);
    expect(ids).toEqual([
      'based-on-interests',
      'for-adam',
      'camps-adam',
      'for-lina',
      'camps-lina',
      'available-today',
      'offers',
    ]);
  });

  test('titles are generated, never hard-coded to demo names in logic', () => {
    const sections = programSections(buildHomeFeed(household).sections);
    expect(sections.find((s) => s.id === 'for-adam')?.title).toBe('For Adam');
    expect(sections.find((s) => s.id === 'camps-lina')?.title).toBe('Camps for Lina');
    expect(sections.find((s) => s.id === 'based-on-interests')?.title).toBe(
      'Based on your interests',
    );
  });

  test('child rails contain only age-eligible programs', () => {
    const sections = programSections(buildHomeFeed(household).sections);
    for (const section of sections) {
      if (section.id.endsWith('-adam')) {
        for (const program of section.programs) {
          expect(suitsChild(program.eligibility, 8)).toBe(true);
        }
      }
      if (section.id.endsWith('-lina')) {
        for (const program of section.programs) {
          expect(suitsChild(program.eligibility, 12)).toBe(true);
        }
      }
    }
  });

  test('supplemental camp rails hold at least two camps', () => {
    const sections = programSections(buildHomeFeed(household).sections);
    for (const id of ['camps-adam', 'camps-lina']) {
      const rail = sections.find((s) => s.id === id);
      expect(rail?.programs.length).toBeGreaterThanOrEqual(2);
      for (const program of rail?.programs ?? []) {
        expect(program.isCamp).toBe(true);
      }
    }
  });

  test('popular-near yields once real schedule content exists', () => {
    expect(programIds(buildHomeFeed(household).sections)).not.toContain('popular-near');
  });

  test('available today is scoped to household eligibility and time-led', () => {
    const section = programSections(buildHomeFeed(household).sections).find(
      (s) => s.id === 'available-today',
    );
    expect(section?.title).toBe('Available today for you');
    expect(section?.programs.length).toBeGreaterThan(0);
    for (const program of section?.programs ?? []) {
      expect(program.availableToday).toBe(true);
      const eligible =
        suitsAdult(program.eligibility) ||
        suitsChild(program.eligibility, 8) ||
        suitsChild(program.eligibility, 12);
      expect(eligible).toBe(true);
    }
  });

  test('offers stay small and personalized', () => {
    const section = programSections(buildHomeFeed(household).sections).find(
      (s) => s.id === 'offers',
    );
    expect(section?.title).toBe('Offers for you');
    expect(section?.programs.length).toBeLessThanOrEqual(3);
    for (const program of section?.programs ?? []) {
      expect(program.offer).toBeDefined();
    }
  });

  test('week strip lists only days inside the 7-day window with entries', () => {
    const feed = buildHomeFeed(
      input({
        participants: [me],
        scheduleEntries: [
          entry({ id: 'a', dayOffset: 0, dayLabel: 'Today' }),
          entry({ id: 'b', dayOffset: 3, dayLabel: 'Wed 5' }),
          entry({ id: 'c', dayOffset: 8, dayLabel: 'Mon 10' }),
        ],
      }),
    );
    const week = feed.sections.find((s) => s.kind === 'week');
    expect(week?.kind).toBe('week');
    if (week?.kind === 'week') {
      expect(week.days.map((day) => day.dayOffset)).toEqual([0, 3]);
      expect(week.days.every((day) => day.entries.length > 0)).toBe(true);
    }
    // The out-of-window entry still counts as real schedule content.
    expect(programIds(feed.sections)).not.toContain('popular-near');
  });

  test('deterministic: identical inputs give identical output', () => {
    expect(buildHomeFeed(household)).toEqual(buildHomeFeed(household));
  });
});

describe('buildHomeFeed — dynamic participants, arbitrary names (docs/18 §3)', () => {
  const lena: Participant = { id: 'lena', label: 'Lena', kind: 'child', dateOfBirth: '2016-04-10' };
  const omar: Participant = { id: 'omar', label: 'Omar', kind: 'child', dateOfBirth: '2014-01-15' };

  test('one synthetic child generates her rail from the array', () => {
    const ids = programIds(buildHomeFeed(input({ participants: [me, lena] })).sections);
    expect(ids).toContain('for-lena');
    const section = programSections(buildHomeFeed(input({ participants: [me, lena] })).sections).find(
      (s) => s.id === 'for-lena',
    );
    expect(section?.title).toBe('For Lena');
  });

  test('camp-eligible synthetic child gets a generated camps rail', () => {
    const sections = programSections(buildHomeFeed(input({ participants: [me, omar] })).sections);
    const camps = sections.find((s) => s.id === 'camps-omar');
    expect(camps?.title).toBe('Camps for Omar');
    expect(camps?.programs.length).toBeGreaterThanOrEqual(2);
    for (const program of camps?.programs ?? []) {
      expect(program.isCamp).toBe(true);
      expect(suitsChild(program.eligibility, 12)).toBe(true);
    }
  });

  test('multiple children produce one rail each, in account order', () => {
    const ids = programIds(buildHomeFeed(input({ participants: [me, lena, omar] })).sections);
    expect(ids.indexOf('for-lena')).toBeGreaterThan(ids.indexOf('based-on-interests'));
    expect(ids.indexOf('for-omar')).toBeGreaterThan(ids.indexOf('for-lena'));
  });

  test('removing the last child removes every child-focused section', () => {
    const withChild = programIds(buildHomeFeed(input({ participants: [me, lena] })).sections);
    expect(withChild.some((id) => CHILD_SECTION.test(id))).toBe(true);
    const without = programIds(buildHomeFeed(input({ participants: [me] })).sections);
    expect(without.some((id) => CHILD_SECTION.test(id))).toBe(false);
  });

  test('a child with almost no age-eligible supply gets no supplemental rail', () => {
    // Age 3: no camp or after-school program covers this age; only all-ages
    // community programs remain, so the base rail may render but nothing else.
    const toddler: Participant = {
      id: 'zayed',
      label: 'Zayed',
      kind: 'child',
      dateOfBirth: '2023-05-01',
    };
    const sections = programSections(buildHomeFeed(input({ participants: [me, toddler] })).sections);
    expect(sections.some((s) => s.id === 'camps-zayed')).toBe(false);
    expect(sections.some((s) => s.id === 'after-school-zayed')).toBe(false);
    const base = sections.find((s) => s.id === 'for-zayed');
    for (const program of base?.programs ?? []) {
      expect(suitsChild(program.eligibility, 3)).toBe(true);
    }
  });

  test('a teen with a single eligible camp gets no camps rail (threshold is 2)', () => {
    // Age 17: only Teen Arabic Summer Intensive (12–17) fits; Holiday Swim
    // (6–14), Active Summer (6–12), and Teen Coding (12–16) do not.
    const teen: Participant = { id: 'noura', label: 'Noura', kind: 'child', dateOfBirth: '2009-03-20' };
    const sections = programSections(buildHomeFeed(input({ participants: [me, teen] })).sections);
    expect(sections.some((s) => s.id === 'camps-noura')).toBe(false);
  });
});

describe('buildHomeFeed — zero-child signed-in accounts (docs/18 §6, §9 B/C)', () => {
  test('no bookings: discovery-aid sections, no schedule sections, no child content, no prompts', () => {
    const feed = buildHomeFeed(input({ participants: [me] }));
    const observed = kinds(feed.sections);
    expect(observed).not.toContain('upcoming');
    expect(observed).not.toContain('week');
    expect(observed).not.toContain('plans');
    expect(observed).not.toContain('action');
    expect(observed).not.toContain('welcome');
    expect(observed[observed.length - 1]).toBe('credit');

    const ids = programIds(feed.sections);
    expect(ids).toEqual(['based-on-interests', 'popular-near', 'available-today', 'offers']);

    // No child-focused content anywhere: every program is adult-suitable,
    // which structurally excludes camps/after-school junior programs.
    for (const section of programSections(feed.sections)) {
      for (const program of section.programs) {
        expect(suitsAdult(program.eligibility)).toBe(true);
      }
    }
  });

  test('with bookings and a plan: schedule sections lead, popular-near yields, still no child content', () => {
    const feed = buildHomeFeed(
      input({
        participants: [me],
        scheduleEntries: [entry({ id: 'e1', dayOffset: 0, dayLabel: 'Today' })],
        activePlans: [plan],
      }),
    );
    const observed = kinds(feed.sections);
    expect(observed.slice(0, 3)).toEqual(['upcoming', 'week', 'plans']);
    const ids = programIds(feed.sections);
    expect(ids).toEqual(['based-on-interests', 'available-today', 'offers']);
    expect(observed).not.toContain('action');
    expect(ids.some((id) => CHILD_SECTION.test(id))).toBe(false);
  });

  test('interest rail keeps discovery diversity (docs/05 §9.4)', () => {
    const feed = buildHomeFeed(input({ participants: [me] }));
    const rail = programSections(feed.sections).find((s) => s.id === 'based-on-interests');
    const interests = new Set(me.interests ?? []);
    const matches = rail?.programs.filter((p) => interests.has(p.activityTypeId)) ?? [];
    const others = rail?.programs.filter((p) => !interests.has(p.activityTypeId)) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
  });

  test('a primary participant without declared interests gets a neutral label', () => {
    const primary: Participant = { id: 'me', label: 'Me', kind: 'self' };
    const rail = programSections(buildHomeFeed(input({ participants: [primary] })).sections).find(
      (s) => s.id === 'based-on-interests',
    );
    expect(rail?.title).toBe('For you');
  });
});

describe('buildHomeFeed — guest (docs/18 §9 A)', () => {
  const guest = input({ account: null, participants: [], credit: undefined });

  test('welcome leads, setup action closes, nothing fabricated', () => {
    const feed = buildHomeFeed(guest);
    const observed = kinds(feed.sections);
    expect(observed[0]).toBe('welcome');
    expect(observed[observed.length - 1]).toBe('action');
    expect(observed).not.toContain('upcoming');
    expect(observed).not.toContain('week');
    expect(observed).not.toContain('plans');
    expect(observed).not.toContain('credit');

    const action = feed.sections.find((s) => s.kind === 'action');
    expect(action?.kind === 'action' && action.id).toBe('setup');
  });

  test('marketplace sections are area-scoped, not personalized', () => {
    const sections = programSections(buildHomeFeed(guest).sections);
    expect(sections.map((s) => s.id)).toEqual(['popular-near', 'available-today', 'offers']);
    expect(sections.find((s) => s.id === 'popular-near')?.title).toBe('Popular near Khalifa City');
    expect(sections.find((s) => s.id === 'available-today')?.title).toBe('Available today');
    expect(sections.find((s) => s.id === 'offers')?.title).toBe('Offers');
  });
});

describe('buildHomeFeed — fixture resolver feeds the same single path (docs/19 §3)', () => {
  test('household fixture: demo schedule renders as specified', () => {
    const resolved = resolveAccountScenario('household');
    const feed = buildHomeFeed(toHomeFeedBuildInput(resolved, 'khalifa-city'));

    const upcoming = feed.sections.find((s) => s.kind === 'upcoming');
    expect(upcoming?.kind === 'upcoming' && upcoming.entry.programId).toBe('junior-swim-squad');
    expect(upcoming?.kind === 'upcoming' && upcoming.entry.dayLabel).toBe('Today');
    expect(upcoming?.kind === 'upcoming' && upcoming.entry.participantLabel).toBe('Adam');

    const week = feed.sections.find((s) => s.kind === 'week');
    // Adam Sun+Sat, Sarah Mon+Wed; Lina's camp runs next week (offsets 8–12).
    expect(week?.kind === 'week' && week.days.map((d) => d.dayOffset)).toEqual([0, 1, 3, 6]);

    const plans = feed.sections.find((s) => s.kind === 'plans');
    expect(plans?.kind === 'plans' && plans.plans[0]?.progressLabel).toBe('6 of 10 sessions left');
  });

  test('me-only fixture matches the hand-built zero-child shape', () => {
    const resolved = resolveAccountScenario('me-only');
    const feed = buildHomeFeed(toHomeFeedBuildInput(resolved, 'khalifa-city'));
    expect(programIds(feed.sections)).toEqual([
      'based-on-interests',
      'popular-near',
      'available-today',
      'offers',
    ]);
    expect(kinds(feed.sections)).not.toContain('action');
  });

  test('guest fixture produces the guest shape', () => {
    const resolved = resolveAccountScenario('guest');
    const feed = buildHomeFeed(toHomeFeedBuildInput(resolved, 'khalifa-city'));
    expect(kinds(feed.sections)[0]).toBe('welcome');
    expect(kinds(feed.sections)).not.toContain('credit');
  });
});
