import type { Eligibility, Participant } from '@/types/domain';

/**
 * Fixed mock "today" for deterministic age computation — docs/08 §10.
 * Never use the device clock in mock logic.
 */
export const MOCK_TODAY = { year: 2026, month: 8, day: 2 } as const;

/** Age in whole years on MOCK_TODAY for an ISO yyyy-mm-dd date of birth. */
export function childAge(dateOfBirth: string): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number);
  let age = MOCK_TODAY.year - year;
  const hadBirthday =
    MOCK_TODAY.month > month || (MOCK_TODAY.month === month && MOCK_TODAY.day >= day);
  if (!hadBirthday) age -= 1;
  return age;
}

export function participantAge(participant: Participant): number | undefined {
  return participant.dateOfBirth === undefined ? undefined : childAge(participant.dateOfBirth);
}

/**
 * Customer-facing age label — docs/05 §7: "Ages 6–9", "Ages 12+", "All ages".
 * Undefined when the program defines no age information.
 */
export function ageRangeLabel(eligibility: Eligibility): string | undefined {
  if (eligibility.allAges) return 'All ages';
  const { minimumAge, maximumAge } = eligibility;
  if (minimumAge !== undefined && maximumAge !== undefined && maximumAge !== null) {
    return `Ages ${minimumAge}–${maximumAge}`;
  }
  if (minimumAge !== undefined) return `Ages ${minimumAge}+`;
  if (maximumAge !== undefined && maximumAge !== null) return `Up to age ${maximumAge}`;
  return undefined;
}

/** Hard age check for a selected child — docs/05 §7. Out-of-range is excluded. */
export function suitsChild(eligibility: Eligibility, age: number): boolean {
  if (eligibility.allAges) return true;
  if (eligibility.minimumAge !== undefined && age < eligibility.minimumAge) return false;
  if (
    eligibility.maximumAge !== undefined &&
    eligibility.maximumAge !== null &&
    age > eligibility.maximumAge
  ) {
    return false;
  }
  return true;
}

/**
 * Adult suitability for the "Me" context. Never gender-based — adults see
 * men, ladies, and mixed classes alike. A program is adult-suitable unless
 * its age range tops out below adulthood.
 */
export function suitsAdult(eligibility: Eligibility): boolean {
  if (eligibility.allAges) return true;
  const max = eligibility.maximumAge;
  return max === undefined || max === null || max >= 18;
}

/** A program a child could plausibly attend — drives age-label display on cards. */
export function isChildRelevant(eligibility: Eligibility): boolean {
  if (eligibility.allAges) return true;
  const max = eligibility.maximumAge;
  return max !== undefined && max !== null && max <= 17;
}

/** Screen-reader form of an age label: "Ages 6 to 9", "Ages 12 and up". */
export function spokenAgeLabel(label: string): string {
  return label.replace('–', ' to ').replace('+', ' and up');
}

/** The optional Ladies-only customer filter — docs/05 §7. */
export function isLadiesOnly(eligibility: Eligibility): boolean {
  return eligibility.genderEligibility === 'ladies';
}
