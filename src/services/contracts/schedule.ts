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
  /** Days after today (0 = today); the week strip shows offsets 0–6.
   *  (Fixture entries derive from MOCK_TODAY; real entries — RI-5 — from
   *  the unified Calendar events.) */
  dayOffset: number;
  /** 'Today' | 'Mon 3' | … */
  dayLabel: string;
  timeLabel: string;
  participantId: ParticipantId;
  /** 'You' for the primary participant, else the profile name. */
  participantLabel: string;
  programTitle: string;
  providerName: string;
  areaLabel: string;
  imageKey: string;
  /** RI-5 — the EXPLICIT navigable owner where the backend event carries
   *  one (never parsed from an event key). Fixture entries omit both. */
  bookingId?: string;
  entitlementId?: string;
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
  /** e.g. 'Mon, 6:30 PM'. RI-5: real plans carry it only when the SERVER
   *  reports a next reserved session — never a fabricated date. */
  nextSessionLabel?: string;
  /** RI-5 — the real Pass/Membership this plan card opens. */
  entitlementId?: string;
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
  /**
   * RI-1 (real accounts only): false while the authenticated participant
   * list is still loading — participant-dependent screens hold their
   * loading state instead of flashing a wrong empty/ineligible state.
   * Fixture accounts omit it (always ready).
   */
  participantsReady?: boolean;
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
