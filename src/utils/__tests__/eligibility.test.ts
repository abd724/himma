import type { Eligibility } from '@/types/domain';
import {
  ageRangeLabel,
  childAge,
  isChildRelevant,
  isLadiesOnly,
  suitsAdult,
  suitsChild,
} from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const elig = (partial: Partial<Eligibility>): Eligibility => ({
  allAges: false,
  genderEligibility: 'mixed',
  ...partial,
});

describe('childAge against the fixed mock today (2026-08-02)', () => {
  test('birthday already passed this year', () => {
    expect(childAge('2018-03-14')).toBe(8); // Adam
  });
  test('birthday later this year', () => {
    expect(childAge('2013-11-02')).toBe(12); // Lina — turns 13 in November
  });
  test('birthday today counts as had', () => {
    expect(childAge('2016-08-02')).toBe(10);
  });
});

describe('ageRangeLabel (docs/05 §7 display formats)', () => {
  test('bounded range', () => {
    expect(ageRangeLabel(elig({ minimumAge: 6, maximumAge: 9 }))).toBe('Ages 6–9');
  });
  test('open-ended upper bound (null maximumAge)', () => {
    expect(ageRangeLabel(elig({ minimumAge: 12, maximumAge: null }))).toBe('Ages 12+');
  });
  test('minimum only', () => {
    expect(ageRangeLabel(elig({ minimumAge: 16 }))).toBe('Ages 16+');
  });
  test('all ages', () => {
    expect(ageRangeLabel(elig({ allAges: true }))).toBe('All ages');
  });
  test('no age information', () => {
    expect(ageRangeLabel(elig({}))).toBeUndefined();
  });
});

describe('suitsChild — hard age range check', () => {
  const range = elig({ minimumAge: 6, maximumAge: 12 });
  test('inside, at edges, outside', () => {
    expect(suitsChild(range, 8)).toBe(true);
    expect(suitsChild(range, 6)).toBe(true);
    expect(suitsChild(range, 12)).toBe(true);
    expect(suitsChild(range, 5)).toBe(false);
    expect(suitsChild(range, 13)).toBe(false);
  });
  test('null maximumAge is open-ended', () => {
    expect(suitsChild(elig({ minimumAge: 12, maximumAge: null }), 15)).toBe(true);
    expect(suitsChild(elig({ minimumAge: 12, maximumAge: null }), 11)).toBe(false);
  });
  test('allAges always suits', () => {
    expect(suitsChild(elig({ allAges: true }), 3)).toBe(true);
  });
});

describe('suitsAdult — never gender-based', () => {
  test('adult classes of every gender classification suit adults', () => {
    expect(suitsAdult(elig({ minimumAge: 16, genderEligibility: 'ladies' }))).toBe(true);
    expect(suitsAdult(elig({ minimumAge: 16, genderEligibility: 'men' }))).toBe(true);
    expect(suitsAdult(elig({ minimumAge: 16, genderEligibility: 'mixed' }))).toBe(true);
  });
  test('junior-capped programs are not adult-suitable', () => {
    expect(suitsAdult(elig({ minimumAge: 6, maximumAge: 12 }))).toBe(false);
  });
  test('allAges and open-ended suit adults', () => {
    expect(suitsAdult(elig({ allAges: true }))).toBe(true);
    expect(suitsAdult(elig({ minimumAge: 12, maximumAge: null }))).toBe(true);
  });
});

describe('isChildRelevant and isLadiesOnly', () => {
  test('child relevance drives age-label display', () => {
    expect(isChildRelevant(elig({ minimumAge: 6, maximumAge: 12 }))).toBe(true);
    expect(isChildRelevant(elig({ allAges: true }))).toBe(true);
    expect(isChildRelevant(elig({ minimumAge: 16 }))).toBe(false);
  });
  test('ladies-only maps exactly to genderEligibility', () => {
    expect(isLadiesOnly(elig({ genderEligibility: 'ladies' }))).toBe(true);
    expect(isLadiesOnly(elig({ genderEligibility: 'mixed' }))).toBe(false);
    expect(isLadiesOnly(elig({ genderEligibility: 'men' }))).toBe(false);
  });
});
