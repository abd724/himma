/**
 * RI-5 — pure presentation over the certified unified Calendar read.
 * Display derivation ONLY: the backend is the one aggregation authority —
 * every event arrives fully derived (camp daily occurrences, cohort
 * recurrences minus exceptions, immutable membership schedule occurrences,
 * reserved sessions already deduplicated). Nothing here expands recurrence
 * rules, generates dates from spans, infers attendance, or dissects the
 * OPAQUE `eventKey` (React keys / defensive dedup only); navigation uses
 * the explicit `bookingId`/`entitlementId` fields.
 *
 * Timezone rule (owner item 11): camp/cohort events carry the EXPLICIT
 * canonical civil `occurrence` pair — day grouping and time labels use it
 * verbatim (the cross-midnight invariant holds by construction: a Monday
 * 00:30 occurrence renders under Monday 00:30 whatever the device clock
 * says). Instant-only events (sessions, membership occurrences) group and
 * label from the SAME server instant, so a card can never show a day and
 * a time derived from different truths.
 */
import type { CalendarOccurrence } from '@/services/contracts/entitlements';
import { displayTime } from '@/features/passes/passes-presentation';
import { civilDateInZone, timeLabelInZone } from '@/utils/venue-time';

/** Local civil date (YYYY-MM-DD) of a Date — presentation only. */
export function civilDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(year!, month! - 1, day! + days);
  return civilDate(next);
}

/** Monday-start week anchor for a civil date. */
export function weekStart(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(year!, month! - 1, day!);
  const offset = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(date, -offset);
}

export function weekDates(start: string): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addDays(start, offset));
}

/**
 * The bounded request window covering a visible week: one week back and
 * three ahead of the week start (28 days — well inside the server's
 * 62-day maximum). Never unbounded, never from account creation.
 */
export function calendarWindow(selectedDate: string): { from: string; to: string } {
  const start = weekStart(selectedDate);
  return { from: addDays(start, -7), to: addDays(start, 20) };
}

/** The civil day an event belongs to: the explicit canonical occurrence
 *  date where the server supplies one; otherwise the VENUE-local day of
 *  the server start instant (RI-6 — the event's own `timezone`, never the
 *  device's: canonical UAE activity never drifts onto the wrong customer-
 *  facing day). Never derived from the event key. */
export function eventDay(event: CalendarOccurrence): string {
  return event.occurrence?.date ?? civilDateInZone(new Date(event.startAt), event.timezone);
}

/** Start-time label from the same truth the day grouping uses. */
export function eventTimeLabel(event: CalendarOccurrence): string {
  if (event.occurrence !== undefined) return displayTime(event.occurrence.startTime);
  return timeLabelInZone(new Date(event.startAt), event.timezone);
}

/** Customer wording for the server event context — never backend
 *  vocabulary. `booked` needs no badge. */
export function contextLabel(event: CalendarOccurrence): string | null {
  switch (event.context) {
    case 'reservedWithPass':
      return 'Included with pass';
    case 'includedSchedule':
      return 'Membership schedule';
    case 'booked':
      return null;
  }
}

function shortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
  });
}

/** Camp supporting line from the server span METADATA (presentation only —
 *  daily occurrences arrive individually from the server, never generated
 *  from this span). */
export function spanLine(event: CalendarOccurrence): string | null {
  if (event.span === undefined) return null;
  return `Camp week · ${shortDate(event.span.startDate)} – ${shortDate(event.span.endDate)}`;
}

export type CalendarEventTarget =
  | { kind: 'booking'; bookingId: string }
  | { kind: 'pass'; entitlementId: string };

/**
 * Where opening an event navigates — EXPLICIT server identifiers only
 * (owner items 12–13): a Booking-backed event opens Booking detail; an
 * Entitlement-owned occurrence opens the Pass. The opaque key is never a
 * navigation source; an event with neither id renders read-only.
 */
export function eventTarget(event: CalendarOccurrence): CalendarEventTarget | null {
  if (event.bookingId !== undefined) return { kind: 'booking', bookingId: event.bookingId };
  if (event.entitlementId !== undefined) {
    return { kind: 'pass', entitlementId: event.entitlementId };
  }
  return null;
}

/**
 * Server-ordered events for one day, defensively deduplicated by the
 * OPAQUE event key only (owner item 8 — the backend owns business
 * deduplication; the app never re-merges by program/time/participant, so
 * two children's same-time activities always stay distinct events).
 */
export function eventsForDay(
  events: CalendarOccurrence[],
  day: string,
): CalendarOccurrence[] {
  const seen = new Set<string>();
  const out: CalendarOccurrence[] = [];
  for (const event of events) {
    if (eventDay(event) !== day || seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    out.push(event);
  }
  return out.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
}

/** The set of days in a range that hold at least one event (chip dots). */
export function daysWithEvents(events: CalendarOccurrence[]): Set<string> {
  return new Set(events.map(eventDay));
}

export function dayHeading(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  const [year, month, dayNo] = day.split('-').map(Number);
  return new Date(year!, month! - 1, dayNo!).toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
}

export function chipLabels(day: string): { weekday: string; day: string } {
  const [year, month, dayNo] = day.split('-').map(Number);
  const date = new Date(year!, month! - 1, dayNo!);
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'short' }),
    day: `${date.getDate()}`,
  };
}

/** 'Aug 31 – Sep 6' — the visible week range label. */
export function weekRangeLabel(start: string): string {
  const end = addDays(start, 6);
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const startLabel = new Date(sy!, sm! - 1, sd!).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const endLabel = new Date(ey!, em! - 1, ed!).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return `${startLabel} – ${endLabel}`;
}
