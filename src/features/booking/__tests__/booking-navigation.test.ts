import { describe, expect, test } from '@jest/globals';
import { bookingHref, bookingStepHref } from '@/features/booking/booking-navigation';

/** Booking-route policy — docs/21 §3: one flow, one entry, no duplicates. */
describe('booking hrefs', () => {
  test('flow start', () => {
    expect(bookingHref('beginner-calisthenics')).toBe('/booking/beginner-calisthenics');
  });

  test('step routes', () => {
    expect(bookingStepHref('beginner-calisthenics', 'participant')).toBe(
      '/booking/beginner-calisthenics/participant',
    );
    expect(bookingStepHref('beginner-calisthenics', 'summary')).toBe(
      '/booking/beginner-calisthenics/summary',
    );
  });
});
