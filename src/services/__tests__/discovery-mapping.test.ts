/**
 * RI-2 — wire→domain mapping truth: server fields map 1:1; fields with no
 * backend authority stay ABSENT (never invented); the D-RI-4 availability
 * bands pass through unchanged with `spotsLeft` only where the server put
 * it; occurrences keep full/closed visible.
 */
import { describe, expect, it } from '@jest/globals';
import type { AvailabilityUnitDto, ListingSummaryDto } from '@/services/api/discovery-api';
import {
  fromPriceToModel,
  offerFromBadges,
  presentationImageKey,
  searchResultToProgram,
  toSessionOccurrences,
  unitKindsForOptions,
} from '@/services/api/discovery-mapping';

const SUMMARY: ListingSummaryDto = {
  id: 'aaaaaaaa-0000-7000-8000-000000000001',
  titleEn: 'Adult Padel Open Play',
  titleAr: null,
  setting: 'indoor',
  minAge: 16,
  maxAge: null,
  allAges: false,
  genderEligibility: 'mixed',
  skillLevel: null,
  category: { id: 'cat-1', slug: 'padel-racquet', labelEn: 'Padel & racquet', labelAr: null },
  activityType: { id: 'type-1', slug: 'padel', labelEn: 'Padel', labelAr: null },
  media: [],
  fromPrice: { kind: 'from', amountFils: 9000, currency: 'AED' },
  offerBadges: [],
  areaLabels: ['Al Raha', 'Yas Island'],
};

describe('discovery mapping', () => {
  it('maps a search result 1:1 and leaves authority-less fields ABSENT', () => {
    const program = searchResultToProgram({
      ...SUMMARY,
      provider: { id: 'org-1', displayName: 'Coastal Padel Club' },
    });
    expect(program.title).toBe('Adult Padel Open Play');
    expect(program.providerName).toBe('Coastal Padel Club');
    expect(program.areaLabel).toBe('Al Raha +1');
    expect(program.price).toEqual({ kind: 'from', amount: 90 });
    expect(program.eligibility).toMatchObject({ minimumAge: 16, genderEligibility: 'mixed' });
    // No backend authority — never invented:
    expect(program.rating).toBeUndefined();
    expect(program.scheduleLabel).toBeUndefined();
    expect(program.availableToday).toBeUndefined();
    expect(program.offer).toBeUndefined();
  });

  it('prices: free stays free, fils convert to whole AED, and NO active price maps to no price', () => {
    expect(fromPriceToModel({ kind: 'free' })).toEqual({ kind: 'free' });
    expect(fromPriceToModel({ kind: 'from', amountFils: 45000, currency: 'AED' })).toEqual({
      kind: 'from',
      amount: 450,
    });
    expect(fromPriceToModel(null)).toBeUndefined();
  });

  it('offer badges: real server kinds only; nothing from an empty badge set', () => {
    expect(offerFromBadges(['freeTrial'])).toEqual({ kind: 'freeTrial', label: 'Free trial' });
    expect(offerFromBadges(['paidTrial'])).toEqual({ kind: 'paidTrial', label: 'Trial offer' });
    expect(offerFromBadges([])).toBeUndefined();
  });

  it('server gender vocabulary presents women as the approved Ladies-only wording', () => {
    const ladies = searchResultToProgram({
      ...SUMMARY,
      genderEligibility: 'women',
      provider: { id: 'org-1', displayName: 'Studio' },
    });
    expect(ladies.eligibility.genderEligibility).toBe('ladies');
  });

  it('D-RI-4 occurrences: bands pass through UNCHANGED; full/closed stay visible; spotsLeft only where the server put it; past units drop', () => {
    const now = new Date('2026-08-25T08:00:00Z');
    const at = (days: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString();
    };
    const base = {
      kind: 'session' as const,
      branchId: 'branch-1',
      endAt: null,
      startDate: null,
      endDate: null,
      effectiveStart: null,
      effectiveEnd: null,
      timezone: 'Asia/Dubai',
      registrationCutoffAt: at(1),
    };
    const units: AvailabilityUnitDto[] = [
      { ...base, unitId: 'u-open', startAt: at(2), availability: 'available' },
      { ...base, unitId: 'u-few', startAt: at(3), availability: 'fewLeft', spotsLeft: 2 },
      { ...base, unitId: 'u-full', startAt: at(4), availability: 'full' },
      { ...base, unitId: 'u-closed', startAt: at(5), availability: 'closed' },
      { ...base, unitId: 'u-past', startAt: at(-1), availability: 'available' },
    ];
    const occurrences = toSessionOccurrences(units, new Map([['branch-1', 'Al Raha Courts']]), now);
    expect(occurrences.map((o) => o.id)).toEqual(['u-open', 'u-few', 'u-full', 'u-closed']);
    expect(occurrences.map((o) => o.availability)).toEqual([
      'available',
      'fewLeft',
      'full',
      'closed',
    ]);
    // spotsLeft ONLY in the fewLeft band — never a total, never elsewhere.
    expect(occurrences.map((o) => o.spotsLeft)).toEqual([undefined, 2, undefined, undefined]);
  });

  it('camp weeks and cohorts label their real date ranges', () => {
    const now = new Date('2026-08-25T08:00:00Z');
    const occurrences = toSessionOccurrences(
      [
        {
          unitId: 'w-1',
          kind: 'campWeek',
          branchId: 'b',
          startAt: null,
          endAt: null,
          startDate: '2026-09-07',
          endDate: '2026-09-11',
          effectiveStart: null,
          effectiveEnd: null,
          timezone: 'Asia/Dubai',
      registrationCutoffAt: '2026-09-07T00:00:00Z',
          availability: 'available',
        },
        {
          unitId: 'c-1',
          kind: 'enrolmentCohort',
          branchId: 'b',
          startAt: null,
          endAt: null,
          startDate: null,
          endDate: null,
          effectiveStart: '2026-09-01',
          effectiveEnd: '2026-12-01',
          timezone: 'Asia/Dubai',
      registrationCutoffAt: '2026-09-01T00:00:00Z',
          availability: 'fewLeft',
          spotsLeft: 3,
        },
      ],
      new Map(),
      now,
    );
    // Sorted by start: the cohort (Sep 1) precedes the camp week (Sep 7).
    expect(occurrences[0]?.dayLabel).toMatch(/^Starts /);
    expect(occurrences[0]?.spotsLeft).toBe(3);
    expect(occurrences[1]?.dayLabel).toContain('Sep');
    expect(occurrences[1]?.timeLabel).toBe('Camp week');
  });

  it('price-option kinds imply the certified unit kinds', () => {
    const option = (kind: string) => ({
      id: 'o',
      kind,
      amountFils: 1000,
      currency: 'AED',
      sessionsCount: null,
      labelEn: null,
      labelAr: null,
    });
    expect(unitKindsForOptions([option('dropIn')])).toEqual(['session']);
    expect(unitKindsForOptions([option('camp')])).toEqual(['campWeek']);
    expect(unitKindsForOptions([option('monthly')])).toEqual(['enrolmentCohort']);
    expect(unitKindsForOptions([option('dropIn'), option('monthly')]).sort()).toEqual([
      'enrolmentCohort',
      'session',
    ]);
  });

  it('presentation imagery is deterministic bundled photography keyed by category', () => {
    expect(presentationImageKey('padel-racquet', 'x')).toBe(presentationImageKey('padel-racquet', 'x'));
    expect(['tennis']).toContain(presentationImageKey('padel-racquet', 'anything'));
  });
});
