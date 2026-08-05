import { describe, expect, test } from '@jest/globals';
import {
  checkoutReadiness,
  checkoutReducer,
  CTA_DOUBLE_PRESS_WINDOW_MS,
  ctaPressAllowed,
  initialCheckoutUiState,
  PAYMENT_METHOD_BLOCKER,
  type CheckoutUiState,
} from '@/features/booking/checkout-state';
import type { PaymentMethod } from '@/services/contracts/checkout';

/**
 * Commit 17 pure-core tests — docs/22 §9/§11, owner decisions docs/09 §22.
 * Readiness pages are synthetic: only the fields the rule reads are shaped,
 * so no test depends on catalogue data (the service-level composition is
 * covered in services/__tests__/checkout.test.ts).
 */

const cardMethod: PaymentMethod = {
  id: 'card',
  kind: 'card',
  label: 'Card payment',
  availability: { status: 'contractOnly' },
};

const unavailableMethod: PaymentMethod = {
  id: 'apple-pay',
  kind: 'applePay',
  label: 'Apple Pay',
  availability: { status: 'unavailable', reason: 'Not available yet' },
};

/** Readiness reads only this slice of CheckoutPage — typed as exactly that. */
function pageWith(paymentRequired: boolean, methods: PaymentMethod[]) {
  return { paymentRequired, paymentMethods: methods };
}

describe('checkoutReducer (docs/22 §11)', () => {
  test('selectMethod stores the method id', () => {
    const state = checkoutReducer(initialCheckoutUiState, {
      type: 'selectMethod',
      paymentMethodId: 'card',
    });
    expect(state).toEqual({ paymentMethodId: 'card' });
  });

  test('re-selecting replaces the previous selection', () => {
    const first = checkoutReducer(initialCheckoutUiState, {
      type: 'selectMethod',
      paymentMethodId: 'card',
    });
    const second = checkoutReducer(first, { type: 'selectMethod', paymentMethodId: 'other' });
    expect(second).toEqual({ paymentMethodId: 'other' });
  });

  test('reset clears the selection (re-entry starts clean, docs/22 §5)', () => {
    const selected: CheckoutUiState = { paymentMethodId: 'card' };
    expect(checkoutReducer(selected, { type: 'reset' })).toEqual({});
  });

  test('reducer is pure — inputs are never mutated', () => {
    const before: CheckoutUiState = { paymentMethodId: 'card' };
    checkoutReducer(before, { type: 'selectMethod', paymentMethodId: 'other' });
    checkoutReducer(before, { type: 'reset' });
    expect(before).toEqual({ paymentMethodId: 'card' });
  });
});

describe('checkoutReadiness matrix (docs/22 §9)', () => {
  test('free booking is ready with no blocker and no method', () => {
    expect(checkoutReadiness(pageWith(false, []), {})).toEqual({ ready: true });
  });

  test('free booking stays ready regardless of stray UI state', () => {
    expect(checkoutReadiness(pageWith(false, []), { paymentMethodId: 'junk' })).toEqual({
      ready: true,
    });
  });

  test('paid booking without a selection names the blocker', () => {
    expect(checkoutReadiness(pageWith(true, [cardMethod]), {})).toEqual({
      ready: false,
      blocker: PAYMENT_METHOD_BLOCKER,
    });
  });

  test('paid booking with the contract method selected is ready', () => {
    expect(
      checkoutReadiness(pageWith(true, [cardMethod]), { paymentMethodId: 'card' }),
    ).toEqual({ ready: true });
  });

  test('a selection that matches no offered method never satisfies readiness', () => {
    expect(
      checkoutReadiness(pageWith(true, [cardMethod]), { paymentMethodId: 'unknown' }),
    ).toEqual({ ready: false, blocker: PAYMENT_METHOD_BLOCKER });
  });

  test('an unavailable method never satisfies readiness (docs/22 §7.5)', () => {
    expect(
      checkoutReadiness(pageWith(true, [cardMethod, unavailableMethod]), {
        paymentMethodId: 'apple-pay',
      }),
    ).toEqual({ ready: false, blocker: PAYMENT_METHOD_BLOCKER });
  });

  test('the blocker is the single approved status line', () => {
    expect(PAYMENT_METHOD_BLOCKER).toBe('Choose a payment method to continue');
  });
});

describe('ctaPressAllowed press gate (docs/22 §13, docs/09 §22.11)', () => {
  const unready = { ready: false, blocker: PAYMENT_METHOD_BLOCKER };
  const ready = { ready: true };

  test('an unready press never proceeds, regardless of timing', () => {
    expect(ctaPressAllowed(unready, 0, 10_000)).toBe(false);
    expect(ctaPressAllowed(unready, 0, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test('a ready first press passes the gate', () => {
    expect(ctaPressAllowed(ready, 0, CTA_DOUBLE_PRESS_WINDOW_MS)).toBe(true);
  });

  test('a duplicate press inside the window is swallowed', () => {
    const first = 10_000;
    expect(ctaPressAllowed(ready, first, first + CTA_DOUBLE_PRESS_WINDOW_MS - 1)).toBe(false);
  });

  test('a press after the window passes again (still the inert contract)', () => {
    const first = 10_000;
    expect(ctaPressAllowed(ready, first, first + CTA_DOUBLE_PRESS_WINDOW_MS)).toBe(true);
  });

  test('readiness gating and the press window compose: unready wins', () => {
    expect(ctaPressAllowed(unready, 0, CTA_DOUBLE_PRESS_WINDOW_MS * 10)).toBe(false);
  });
});
