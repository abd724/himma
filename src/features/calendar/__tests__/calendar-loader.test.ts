/**
 * RI-5 — the bounded Calendar loading state: range changes issue one
 * bounded reload, errors surface a retry state, and a server re-read
 * REPLACES the held truth wholesale (a refreshed reservation appears
 * exactly once; a redeemed check-in never duplicates an event; a later
 * provider schedule revision shows whatever the server now says — no
 * stale client cache survives a reload).
 */
import { describe, expect, it } from '@jest/globals';
import {
  INITIAL_CALENDAR_STATE,
  loadFailed,
  loadStarted,
  loadSucceeded,
  requiredRequest,
} from '@/features/calendar/calendar-loader';
import type { CalendarOccurrence } from '@/services/contracts/entitlements';

function calendarEvent(eventKey: string): CalendarOccurrence {
  return {
    eventKey,
    sourceType: 'sessionBooking',
    context: 'booked',
    participant: { id: 'p-1', firstName: 'Sara' },
    program: { id: 'prog-1', titleEn: 'Lap swimming' },
    provider: { id: 'org-1', displayName: 'Marina Aquatics' },
    branch: null,
    startAt: '2026-09-06T05:00:00.000Z',
    endAt: '2026-09-06T06:00:00.000Z',
    timezone: 'Asia/Dubai',
  };
}

describe('bounded reload on range change (owner item 13)', () => {
  it('the first look and any out-of-window week require ONE bounded request; an in-window selection requires none', () => {
    const first = requiredRequest(INITIAL_CALENDAR_STATE, '2026-09-02');
    expect(first).toEqual({ from: '2026-08-24', to: '2026-09-20' });

    let state = loadStarted(INITIAL_CALENDAR_STATE, first!);
    state = loadSucceeded(state, first!, [calendarEvent('k-1')]);

    // Selecting another day INSIDE the loaded window: no new request.
    expect(requiredRequest(state, '2026-09-10')).toBeNull();

    // Navigating far outside: exactly one new bounded window.
    const far = requiredRequest(state, '2026-10-15');
    expect(far).toEqual({ from: '2026-10-05', to: '2026-11-01' });
  });

  it('force refresh re-reads the current window while keeping events visible', () => {
    const range = { from: '2026-08-24', to: '2026-09-20' };
    let state = loadSucceeded(loadStarted(INITIAL_CALENDAR_STATE, range), range, [
      calendarEvent('k-1'),
    ]);
    const refresh = requiredRequest(state, '2026-09-02', true);
    expect(refresh).toEqual(range);
    state = loadStarted(state, refresh!);
    expect(state.events).toHaveLength(1); // same-range refresh: no skeleton flash
  });
});

describe('server truth replaces held truth (owner items 8/19/21)', () => {
  it('a re-read REPLACES the list — a new reservation appears once, a redeemed event never duplicates, a schedule change shows through', () => {
    const range = { from: '2026-08-24', to: '2026-09-20' };
    let state = loadSucceeded(loadStarted(INITIAL_CALENDAR_STATE, range), range, [
      calendarEvent('k-1'),
    ]);
    // Server now returns the SAME event plus the newly reserved one.
    state = loadSucceeded(loadStarted(state, range), range, [
      calendarEvent('k-1'),
      calendarEvent('k-new-reservation'),
    ]);
    expect(state.events!.map((event) => event.eventKey)).toEqual(['k-1', 'k-new-reservation']);
    // And a later authoritative change (e.g. a revision) replaces wholesale
    // — nothing stale is merged back in.
    state = loadSucceeded(loadStarted(state, range), range, [calendarEvent('k-2')]);
    expect(state.events!.map((event) => event.eventKey)).toEqual(['k-2']);
  });

  it('a stale response for a superseded range never overwrites newer truth', () => {
    const oldRange = { from: '2026-08-24', to: '2026-09-20' };
    const newRange = { from: '2026-10-05', to: '2026-11-01' };
    let state = loadStarted(INITIAL_CALENDAR_STATE, oldRange);
    state = loadStarted(state, newRange);
    state = loadSucceeded(state, oldRange, [calendarEvent('stale')]);
    expect(state.events).toBeNull(); // still loading the NEW range
    state = loadSucceeded(state, newRange, [calendarEvent('fresh')]);
    expect(state.events!.map((event) => event.eventKey)).toEqual(['fresh']);
  });
});

describe('network error (owner items 20/24)', () => {
  it('a failed range load surfaces the retry state; a successful retry clears it', () => {
    const range = { from: '2026-08-24', to: '2026-09-20' };
    let state = loadStarted(INITIAL_CALENDAR_STATE, range);
    state = loadFailed(state, range);
    expect(state.failed).toBe(true);
    state = loadStarted(state, range);
    expect(state.failed).toBe(false);
    state = loadSucceeded(state, range, []);
    expect(state.events).toEqual([]);
    expect(state.failed).toBe(false);
  });

  it('a stale failure for a superseded range is ignored', () => {
    const oldRange = { from: '2026-08-24', to: '2026-09-20' };
    const newRange = { from: '2026-10-05', to: '2026-11-01' };
    let state = loadStarted(INITIAL_CALENDAR_STATE, oldRange);
    state = loadStarted(state, newRange);
    state = loadFailed(state, oldRange);
    expect(state.failed).toBe(false);
  });
});
