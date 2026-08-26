import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiJsonResponse } from '../src/api/client';
import type { LiveTransport } from '../src/auth/live/live-auth-runtime';
import { createLiveFulfillmentPort } from '../src/services/live/live-fulfillment-port';

/**
 * Live fulfillment-configuration port (W2-13) — deterministic mapping
 * coverage over a stubbed transport: the real GET/PUT fulfillment routes
 * and their exact payloads, the immutable-revision result, the refusal
 * mapping (invalidFulfillmentConfig / invalidBranchScope /
 * lifecycleConflict), fail-closed DTO validation, and fixture isolation.
 * The REAL backend supersede-and-insert behavior is proven by the contract
 * suite (test-contract/attendance-contract.test.ts).
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
      throw new Error('fulfillment configuration never uses the public channel');
    },
    notifyAccessChanged() {
      throw new Error('fulfillment configuration must never claim an access change');
    },
  };
  return { transport, calls };
}

const ORG = '018f0000-0000-7000-8000-00000000f001';
const PROGRAM = '018f0000-0000-7000-8000-00000000f101';
const OPTION = '018f0000-0000-7000-8000-00000000f201';
const PATH = `/provider/organizations/${ORG}/programs/${PROGRAM}/price-options/${OPTION}/fulfillment`;

const REVISION = {
  revisionId: '018f0000-0000-7000-8000-00000000f301',
  revisionNo: 2,
  state: 'active',
  usageKind: 'finite',
  usesTotal: 10,
  validityKind: 'daysFromConfirmation',
  validityDays: 90,
  reservationRequired: false,
  walkInAllowed: true,
  scheduleTerms: [{ weekday: 1, startTime: '06:00', endTime: '22:00' }],
  createdAt: '2026-08-26T09:00:00.000Z',
};

const TERMS = {
  usageKind: 'finite',
  usesTotal: 10,
  validityKind: 'daysFromConfirmation',
  validityDays: 90,
  reservationRequired: false,
  walkInAllowed: true,
} as const;

describe('loadFulfillment', () => {
  test('GETs the real fulfillment route and returns kind/supported/active', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { fulfillment: { optionKind: 'membership', supported: true, active: REVISION } },
    }));
    const port = createLiveFulfillmentPort(transport);
    const outcome = await port.loadFulfillment(ORG, PROGRAM, OPTION);
    expect(calls[0]).toEqual({ path: PATH, method: 'GET', body: undefined });
    expect(outcome).toEqual({
      kind: 'fulfillment',
      optionKind: 'membership',
      supported: true,
      active: REVISION,
    });
  });

  test('a capacity option loads truthfully as unsupported with no active revision', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { fulfillment: { optionKind: 'dropIn', supported: false, active: null } },
    }));
    const port = createLiveFulfillmentPort(transport);
    expect(await port.loadFulfillment(ORG, PROGRAM, OPTION)).toEqual({
      kind: 'fulfillment',
      optionKind: 'dropIn',
      supported: false,
      active: null,
    });
  });

  test('notFound and forbidden map 1:1; anything unknown fails closed', async () => {
    const notFound = createLiveFulfillmentPort(
      makeTransport(() => ({ status: 404, code: 'notFound' })).transport,
    );
    expect(await notFound.loadFulfillment(ORG, PROGRAM, OPTION)).toEqual({ kind: 'notFound' });
    const forbidden = createLiveFulfillmentPort(
      makeTransport(() => ({ status: 403, code: 'forbidden' })).transport,
    );
    expect(await forbidden.loadFulfillment(ORG, PROGRAM, OPTION)).toEqual({ kind: 'forbidden' });
    const unknown = createLiveFulfillmentPort(
      makeTransport(() => ({ status: 500, code: 'somethingNew' })).transport,
    );
    expect(await unknown.loadFulfillment(ORG, PROGRAM, OPTION)).toEqual({ kind: 'unavailable' });
  });

  test('a malformed active revision fails closed rather than rendering partial terms', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: {
        fulfillment: { optionKind: 'membership', supported: true, active: { revisionId: 'x' } },
      },
    }));
    const port = createLiveFulfillmentPort(transport);
    expect(await port.loadFulfillment(ORG, PROGRAM, OPTION)).toEqual({ kind: 'unavailable' });
  });
});

describe('setFulfillment — supersede-and-insert', () => {
  test('PUTs the terms verbatim and returns the newly inserted IMMUTABLE revision', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { revision: REVISION },
    }));
    const port = createLiveFulfillmentPort(transport);
    const outcome = await port.setFulfillment(ORG, PROGRAM, OPTION, TERMS);
    expect(calls[0]).toEqual({ path: PATH, method: 'PUT', body: TERMS });
    expect(outcome).toEqual({ kind: 'revisionCreated', revision: REVISION });
  });

  test.each([
    ['invalidFulfillmentConfig', 'invalidFulfillmentConfig'],
    ['invalidBranchScope', 'invalidBranch'],
    ['lifecycleConflict', 'lifecycleConflict'],
    ['notFound', 'notFound'],
    ['forbidden', 'forbidden'],
  ] as const)('maps server code %s to %s', async (code, kind) => {
    const { transport } = makeTransport(() => ({ status: 422, code }));
    const port = createLiveFulfillmentPort(transport);
    expect(await port.setFulfillment(ORG, PROGRAM, OPTION, TERMS)).toEqual({ kind });
  });

  test('network failure, missing session, and a malformed success body all fail closed', async () => {
    const network = createLiveFulfillmentPort(makeTransport(() => 'network').transport);
    expect(await network.setFulfillment(ORG, PROGRAM, OPTION, TERMS)).toEqual({
      kind: 'unavailable',
    });
    const noSession = createLiveFulfillmentPort(makeTransport(() => 'noSession').transport);
    expect(await noSession.setFulfillment(ORG, PROGRAM, OPTION, TERMS)).toEqual({
      kind: 'unavailable',
    });
    const malformed = createLiveFulfillmentPort(
      makeTransport(() => ({ status: 200, body: { revision: { revisionNo: 'two' } } })).transport,
    );
    expect(await malformed.setFulfillment(ORG, PROGRAM, OPTION, TERMS)).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('structural guarantees', () => {
  test('the live fulfillment module is structurally isolated from fixture code', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'services', 'live', 'live-fulfillment-port.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/services\/mock|fixture-auth/i);
  });
});
