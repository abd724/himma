import { describe, expect, test } from '@jest/globals';
import {
  spokenBookingPriceLabel,
  summaryParticipantBlock,
} from '@/features/booking/summary-presentation';
import type { Participant } from '@/types/domain';

/**
 * Summary presentation — docs/21 §8.3, §14. Synthetic participants only
 * (docs/18 §3): nothing here depends on demo names or counts.
 */
const self: Participant = { id: 'me', label: 'Me', kind: 'self' };
const child: Participant = { id: 'p-child', label: 'Noor', kind: 'child', dateOfBirth: '2017-06-20' }; // 9

describe('summaryParticipantBlock', () => {
  test('the primary participant reads as You with a natural confirmation', () => {
    const block = summaryParticipantBlock(
      { participantId: 'me', label: 'Me', suitable: true, reason: 'Open to adults' },
      [self, child],
    );
    expect(block).toEqual({
      displayName: 'You',
      detailLine: undefined,
      confirmation: 'Suitable for you',
      accessibilityLabel: 'You, suitable for this program',
    });
  });

  test('a child shows the age and the re-asserted eligibility confirmation', () => {
    const block = summaryParticipantBlock(
      { participantId: 'p-child', label: 'Noor', suitable: true, reason: 'Noor is 9' },
      [self, child],
    );
    expect(block).toEqual({
      displayName: 'Noor',
      detailLine: 'Age 9',
      confirmation: 'Suitable for Noor (age 9)',
      accessibilityLabel: 'Noor, age 9, suitable for this program',
    });
  });
});

describe('spokenBookingPriceLabel (docs/21 §14)', () => {
  test('currency and separator become natural speech', () => {
    expect(spokenBookingPriceLabel('Booking price · AED 85 per session')).toBe(
      'Booking price, 85 dirhams per session',
    );
    expect(spokenBookingPriceLabel('Booking price · AED 1,800 per term')).toBe(
      'Booking price, 1,800 dirhams per term',
    );
    expect(spokenBookingPriceLabel('Booking price · AED 480')).toBe(
      'Booking price, 480 dirhams',
    );
  });

  test('free stays Free', () => {
    expect(spokenBookingPriceLabel('Booking price · Free')).toBe('Booking price, Free');
  });
});
