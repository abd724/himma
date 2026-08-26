/**
 * RI-3 — the bounded payment-status reconciliation loop (owner RI-3 §16).
 *
 * Server truth only; the loop merely READS. Cadence (recorded):
 * immediate read, then 1s → 2s → 3s → 5s and every 5s thereafter;
 * `compensationPending` slows to 10s. Polling PAUSES after ~3 minutes of
 * nonterminal status (manual "Check again" continues — never forever at
 * aggressive frequency). Transient network/backend failures keep the last
 * known status (they are NEVER presented as a payment failure) and back
 * off up to 15s; terminal states stop the loop.
 */
import type { CustomerPaymentStatus } from '@/services/contracts/commerce';
import { PAYMENT_STATUS_COPY } from '@/features/bookings/payment-status-copy';

export const POLL_STEPS_MS = [1_000, 2_000, 3_000, 5_000];
export const POLL_STEADY_MS = 5_000;
export const POLL_COMPENSATION_MS = 10_000;
export const POLL_FAILURE_MAX_MS = 15_000;
/** Automatic polling budget before requiring a manual continue. */
export const POLL_BUDGET_MS = 3 * 60_000;

export interface PollPlanInput {
  attempt: number;
  elapsedMs: number;
  lastStatus: CustomerPaymentStatus | null;
  consecutiveFailures: number;
}

export type PollPlan =
  | { kind: 'stop' }
  | { kind: 'pause' }
  | { kind: 'next'; delayMs: number };

/** Pure cadence rule — the unit-test surface. */
export function nextPoll(input: PollPlanInput): PollPlan {
  if (input.lastStatus !== null && PAYMENT_STATUS_COPY[input.lastStatus.status].terminal) {
    return { kind: 'stop' };
  }
  if (input.elapsedMs >= POLL_BUDGET_MS) return { kind: 'pause' };
  if (input.consecutiveFailures > 0) {
    const backoff = Math.min(
      POLL_STEADY_MS * 2 ** (input.consecutiveFailures - 1),
      POLL_FAILURE_MAX_MS,
    );
    return { kind: 'next', delayMs: backoff };
  }
  if (input.lastStatus?.status === 'compensationPending') {
    return { kind: 'next', delayMs: POLL_COMPENSATION_MS };
  }
  const step = POLL_STEPS_MS[Math.min(input.attempt, POLL_STEPS_MS.length - 1)] ?? POLL_STEADY_MS;
  return { kind: 'next', delayMs: input.attempt >= POLL_STEPS_MS.length ? POLL_STEADY_MS : step };
}
