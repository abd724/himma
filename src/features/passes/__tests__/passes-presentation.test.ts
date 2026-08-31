/**
 * RI-4 — pure Passes presentation: the truthful finite vocabulary
 * (remaining vs available-to-reserve NEVER conflated), server-status
 * wording, schedule summaries, the 4-4 code grouping, and canonical
 * occurrence EXTRACTION from the server's own event keys (never
 * construction).
 */
import { describe, expect, it } from '@jest/globals';
import {
  displayCodeGroups,
  displayTime,
  finiteCommitmentLine,
  finiteHeadline,
  occurrenceChoices,
  scheduleSummaryLines,
  statusPresentation,
} from '@/features/passes/passes-presentation';
import type { CalendarOccurrence } from '@/services/contracts/entitlements';

/** Full server event from the varying fields (RI-5 widened DTO). */
function calendarEvent(
  partial: Pick<CalendarOccurrence, 'eventKey' | 'sourceType' | 'startAt' | 'endAt'> &
    Partial<CalendarOccurrence>,
): CalendarOccurrence {
  return {
    context: 'booked',
    participant: { id: 'p-1', firstName: 'Sara' },
    program: { id: 'prog-1', titleEn: 'Program' },
    provider: { id: 'org-1', displayName: 'Provider' },
    branch: null,
    ...partial,
  };
}

describe('finite balance vocabulary (docs/35 §8)', () => {
  // The owner's worked example: 5 total, 1 attended, 2 upcoming
  // reservations → 4 REMAIN while only 2 can be newly booked.
  const finite = {
    usesTotal: 5,
    used: 1,
    remaining: 4,
    reservedUpcoming: 2,
    availableToReserve: 2,
  };

  it('the headline states REMAINING (server truth), never the bookable count', () => {
    expect(finiteHeadline(finite)).toBe('4 of 5 visits remaining');
  });

  it('the commitment line states BOTH truths when reservations hold credits', () => {
    expect(finiteCommitmentLine(finite)).toBe(
      '2 visits reserved for upcoming sessions · 2 more can be booked',
    );
    expect(
      finiteCommitmentLine({ ...finite, reservedUpcoming: 0, availableToReserve: 4 }),
    ).toBeNull();
  });

  it('server status maps to customer wording; exhausted is "Used up"', () => {
    expect(statusPresentation('active')).toEqual({ label: 'Active', tone: 'positive' });
    expect(statusPresentation('exhausted')).toEqual({ label: 'Used up', tone: 'neutral' });
    expect(statusPresentation('expired')).toEqual({ label: 'Expired', tone: 'neutral' });
  });
});

describe('schedule + code display', () => {
  it('groups purchased schedule terms by time window', () => {
    expect(
      scheduleSummaryLines([
        { weekday: 1, startTime: '19:00', endTime: '20:00' },
        { weekday: 3, startTime: '19:00', endTime: '20:00' },
      ]),
    ).toEqual(['Mon & Wed · 7:00 PM–8:00 PM']);
    expect(displayTime('00:30')).toBe('12:30 AM');
  });

  it('displays the 8-digit code in the approved 4-4 grouping', () => {
    expect(displayCodeGroups('12345678')).toBe('1234 5678');
  });
});

describe('canonical occurrence pass-through (owner RI-4 correction; docs/35 §28)', () => {
  it('uses the EXPLICIT server occurrence DTO verbatim — event keys are opaque and their format is irrelevant; two same-day meetings stay distinct', () => {
    const choices = occurrenceChoices(
      [
        calendarEvent({
          // Deliberately opaque keys: the format carries NO meaning here.
          eventKey: 'opaque-event-1',
          sourceType: 'cohortOccurrence',
          startAt: '2026-09-06T05:00:00.000Z',
          endAt: '2026-09-06T06:00:00.000Z',
          bookingId: 'bk-1',
          occurrence: { date: '2026-09-06', startTime: '09:00' },
        }),
        calendarEvent({
          eventKey: 'opaque-event-2',
          sourceType: 'cohortOccurrence',
          startAt: '2026-09-06T13:00:00.000Z',
          endAt: '2026-09-06T14:00:00.000Z',
          bookingId: 'bk-1',
          occurrence: { date: '2026-09-06', startTime: '17:00' },
        }),
        calendarEvent({
          eventKey: 'opaque-event-3',
          sourceType: 'cohortOccurrence',
          startAt: '2026-09-06T05:00:00.000Z',
          endAt: '2026-09-06T06:00:00.000Z',
          bookingId: 'OTHER',
          occurrence: { date: '2026-09-06', startTime: '09:00' },
        }),
        calendarEvent({
          // A session-booking event carries no occurrence DTO → no choice.
          eventKey: 'opaque-event-4',
          sourceType: 'sessionBooking',
          startAt: '2026-09-06T05:00:00.000Z',
          endAt: '2026-09-06T06:00:00.000Z',
          bookingId: 'bk-1',
        }),
      ],
      'bk-1',
    );
    expect(choices.map((choice) => `${choice.date} ${choice.startTime}`)).toEqual([
      '2026-09-06 09:00',
      '2026-09-06 17:00',
    ]);
  });

  it('CROSS-MIDNIGHT: the explicit Monday/00:30 DTO passes through untouched — no client timezone arithmetic exists', () => {
    const choices = occurrenceChoices(
      [
        calendarEvent({
          eventKey: 'opaque-event-5',
          sourceType: 'campWeekOccurrence',
          // The instant is Sunday in UTC — the AUTHORITY stays the server DTO.
          startAt: '2026-09-06T20:30:00.000Z',
          endAt: '2026-09-06T21:30:00.000Z',
          bookingId: 'bk-1',
          occurrence: { date: '2026-09-07', startTime: '00:30' },
        }),
      ],
      'bk-1',
    );
    expect(choices[0]).toMatchObject({ date: '2026-09-07', startTime: '00:30' });
  });
});
