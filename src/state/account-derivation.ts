/**
 * RI-1 — pure derivation of the app-wide `ResolvedAccount` from REAL auth
 * + participant truth. The shape stays the certified contract the screens
 * already consume; only the source changes:
 *
 * - guest → the empty guest account (no participants, no schedule);
 * - authenticated → real participants mapped into the domain shape.
 *   RI-3: `scheduleEntries` now derive from REAL confirmed bookings (the
 *   certified own-booking read) — upcoming only, never fabricated. Active
 *   plans stay truthfully EMPTY until S6/RI-4 (docs/18 §10 no-history).
 *
 * `participantsReady` lets participant-dependent screens hold their
 * loading state until the real list arrived, instead of flashing a wrong
 * empty/ineligible state.
 */
import { bookingStart, categorizeBooking } from '@/features/bookings/booking-presentation';
import { presentationImageKey } from '@/services/api/discovery-mapping';
import type { CustomerBooking } from '@/services/contracts/commerce';
import type { ParticipantProfile } from '@/services/contracts/identity';
import type { ResolvedAccount, ScheduleEntry } from '@/services/contracts/schedule';
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

/** RI-3: a confirmed upcoming booking → the Home schedule entry shape. */
export function toScheduleEntries(
  bookings: CustomerBooking[],
  selfParticipantId: string | undefined,
  now: Date = new Date(),
): ScheduleEntry[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const entries: ScheduleEntry[] = [];
  for (const booking of bookings) {
    if (categorizeBooking(booking, now) !== 'upcoming') continue;
    const start = bookingStart(booking);
    if (start === null) continue;
    const dayOffset = Math.round(
      (new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() -
        startOfToday.getTime()) /
        86_400_000,
    );
    const dayLabel =
      dayOffset === 0
        ? 'Today'
        : dayOffset === 1
          ? 'Tomorrow'
          : start.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
    const timeLabel =
      booking.unit.startAt !== null
        ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : booking.unit.kind === 'campWeek'
          ? 'Camp week'
          : 'Enrolment';
    entries.push({
      id: booking.bookingId,
      programId: booking.program.id,
      dayOffset,
      dayLabel,
      timeLabel,
      participantId: booking.participant.id,
      participantLabel:
        booking.participant.id === selfParticipantId ? 'You' : booking.participant.firstName,
      programTitle: booking.program.titleEn,
      providerName: booking.provider.displayName,
      areaLabel: booking.branch?.label ?? '',
      imageKey: presentationImageKey('fitness', booking.program.id),
    });
  }
  return entries.sort((a, b) => a.dayOffset - b.dayOffset);
}

export function deriveRealAccount(
  profiles: ParticipantProfile[],
  ready: boolean,
  bookings: CustomerBooking[] = [],
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
    // REAL confirmed bookings only — never fabricated (RI-3).
    scheduleEntries: toScheduleEntries(bookings, self?.id),
    activePlans: [],
    participantsReady: ready,
  };
}
