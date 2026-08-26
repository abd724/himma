import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiJsonResponse } from '../src/api/client';
import type { LiveTransport } from '../src/auth/live/live-auth-runtime';
import { createLiveCheckInPort } from '../src/services/live/live-checkin-port';

/**
 * Live provider check-in port (W2-13) — deterministic mapping coverage
 * over a stubbed transport: the two real S6-2 routes and their exact
 * payloads, the 201-only redeem success, the 1:1 refusal-code mapping
 * (generic notFound STAYS generic — the S6-2 privacy shaping is never
 * "improved" client-side), fail-closed DTO validation, and fixture
 * isolation. The REAL backend behavior behind the same port is proven by
 * the contract suite (test-contract/attendance-contract.test.ts).
 */

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

function makeTransport(
  respond: (
    call: RecordedCall,
  ) => { status: number; body?: unknown; code?: string } | 'network' | 'noSession',
) {
  const calls: RecordedCall[] = [];
  const transport: LiveTransport = {
    async authorizedRequest(path, options = {}) {
      const call: RecordedCall = { path, method: options.method ?? 'GET', body: options.body };
      calls.push(call);
      const result = respond(call);
      if (result === 'noSession') return null;
      if (result === 'network') {
        return { status: 0, code: null, body: null, networkFailure: true };
      }
      const response: ApiJsonResponse = {
        status: result.status,
        code: result.code ?? null,
        body:
          result.body ??
          (result.code !== undefined ? { code: result.code, message: 'refused' } : null),
        networkFailure: false,
      };
      return response;
    },
    async publicRequest() {
      throw new Error('check-in never uses the public channel');
    },
    notifyAccessChanged() {
      throw new Error('check-in must never claim an access change');
    },
  };
  return { transport, calls };
}

const ORG = '018f0000-0000-7000-8000-00000000c001';
const CREDENTIAL = '018f0000-0000-7000-8000-00000000c101';
const IDEMPOTENCY = '018f0000-0000-7000-8000-00000000c201';

const PREVIEW_BODY = {
  preview: {
    credentialId: CREDENTIAL,
    expiresAt: '2026-08-26T10:10:00.000Z',
    participantFirstName: 'Maya',
    programTitle: 'Aqua Fitness',
    targetKind: 'walkIn',
    usage: { usageKind: 'finite', usesTotal: 8, used: 2, remaining: 6 },
    validity: { validFrom: '2026-08-01T00:00:00.000Z', validUntil: '2026-10-01T00:00:00.000Z' },
  },
};

const ATTENDANCE_BODY = {
  attendance: {
    attendanceId: '018f0000-0000-7000-8000-00000000c301',
    credentialId: CREDENTIAL,
    participantFirstName: 'Maya',
    programTitle: 'Aqua Fitness',
    targetKind: 'walkIn',
    occurredAt: '2026-08-26T10:02:00.000Z',
    remaining: 5,
  },
};

