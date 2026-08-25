import type { FixtureProgram } from '@/data/mock/catalogue';
import { areas, programs } from '@/data/mock/catalogue';
import type {
  HeroContent,
  HomeFeed,
  HomeFeedBuildInput,
  HomeFeedService,
  HomeSection,
  WeekDay,
} from '@/services/contracts/home-feed';
import type { ScheduleEntry } from '@/services/contracts/schedule';
import { weekEntries } from '@/services/mock/mock-schedule-service';
import type { Area, AreaId, Participant } from '@/types/domain';
import { participantAge, suitsAdult, suitsChild } from '@/utils/eligibility';

/**
 * Home feed assembly — docs/18 §4–§5, docs/19 §5. Pure and synchronous so
 * behavior is directly testable. Every condition reads the resolved input
 * data (null account, empty schedule, participant array) — never a scenario
 * id, participant name, or fixed household shape.
 */

const CAPS = { interests: 5, childRail: 5, supplemental: 4, popular: 4, today: 4, offers: 3 } as const;

/** Guest welcome card — the approved seasonal hero copy, reused (docs/18 §9 A). */
const guestWelcome: HeroContent = {
  eyebrow: 'August in Abu Dhabi',
  title: 'Indoor this August',
  subtitle: 'Cool indoor picks for you and the family — pools, courts and camps.',
  actionLabel: 'Explore summer picks',
  imageKey: 'swimRace',
};

const stableIndex = new Map(programs.map((program, index) => [program.id, index]));
const stable = (program: FixtureProgram) => stableIndex.get(program.id) ?? 0;

function areaRank(areaId: AreaId, reference: Area): number {
  if (areaId === reference.id) return 0;
  const nearbyIndex = reference.nearby.indexOf(areaId);
  return nearbyIndex === -1 ? reference.nearby.length + 1 : nearbyIndex + 1;
}

/** Minutes since midnight for "7:30 PM"; non-clock labels sort last. */
function todayTimeMinutes(program: FixtureProgram): number {
  const match = program.todayTime?.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = (Number(match[1]) % 12) + (match[3] === 'PM' ? 12 : 0);
  return hours * 60 + Number(match[2]);
}

function entryTimeMinutes(entry: ScheduleEntry): number {
  const match = entry.timeLabel.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = (Number(match[1]) % 12) + (match[3] === 'PM' ? 12 : 0);
  return hours * 60 + Number(match[2]);
}

/** FixtureProvider-defined eligibility for one account participant (docs/05 §7). */
function eligibleFor(program: FixtureProgram, participant: Participant): boolean {
  if (participant.kind === 'child') {
    return suitsChild(program.eligibility, participantAge(participant) ?? 0);
  }
  return suitsAdult(program.eligibility);
}

/** Eligibility across the whole account; a guest (no participants) is open. */
function eligibleForAccount(program: FixtureProgram, participants: Participant[]): boolean {
  if (participants.length === 0) return true;
  return participants.some((participant) => eligibleFor(program, participant));
}

const byRating = (a: FixtureProgram, b: FixtureProgram) => b.rating - a.rating || stable(a) - stable(b);

/**
 * Declared-interest ranking with discovery diversity — docs/05 §9: interest
 * matches lead, but the rail always keeps room for one popular non-match so
 * recommendations never collapse to exact interest matches only.
 */
function interestRanked(pool: FixtureProgram[], interests: string[], cap: number): FixtureProgram[] {
  const interestSet = new Set(interests);
  const matches = pool.filter((p) => interestSet.has(p.activityTypeId)).sort(byRating);
  const others = pool.filter((p) => !interestSet.has(p.activityTypeId)).sort(byRating);
  if (matches.length === 0) return others.slice(0, cap);
  return [...matches.slice(0, cap - 1), ...others, ...matches.slice(cap - 1)].slice(0, cap);
}

/** Group the 7-day window into non-empty days, in order (docs/19 §5.3). */
function buildWeek(entries: ScheduleEntry[]): WeekDay[] {
  const days = new Map<number, WeekDay>();
  for (const entry of weekEntries(entries)) {
    const day = days.get(entry.dayOffset) ?? {
      dayOffset: entry.dayOffset,
      dayLabel: entry.dayLabel,
      entries: [],
    };
    day.entries.push(entry);
    days.set(entry.dayOffset, day);
  }
  return [...days.values()].sort((a, b) => a.dayOffset - b.dayOffset);
}

