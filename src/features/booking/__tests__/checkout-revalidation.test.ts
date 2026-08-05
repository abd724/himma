import { describe, expect, test } from '@jest/globals';
import {
  checkoutIssuePresentation,
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

describe('checkoutIssuePresentation (owner-directed CheckoutIssueCard design)', () => {
  test('every code carries a complete presentation', () => {
    for (const code of ALL_CODES) {
      const presentation = checkoutIssuePresentation(code);
      expect(presentation.icon.length).toBeGreaterThan(0);
      expect(presentation.stateLabel.length).toBeGreaterThan(0);
      expect(presentation.headline.length).toBeGreaterThan(0);
      expect(presentation.support.length).toBeGreaterThan(0);
      // Never the generic feed empty-state glyph.
      expect(presentation.icon).not.toBe('search-outline');
    }
  });

  test('states are not visually identical — icons and headlines differ per meaning', () => {
    const icons = ALL_CODES.map((code) => checkoutIssuePresentation(code).icon);
    const headlines = ALL_CODES.map((code) => checkoutIssuePresentation(code).headline);
    expect(new Set(headlines).size).toBe(ALL_CODES.length);
    // Distinct icon families across distinct meanings (some sharing is fine
    // only where meanings overlap; today every state has its own glyph).
    expect(new Set(icons).size).toBe(ALL_CODES.length);
  });

  test('session-full state matches the directed design', () => {
    expect(checkoutIssuePresentation('sessionFull')).toEqual({
      icon: 'calendar-outline',
      stateLabel: 'Session unavailable',
      headline: 'This session just filled up',
      support: 'Choose another available time to continue your booking.',
    });
  });

  test('price-changed state matches the directed design (booking-generic headline)', () => {
    expect(checkoutIssuePresentation('priceChanged')).toEqual({
      icon: 'pricetag-outline',
      stateLabel: 'Price updated',
      headline: 'Your booking price has changed',
      support: 'Review the updated price before continuing.',
    });
  });

  test('presentation copy stays honest — no claims, no amounts, no card wording', () => {
    for (const code of ALL_CODES) {
      const presentation = checkoutIssuePresentation(code);
      const copy = [presentation.stateLabel, presentation.headline, presentation.support].join(' | ');
      expect(copy).not.toMatch(/\bTotal\b/);
      expect(copy).not.toMatch(/VAT|\bfees?\b/i);
      expect(copy).not.toMatch(/AED|\d/);
      expect(copy).not.toMatch(/reserv|holding|charged|confirmed|success|receipt/i);
      expect(copy).not.toMatch(/ending in|last four|expir|cvv|cardholder/i);
      expect(copy).not.toMatch(/i agree|i accept|by continuing/i);
    }
  });
});
