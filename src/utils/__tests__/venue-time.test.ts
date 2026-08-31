/**
 * RI-6 — venue-local presentation (owner item 20): scheduled UAE activity
 * keeps its venue civil day/time on ANY device timezone. These are pure
 * Intl-based helpers, deterministic regardless of the host timezone the
 * suite runs under.
 */
import { describe, expect, it } from '@jest/globals';
import {
  civilDateInZone,
  civilDayDiff,
  dateLabelInZone,
  platformToday,
  PLATFORM_TIME_ZONE,
  timeLabelInZone,
} from '@/utils/venue-time';

describe('venue-local civil presentation', () => {
  it('CROSS-MIDNIGHT: a Dubai 00:30 session (20:30 UTC the previous day) stays on the DUBAI civil day', () => {
    const instant = new Date('2026-09-06T20:30:00.000Z'); // Sunday in UTC
    expect(civilDateInZone(instant, 'Asia/Dubai')).toBe('2026-09-07'); // Monday in Dubai
    expect(timeLabelInZone(instant, 'Asia/Dubai')).toBe('12:30 AM');
    // The SAME instant in a western zone is a different civil day — which
    // is exactly why the venue zone (never the device zone) is authority.
    expect(civilDateInZone(instant, 'America/New_York')).toBe('2026-09-06');
  });

  it('an ordinary evening class formats in venue terms', () => {
    const instant = new Date('2026-09-02T15:00:00.000Z'); // 19:00 Dubai
    expect(civilDateInZone(instant, 'Asia/Dubai')).toBe('2026-09-02');
    expect(timeLabelInZone(instant, 'Asia/Dubai')).toBe('7:00 PM');
    expect(dateLabelInZone(instant, 'Asia/Dubai', { weekday: 'short', day: 'numeric' })).toMatch(
      /Wed/,
    );
  });

  it('platformToday anchors to the pinned platform timezone', () => {
    expect(PLATFORM_TIME_ZONE).toBe('Asia/Dubai');
    // 21:00 UTC on the 6th is already the 7th in Dubai.
    expect(platformToday(new Date('2026-09-06T21:00:00.000Z'))).toBe('2026-09-07');
    expect(platformToday(new Date('2026-09-06T12:00:00.000Z'))).toBe('2026-09-06');
  });

  it('civil day math is timezone-free', () => {
    expect(civilDayDiff('2026-09-07', '2026-09-01')).toBe(6);
    expect(civilDayDiff('2026-09-01', '2026-09-07')).toBe(-6);
  });
});
