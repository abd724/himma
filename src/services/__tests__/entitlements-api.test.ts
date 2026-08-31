/**
 * RI-4 — the entitlements HTTP adapter over a stub client: canonical
 * paths/bodies (identifiers + idempotency context + the server-derived
 * occurrence pair ONLY), the alreadyLive/issued outcome split, and
 * not-found shaping. Secrets pass through untouched — never stored here.
 */
import { describe, expect, it } from '@jest/globals';
import { createEntitlementsApi } from '@/services/api/entitlements-api';
import { ApiError, type HttpClient } from '@/services/http/http-client';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function stubClient(respond: (call: Call) => unknown): { client: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: HttpClient = {
    async request(method, path, options = {}) {
      const call: Call = { method, path, ...(options.body !== undefined ? { body: options.body } : {}) };
      calls.push(call);
      return respond(call) as never;
    },
  };
  return { client, calls };
}

describe('entitlements api adapter', () => {
  it('reads use the canonical customer routes with bounded query params', async () => {
    const { client, calls } = stubClient((call) => {
      if (call.path.startsWith('/customer/entitlements?')) {
        return { entitlements: [], nextCursor: null };
      }
      if (call.path.includes('/reservable-sessions')) return { sessions: [] };
      if (call.path.includes('/attendance')) return { attendance: [], nextCursor: null };
      if (call.path.startsWith('/customer/calendar')) return { events: [] };
      return { entitlement: { entitlementId: 'ent-1' } };
    });
    const api = createEntitlementsApi(client);
    await api.listEntitlements({ limit: 50 });
    await api.getEntitlement('ent-1');
    await api.listAttendance('ent-1', { limit: 10 });
    await api.listReservableSessions('ent-1', { from: '2026-09-01', to: '2026-10-01' });
    await api.listOccurrences({ from: '2026-09-01', to: '2026-09-30' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /customer/entitlements?limit=50',
      'GET /customer/entitlements/ent-1',
      'GET /customer/entitlements/ent-1/attendance?limit=10',
      'GET /customer/entitlements/ent-1/reservable-sessions?from=2026-09-01&to=2026-10-01',
      'GET /customer/calendar?from=2026-09-01&to=2026-09-30',
    ]);
  });

  it('reservation + acquisition writes carry identifiers and idempotency keys ONLY', async () => {
    const { client, calls } = stubClient((call) => {
      if (call.path.endsWith('/reservation-quote')) return { quote: { quoteId: 'q1' } };
      if (call.path.endsWith('/confirm')) return { reservation: { bookingId: 'b1' } };
      if (call.path.endsWith('/quote')) return { quote: { quoteId: 'aq1' } };
      if (call.path.endsWith('/confirm-free')) return { purchase: { purchaseId: 'p1' } };
      return { checkout: { purchaseId: 'p1', redirectUrl: 'https://x', expiresAt: 'now' } };
    });
    const api = createEntitlementsApi(client);
    await api.requestReservationQuote('ent-1', 'sess-1');
    await api.confirmReservation('hold-1', 'key-1');
    await api.requestAcquisitionQuote({
      programId: 'prog-1',
      priceOptionId: 'po-1',
      participantId: 'part-1',
    });
    await api.confirmFreeAcquisition('aq1', 'key-2');
    await api.initiateAcquisition('aq1', 'key-3');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/customer/entitlements/ent-1/reservation-quote',
        body: { sessionId: 'sess-1' },
      },
      {
        method: 'POST',
        path: '/customer/entitlement-reservations/confirm',
        body: { holdId: 'hold-1', idempotencyKey: 'key-1' },
      },
      {
        method: 'POST',
        path: '/customer/entitlement-purchases/quote',
        body: { programId: 'prog-1', priceOptionId: 'po-1', participantId: 'part-1' },
      },
      {
        method: 'POST',
        path: '/customer/entitlement-purchases/confirm-free',
        body: { quoteId: 'aq1', idempotencyKey: 'key-2' },
      },
      {
        method: 'POST',
        path: '/customer/entitlement-purchases/initiate',
        body: { quoteId: 'aq1', idempotencyKey: 'key-3' },
      },
    ]);
  });

  it('credential issuance carries the occurrence pair VERBATIM and splits issued vs alreadyLive (no secret on alreadyLive)', async () => {
    const { client, calls } = stubClient((call) => {
      if (call.path.endsWith('/bookings/bk-1/credential')) {
        return {
          credential: {
            credentialId: 'cred-1',
            state: 'live',
            expiresAt: 'later',
            displayCode: '12345678',
            token: 'opaque',
            replayed: false,
          },
        };
      }
      return {
        credential: { credentialId: 'cred-2', state: 'live', expiresAt: 'later', alreadyLive: true },
      };
    });
    const api = createEntitlementsApi(client);
    const issued = await api.issueBookingCredential('bk-1', {
      idempotencyKey: 'key-1',
      occurrence: { date: '2026-09-07', startTime: '09:00' },
    });
    expect(issued.kind).toBe('issued');
    if (issued.kind === 'issued') expect(issued.credential.displayCode).toBe('12345678');
    expect(calls[0]!.body).toEqual({
      idempotencyKey: 'key-1',
      occurrence: { date: '2026-09-07', startTime: '09:00' },
    });
    const alreadyLive = await api.issueEntitlementCredential('ent-1', {
      idempotencyKey: 'key-2',
    });
    expect(alreadyLive.kind).toBe('alreadyLive');
    expect('displayCode' in alreadyLive.credential).toBe(false);
  });

  it('regeneration names the CURRENT credential explicitly', async () => {
    const { client, calls } = stubClient(() => ({
      credential: {
        credentialId: 'cred-2',
        state: 'live',
        expiresAt: 'later',
        displayCode: '87654321',
        replayed: false,
      },
    }));
    const api = createEntitlementsApi(client);
    await api.issueEntitlementCredential('ent-1', {
      idempotencyKey: 'key-3',
      regenerateCredentialId: 'cred-1',
    });
    expect(calls[0]!.body).toEqual({ idempotencyKey: 'key-3', regenerateCredentialId: 'cred-1' });
  });

  it('unknown/foreign ids stay not-found-shaped (undefined, never a throw)', async () => {
    const client: HttpClient = {
      async request() {
        throw new ApiError(404, 'notFound', 'not found');
      },
    };
    const api = createEntitlementsApi(client);
    expect(await api.getEntitlement('foreign')).toBeUndefined();
    expect(await api.credentialStatus('foreign')).toBeUndefined();
    expect(await api.getPurchase('foreign')).toBeUndefined();
  });
});
