/**
 * RI-1/RI-5 — real-account derivation: guests are empty, authenticated
 * accounts carry real participants in the domain shape, and the schedule
 * surfaces derive from the REAL unified Calendar read + Entitlement
 * family (nothing fabricated — docs/18 §10): a flexible pass with no
 * reservation contributes no dates, plans carry a next-session line only
 * when the server reports one, self is presented as "Me".
 */
import { describe, expect, it } from '@jest/globals';
import type { CalendarOccurrence, CustomerEntitlement } from '@/services/contracts/entitlements';
import type { ParticipantProfile } from '@/services/contracts/identity';
import {
  deriveRealAccount,
  GUEST_ACCOUNT,
  toActivePlans,
  toDomainParticipant,
  toScheduleEntries,
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

/** Full server calendar event from the varying fields. */
function calendarEvent(partial: Partial<CalendarOccurrence> & { eventKey: string }): CalendarOccurrence {
  return {
    sourceType: 'sessionBooking',
    context: 'booked',
    participant: { id: 'p-self', firstName: 'Abdelrahman' },
    program: { id: 'prog-1', titleEn: 'Lap swimming' },
    provider: { id: 'org-1', displayName: 'Marina Aquatics' },
    branch: { id: 'br-1', label: 'Marina branch' },
    startAt: '2026-09-02T15:00:00.000Z',
    endAt: '2026-09-02T16:00:00.000Z',
    timezone: 'Asia/Dubai',
    ...partial,
  };
}

function entitlement(partial: Partial<CustomerEntitlement>): CustomerEntitlement {
  return {
    entitlementId: 'ent-1',
    participant: { id: 'p-self', firstName: 'Abdelrahman' },
    program: { id: 'prog-1', titleEn: '10-class pack' },
    provider: { id: 'org-1', displayName: 'Marina Aquatics' },
    branch: null,
    productLabel: '10-class pack',
    optionKind: 'package',
    usageKind: 'finite',
    status: 'active',
    validFrom: '2026-08-01T00:00:00.000Z',
    validUntil: null,
    walkInAllowed: true,
    reservationRequired: false,
    finite: { usesTotal: 10, used: 2, remaining: 8, reservedUpcoming: 0, availableToReserve: 8 },
    scheduleTerms: [],
    nextReservedSessionAt: null,
    ...partial,
  };
}

const NOW = new Date('2026-09-01T08:00:00.000Z');

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

  it('an authenticated account maps real participants and keeps schedule surfaces truthfully empty without server events', () => {
    const account = deriveRealAccount([SELF, CHILD], true);
    expect(account.account).toEqual({ primaryParticipantId: 'p-self' });
    expect(account.participants).toHaveLength(2);
    expect(account.childParticipants).toEqual([
      expect.objectContaining({ id: 'p-child', kind: 'child' }),
    ]);
    expect(account.scheduleEntries).toEqual([]); // no fabricated events
    expect(account.activePlans).toEqual([]); // no fabricated plans
    expect(account.participantsReady).toBe(true);
  });

  it('the readiness flag reflects a still-loading participant list', () => {
    expect(deriveRealAccount([], false).participantsReady).toBe(false);
  });
});

describe('RI-5: schedule entries from the unified Calendar read', () => {
  it('renders the server list verbatim — one entry per event, explicit ids carried, participants distinct', () => {
    const entries = toScheduleEntries(
      [
        calendarEvent({ eventKey: 'k-1', bookingId: 'bk-1' }),
        // A different child at the SAME time/program stays a distinct entry.
        calendarEvent({
          eventKey: 'k-2',
          bookingId: 'bk-2',
          participant: { id: 'p-child', firstName: 'Ahmed' },
        }),
        // A membership schedule occurrence carries its Pass id.
        calendarEvent({
          eventKey: 'k-3',
          sourceType: 'membershipOccurrence',
          context: 'includedSchedule',
          entitlementId: 'ent-9',
          startAt: '2026-09-03T15:00:00.000Z',
          endAt: '2026-09-03T16:00:00.000Z',
        }),
      ],
      'p-self',
      NOW,
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      id: 'k-1',
      bookingId: 'bk-1',
      participantLabel: 'You',
      areaLabel: 'Marina branch',
    });
    expect(entries[1]).toMatchObject({ id: 'k-2', participantLabel: 'Ahmed' });
    expect(entries[2]).toMatchObject({ id: 'k-3', entitlementId: 'ent-9' });
    expect(entries[2]!.bookingId).toBeUndefined();
  });

  it('keys defensively by the OPAQUE event key only and drops finished events — no business dedupe, no format assumptions', () => {
    const entries = toScheduleEntries(
      [
        calendarEvent({ eventKey: '@!opaque//1', bookingId: 'bk-1' }),
        calendarEvent({ eventKey: '@!opaque//1', bookingId: 'bk-1' }), // defensive
        calendarEvent({
          eventKey: 'past-1',
          startAt: '2026-08-30T15:00:00.000Z',
          endAt: '2026-08-30T16:00:00.000Z',
        }),
      ],
      'p-self',
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('@!opaque//1');
  });

  it('camp/cohort occurrence events group by the EXPLICIT server civil pair (cross-midnight invariant)', () => {
    const entries = toScheduleEntries(
      [
        calendarEvent({
          eventKey: 'camp-day',
          sourceType: 'campWeekOccurrence',
          bookingId: 'bk-1',
          // Sunday in UTC; the canonical day is Monday 00:30 (Dubai).
          startAt: '2026-09-06T20:30:00.000Z',
          endAt: '2026-09-06T21:30:00.000Z',
          occurrence: { date: '2026-09-07', startTime: '00:30' },
        }),
      ],
      'p-self',
      new Date('2026-09-05T08:00:00.000Z'),
    );
    expect(entries[0]!.timeLabel).toBe('12:30 AM');
    expect(entries[0]!.dayLabel).not.toBe(''); // derived from 2026-09-07
  });
});

describe('RI-5: active plans from the REAL Entitlement family', () => {
  it('maps ACTIVE passes with server truths — finite headline, Unlimited, next only when the server reports one', () => {
    const plans = toActivePlans(
      [
        entitlement({}),
        entitlement({
          entitlementId: 'ent-2',
          optionKind: 'membership',
          usageKind: 'unlimited',
          finite: undefined,
          participant: { id: 'p-child', firstName: 'Ahmed' },
          nextReservedSessionAt: '2026-09-04T15:00:00.000Z',
        }),
        entitlement({ entitlementId: 'ent-3', status: 'expired' }),
        entitlement({ entitlementId: 'ent-4', status: 'exhausted' }),
      ],
      'p-self',
    );
    expect(plans).toHaveLength(2); // inactive passes never fabricate plans
    expect(plans[0]).toMatchObject({
      id: 'ent-1',
      entitlementId: 'ent-1',
      kind: 'package',
      participantLabel: 'You',
      progressLabel: '8 of 10 visits remaining',
    });
    expect(plans[0]!.nextSessionLabel).toBeUndefined(); // no fake next date
    expect(plans[1]).toMatchObject({
      kind: 'membership',
      participantLabel: 'Ahmed',
      progressLabel: 'Unlimited',
    });
    expect(plans[1]!.nextSessionLabel).toBeDefined();
  });
});
