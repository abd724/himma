import { areas, participants, programs, providers } from '@/data/mock/catalogue';
import {
  accountScenarios,
  bookingFixtures,
  planFixtures,
  type BookingFixture,
  type PlanFixture,
} from '@/data/mock/schedule';
import type {
  AccountScenarioId,
  ActivePlan,
  ResolvedAccount,
  ScheduleEntry,
  ScheduleService,
} from '@/services/contracts/schedule';
import { MOCK_TODAY } from '@/utils/eligibility';
import type { Participant } from '@/types/domain';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** MOCK_TODAY (2026-08-02) is a Sunday — index 0 in WEEKDAYS. */
const MOCK_TODAY_WEEKDAY = 0;

const programById = new Map(programs.map((program) => [program.id, program]));
const providerById = new Map(providers.map((provider) => [provider.id, provider]));
const areaLabelById = new Map(areas.map((area) => [area.id, area.label]));
const participantById = new Map(participants.map((participant) => [participant.id, participant]));

/** 'Today' for offset 0, else weekday + date ('Mon 3') from MOCK_TODAY. */
export function dayLabelForOffset(offset: number): string {
  if (offset === 0) return 'Today';
  const weekday = WEEKDAYS[(MOCK_TODAY_WEEKDAY + offset) % 7];
  return `${weekday} ${MOCK_TODAY.day + offset}`;
}

/** Minutes since midnight for '10:00 AM'-style labels; used only for sorting. */
function timeLabelMinutes(label: string): number {
  const match = label.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const hours = (Number(match[1]) % 12) + (match[3] === 'PM' ? 12 : 0);
  return hours * 60 + Number(match[2]);
}

function participantLabelFor(participant: Participant): string {
  // 'You' for the primary participant — never expose an internal profile
  // name unnecessarily (docs/18 §5.3).
  return participant.kind === 'self' ? 'You' : participant.label;
}

function enrichBooking(fixture: BookingFixture): ScheduleEntry | null {
  const program = programById.get(fixture.programId);
  const participant = participantById.get(fixture.participantId);
  if (program === undefined || participant === undefined) return null;
  const provider = providerById.get(program.providerId);
  return {
    id: fixture.id,
    programId: program.id,
    dayOffset: fixture.dayOffset,
    dayLabel: dayLabelForOffset(fixture.dayOffset),
    timeLabel: fixture.timeLabel,
    participantId: participant.id,
    participantLabel: participantLabelFor(participant),
    programTitle: program.title,
    providerName: provider?.name ?? '',
    areaLabel: areaLabelById.get(program.areaId) ?? '',
    imageKey: program.imageKey,
  };
}

function enrichPlan(fixture: PlanFixture): ActivePlan | null {
  const program = programById.get(fixture.programId);
  const participant = participantById.get(fixture.participantId);
  if (program === undefined || participant === undefined) return null;
  const provider = providerById.get(program.providerId);
  const nextDay =
    fixture.nextDayOffset === 0
      ? 'Today'
      : WEEKDAYS[(MOCK_TODAY_WEEKDAY + fixture.nextDayOffset) % 7];
  return {
    id: fixture.id,
    programId: program.id,
    participantId: participant.id,
    participantLabel: participantLabelFor(participant),
    kind: fixture.kind,
    programTitle: program.title,
    providerName: provider?.name ?? '',
    progressLabel: `${fixture.sessionsRemaining} of ${fixture.sessionsTotal} sessions left`,
    nextSessionLabel: `${nextDay}, ${fixture.nextTimeLabel}`,
  };
}

/**
 * Pure fixture resolution — docs/19 §3: `?qa-scenario` → deterministic mock
 * account fixture → resolved account data. Everything downstream (the Home
 * feed builder, screens) consumes this data, never the scenario id.
 */
export function resolveAccountScenario(scenario: AccountScenarioId): ResolvedAccount {
  const fixture = accountScenarios[scenario];
  const bookingIds = new Set(fixture.bookingIds);
  const planIds = new Set(fixture.planIds);

  const resolvedParticipants = fixture.participantIds
    .map((id) => participantById.get(id))
    .filter((participant): participant is Participant => participant !== undefined);

  const scheduleEntries = bookingFixtures
    .filter((booking) => bookingIds.has(booking.id))
    .map(enrichBooking)
    .filter((entry): entry is ScheduleEntry => entry !== null)
    .sort(
      (a, b) =>
        a.dayOffset - b.dayOffset || timeLabelMinutes(a.timeLabel) - timeLabelMinutes(b.timeLabel),
    );

  const activePlans = planFixtures
    .filter((plan) => planIds.has(plan.id))
    .map(enrichPlan)
    .filter((plan): plan is ActivePlan => plan !== null);

  return {
    scenario,
    account: fixture.account,
    participants: resolvedParticipants,
    childParticipants: resolvedParticipants.filter((participant) => participant.kind === 'child'),
    scheduleEntries,
    activePlans,
    credit: fixture.creditAmount === undefined ? undefined : { availableCredit: fixture.creditAmount },
  };
}

/** The week strip window: the 7 days starting at MOCK_TODAY (docs/18 §10). */
export function weekEntries(entries: ScheduleEntry[]): ScheduleEntry[] {
  return entries.filter((entry) => entry.dayOffset >= 0 && entry.dayOffset <= 6);
}

export class MockScheduleService implements ScheduleService {
  constructor(private readonly delayMs: number = 0) {}

  private async resolve(scenario: AccountScenarioId): Promise<ResolvedAccount> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return resolveAccountScenario(scenario);
  }

  async getUpcomingActivity(scenario: AccountScenarioId): Promise<ScheduleEntry | null> {
    const { scheduleEntries } = await this.resolve(scenario);
    return scheduleEntries[0] ?? null;
  }

  async getWeekSchedule(scenario: AccountScenarioId): Promise<ScheduleEntry[]> {
    const { scheduleEntries } = await this.resolve(scenario);
    return weekEntries(scheduleEntries);
  }

  async getActivePlans(scenario: AccountScenarioId): Promise<ActivePlan[]> {
    const { activePlans } = await this.resolve(scenario);
    return activePlans;
  }
}

export const scheduleService: ScheduleService = new MockScheduleService();
