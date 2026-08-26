/**
 * RI-3 — the OWNER-APPROVED payment status copy (docs/34 §12.1 D-RI-5).
 * Copy follows the AUTHORITATIVE server status only; browser return can
 * never select the payment-received wording.
 */
import type { CustomerPaymentStatusName } from '@/services/contracts/commerce';

export interface PaymentStatusPresentation {
  title: string;
  body: string;
  tone: 'progress' | 'success' | 'expired' | 'compensation';
  terminal: boolean;
}

export const PAYMENT_STATUS_COPY: Record<CustomerPaymentStatusName, PaymentStatusPresentation> = {
  awaitingPayment: {
    title: 'Checking your payment',
    body: "We're checking your payment status…",
    tone: 'progress',
    terminal: false,
  },
  processing: {
    title: 'Payment received',
    body: 'Payment received — confirming your booking…',
    tone: 'progress',
    terminal: false,
  },
  confirmed: {
    title: 'Booking confirmed',
    body: 'Your booking is confirmed.',
    tone: 'success',
    terminal: true,
  },
  expired: {
    title: 'Checkout window closed',
    body: 'This checkout has expired. Your card was not charged by this checkout.',
    tone: 'expired',
    terminal: true,
  },
  compensationPending: {
    title: 'Spot no longer available',
    body: 'Your payment was received, but the spot was no longer available. Your payment is being returned.',
    tone: 'compensation',
    terminal: false,
  },
  compensated: {
    title: 'Payment returned',
    body: 'Your payment has been returned because the spot was no longer available.',
    tone: 'compensation',
    terminal: true,
  },
};