describe('previewCheckIn — the pure read', () => {
  test('POSTs the raw code to the real preview route and returns the full preview DTO', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 200, body: PREVIEW_BODY }));
    const port = createLiveCheckInPort(transport);
    const outcome = await port.previewCheckIn(ORG, '12345678');
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/check-in/preview`,
      method: 'POST',
      body: { code: '12345678' },
    });
    expect(outcome).toEqual({ kind: 'preview', preview: PREVIEW_BODY.preview });
  });

  test.each([
    ['notFound', 'codeNotFound'],
    ['credentialExpired', 'codeExpired'],
    ['credentialAlreadyUsed', 'codeAlreadyUsed'],
    ['forbidden', 'notAuthorized'],
    ['entitlementNotActive', 'entitlementNotActive'],
    ['entitlementExhausted', 'entitlementExhausted'],
    ['rateLimited', 'tooManyAttempts'],
  ] as const)('maps server code %s to the typed refusal %s', async (code, kind) => {
    const { transport } = makeTransport(() => ({ status: 422, code }));
    const port = createLiveCheckInPort(transport);
    expect(await port.previewCheckIn(ORG, '12345678')).toEqual({ kind });
  });

  test('an unknown code, a missing session, and a network failure all FAIL CLOSED to unavailable', async () => {
    const unknown = createLiveCheckInPort(
      makeTransport(() => ({ status: 500, code: 'somethingNew' })).transport,
    );
    expect(await unknown.previewCheckIn(ORG, '12345678')).toEqual({ kind: 'unavailable' });
    const noSession = createLiveCheckInPort(makeTransport(() => 'noSession').transport);
    expect(await noSession.previewCheckIn(ORG, '12345678')).toEqual({ kind: 'unavailable' });
    const network = createLiveCheckInPort(makeTransport(() => 'network').transport);
    expect(await network.previewCheckIn(ORG, '12345678')).toEqual({ kind: 'unavailable' });
  });

  test('a 200 whose body is outside the approved DTO shape fails closed — never a partial preview', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { preview: { credentialId: CREDENTIAL, participantFirstName: 'Maya' } },
    }));
    const port = createLiveCheckInPort(transport);
    expect(await port.previewCheckIn(ORG, '12345678')).toEqual({ kind: 'unavailable' });
  });
});

describe('redeemCheckIn — the atomic authority', () => {
  test('POSTs code + credentialId + idempotencyKey to the real redeem route and accepts 201 ONLY', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 201, body: ATTENDANCE_BODY }));
    const port = createLiveCheckInPort(transport);
    const outcome = await port.redeemCheckIn(ORG, {
      code: '12345678',
      credentialId: CREDENTIAL,
      idempotencyKey: IDEMPOTENCY,
    });
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/check-in/redeem`,
      method: 'POST',
      body: { code: '12345678', credentialId: CREDENTIAL, idempotencyKey: IDEMPOTENCY },
    });
    expect(outcome).toEqual({ kind: 'attendanceRecorded', attendance: ATTENDANCE_BODY.attendance });
  });

  test('a 200 with an attendance body is NOT treated as success — the backend answers 201, anything else fails closed', async () => {
    const { transport } = makeTransport(() => ({ status: 200, body: ATTENDANCE_BODY }));
    const port = createLiveCheckInPort(transport);
    expect(
      await port.redeemCheckIn(ORG, {
        code: '12345678',
        credentialId: CREDENTIAL,
        idempotencyKey: IDEMPOTENCY,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  test.each([
    ['credentialAlreadyUsed', 'codeAlreadyUsed'],
    ['credentialExpired', 'codeExpired'],
    ['notFound', 'codeNotFound'],
    ['entitlementExhausted', 'entitlementExhausted'],
    ['rateLimited', 'tooManyAttempts'],
    ['forbidden', 'notAuthorized'],
  ] as const)('a confirm-time %s maps to %s — the truthful race refusal, never a false success', async (code, kind) => {
    const { transport } = makeTransport(() => ({ status: 409, code }));
    const port = createLiveCheckInPort(transport);
    expect(
      await port.redeemCheckIn(ORG, {
        code: '12345678',
        credentialId: CREDENTIAL,
        idempotencyKey: IDEMPOTENCY,
      }),
    ).toEqual({ kind });
  });

  test('a 201 whose attendance body is malformed fails closed instead of inventing a success', async () => {
    const { transport } = makeTransport(() => ({
      status: 201,
      body: { attendance: { attendanceId: 'not-there' } },
    }));
    const port = createLiveCheckInPort(transport);
    expect(
      await port.redeemCheckIn(ORG, {
        code: '12345678',
        credentialId: CREDENTIAL,
        idempotencyKey: IDEMPOTENCY,
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('structural guarantees', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'services', 'live', 'live-checkin-port.ts'),
    'utf8',
  );

  test('the live check-in module is structurally isolated from fixture code', () => {
    expect(source).not.toMatch(/services\/mock|fixture/i);
  });

  test('no QR/scanner machinery and no manual attendance mutation exists in the live port', () => {
    // (The doc comment MENTIONS QR only to record its deliberate absence.)
    expect(source).not.toMatch(/getUserMedia|BarcodeDetector|jsQR|qr-scanner|camera/i);
    expect(source).not.toMatch(/adjustBalance|setRemaining|deleteAttendance/);
  });
});