export function buildHomeFeed(input: HomeFeedBuildInput): HomeFeed {
  const referenceArea = areas.find((area) => area.id === input.areaId) ?? areas[0];
  const isGuest = input.account === null;
  const primary = isGuest
    ? undefined
    : (input.participants.find((p) => p.id === input.account?.primaryParticipantId) ??
      input.participants[0]);
  const children = input.participants.filter((participant) => participant.kind === 'child');

  const scheduleEntries = [...input.scheduleEntries].sort(
    (a, b) => a.dayOffset - b.dayOffset || entryTimeMinutes(a) - entryTimeMinutes(b),
  );
  const hasSchedule = scheduleEntries.length > 0;

  const sections: HomeSection[] = [];
  const pushPrograms = (id: string, title: string, list: FixtureProgram[]) => {
    if (list.length > 0) sections.push({ kind: 'programs', id, title, programs: list });
  };

  // 1. Guest welcome (docs/18 §9 A) — the only Home surface keeping hero language.
  if (isGuest) sections.push({ kind: 'welcome', content: guestWelcome });

  // 2–4. Schedule context — only from real data, never fabricated.
  if (hasSchedule) {
    sections.push({ kind: 'upcoming', entry: scheduleEntries[0] });
    const days = buildWeek(scheduleEntries);
    if (days.length > 0) sections.push({ kind: 'week', days });
  }
  if (input.activePlans.length > 0) sections.push({ kind: 'plans', plans: input.activePlans });

  // 5. Primary participant rail — declared interests, adult-suitable pool.
  if (primary !== undefined) {
    const pool = programs.filter((program) => suitsAdult(program.eligibility));
    pushPrograms(
      'based-on-interests',
      (primary.interests?.length ?? 0) > 0 ? 'Based on your interests' : 'For you',
      interestRanked(pool, primary.interests ?? [], CAPS.interests),
    );
  }

  // 6. One rail per additional profile, account order; provider-defined age
  // eligibility is the authoritative first gate (docs/05 §9). Child-focused
  // sections exist only because a real child profile does (docs/18 §6).
  for (const child of children) {
    const age = participantAge(child) ?? 0;
    const pool = programs.filter((program) => suitsChild(program.eligibility, age));
    pushPrograms(
      `for-${child.id}`,
      `For ${child.label}`,
      interestRanked(pool, child.interests ?? [], CAPS.childRail),
    );

    // At most one supplemental format rail, only with ≥ 2 age-eligible
    // matches (docs/18 §5.1); camps lead in season, after-school otherwise.
    const camps = pool.filter((program) => program.isCamp).sort(byRating);
    const afterSchool = pool.filter((program) => program.runsAfterSchool === true).sort(byRating);
    if (camps.length >= 2) {
      pushPrograms(`camps-${child.id}`, `Camps for ${child.label}`, camps.slice(0, CAPS.supplemental));
    } else if (afterSchool.length >= 2) {
      pushPrograms(
        `after-school-${child.id}`,
        `After school for ${child.label}`,
        afterSchool.slice(0, CAPS.supplemental),
      );
    }
  }

  // 7. Popular near — a discovery aid only while no real schedule exists
  // (docs/18 §9 C, owner decision): it yields to schedule content.
  if (!hasSchedule) {
    const pool = programs
      .filter((program) => eligibleForAccount(program, input.participants))
      .sort(
        (a, b) =>
          areaRank(a.areaId, referenceArea) - areaRank(b.areaId, referenceArea) || byRating(a, b),
      );
    pushPrograms('popular-near', `Popular near ${referenceArea.label}`, pool.slice(0, CAPS.popular));
  }

  // 8. Available today — household-eligibility scoped, time-led.
  const today = programs
    .filter(
      (program) => program.availableToday && eligibleForAccount(program, input.participants),
    )
    .sort((a, b) => todayTimeMinutes(a) - todayTimeMinutes(b) || stable(a) - stable(b));
  pushPrograms(
    'available-today',
    isGuest ? 'Available today' : 'Available today for you',
    today.slice(0, CAPS.today),
  );

  // 9. Offers — small, badge-led, interest-aware for signed-in accounts.
  const accountInterests = input.participants.flatMap((participant) => participant.interests ?? []);
  const offers = interestRanked(
    programs.filter(
      (program) => program.offer !== undefined && eligibleForAccount(program, input.participants),
    ),
    accountInterests,
    CAPS.offers,
  );
  pushPrograms('offers', isGuest ? 'Offers' : 'Offers for you', offers);

  // 10. Guest setup invitation — the only action card this milestone; never
  // an add-child prompt (docs/09 §19.6).
  if (isGuest) {
    sections.push({
      kind: 'action',
      id: 'setup',
      title: 'Make Himma yours',
      body: 'Create an account to set your interests and get recommendations picked for you.',
    });
  }

  // 11. Credit strip — only when the account has credit data.
  if (input.credit !== undefined) sections.push({ kind: 'credit', credit: input.credit });

  return { sections };
}

export class MockHomeFeedService implements HomeFeedService {
  constructor(private readonly delayMs: number = 400) {}

  async getAreas(): Promise<Area[]> {
    return areas;
  }

  async getHomeFeed(input: HomeFeedBuildInput): Promise<HomeFeed> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return buildHomeFeed(input);
  }
}

export const homeFeedService: HomeFeedService = new MockHomeFeedService();
