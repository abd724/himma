import {
  filsToAedInput,
  MAX_AMOUNT_FILS,
  parseAedToFils,
  parseSessionsCount,
} from '../src/catalogue/money';

/**
 * W2-8 §29 — deterministic AED ⇄ integer-fils conversion. Fils are the ONLY
 * canonical money representation (100 fils = AED 1); AED strings exist only
 * at the input boundary and every conversion is exact integer arithmetic —
 * no parseFloat, no floating-point drift, no rounding surprises.
 */
describe('parseAedToFils (deterministic, integer-exact)', () => {
  test('whole AED amounts convert exactly', () => {
    expect(parseAedToFils('450')).toEqual({ kind: 'fils', fils: 45_000 });
    expect(parseAedToFils('1')).toEqual({ kind: 'fils', fils: 100 });
    expect(parseAedToFils('9999')).toEqual({ kind: 'fils', fils: 999_900 });
  });

  test('one- and two-decimal amounts convert exactly (no float drift)', () => {
    expect(parseAedToFils('450.5')).toEqual({ kind: 'fils', fils: 45_050 });
    expect(parseAedToFils('450.50')).toEqual({ kind: 'fils', fils: 45_050 });
    expect(parseAedToFils('0.01')).toEqual({ kind: 'fils', fils: 1 });
    expect(parseAedToFils('0.1')).toEqual({ kind: 'fils', fils: 10 });
    // The classic float trap: 19.99 * 100 === 1998.9999999999998.
    expect(parseAedToFils('19.99')).toEqual({ kind: 'fils', fils: 1_999 });
    expect(parseAedToFils('0.29')).toEqual({ kind: 'fils', fils: 29 });
    expect(parseAedToFils('1.15')).toEqual({ kind: 'fils', fils: 115 });
  });

  test('surrounding whitespace is tolerated; the value itself must be plain digits', () => {
    expect(parseAedToFils('  450  ')).toEqual({ kind: 'fils', fils: 45_000 });
  });

  test('empty and non-numeric input is refused', () => {
    expect(parseAedToFils('')).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(parseAedToFils('   ')).toEqual({ kind: 'invalid', reason: 'empty' });
    expect(parseAedToFils('abc')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('4 50')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('1,200')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('AED 45')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('45.')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('.5')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('1e3')).toEqual({ kind: 'invalid', reason: 'notANumber' });
    expect(parseAedToFils('Infinity')).toEqual({ kind: 'invalid', reason: 'notANumber' });
  });

  test('excessive decimal precision is refused, never rounded', () => {
    expect(parseAedToFils('19.999')).toEqual({ kind: 'invalid', reason: 'tooManyDecimals' });
    expect(parseAedToFils('0.001')).toEqual({ kind: 'invalid', reason: 'tooManyDecimals' });
  });

  test('zero and negative amounts are refused (paid options need a positive amount)', () => {
    expect(parseAedToFils('0')).toEqual({ kind: 'invalid', reason: 'notPositive' });
    expect(parseAedToFils('0.00')).toEqual({ kind: 'invalid', reason: 'notPositive' });
    expect(parseAedToFils('-5')).toEqual({ kind: 'invalid', reason: 'notANumber' });
  });

  test('amounts beyond the supported bound are refused', () => {
    expect(parseAedToFils('10000000')).toEqual({ kind: 'invalid', reason: 'tooLarge' });
    const max = parseAedToFils('9999999.99');
    expect(max).toEqual({ kind: 'fils', fils: MAX_AMOUNT_FILS });
  });
});

describe('filsToAedInput (round-trips through parseAedToFils)', () => {
  test('renders whole and fractional amounts minimally', () => {
    expect(filsToAedInput(45_000)).toBe('450');
    expect(filsToAedInput(45_050)).toBe('450.50');
    expect(filsToAedInput(1)).toBe('0.01');
    expect(filsToAedInput(1_999)).toBe('19.99');
  });

  test('every representable amount round-trips exactly', () => {
    for (const fils of [1, 10, 99, 100, 101, 1_999, 45_050, 120_000, MAX_AMOUNT_FILS]) {
      const rendered = filsToAedInput(fils);
      expect(parseAedToFils(rendered)).toEqual({ kind: 'fils', fils });
    }
  });
});

describe('parseSessionsCount (package tie)', () => {
  test('positive integers pass; everything else is refused', () => {
    expect(parseSessionsCount('8')).toEqual({ kind: 'sessions', sessions: 8 });
    expect(parseSessionsCount(' 12 ')).toEqual({ kind: 'sessions', sessions: 12 });
    expect(parseSessionsCount('')).toEqual({ kind: 'invalid' });
    expect(parseSessionsCount('0')).toEqual({ kind: 'invalid' });
    expect(parseSessionsCount('-3')).toEqual({ kind: 'invalid' });
    expect(parseSessionsCount('2.5')).toEqual({ kind: 'invalid' });
    expect(parseSessionsCount('abc')).toEqual({ kind: 'invalid' });
    expect(parseSessionsCount('10001')).toEqual({ kind: 'invalid' });
  });
});
