import { describe, expect, test } from '@jest/globals';
import { buildParticipantRows } from '@/features/booking/participant-rows';
import type { Eligibility, Participant } from '@/types/domain';
import { householdSuitability } from '@/utils/eligibility';

/**
 * Participant-step rows — docs/21 §6. Every case uses arbitrary participant
 * arrays; nothing branches on demo names (docs/18 §3).
 */
const adultsOnly: Eligibility = { minimumAge: 16, allAges: false, genderEligibility: 'mixed' };
const juniors: Eligibility = {
  minimumAge: 6,
  maximumAge: 12,
  allAges: false,
  genderEligibility: 'mixed',
};
const allAges: Eligibility = { allAges: true, genderEligibility: 'mixed' };
const ladiesOnly: Eligibility = { minimumAge: 16, allAges: false, genderEligibility: 'ladies' };

const self: Participant = { id: 'me', label: 'Me', kind: 'self' };
const child = (id: string, label: string, dateOfBirth: string): Participant => ({
  id,
  label,
  kind: 'child',
  dateOfBirth,
});

function rows(eligibility: Eligibility, participants: Participant[]) {
  return buildParticipantRows(householdSuitability(eligibility, participants), participants);
}

describe('buildParticipantRows', () => {
  test('primary participant displays and announces as You', () => {
    const [row] = rows(adultsOnly, [self]);
    expect(row.displayName).toBe('You');
    expect(row.accessibilityLabel).toBe('You');
    expect(row.suitable).toBe(true);
  });

  test('eligible children show a natural age line', () => {
    const result = rows(juniors, [self, child('omar', 'Omar', '2018-01-10')]); // 8
    const omar = result.find((row) => row.participantId === 'omar')!;
    expect(omar.displayName).toBe('Omar');
    expect(omar.detailLine).toBe('Age 8');
    expect(omar.accessibilityLabel).toBe('Omar, age 8');
  });

  test('eligible participants rank before ineligible, account order within groups', () => {
    const result = rows(juniors, [
      self, // ineligible (adults on juniors)
      child('a', 'Aya', '2019-02-01'), // 7, eligible
      child('b', 'Badr', '2008-02-01'), // 18, ineligible
      child('c', 'Celine', '2015-02-01'), // 11, eligible
    ]);
    expect(result.map((row) => row.participantId)).toEqual(['a', 'c', 'me', 'b']);
  });

  test('ineligible rows carry the authoritative age reason', () => {
    const result = rows(adultsOnly, [self, child('omar', 'Omar', '2018-01-10')]);
    const omar = result.find((row) => row.participantId === 'omar')!;
    expect(omar.suitable).toBe(false);
    expect(omar.detailLine).toBe('Ages 16+ — Omar is 8');
    expect(omar.accessibilityLabel).toBe(
      'Omar, age 8, not suitable. Ages 16 and up — Omar is 8',
    );
  });

  test('an adult ineligible for a junior program gets the designed-for reason', () => {
    const result = rows(juniors, [self]);
    expect(result[0].suitable).toBe(false);
    expect(result[0].detailLine).toBe('Designed for ages 6–12');
  });

  test('all-ages programs make every participant eligible', () => {
    const result = rows(allAges, [self, child('t', 'Tala', '2021-06-01')]);
    expect(result.every((row) => row.suitable)).toBe(true);
  });

  test('ladies-only programs never gender-exclude (docs/05 §7)', () => {
    const result = rows(ladiesOnly, [self]);
    expect(result[0].suitable).toBe(true);
  });

  test('zero, one, and many children all derive from the array alone', () => {
    expect(rows(allAges, [self])).toHaveLength(1);
    expect(rows(allAges, [self, child('x', 'Xena', '2016-01-01')])).toHaveLength(2);
    expect(
      rows(allAges, [
        self,
        child('x', 'Xena', '2016-01-01'),
        child('y', 'Yousef', '2014-01-01'),
        child('z', 'Zara', '2012-01-01'),
      ]),
    ).toHaveLength(4);
  });

  test('guest (empty list) yields no rows', () => {
    expect(buildParticipantRows([], [])).toEqual([]);
  });
});
