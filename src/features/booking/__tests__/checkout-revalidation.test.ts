import { describe, expect, test } from '@jest/globals';
import {
  checkoutIssueRecovery,
  REVALIDATION_REASSURANCE,
} from '@/features/booking/checkout-revalidation';
import type { CheckoutIssueCode } from '@/services/contracts/checkout';

/**
 * Commit 18 recovery-mapping tests — docs/22 §7.10.2, docs/09 §22.10. Every
 * declared issue code must map to exactly one honest recovery action so the
 * future backend can return any code and the screen always offers a way
 * forward; re-derive belongs only to the review-style states.
 */

const ALL_CODES: CheckoutIssueCode[] = [
  'sessionFull',
  'registrationClosed',
  'priceChanged',
  'offerExpired',
  'participantIneligible',
  'branchUnavailable',
  'invalidDraft',
];

describe('checkoutIssueRecovery (docs/22 §7.10.2)', () => {
  test('every issue code maps to a labelled recovery action', () => {
    for (const code of ALL_CODES) {
      const recovery = checkoutIssueRecovery(code);
      expect(recovery.actionLabel.length).toBeGreaterThan(0);
      expect(['flow-start', 'participant', 'program', 'rederive']).toContain(recovery.target);
    }
  });

  test('sessionFull returns to selection (docs/22 §7.10 spec action)', () => {
    expect(checkoutIssueRecovery('sessionFull')).toEqual({
      actionLabel: 'Choose another session',
      target: 'flow-start',
    });
  });

  test('priceChanged re-derives via the explicit review action (spec copy)', () => {
    expect(checkoutIssueRecovery('priceChanged')).toEqual({
      actionLabel: 'Review updated price',
      target: 'rederive',
    });
  });

  test('offerExpired re-derives; stale data is never silently repaired', () => {
    expect(checkoutIssueRecovery('offerExpired').target).toBe('rederive');
  });

  test('participant and draft issues return to the owning step', () => {
    expect(checkoutIssueRecovery('participantIneligible').target).toBe('participant');
    expect(checkoutIssueRecovery('invalidDraft').target).toBe('flow-start');
    expect(checkoutIssueRecovery('branchUnavailable').target).toBe('flow-start');
    expect(checkoutIssueRecovery('registrationClosed').target).toBe('program');
  });

  test('only review-style codes re-derive — step codes never do', () => {
    const rederiveCodes = ALL_CODES.filter(
      (code) => checkoutIssueRecovery(code).target === 'rederive',
    );
    expect(rederiveCodes.sort()).toEqual(['offerExpired', 'priceChanged']);
  });

  test('the reassurance line claims nothing and stays honest', () => {
    expect(REVALIDATION_REASSURANCE).toBe('No payment has been made.');
    expect(REVALIDATION_REASSURANCE).not.toMatch(
      /reserv|holding|charged|confirmed|success|receipt|Total/i,
    );
  });
});
