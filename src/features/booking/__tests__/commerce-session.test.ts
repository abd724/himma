/**
 * RI-3 — the frontend idempotency authority (owner §10): stable keys per
 * material intent, replay-safe retries, explicit idempotent release on
 * material change, and no fresh commercial intent from re-renders.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  BookingCommerceController,
  holdSignature,
  newIdempotencyKey,
} from '@/features/booking/commerce-session';
import type { CapacityHold, CommerceApi, HoldRequest } from '@/services/contracts/commerce';

const INTENT = {
  programId: 'prog-1',
  optionId: 'opt-1',
  unitKind: 'session' as const,
  unitId: 'unit-1',
  participantId: 'part-1',
  quoteId: 'quote-1',
};

function apiDouble() {
  const claims: { key: string; unitId: string }[] = [];
  const releases: { holdId: string; key: string }[] = [];
  let failNextClaim = false;
  const api = {
    async claimHold(input: HoldRequest) {
      claims.push({ key: input.idempotencyKey, unitId: input.unitId });
      if (failNextClaim) {
        failNextClaim = false;
        throw new Error('network timeout');
      }
      const hold: CapacityHold = {
        holdId: `hold-${input.idempotencyKey}`,
        unitKind: input.unitKind,
        unitId: input.unitId,
        participantId: input.participantId,
        state: 'active',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      return hold;
    },
    async releaseHold(holdId: string, idempotencyKey: string) {
      releases.push({ holdId, key: idempotencyKey });
      return 'holdReleased' as const;
    },
  } as unknown as CommerceApi;
  return {
    api,
    claims,
    releases,
    failNext: () => {
      failNextClaim = true;
    },
  };
}

describe('booking commerce controller', () => {
  it('same intent + double tap/retry reuses the SAME key — one hold, never two', async () => {
    const { api, claims } = apiDouble();
    const controller = new BookingCommerceController(api);
    const first = await controller.ensureHold(INTENT);
    const second = await controller.ensureHold(INTENT);
    expect(second.holdId).toBe(first.holdId);
    // The second call did not even reach the wire (hold reused locally).
    expect(claims).toHaveLength(1);
  });

  it('a TIMEOUT retry replays the SAME key (the certified claim replays the hold)', async () => {
    const { api, claims, failNext } = apiDouble();
    const controller = new BookingCommerceController(api);
    failNext();
    await expect(controller.ensureHold(INTENT)).rejects.toThrow('network timeout');
    await controller.ensureHold(INTENT);
    expect(claims).toHaveLength(2);
    expect(claims[0]!.key).toBe(claims[1]!.key);
  });

  it('a MATERIAL intent change releases the old hold (idempotent key) and claims with a NEW key', async () => {
    const { api, claims, releases } = apiDouble();
    const controller = new BookingCommerceController(api);
    const first = await controller.ensureHold(INTENT);
    await controller.ensureHold({ ...INTENT, unitId: 'unit-2', quoteId: 'quote-2' });
    expect(releases).toHaveLength(1);
    expect(releases[0]!.holdId).toBe(first.holdId);
    expect(claims).toHaveLength(2);
    expect(claims[0]!.key).not.toBe(claims[1]!.key);
  });

  it('confirm/checkout keys are stable per hold — repeated reads never mint new commercial intents', async () => {
    const { api } = apiDouble();
    const controller = new BookingCommerceController(api);
    const hold = await controller.ensureHold(INTENT);
    const confirm1 = controller.confirmKeyFor(hold.holdId);
    const confirm2 = controller.confirmKeyFor(hold.holdId);
    const checkout1 = controller.checkoutKeyFor(hold.holdId);
    const checkout2 = controller.checkoutKeyFor(hold.holdId);
    expect(confirm1).toBe(confirm2);
    expect(checkout1).toBe(checkout2);
    expect(confirm1).not.toBe(checkout1);
  });

  it('release is swallowed-on-failure (expiry stays authoritative) and forgets local state', async () => {
    const { api } = apiDouble();
    const failing = {
      ...api,
      releaseHold: jest.fn(async () => {
        throw new Error('offline');
      }),
    } as unknown as CommerceApi;
    const controller = new BookingCommerceController(failing);
    await controller.ensureHold(INTENT);
    await expect(controller.releaseCurrentHold()).resolves.toBeUndefined();
    expect(controller.hold).toBeUndefined();
  });

  it('keys are contract-valid and unique; signatures change with any material field', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(holdSignature(INTENT)).not.toBe(holdSignature({ ...INTENT, participantId: 'other' }));
    expect(holdSignature(INTENT)).toBe(holdSignature({ ...INTENT }));
  });
});
