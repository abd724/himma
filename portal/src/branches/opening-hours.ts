/**
 * Weekly opening hours over `branch.opening_hours` (jsonb, nullable).
 *
 * Canon (docs/24 §1.3, docs/27 §4): the column holds "structured weekly
 * hours" and display formatting is a client concern — but the implemented
 * service layer performs NO shape validation yet (`Type.Any()` passthrough),
 * and no canonical JSON encoding has been ratified anywhere. W2-5 therefore
 * uses ONE conservative weekly encoding, kept entirely inside this module,
 * and records the gap (see HANDOFF): the encoding must be ratified with the
 * backend's promised service-layer validation before W2-12 writes it to
 * production. Reading is tolerant — any value this module does not
 * recognise renders as "not set" and is NEVER rewritten unless the provider
 * deliberately edits hours (dirty-field PATCH semantics).
 *
 * Encoding: `null` = no hours recorded; otherwise an object keyed by day
 * (`mon`…`sun`); each present day maps to `{ open: 'HH:MM', close: 'HH:MM' }`;
 * an absent day means closed/not stated.
 */

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type WeekDay = (typeof WEEK_DAYS)[number];

export const WEEK_DAY_LABELS: Record<WeekDay, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface DayHours {
  /** 24-hour 'HH:MM'. */
  readonly open: string;
  readonly close: string;
}

export type WeeklyOpeningHours = Partial<Record<WeekDay, DayHours>>;

const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(value: string): boolean {
  return TIME_SHAPE.test(value);
}

function parseDay(value: unknown): DayHours | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as { open?: unknown; close?: unknown };
  if (
    typeof candidate.open !== 'string' ||
    typeof candidate.close !== 'string' ||
    !isValidTime(candidate.open) ||
    !isValidTime(candidate.close)
  ) {
    return null;
  }
  return { open: candidate.open, close: candidate.close };
}

/**
 * Tolerant read of the stored jsonb value. `null` when nothing usable is
 * recorded (including legacy/unknown shapes — those are shown as "not set"
 * and left untouched on disk unless the provider edits hours).
 */
export function parseOpeningHours(value: unknown): WeeklyOpeningHours | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const parsed: Partial<Record<WeekDay, DayHours>> = {};
  let any = false;
  for (const day of WEEK_DAYS) {
    const dayValue = record[day];
    if (dayValue === undefined || dayValue === null) {
      continue;
    }
    const hours = parseDay(dayValue);
    if (hours === null) {
      // One unrecognisable day makes the whole value unusable — a partial
      // reinterpretation could silently drop data on the next save.
      return null;
    }
    parsed[day] = hours;
    any = true;
  }
  return any ? parsed : null;
}

/** The value written back to `openingHours` — `null` when no day is open. */
export function serializeOpeningHours(hours: WeeklyOpeningHours): WeeklyOpeningHours | null {
  const days = WEEK_DAYS.filter((day) => hours[day] !== undefined);
  if (days.length === 0) {
    return null;
  }
  const out: Partial<Record<WeekDay, DayHours>> = {};
  for (const day of days) {
    const dayHours = hours[day];
    if (dayHours !== undefined) {
      out[day] = dayHours;
    }
  }
  return out;
}

/** 'HH:MM' → provider-friendly '6:00 AM'. */
export function formatTime(value: string): string {
  if (!isValidTime(value)) {
    return value;
  }
  const [hourPart = '0', minutePart = '00'] = value.split(':');
  const hour = Number(hourPart);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minutePart} ${suffix}`;
}
