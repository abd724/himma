/**
 * RI-1 — real-account derivation: guests are empty, authenticated accounts
 * carry real participants in the domain shape with EMPTY schedule surfaces
 * (nothing fabricated — docs/18 §10), self is presented as "Me".
 */
import { describe, expect, it } from '@jest/globals';
import type { ParticipantProfile } from '@/services/contracts/identity';
import {
  deriveRealAccount,
  GUEST_ACCOUNT,
  toDomainParticipant,
} from '@/state/account-derivation';

const SELF: ParticipantProfile = {
  id: 'p-self',
  kind: 'self',
  firstName: 'Abdelrahman',
  dateOfBirth: null,
  status: 'active',
  version: 1,
};
const CHILD: ParticipantProfile = {
  id: 'p-child',
  kind: 'child',
  firstName: 'Ahmed',
  dateOfBirth: '2018-03-01',
  status: 'active',
  version: 1,
};

describe('account derivation', () => {
  it('guest account is empty and account-less', () => {
    expect(GUEST_ACCOUNT.account).toBeNull();
    expect(GUEST_ACCOUNT.participants).toEqual([]);
    expect(GUEST_ACCOUNT.scheduleEntries).toEqual([]);
    expect(GUEST_ACCOUNT.activePlans).toEqual([]);
  });

  it('self is presented as "Me"; children by name with their DOB', () => {
    expect(toDomainParticipant(SELF)).toEqual({ id: 'p-self', label: 'Me', kind: 'self' });
    expect(toDomainParticipant(CHILD)).toEqual({
      id: 'p-child',
      label: 'Ahmed',
      kind: 'child',
      dateOfBirth: '2018-03-01',
    });
  });

  it('an authenticated account maps real participants and keeps schedule surfaces truthfully empty', () => {
    const account = deriveRealAccount([SELF, CHILD], true);
    expect(account.account).toEqual({ primaryParticipantId: 'p-self' });
    expect(account.participants).toHaveLength(2);
    expect(account.childParticipants).toEqual([
      expect.objectContaining({ id: 'p-child', kind: 'child' }),
    ]);
    expect(account.scheduleEntries).toEqual([]); // no fabricated bookings
    expect(account.activePlans).toEqual([]); // no fabricated plans
    expect(account.participantsReady).toBe(true);
  });

  it('the readiness flag reflects a still-loading participant list', () => {
    expect(deriveRealAccount([], false).participantsReady).toBe(false);
  });
});
