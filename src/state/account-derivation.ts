/**
 * RI-1 — pure derivation of the app-wide `ResolvedAccount` from REAL auth
 * + participant truth. The shape stays the certified contract the screens
 * already consume; only the source changes:
 *
 * - guest → the empty guest account (no participants, no schedule);
 * - authenticated → real participants mapped into the domain shape.
 *   RI-5: `scheduleEntries` derive from the SAME bounded unified Calendar
 *   read the Calendar surface consumes (the one backend aggregation
 *   authority — sessions, reserved sessions, camp daily occurrences,
 *   cohort occurrences, membership schedule occurrences), and
 *   `activePlans` derive from the REAL Entitlement family (RI-4). Nothing
 *   is fabricated: a flexible pass with no reservation contributes no
 *   schedule dates, and a plan carries a next-session line only when the
 *   server reports one.
 *
 * `participantsReady` lets participant-dependent screens hold their
 * loading state until the real list arrived, instead of flashing a wrong
 * empty/ineligible state.
 */
import { eventDay, eventTimeLabel } from '@/features/calendar/calendar-presentation';
import { dateLabelInZone, platformToday, PLATFORM_TIME_ZONE } from '@/utils/venue-time';
import { finiteHeadline } from '@/features/passes/passes-presentation';
import { presentationImageKey } from '@/services/api/discovery-mapping';
import type { CalendarOccurrence, CustomerEntitlement } from '@/services/contracts/entitlements';
import type { ParticipantProfile } from '@/services/contracts/identity';
import type { ActivePlan, ResolvedAccount, ScheduleEntry } from '@/services/contracts/schedule';
import type { Participant } from '@/types/domain';

export const GUEST_ACCOUNT: ResolvedAccount = {
  scenario: 'guest',
  account: null,
  participants: [],
  childParticipants: [],
  scheduleEntries: [],
  activePlans: [],
};

export function toDomainParticipant(profile: ParticipantProfile): Participant {
  return {
    id: profile.id,
    // Product rule (docs/02 §4): the account holder is always presented as
    // "Me"; children by their name.
    label: profile.kind === 'self' ? 'Me' : profile.firstName,
    kind: profile.kind,
    ...(profile.dateOfBirth !== null ? { dateOfBirth: profile.dateOfBirth } : {}),
  };
}

function dayOffsetOf(day: string, today: string): number {
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = day.split('-').map(Number);
  return Math.round(
    (new Date(y2!, m2! - 1, d2!).getTime() - new Date(y1!, m1! - 1, d1!).getTime()) / 86_400_000,
  );
}

/**
 * RI-5: unified Calendar events → the Home schedule entry shape. The
 * server list renders verbatim (already deduplicated and expanded);
 * upcoming/ongoing events only, keyed by the OPAQUE event key.
 */
export function toScheduleEntries(
  events: CalendarOccurrence[],
  selfParticipantId: string | undefined,
  now: Date = new Date(),
): ScheduleEntry[] {
  // RI-6 — day offsets/labels anchor to the platform venue timezone, the
  // same civil frame the events themselves group by.
  const today = platformToday(now);
  const entries: ScheduleEntry[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    if (new Date(event.endAt).getTime() <= now.getTime()) continue;
    const day = eventDay(event);
    const dayOffset = dayOffsetOf(day, today);
    if (dayOffset < 0) continue;
    const [year, month, dayNo] = day.split('-').map(Number);
    const dayLabel =
      dayOffset === 0
        ? 'Today'
        : dayOffset === 1
          ? 'Tomorrow'
          : new Date(year!, month! - 1, dayNo!).toLocaleDateString('en-US', {
              weekday: 'short',
              day: 'numeric',
            });
    entries.push({
      id: event.eventKey,
      programId: event.program.id,
      dayOffset,
      dayLabel,
      timeLabel: eventTimeLabel(event),
      participantId: event.participant.id,
      participantLabel:
        event.participant.id === selfParticipantId ? 'You' : event.participant.firstName,
      programTitle: event.program.titleEn,
      providerName: event.provider.displayName,
      areaLabel: event.branch?.label ?? '',
      imageKey: presentationImageKey('fitness', event.program.id),
      ...(event.bookingId !== undefined ? { bookingId: event.bookingId } : {}),
      ...(event.entitlementId !== undefined ? { entitlementId: event.entitlementId } : {}),
    });
  }
  return entries.sort((a, b) =>
    a.dayOffset !== b.dayOffset ? a.dayOffset - b.dayOffset : a.id < b.id ? -1 : 1,
  );
}

/**
 * RI-5: REAL active Passes/Memberships → the Home plan card shape. Server
 * truths only: the finite headline or "Unlimited", and a next-session
 * line only from the server's `nextReservedSessionAt` (a pass with no
 * reservation shows no fake date).
 */
export function toActivePlans(
  entitlements: CustomerEntitlement[],
  selfParticipantId: string | undefined,
): ActivePlan[] {
  return entitlements
    .filter((entitlement) => entitlement.status === 'active')
    .map((entitlement) => {
      const next =
        entitlement.nextReservedSessionAt === null
          ? undefined
          : dateLabelInZone(new Date(entitlement.nextReservedSessionAt), PLATFORM_TIME_ZONE, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            });
      return {
        id: entitlement.entitlementId,
        programId: entitlement.program.id,
        participantId: entitlement.participant.id,
        participantLabel:
          entitlement.participant.id === selfParticipantId
            ? 'You'
            : entitlement.participant.firstName,
        kind: (entitlement.optionKind === 'package' ? 'package' : 'membership') as ActivePlan['kind'],
        programTitle: entitlement.program.titleEn,
        providerName: entitlement.provider.displayName,
        progressLabel:
          entitlement.finite !== undefined ? finiteHeadline(entitlement.finite) : 'Unlimited',
        ...(next !== undefined ? { nextSessionLabel: next } : {}),
        entitlementId: entitlement.entitlementId,
      };
    });
}

export function deriveRealAccount(
  profiles: ParticipantProfile[],
  ready: boolean,
  calendarEvents: CalendarOccurrence[] = [],
  entitlements: CustomerEntitlement[] = [],
): ResolvedAccount {
  const participants = profiles.map(toDomainParticipant);
  const self = participants.find((participant) => participant.kind === 'self');
  return {
    // Nominal fixture id only (the field exists for the QA fixture layer);
    // nothing downstream branches on it.
    scenario: 'me-only',
    account: { primaryParticipantId: self?.id ?? 'me' },
    participants,
    childParticipants: participants.filter((participant) => participant.kind === 'child'),
    // REAL server Calendar events / Entitlements only — never fabricated.
    scheduleEntries: toScheduleEntries(calendarEvents, self?.id),
    activePlans: toActivePlans(entitlements, self?.id),
    participantsReady: ready,
  };
}
