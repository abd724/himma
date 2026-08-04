import type { ParticipantEligibility } from '@/services/contracts/booking';
import type { Participant, ParticipantId } from '@/types/domain';
import { participantAge, spokenAgeLabel } from '@/utils/eligibility';

/**
 * Presentation rows for the booking participant step — docs/21 §6. Pure and
 * derived from the real account participant list: no fixed names, no fixed
 * counts (docs/18 §3). Eligible participants rank first; within each group
 * the account order (primary first) is preserved. Ineligible participants
 * stay visible with the authoritative age reason — never hidden, never
 * silently switched (docs/09 §21.15, docs/04 HMA-019).
 */
export interface ParticipantRow {
  participantId: ParticipantId;
  /** 'You' for the primary participant (announced naturally), else the name. */
  displayName: string;
  /** 'Age 8' for eligible children; the canonical reason when ineligible. */
  detailLine?: string;
  suitable: boolean;
  accessibilityLabel: string;
}

export function buildParticipantRows(
  eligibility: ParticipantEligibility[],
  participants: Participant[],
): ParticipantRow[] {
  const byId = new Map(participants.map((participant) => [participant.id, participant]));
  const rows = eligibility.map((entry) => {
    const participant = byId.get(entry.participantId);
    const isSelf = participant?.kind === 'self';
    const age = participant === undefined ? undefined : participantAge(participant);
    const displayName = isSelf ? 'You' : entry.label;
    const detailLine = entry.suitable
      ? age !== undefined
        ? `Age ${age}`
        : undefined
      : entry.reason;
    const spokenAge = age !== undefined ? `, age ${age}` : '';
    const accessibilityLabel = entry.suitable
      ? `${displayName}${spokenAge}`
      : `${displayName}${spokenAge}, not suitable. ${spokenAgeLabel(entry.reason)}`;
    return { participantId: entry.participantId, displayName, detailLine, suitable: entry.suitable, accessibilityLabel };
  });
  // Stable partition: eligible first, account order preserved in each group.
  return [...rows.filter((row) => row.suitable), ...rows.filter((row) => !row.suitable)];
}
