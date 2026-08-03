import type { Eligibility, Participant, ParticipantId } from '@/types/domain';

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

/**
 * Presentation of one participant's suitability on evaluation surfaces
 * (docs/20 §6.1). Children hard-check the provider-defined age range;
 * adults use `suitsAdult` — never gender (docs/05 §7).
 */
export interface ParticipantSuitability {
  participantId: ParticipantId;
  label: string;
  suitable: boolean;
  /** Customer wording, e.g. "Ages 6–12 — Adam is 8". */
  reason: string;
}

export function participantSuitability(
  eligibility: Eligibility,
  participant: Participant,
): ParticipantSuitability {
  const ageLabel = ageRangeLabel(eligibility) ?? 'All ages';
  if (participant.kind === 'child') {
    const age = participantAge(participant) ?? 0;
    const suitable = suitsChild(eligibility, age);
    return {
      participantId: participant.id,
      label: participant.label,
      suitable,
      reason: suitable
        ? `${participant.label} is ${age}`
        : `${ageLabel} — ${participant.label} is ${age}`,
    };
  }
  const suitable = suitsAdult(eligibility);
  return {
    participantId: participant.id,
    label: participant.label,
    suitable,
    reason: suitable ? 'Open to adults' : `Designed for ${ageLabel.toLowerCase()}`,
  };
}

/**
 * Suitability for every real household participant (the `everyone` browsing
 * entry is context, not a person). Order preserved: primary first.
 */
export function householdSuitability(
  eligibility: Eligibility,
  participants: Participant[],
): ParticipantSuitability[] {
  return participants
    .filter((participant) => participant.kind !== 'everyone')
    .map((participant) => participantSuitability(eligibility, participant));
}
