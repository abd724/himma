/**
 * RI-1 — pure derivation of the app-wide `ResolvedAccount` from REAL auth
 * + participant truth. The shape stays the certified contract the screens
 * already consume; only the source changes:
 *
 * - guest → the empty guest account (no participants, no schedule);
 * - authenticated → real participants mapped into the domain shape, with
 *   EMPTY schedule/plans (truthful: real schedule surfaces arrive with the
 *   RI-3/RI-5 booking/entitlement reads — nothing is fabricated, exactly
 *   the docs/18 §10 no-history rule).
 *
 * `participantsReady` lets participant-dependent screens hold their
 * loading state until the real list arrived, instead of flashing a wrong
 * empty/ineligible state.
 */
import type { ParticipantProfile } from '@/services/contracts/identity';
import type { ResolvedAccount } from '@/services/contracts/schedule';
import type { Participant } from '@/types/domain';

export const GUEST_ACCOUNT: ResolvedAccount = {
  scenario: 'guest',
  account: null,
  participants: [],
  childParticipants: [],
  scheduleEntries: [],
  activePlans: [],
};

export function toDomainParticipant(profile: ParticipantProfile): Participant {
  return {
    id: profile.id,
    // Product rule (docs/02 §4): the account holder is always presented as
    // "Me"; children by their name.
    label: profile.kind === 'self' ? 'Me' : profile.firstName,
    kind: profile.kind,
    ...(profile.dateOfBirth !== null ? { dateOfBirth: profile.dateOfBirth } : {}),
  };
}

export function deriveRealAccount(
  profiles: ParticipantProfile[],
  ready: boolean,
): ResolvedAccount {
  const participants = profiles.map(toDomainParticipant);
  const self = participants.find((participant) => participant.kind === 'self');
  return {
    // Nominal fixture id only (the field exists for the QA fixture layer);
    // nothing downstream branches on it.
    scenario: 'me-only',
    account: { primaryParticipantId: self?.id ?? 'me' },
    participants,
    childParticipants: participants.filter((participant) => participant.kind === 'child'),
    scheduleEntries: [],
    activePlans: [],
    participantsReady: ready,
  };
}
