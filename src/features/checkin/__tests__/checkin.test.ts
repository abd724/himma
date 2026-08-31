/**
 * RI-4 — check-in mechanics: the in-memory secret store (no persistence),
 * stable per-target issuance keys, secret-free hrefs, and the bounded
 * credential poll cadence.
 */
import { describe, expect, it } from '@jest/globals';
import { credentialHref, issueKeyFor, retireIssueKey } from '@/features/checkin/checkin-entry';
import {
  CREDENTIAL_POLL_BUDGET_MS,
  CREDENTIAL_POLL_MS,
  nextCredentialPoll,
} from '@/features/checkin/credential-polling';
import {
  clearStashedCredential,
  stashCredential,
  stashedCredential,
} from '@/features/checkin/credential-store';

describe('credential secret store (owner §17)', () => {
  it('holds the secret in memory for its credential only, and clears on demand', () => {
    stashCredential({ credentialId: 'c1', displayCode: '12345678', expiresAt: 'later' });
    expect(stashedCredential('c1')?.displayCode).toBe('12345678');
    expect(stashedCredential('other')).toBeNull();
    clearStashedCredential('c1');
    expect(stashedCredential('c1')).toBeNull();
  });

  it('a new stash replaces the previous secret (one current credential)', () => {
    stashCredential({ credentialId: 'c1', displayCode: '11111111', expiresAt: 'later' });
    stashCredential({ credentialId: 'c2', displayCode: '22222222', expiresAt: 'later' });
    expect(stashedCredential('c1')).toBeNull();
    expect(stashedCredential('c2')?.displayCode).toBe('22222222');
    clearStashedCredential();
  });
});

describe('issuance keys + hrefs (owner §15/§18)', () => {
  it('the SAME target+occurrence intent reuses the SAME idempotency key; different occurrences differ', () => {
    const a1 = issueKeyFor({
      kind: 'booking',
      bookingId: 'bk-1',
      occurrence: { date: '2026-09-07', startTime: '09:00' },
    });
    const a2 = issueKeyFor({
      kind: 'booking',
      bookingId: 'bk-1',
      occurrence: { date: '2026-09-07', startTime: '09:00' },
    });
    const b = issueKeyFor({
      kind: 'booking',
      bookingId: 'bk-1',
      occurrence: { date: '2026-09-08', startTime: '09:00' },
    });
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(issueKeyFor({ kind: 'entitlement', entitlementId: 'ent-1' })).toBe(
      issueKeyFor({ kind: 'entitlement', entitlementId: 'ent-1' }),
    );
  });

  it('an OBSERVED outcome retires the pending key — the next check-in is a NEW intent, never a replay of the redeemed credential', () => {
    const target = { kind: 'entitlement', entitlementId: 'ent-2' } as const;
    const first = issueKeyFor(target);
    retireIssueKey(target);
    expect(issueKeyFor(target)).not.toBe(first);
  });

  it('the credential href carries IDENTIFIERS only — never the display code', () => {
    const href = credentialHref('cred-1', {
      kind: 'booking',
      bookingId: 'bk-1',
      occurrence: { date: '2026-09-07', startTime: '09:00' },
    });
    expect(href).toBe('/checkin/cred-1?booking=bk-1&date=2026-09-07&time=09%3A00');
    expect(credentialHref('cred-2', { kind: 'entitlement', entitlementId: 'ent-1' })).toBe(
      '/checkin/cred-2?entitlement=ent-1',
    );
  });
});

describe('bounded credential poll (owner §20/§21)', () => {
  const live = {
    credentialId: 'c1',
    state: 'live' as const,
    expiresAt: 'later',
  };

  it('polls every 3s while live; stops on terminal states and at the budget', () => {
    expect(nextCredentialPoll({ elapsedMs: 0, lastStatus: live, consecutiveFailures: 0 })).toEqual({
      kind: 'next',
      delayMs: CREDENTIAL_POLL_MS,
    });
    for (const state of ['used', 'expired', 'superseded'] as const) {
      expect(
        nextCredentialPoll({
          elapsedMs: 0,
          lastStatus: { ...live, state },
          consecutiveFailures: 0,
        }),
      ).toEqual({ kind: 'stop' });
    }
    expect(
      nextCredentialPoll({
        elapsedMs: CREDENTIAL_POLL_BUDGET_MS,
        lastStatus: live,
        consecutiveFailures: 0,
      }),
    ).toEqual({ kind: 'stop' });
  });

  it('transient failures back off and never exceed 15s', () => {
    const plan = nextCredentialPoll({ elapsedMs: 0, lastStatus: live, consecutiveFailures: 5 });
    expect(plan).toEqual({ kind: 'next', delayMs: 15_000 });
  });
});
