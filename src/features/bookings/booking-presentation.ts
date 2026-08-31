/**
 * RI-3 — pure presentation/categorization over the certified own-booking
 * projection. Display derivation only; nothing here creates truth.
 *
 * RI-6 — when-labels present in the unit's VENUE timezone (the server's
 * explicit `unit.timezone`), never the device's: a Dubai-midnight session
 * never drifts onto the wrong customer-facing civil day. Camp/cohort
 * civil dates are timezone-free by construction.
 */
import type { CustomerBooking } from '@/services/contracts/commerce';
import { civilDateInZone, civilDayDiff, dateLabelInZone, timeLabelInZone } from '@/utils/venue-time';

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
  const timezone = booking.unit.timezone;
  // Civil day in the venue frame: sessions from the instant, camps/cohorts
  // from their explicit civil dates.
  const venueDay =
    booking.unit.startAt !== null
      ? civilDateInZone(new Date(booking.unit.startAt), timezone)
      : (booking.unit.startDate ?? booking.unit.effectiveStart);
  if (venueDay === null) return '';
  const offset = civilDayDiff(venueDay, civilDateInZone(now, timezone));
  const [year, month, dayNo] = venueDay.split('-').map(Number);
  const dayLabel =
    offset === 0
      ? 'Today'
      : offset === 1
        ? 'Tomorrow'
        : booking.unit.startAt !== null
          ? dateLabelInZone(new Date(booking.unit.startAt), timezone, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })
          : new Date(year!, month! - 1, dayNo!).toLocaleDateString('en-US', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            });
  if (booking.unit.startAt !== null) {
    const time = timeLabelInZone(new Date(booking.unit.startAt), timezone);
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
