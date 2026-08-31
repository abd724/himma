/**
 * RI-5 — the bounded Calendar loading controller (pure state; the screen
 * renders what it holds). One bounded server request covers the visible
 * range (owner item 25 — never per-day/per-event/per-entitlement); a
 * server re-read REPLACES the held events wholesale (owner item 21 —
 * nothing optimistic is inserted, nothing stale is merged back, so a new
 * reservation appears exactly once after refresh and a redeemed check-in
 * never duplicates an event).
 */
import type { CalendarOccurrence } from '@/services/contracts/entitlements';
import { addDays, calendarWindow, weekStart } from '@/features/calendar/calendar-presentation';

export interface CalendarRange {
  from: string;
  to: string;
}

export interface CalendarLoadState {
  /** The bounded range the held events cover (null before the first load). */
  range: CalendarRange | null;
  /** Server truth for `range` — null while loading it. */
  events: CalendarOccurrence[] | null;
  failed: boolean;
}

export const INITIAL_CALENDAR_STATE: CalendarLoadState = {
  range: null,
  events: null,
  failed: false,
};

function covers(range: CalendarRange, day: string): boolean {
  return range.from <= day && day <= range.to;
}

/**
 * The request the selected date requires, or null when the held range
 * already covers its whole visible week (the window prefetches
 * neighboring weeks, so adjacent-week navigation reuses the loaded
 * range). `force` re-reads the current range (focus/booking-change
 * refresh — server truth replaces the list).
 */
export function requiredRequest(
  state: CalendarLoadState,
  selectedDate: string,
  force = false,
): CalendarRange | null {
  const start = weekStart(selectedDate);
  if (force || state.range === null || state.events === null) {
    return calendarWindow(selectedDate);
  }
  if (covers(state.range, start) && covers(state.range, addDays(start, 6))) return null;
  return calendarWindow(selectedDate);
}

export function loadStarted(state: CalendarLoadState, range: CalendarRange): CalendarLoadState {
  const sameRange =
    state.range !== null && state.range.from === range.from && state.range.to === range.to;
  return {
    range,
    // A refresh of the SAME range keeps the current events visible while
    // the re-read runs; a new range shows the loading state.
    events: sameRange ? state.events : null,
    failed: false,
  };
}

export function loadSucceeded(
  state: CalendarLoadState,
  range: CalendarRange,
  events: CalendarOccurrence[],
): CalendarLoadState {
  // A stale response for a superseded range never overwrites newer truth.
  if (state.range === null || state.range.from !== range.from || state.range.to !== range.to) {
    return state;
  }
  return { range, events, failed: false };
}

export function loadFailed(state: CalendarLoadState, range: CalendarRange): CalendarLoadState {
  if (state.range === null || state.range.from !== range.from || state.range.to !== range.to) {
    return state;
  }
  return { ...state, failed: true };
}
