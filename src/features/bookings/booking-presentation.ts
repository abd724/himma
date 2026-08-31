/**
 * RI-3 — pure presentation/categorization over the certified own-booking
 * projection. Display derivation only; nothing here creates truth.
 */
import type { CustomerBooking } from '@/services/contracts/commerce';

/** The unit's start instant (sessions) or start day (camps/cohorts). */
export function bookingStart(booking: CustomerBooking): Date | null {
  if (booking.unit.startAt !== null) return new Date(booking.unit.startAt);
  if (booking.unit.startDate !== null) return new Date(`${booking.unit.startDate}T00:00:00`);
  if (booking.unit.effectiveStart !== null) {
    return new Date(`${booking.unit.effectiveStart}T00:00:00`);
  }
  return null;
}

export function bookingWhenLabel(booking: CustomerBooking, now: Date = new Date()): string {
  const start = bookingStart(booking);
  if (start === null) return '';
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const dayLabel = sameDay(start, now)
    ? 'Today'
    : sameDay(start, tomorrow)
      ? 'Tomorrow'
      : start.toLocaleDateString('en-US', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
        });
  if (booking.unit.startAt !== null) {
    const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${dayLabel} · ${time}`;
  }
  if (booking.unit.kind === 'campWeek') return `Week of ${dayLabel}`;
  return `Starts ${dayLabel}`;
}

export function bookingPriceLabel(booking: CustomerBooking): string {
  // RI-4 (S6-3 item 26): an entitlement-reserved Booking is paid-for by the
  // customer's pass — the SERVER flag decides, never the AED 0 amount; a
  // provider's genuinely free session still reads "Free".
  if (booking.coveredByEntitlement) return 'Included with pass';
  if (booking.price.totalFils === 0) return 'Free';
  return `AED ${(booking.price.totalFils / 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })}`;
}

export type BookingCategory =
  | 'upcoming'
  | 'past'
  | 'pendingPayment'
  | 'notCompleted';

/**
 * Truthful My Bookings categorization (owner RI-3 §20): only CONFIRMED
 * bookings appear as bookings; `pending_payment` needs the status read;
 * expired/failed attempts are history, never confirmed.
 */
export function categorizeBooking(
  booking: CustomerBooking,
  now: Date = new Date(),
): BookingCategory {
  if (booking.state === 'confirmed' || booking.state === 'completed') {
    const start = bookingStart(booking);
    if (booking.state === 'completed') return 'past';
    if (start === null) return 'upcoming';
    return start.getTime() >= now.getTime() - 60 * 60 * 1000 ? 'upcoming' : 'past';
  }
  if (booking.state === 'pending_payment') return 'pendingPayment';
  return 'notCompleted';
}

export interface BookingSections {
  pendingPayment: CustomerBooking[];
  upcoming: CustomerBooking[];
  past: CustomerBooking[];
  notCompleted: CustomerBooking[];
}

export function sectionBookings(
  bookings: CustomerBooking[],
  now: Date = new Date(),
): BookingSections {
  const sections: BookingSections = { pendingPayment: [], upcoming: [], past: [], notCompleted: [] };
  for (const booking of bookings) {
    sections[categorizeBooking(booking, now)].push(booking);
  }
  const startTime = (booking: CustomerBooking) => bookingStart(booking)?.getTime() ?? 0;
  sections.upcoming.sort((a, b) => startTime(a) - startTime(b));
  sections.past.sort((a, b) => startTime(b) - startTime(a));
  return sections;
}
