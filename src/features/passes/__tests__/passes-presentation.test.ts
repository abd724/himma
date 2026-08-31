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
  parseOccurrenceKey,
  scheduleSummaryLines,
  statusPresentation,
} from '@/features/passes/passes-presentation';

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

describe('canonical occurrence extraction (docs/35 §28)', () => {
  it('extracts the SERVER pair from occurrence event keys; other keys are not occurrences', () => {
    expect(parseOccurrenceKey('booking:bk-1:2026-09-07:09:00')).toEqual({
      bookingId: 'bk-1',
      date: '2026-09-07',
      startTime: '09:00',
    });
    // A plain session-booking event key carries no occurrence pair.
    expect(parseOccurrenceKey('booking:bk-1')).toBeUndefined();
    expect(parseOccurrenceKey('entitlement:ent-1:2026-09-07:09:00')).toBeUndefined();
  });

  it('lists a booking’s occurrences verbatim — two same-day meetings stay distinct', () => {
    const choices = occurrenceChoices(
      [
        {
          eventKey: 'booking:bk-1:2026-09-06:09:00',
          sourceType: 'cohortOccurrence',
          startAt: '2026-09-06T05:00:00.000Z',
          endAt: '2026-09-06T06:00:00.000Z',
          bookingId: 'bk-1',
        },
        {
          eventKey: 'booking:bk-1:2026-09-06:17:00',
          sourceType: 'cohortOccurrence',
          startAt: '2026-09-06T13:00:00.000Z',
          endAt: '2026-09-06T14:00:00.000Z',
          bookingId: 'bk-1',
        },
        {
          eventKey: 'booking:OTHER:2026-09-06:09:00',
          sourceType: 'cohortOccurrence',
          startAt: '2026-09-06T05:00:00.000Z',
          endAt: '2026-09-06T06:00:00.000Z',
          bookingId: 'OTHER',
        },
      ],
      'bk-1',
    );
    expect(choices.map((choice) => `${choice.date} ${choice.startTime}`)).toEqual([
      '2026-09-06 09:00',
      '2026-09-06 17:00',
    ]);
  });
});
