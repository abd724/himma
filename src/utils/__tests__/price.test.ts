import { describe, expect, test } from '@jest/globals';
import { formatPrice, priceLabel, programFormatLabel, spokenPriceLabel } from '@/utils/price';

describe('Price formatting — every pricing model (docs/05 §6)', () => {
  test('formatPrice splits amount and unit per model', () => {
    expect(formatPrice({ kind: 'dropIn', amount: 85 })).toEqual({
      amount: 'AED 85',
      unit: 'per session',
    });
    expect(formatPrice({ kind: 'monthly', amount: 450 })).toEqual({
      amount: 'AED 450',
      unit: '/month',
    });
    expect(formatPrice({ kind: 'term', amount: 1800 })).toEqual({
      amount: 'AED 1,800',
      unit: 'per term',
    });
    expect(formatPrice({ kind: 'camp', amountPerWeek: 1250 })).toEqual({
      amount: 'AED 1,250',
      unit: '/week',
    });
    expect(formatPrice({ kind: 'package', amount: 400, sessions: 5 })).toEqual({
      amount: 'AED 400',
      unit: 'for 5 sessions',
    });
    expect(formatPrice({ kind: 'free' })).toEqual({ amount: 'Free', unit: '' });
    expect(formatPrice({ kind: 'freeTrial' })).toEqual({ amount: 'Free', unit: 'trial' });
  });

  test('priceLabel joins into one customer line', () => {
    expect(priceLabel({ kind: 'dropIn', amount: 85 })).toBe('AED 85 per session');
    expect(priceLabel({ kind: 'free' })).toBe('Free');
  });

  test('spoken prices expand currency and units for screen readers', () => {
    expect(spokenPriceLabel({ kind: 'dropIn', amount: 85 })).toBe('85 dirhams per session');
    expect(spokenPriceLabel({ kind: 'monthly', amount: 450 })).toBe('450 dirhams per month');
    expect(spokenPriceLabel({ kind: 'camp', amountPerWeek: 1250 })).toBe('1,250 dirhams per week');
    expect(spokenPriceLabel({ kind: 'free' })).toBe('Free');
  });

  test('format labels map the commercial shape; camps win over price kind', () => {
    expect(programFormatLabel({ price: { kind: 'dropIn', amount: 85 }, isCamp: false })).toBe(
      'Drop-in',
    );
    expect(
      programFormatLabel({ price: { kind: 'camp', amountPerWeek: 850 }, isCamp: true }),
    ).toBe('Camp');
    expect(programFormatLabel({ price: { kind: 'free' }, isCamp: false })).toBe('Free session');
  });
});
