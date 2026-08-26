/**
 * RI-3 — payment-status truth: the D-RI-5 copy set verbatim, the bounded
 * polling cadence, and the COMPENSATION sequence — a compensating payment
 * never presents as confirmed at any point (owner §15/§16/§18/§32
 * app-side proof; the backend race itself is proven by the standing W5-4
 * suites).
 */
import { describe, expect, it } from '@jest/globals';
import {
  nextPoll,
  POLL_BUDGET_MS,
  POLL_COMPENSATION_MS,
  POLL_FAILURE_MAX_MS,
} from '@/features/bookings/payment-polling';
import { PAYMENT_STATUS_COPY } from '@/features/bookings/payment-status-copy';
import type { CustomerPaymentStatusName } from '@/services/contracts/commerce';

describe('D-RI-5 copy (owner-approved, verbatim)', () => {
  it('carries the exact approved wording per authoritative status', () => {
    expect(PAYMENT_STATUS_COPY.awaitingPayment.body).toBe("We're checking your payment status…");
    expect(PAYMENT_STATUS_COPY.processing.body).toBe(
      'Payment received — confirming your booking…',
    );
    expect(PAYMENT_STATUS_COPY.compensationPending.body).toBe(
      'Your payment was received, but the spot was no longer available. Your payment is being returned.',
    );
    expect(PAYMENT_STATUS_COPY.compensated.body).toBe(
      'Your payment has been returned because the spot was no longer available.',
    );
  });

  it('the compensation sequence NEVER presents as success at any point', () => {
    const sequence: CustomerPaymentStatusName[] = [
      'awaitingPayment',
      'processing',
      'compensationPending',
      'compensated',
    ];
    for (const status of sequence) {
      const copy = PAYMENT_STATUS_COPY[status];
      expect(copy.tone).not.toBe('success');
      expect(copy.title).not.toMatch(/confirmed/i);
    }
    // Terminality: compensated ends the loop; compensationPending keeps
    // reconciling (slower) until the reversal posts.
    expect(PAYMENT_STATUS_COPY.compensationPending.terminal).toBe(false);
    expect(PAYMENT_STATUS_COPY.compensated.terminal).toBe(true);
  });
});

describe('bounded polling cadence', () => {
  const at = (status: CustomerPaymentStatusName) => ({ status });

  it('steps 1s→2s→3s→5s then steady 5s; terminal stops; budget pauses', () => {
    const base = { elapsedMs: 0, lastStatus: at('awaitingPayment'), consecutiveFailures: 0 };
    expect(nextPoll({ ...base, attempt: 0 })).toEqual({ kind: 'next', delayMs: 1000 });
    expect(nextPoll({ ...base, attempt: 1 })).toEqual({ kind: 'next', delayMs: 2000 });
    expect(nextPoll({ ...base, attempt: 2 })).toEqual({ kind: 'next', delayMs: 3000 });
    expect(nextPoll({ ...base, attempt: 3 })).toEqual({ kind: 'next', delayMs: 5000 });
    expect(nextPoll({ ...base, attempt: 12 })).toEqual({ kind: 'next', delayMs: 5000 });
    expect(nextPoll({ ...base, attempt: 5, lastStatus: at('confirmed') })).toEqual({
      kind: 'stop',
    });
    expect(nextPoll({ ...base, attempt: 5, lastStatus: at('compensated') })).toEqual({
      kind: 'stop',
    });
    expect(nextPoll({ ...base, attempt: 5, elapsedMs: POLL_BUDGET_MS })).toEqual({
      kind: 'pause',
    });
  });

  it('compensationPending slows down; failures back off bounded — a network error never terminates', () => {
    expect(
      nextPoll({
        attempt: 6,
        elapsedMs: 30_000,
        lastStatus: at('compensationPending'),
        consecutiveFailures: 0,
      }),
    ).toEqual({ kind: 'next', delayMs: POLL_COMPENSATION_MS });
    const backedOff = nextPoll({
      attempt: 6,
      elapsedMs: 30_000,
      lastStatus: null,
      consecutiveFailures: 5,
    });
    expect(backedOff).toEqual({ kind: 'next', delayMs: POLL_FAILURE_MAX_MS });
  });
});
