import type { CheckoutPage } from '@/services/contracts/checkout';

/**
 * Checkout-local UI state — docs/22 §5/§9/§11, owner decisions docs/09 §22.
 * The only state checkout owns is the selected payment method; the order
 * itself lives in the booking draft and is never duplicated here. No
 * acceptance state exists (docs/09 §22.7). The state is component-local, so
 * leaving checkout discards it structurally and re-entry starts clean.
 */
export interface CheckoutUiState {
  paymentMethodId?: string;
}

export type CheckoutUiAction =
  | { type: 'selectMethod'; paymentMethodId: string }
  | { type: 'reset' };

export const initialCheckoutUiState: CheckoutUiState = {};

export function checkoutReducer(state: CheckoutUiState, action: CheckoutUiAction): CheckoutUiState {
  switch (action.type) {
    case 'selectMethod':
      return { ...state, paymentMethodId: action.paymentMethodId };
    case 'reset':
      return initialCheckoutUiState;
  }
}

export interface CheckoutReadiness {
  ready: boolean;
  /** Named reason the CTA is not ready — the CTA is never unready without a
   * visible reason (docs/22 §9). */
  blocker?: string;
}

/** The single approved blocker line (docs/22 §9). */
export const PAYMENT_METHOD_BLOCKER = 'Choose a payment method to continue';

/**
 * The single readiness rule for the checkout CTA — docs/22 §9. Free bookings
 * are always ready; paid bookings require the generic contract method to be
 * selected and selectable (an 'unavailable' method never satisfies
 * readiness — honest disablement, docs/22 §7.5). When ready, the press
 * remains the docs/09 §22.11 inert contract — readiness gates nothing else.
 */
export function checkoutReadiness(
  page: Pick<CheckoutPage, 'paymentRequired' | 'paymentMethods'>,
  state: CheckoutUiState,
): CheckoutReadiness {
  if (!page.paymentRequired) return { ready: true };
  const selected = page.paymentMethods.find((method) => method.id === state.paymentMethodId);
  if (selected === undefined || selected.availability.status !== 'contractOnly') {
    return { ready: false, blocker: PAYMENT_METHOD_BLOCKER };
  }
  return { ready: true };
}
