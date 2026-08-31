/**
 * RI-6 — venue-local time presentation (owner item 20).
 *
 * Scheduled activity is VENUE truth: a canonical UAE session must never
 * move onto a different customer-facing civil day merely because the
 * device timezone changed. Server DTOs carry the explicit venue
 * `timezone` (IANA) next to every schedule instant; these helpers format
 * instants IN that zone via `Intl.DateTimeFormat` — no offset arithmetic,
 * no recurrence math, no device-clock authority.
 *
 * `PLATFORM_TIME_ZONE` mirrors the backend's structurally pinned platform
 * timezone (docs/24: Asia/Dubai server time authority; the
 * `recurring_schedule` CHECK). It is used ONLY as the anchor for "today"
 * when no event is in hand yet (calendar window/selection, day offsets) —
 * event presentation always prefers the DTO's own `timezone`/civil
 * fields.
 */

export const PLATFORM_TIME_ZONE = 'Asia/Dubai';

/** The civil date (YYYY-MM-DD) of an instant in a venue timezone. */
export function civilDateInZone(instant: Date, timeZone: string): string {
  // en-CA yields ISO-shaped YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** '6:00 PM' — the venue-local time of an instant. */
export function timeLabelInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}

/** 'Mon 7' / 'Monday, 7 Sep' style parts for a venue-local instant. */
export function dateLabelInZone(
  instant: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(instant);
}

/** Today's civil date in the platform venue timezone. */
export function platformToday(now: Date = new Date()): string {
  return civilDateInZone(now, PLATFORM_TIME_ZONE);
}

/** Whole-day difference between two civil date strings (tz-free math). */
export function civilDayDiff(day: string, from: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
