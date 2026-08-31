/**
 * RI-6 — booking when-labels in VENUE terms (owner item 20): a
 * Dubai-midnight session keeps its venue civil day on any device
 * timezone. Deterministic regardless of the host timezone (Intl-based).
 */
import { describe, expect, it } from '@jest/globals';
import { bookingPriceLabel, bookingWhenLabel } from '@/features/bookings/booking-presentation';
import type { CustomerBooking } from '@/services/contracts/commerce';

function booking(partial: Partial<CustomerBooking['unit']>): CustomerBooking {
  return {
    bookingId: 'bk-1',
    referenceCode: 'HM-1',
    state: 'confirmed',
    participant: { id: 'p-1', firstName: 'Sara' },
    program: { id: 'prog-1', titleEn: 'Lap swimming' },
    provider: { id: 'org-1', displayName: 'Marina Aquatics' },
    branch: null,
    unit: {
      kind: 'session',
      unitId: 'u-1',
      startAt: '2026-09-06T20:30:00.000Z',
      startDate: null,
      effectiveStart: null,
      timezone: 'Asia/Dubai',
      ...partial,
    },
    price: { totalFils: 0, currency: 'AED' },
    coveredByEntitlement: false,
    entitlementId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    confirmedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('venue-local when-labels', () => {
  it('CROSS-MIDNIGHT: a Monday 00:30 Dubai session labels the DUBAI day and time whatever the device zone', () => {
    // 20:30 UTC Sunday = 00:30 Monday in Dubai.
    const label = bookingWhenLabel(booking({}), new Date('2026-09-01T12:00:00.000Z'));
    expect(label).toMatch(/Mon/); // Monday 7 Sep — the venue civil day
    expect(label).toContain('12:30 AM');
  });

  it('Today/Tomorrow resolve in the VENUE frame', () => {
    // At 21:00 UTC on the 6th it is ALREADY the 7th in Dubai → "Today".
    expect(bookingWhenLabel(booking({}), new Date('2026-09-06T21:00:00.000Z'))).toBe(
      'Today · 12:30 AM',
    );
    expect(bookingWhenLabel(booking({}), new Date('2026-09-05T21:00:00.000Z'))).toBe(
      'Tomorrow · 12:30 AM',
    );
  });

  it('camp/cohort civil dates label timezone-free', () => {
    expect(
      bookingWhenLabel(
        booking({ kind: 'campWeek', startAt: null, startDate: '2026-09-07' }),
        new Date('2026-09-01T12:00:00.000Z'),
      ),
    ).toMatch(/^Week of Mon/);
    expect(
      bookingWhenLabel(
        booking({ kind: 'enrolmentCohort', startAt: null, effectiveStart: '2026-09-07' }),
        new Date('2026-09-01T12:00:00.000Z'),
      ),
    ).toMatch(/^Starts Mon/);
  });

  it('the server coverage flag owns the price wording (unchanged RI-4 truth)', () => {
    expect(bookingPriceLabel(booking({}))).toBe('Free');
    expect(bookingPriceLabel({ ...booking({}), coveredByEntitlement: true })).toBe(
      'Included with pass',
    );
  });
});
