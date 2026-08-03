import type { CreditSummary, Participant, ParticipantId } from '@/types/domain';

/**
 * Schedule and account-fixture boundary — docs/19 §3, docs/18 §10.
 * Scenario ids exist ONLY in this fixture layer: they select deterministic
 * demo data for review (`?qa-scenario`) and never reach the Home feed
 * domain model, screens, or `buildHomeFeed`.
 */
export type AccountScenarioId = 'guest' | 'me-only' | 'me-active' | 'household';

export interface AccountSnapshot {
  primaryParticipantId: ParticipantId;
}

/**
 * Display-ready booked session; joins (program, provider, area, participant)
 * are done in the service — screens never join raw data.
 */
export interface ScheduleEntry {
  id: string;
  programId: string;
  /** Days after MOCK_TODAY (0 = today); the week strip shows offsets 0–6. */
  dayOffset: number;
  /** 'Today' | 'Mon 3' | … — derived from MOCK_TODAY, never the device clock. */
  dayLabel: string;
  timeLabel: string;
  participantId: ParticipantId;
  /** 'You' for the primary participant, else the profile name. */
  participantLabel: string;
  programTitle: string;
  providerName: string;
  areaLabel: string;
  imageKey: string;
}

/** An active membership, package, or recurring enrolment (docs/18 §4.5). */
export interface ActivePlan {
  id: string;
  programId: string;
  participantId: ParticipantId;
  participantLabel: string;
  kind: 'package' | 'membership' | 'recurring';
  programTitle: string;
  providerName: string;
  /** e.g. '6 of 10 sessions left'. */
  progressLabel: string;
  /** e.g. 'Mon, 6:30 PM'. */
  nextSessionLabel: string;
}

/** A scenario fixture resolved into plain account data (docs/19 §3 data flow). */
export interface ResolvedAccount {
  scenario: AccountScenarioId;
  /** null = guest (no account). */
  account: AccountSnapshot | null;
  /** Primary participant first, then additional profiles. Empty for guest. */
  participants: Participant[];
  childParticipants: Participant[];
  scheduleEntries: ScheduleEntry[];
  activePlans: ActivePlan[];
  credit?: CreditSummary;
}

/**
 * Schedule boundary — docs/08 §8. The mock implementation is deterministic;
 * a real API client replaces it later without touching screens.
 */
export interface ScheduleService {
  getUpcomingActivity(scenario: AccountScenarioId): Promise<ScheduleEntry | null>;
  getWeekSchedule(scenario: AccountScenarioId): Promise<ScheduleEntry[]>;
  getActivePlans(scenario: AccountScenarioId): Promise<ActivePlan[]>;
}
