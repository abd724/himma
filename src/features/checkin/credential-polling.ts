/**
 * RI-4 — the bounded credential-state refresh cadence (owner RI-4 §20/§21;
 * the RI-3 payment-polling discipline applied to check-in observation).
 *
 * Server truth only — the loop merely READS. The customer's screen becomes
 * able to observe a provider redemption ("Checked in") without assuming
 * success client-side. Cadence: every 3 s while the credential is LIVE and
 * the screen is visible; transient failures back off (up to 15 s) and keep
 * the last known state; terminal states (`used`/`superseded`/`expired`)
 * stop the loop; a hard budget (12 min — beyond any 10-minute credential
 * TTL) guarantees no unbounded poller survives.
 */
import type { CredentialStatus } from '@/services/contracts/entitlements';

export const CREDENTIAL_POLL_MS = 3_000;
export const CREDENTIAL_POLL_FAILURE_MAX_MS = 15_000;
export const CREDENTIAL_POLL_BUDGET_MS = 12 * 60_000;

export interface CredentialPollInput {
  elapsedMs: number;
  lastStatus: CredentialStatus | null;
  consecutiveFailures: number;
}

export type CredentialPollPlan = { kind: 'stop' } | { kind: 'next'; delayMs: number };

export function nextCredentialPoll(input: CredentialPollInput): CredentialPollPlan {
  if (input.lastStatus !== null && input.lastStatus.state !== 'live') return { kind: 'stop' };
  if (input.elapsedMs >= CREDENTIAL_POLL_BUDGET_MS) return { kind: 'stop' };
  if (input.consecutiveFailures > 0) {
    return {
      kind: 'next',
      delayMs: Math.min(
        CREDENTIAL_POLL_MS * 2 ** input.consecutiveFailures,
        CREDENTIAL_POLL_FAILURE_MAX_MS,
      ),
    };
  }
  return { kind: 'next', delayMs: CREDENTIAL_POLL_MS };
}
