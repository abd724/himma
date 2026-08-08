/**
 * Deterministic AED ⇄ integer-fils conversion (W2-8 §29).
 *
 * Fils are the ONLY canonical money representation anywhere in the portal
 * (100 fils = AED 1 — the backend stores `amount_fils` integers). AED
 * strings exist purely at the input boundary, and every conversion is exact
 * integer arithmetic over the digit text: no parseFloat, no `* 100`, no
 * floating-point representation of money at any point.
 */

/** AED 9,999,999.99 — a generous input bound far below any real price;
 *  keeps every intermediate integer safely inside Number precision. */
export const MAX_AMOUNT_FILS = 999_999_999;

export type AedParseResult =
  | { readonly kind: 'fils'; readonly fils: number }
  | {
      readonly kind: 'invalid';
      readonly reason: 'empty' | 'notANumber' | 'tooManyDecimals' | 'notPositive' | 'tooLarge';
    };

/** Strict shape: plain digits, optionally one dot and 1–2 decimals. A comma,
 *  currency symbol, sign, exponent, or bare/trailing dot is refused — the
 *  provider sees exactly why instead of a silent reinterpretation. */
const AED_SHAPE = /^(\d+)(?:\.(\d+))?$/;

export function parseAedToFils(raw: string): AedParseResult {
  const text = raw.trim();
  if (text === '') return { kind: 'invalid', reason: 'empty' };
  const match = AED_SHAPE.exec(text);
  if (match === null) return { kind: 'invalid', reason: 'notANumber' };
  const whole = match[1]!;
  const decimals = match[2] ?? '';
  if (decimals.length > 2) return { kind: 'invalid', reason: 'tooManyDecimals' };
  // 8 whole digits = up to AED 99,999,999 — bounded before any arithmetic.
  if (whole.length > 8) return { kind: 'invalid', reason: 'tooLarge' };
  const fils = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (fils === 0) return { kind: 'invalid', reason: 'notPositive' };
  if (fils > MAX_AMOUNT_FILS) return { kind: 'invalid', reason: 'tooLarge' };
  return { kind: 'fils', fils };
}

/** Minimal editable rendering of an integer-fils amount ("450", "450.50").
 *  Exact inverse of parseAedToFils for every representable amount. */
export function filsToAedInput(fils: number): string {
  const whole = Math.trunc(fils / 100);
  const cents = fils % 100;
  return cents === 0 ? `${whole}` : `${whole}.${String(cents).padStart(2, '0')}`;
}

export type SessionsParseResult =
  | { readonly kind: 'sessions'; readonly sessions: number }
  | { readonly kind: 'invalid' };

/** Package tie: a positive integer session count (bounded sanity limit). */
export function parseSessionsCount(raw: string): SessionsParseResult {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { kind: 'invalid' };
  const sessions = Number(text);
  if (sessions < 1 || sessions > 10_000) return { kind: 'invalid' };
  return { kind: 'sessions', sessions };
}
