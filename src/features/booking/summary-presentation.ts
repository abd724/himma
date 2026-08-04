import type { ParticipantEligibility } from '@/services/contracts/booking';
import type { Participant } from '@/types/domain';
import { participantAge } from '@/utils/eligibility';
import { spokenLabel } from '@/utils/price';

/**
 * Presentation of the summary's participant block — docs/21 §8.3. Pure and
 * derived from the real account participant list (docs/18 §3: no fixed
 * names or counts); the builder guarantees the participant is suitable, so
 * this only words the confirmation.
 */
export interface SummaryParticipantBlock {
  /** 'You' for the primary participant, else the participant's name. */
  displayName: string;
  /** 'Age 8' for children; absent for adults. */
  detailLine?: string;
  /** 'Suitable for Adam (age 8)' | 'Suitable for you' — §6 re-asserted. */
  confirmation: string;
  accessibilityLabel: string;
}

export function summaryParticipantBlock(
  participant: ParticipantEligibility,
  participants: Participant[],
): SummaryParticipantBlock {
  const entry = participants.find((candidate) => candidate.id === participant.participantId);
  const isSelf = entry?.kind === 'self';
  const age = entry === undefined ? undefined : participantAge(entry);
  const displayName = isSelf ? 'You' : participant.label;
  const confirmation = isSelf
    ? 'Suitable for you'
    : `Suitable for ${participant.label}${age === undefined ? '' : ` (age ${age})`}`;
  return {
    displayName,
    detailLine: age === undefined ? undefined : `Age ${age}`,
    confirmation,
    accessibilityLabel: `${displayName}${age === undefined ? '' : `, age ${age}`}, suitable for this program`,
  };
}

/**
 * Spoken form of the Booking price label — docs/21 §14: currency in words,
 * no 'AED', no separator dot: 'Booking price, 85 dirhams per session',
 * 'Booking price, Free'. Delegates to the shared spokenLabel util so the
 * summary and checkout can never pronounce the same label differently.
 */
export function spokenBookingPriceLabel(label: string): string {
  return spokenLabel(label);
}
