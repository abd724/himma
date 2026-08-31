/**
 * RI-4 — pure presentation over the certified Passes & Memberships
 * projections. Display derivation ONLY: every number/status arrives from
 * the server; nothing here computes usage, infers status from device time,
 * or touches canonical occurrence identity — the explicit server
 * `occurrence` DTO passes through verbatim and event keys stay OPAQUE
 * (owner RI-4 correction; docs/35 §28).
 */
import type {
  CalendarOccurrence,
  CustomerEntitlement,
  EntitlementScheduleTerm,
  FiniteBalance,
} from '@/services/contracts/entitlements';

/** 'Used up' is the customer word for the server's `exhausted`. */
export function statusPresentation(status: CustomerEntitlement['status']): {
  label: string;
  tone: 'positive' | 'neutral';
} {
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'positive' };
    case 'exhausted':
      return { label: 'Used up', tone: 'neutral' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral' };
  }
}

/** The headline balance: ':remaining of :total visits remaining' —
 *  `remaining` is the SERVER's `usesTotal − used`, never conflated with
 *  what can still be reserved (docs/35 §8). */
export function finiteHeadline(finite: FiniteBalance): string {
  const noun = finite.usesTotal === 1 ? 'visit' : 'visits';
  return `${finite.remaining} of ${finite.usesTotal} ${noun} remaining`;
}

/**
 * The truthful commitment line, shown when reservations hold credits: the
 * customer sees BOTH truths — reserved visits stay theirs (never displayed
 * as gone) while newly bookable availability is stated separately.
 */
export function finiteCommitmentLine(finite: FiniteBalance): string | null {
  if (finite.reservedUpcoming === 0) return null;
  const reservedNoun = finite.reservedUpcoming === 1 ? 'visit' : 'visits';
  return `${finite.reservedUpcoming} ${reservedNoun} reserved for upcoming sessions · ${finite.availableToReserve} more can be booked`;
}

export function validityLine(entitlement: CustomerEntitlement): string {
  if (entitlement.validUntil === null) return 'No end date';
  const until = new Date(entitlement.validUntil);
  const label = until.toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return entitlement.status === 'expired' ? `Expired ${label}` : `Valid until ${label}`;
}

/** Customer wording of the purchased fulfillment methods. */
export function methodsLine(entitlement: CustomerEntitlement): string {
  if (entitlement.reservationRequired && entitlement.walkInAllowed) {
    return 'Book sessions ahead, or walk in and check in with a code';
  }
  if (entitlement.reservationRequired) return 'Book your sessions ahead in the app';
  return 'Walk in and check in with a code';
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** '7:00 PM' from the server's HH:MM. */
export function displayTime(time: string): string {
  const [hourRaw, minute] = time.split(':');
  const hour = Number(hourRaw);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minute} ${period}`;
}

/** 'Mon & Wed · 7:00 PM–8:00 PM' summaries of the purchased schedule. */
export function scheduleSummaryLines(terms: EntitlementScheduleTerm[]): string[] {
  const byTime = new Map<string, { weekdays: number[]; startTime: string; endTime: string }>();
  for (const term of terms) {
    const key = `${term.startTime}-${term.endTime}`;
    const entry = byTime.get(key) ?? { weekdays: [], startTime: term.startTime, endTime: term.endTime };
    entry.weekdays.push(term.weekday);
    byTime.set(key, entry);
  }
  return [...byTime.values()].map((entry) => {
    const days = [...entry.weekdays]
      .sort((a, b) => a - b)
      .map((weekday) => WEEKDAY_LABELS[weekday] ?? '')
      .join(' & ');
    return `${days} · ${displayTime(entry.startTime)}–${displayTime(entry.endTime)}`;
  });
}

/** '1234 5678' — the approved 4-4 display grouping of the 8-digit code. */
export function displayCodeGroups(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

export interface OccurrenceChoice {
  date: string;
  startTime: string;
  dayLabel: string;
  timeLabel: string;
}

/**
 * Selectable canonical occurrences for ONE booking, from the bounded
 * server occurrence read. The canonical pair is the backend's EXPLICIT
 * `occurrence` DTO passed through VERBATIM (owner RI-4 correction: the
 * event key is opaque identity — never parsed, never a string-encoded
 * domain payload); labels derive from the server instants for display
 * only and never feed the authority.
 */
export function occurrenceChoices(
  events: CalendarOccurrence[],
  bookingId: string,
): OccurrenceChoice[] {
  const choices: OccurrenceChoice[] = [];
  for (const event of events) {
    if (event.bookingId !== bookingId || event.occurrence === undefined) continue;
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    choices.push({
      date: event.occurrence.date,
      startTime: event.occurrence.startTime,
      dayLabel: start.toLocaleDateString('en-US', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }),
      timeLabel: `${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
    });
  }
  return choices;
}
