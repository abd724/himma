import { describe, expect, test } from '@jest/globals';
import type { Eligibility, Participant } from '@/types/domain';
import { householdSuitability, participantSuitability } from '@/utils/eligibility';

const me: Participant = { id: 'me', label: 'Me', kind: 'self' };
const adam: Participant = { id: 'adam', label: 'Adam', kind: 'child', dateOfBirth: '2018-03-14' }; // 8
const everyone: Participant = { id: 'everyone', label: 'Everyone', kind: 'everyone' };

const junior: Eligibility = {
  minimumAge: 6,
  maximumAge: 12,
  allAges: false,
  genderEligibility: 'mixed',
};
const adults16: Eligibility = { minimumAge: 16, allAges: false, genderEligibility: 'mixed' };
const ladies: Eligibility = { minimumAge: 16, allAges: false, genderEligibility: 'ladies' };
const open: Eligibility = { allAges: true, genderEligibility: 'mixed' };
const openEnded12: Eligibility = { minimumAge: 12, maximumAge: null, allAges: false, genderEligibility: 'mixed' };

describe('participantSuitability — presentation over the hard checks (docs/20 §6.1)', () => {
  test('child inside the range: suitable with age fact', () => {
    expect(participantSuitability(junior, adam)).toEqual({
      participantId: 'adam',
      label: 'Adam',
      suitable: true,
      reason: 'Adam is 8',
    });
  });

  test('child outside the range: unsuitable with range and age', () => {
    expect(participantSuitability(adults16, adam)).toEqual(
      expect.objectContaining({ suitable: false, reason: 'Ages 16+ — Adam is 8' }),
    );
  });

  test('open-ended and all-ages ranges admit children', () => {
    expect(participantSuitability(open, adam).suitable).toBe(true);
    expect(participantSuitability(openEnded12, adam).suitable).toBe(false);
  });

  test('adult on a junior-capped program: honest designed-for reason', () => {
    expect(participantSuitability(junior, me)).toEqual(
      expect.objectContaining({ suitable: false, reason: 'Designed for ages 6–12' }),
    );
  });

  test('adults are never gender-excluded (Ladies only is a filter, not a gate)', () => {
    expect(participantSuitability(ladies, me).suitable).toBe(true);
  });
});

describe('householdSuitability (docs/20 §6.2)', () => {
  test('maps real participants in order and drops the everyone entry', () => {
    const result = householdSuitability(adults16, [everyone, me, adam]);
    expect(result.map((entry) => entry.participantId)).toEqual(['me', 'adam']);
    expect(result[0].suitable).toBe(true);
    expect(result[1].suitable).toBe(false);
  });

  test('empty participant list (guest) yields an empty result', () => {
    expect(householdSuitability(adults16, [])).toEqual([]);
  });
});
