import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiJsonResponse } from '../src/api/client';
import type { LiveTransport } from '../src/auth/live/live-auth-runtime';
import { createLiveLifecyclePort } from '../src/services/live/live-lifecycle-port';

/**
 * Live listing lifecycle actions (W2-12C3) — deterministic mapping
 * coverage over a stubbed transport: the four real named routes, CAS
 * pass-through, canonical server-state results, the structured
 * `programIncomplete` gap mapping, the organization go-live gate,
 * outcome translation, and fixture isolation. The REAL backend behavior
 * behind the same port is proven by the contract suite
 * (test-contract/catalogue-lifecycle-contract.test.ts on real PostgreSQL).
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
      throw new Error('lifecycle actions never use the public channel');
    },
    notifyAccessChanged() {
      throw new Error('lifecycle actions must never claim an access change');
    },
  };
  return { transport, calls };
}

const ORG = '018f0000-0000-7000-8000-00000000e001';
const PROGRAM = '018f0000-0000-7000-8000-00000000e101';

describe('the four real named lifecycle routes', () => {
  test.each([
    ['submitProgram', 'submit', 'programSubmitted', { status: 'programSubmitted', version: 3 }, { kind: 'programSubmitted', version: 3 }],
    ['publishProgram', 'publish', 'programPublished', { status: 'programPublished', version: 4 }, { kind: 'programPublished', version: 4 }],
    ['pauseProgram', 'pause', 'programPaused', { status: 'programPaused', version: 5 }, { kind: 'programPaused', version: 5 }],
    ['archiveProgram', 'archive', 'programArchived', { status: 'programArchived' }, { kind: 'programArchived' }],
  ] as const)('%s POSTs expectedVersion to /%s and returns the canonical result', async (operation, action, _status, body, expected) => {
    const { transport, calls } = makeTransport(() => ({ status: 200, body }));
    const port = createLiveLifecyclePort(transport);
    const outcome = await port[operation](ORG, PROGRAM, 2);
    expect(calls[0]).toEqual({
      path: `/provider/organizations/${ORG}/listings/${PROGRAM}/${action}`,
      method: 'POST',
      body: { expectedVersion: 2 },
    });
    expect(outcome).toEqual(expected);
  });

  test('submission ends at the SERVER state — a submit success is `programSubmitted`, never an optimistic in_review claim', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { status: 'programSubmitted', version: 2 },
    }));
    const outcome = await createLiveLifecyclePort(transport).submitProgram(ORG, PROGRAM, 1);
    expect(outcome).toEqual({ kind: 'programSubmitted', version: 2 });
  });
});

describe('canonical completeness (server-authoritative)', () => {
  test('an incomplete submit maps the EXACT structured service gaps', async () => {
    const { transport } = makeTransport(() => ({
      status: 409,
      body: {
        code: 'programIncomplete',
        message: 'The listing is not ready: complete the missing catalogue requirements.',
        missing: ['activeBranch', 'activePriceOption'],
      },
      code: 'programIncomplete',
    }));
    await expect(
      createLiveLifecyclePort(transport).submitProgram(ORG, PROGRAM, 1),
    ).resolves.toEqual({
      kind: 'programIncomplete',
      missing: ['activeBranch', 'activePriceOption'],
    });
  });

  test('an out-of-vocabulary gap fails the mapping closed — no missing-field explanation is ever fabricated', async () => {
    const { transport } = makeTransport(() => ({
      status: 409,
      body: { code: 'programIncomplete', message: 'incomplete', missing: ['secretInternalCheck'] },
      code: 'programIncomplete',
    }));
    await expect(
      createLiveLifecyclePort(transport).publishProgram(ORG, PROGRAM, 1),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('outcome translation', () => {
  test.each([
    ['a stale expectedVersion', { status: 409, code: 'staleVersion' }, 'staleVersion'],
    ['an illegal source state', { status: 409, code: 'lifecycleConflict' }, 'lifecycleConflict'],
    ['a role without the capability', { status: 403, code: 'forbidden' }, 'forbidden'],
    ['a foreign/unknown program', { status: 404, code: 'notFound' }, 'notFound'],
    ['a suspended organization', { status: 403, code: 'organizationSuspended' }, 'organizationSuspended'],
    ['a backend failure', { status: 500, code: 'internalError' }, 'unavailable'],
    ['a network failure (never success)', 'network' as const, 'unavailable'],
    ['no session', 'noSession' as const, 'unavailable'],
  ])('submit: %s → %s', async (_label, wire, kind) => {
    const { transport } = makeTransport(() => wire);
    await expect(createLiveLifecyclePort(transport).submitProgram(ORG, PROGRAM, 1)).resolves.toEqual(
      { kind },
    );
  });

  test('publish: the organization go-live gate maps 1:1 and is never bypassed client-side', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 409,
      code: 'organizationNotLive',
    }));
    await expect(
      createLiveLifecyclePort(transport).publishProgram(ORG, PROGRAM, 1),
    ).resolves.toEqual({ kind: 'organizationNotLive' });
    // One request, no retry, no fallback path.
    expect(calls).toHaveLength(1);
  });

  test('a stale response is terminal — the port never silently retries with a newer version', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 409, code: 'staleVersion' }));
    await createLiveLifecyclePort(transport).publishProgram(ORG, PROGRAM, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ expectedVersion: 7 });
  });

  test('a malformed success echo fails closed instead of claiming a transition', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { status: 'programPublished' }, // version missing
    }));
    await expect(
      createLiveLifecyclePort(transport).publishProgram(ORG, PROGRAM, 1),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('structural guarantees', () => {
  test('exactly four POST operations — no state patch, no moderation/revision decision is expressible', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 500, code: 'internalError' }));
    const port = createLiveLifecyclePort(transport);
    await port.submitProgram(ORG, PROGRAM, 1);
    await port.publishProgram(ORG, PROGRAM, 1);
    await port.pauseProgram(ORG, PROGRAM, 1);
    await port.archiveProgram(ORG, PROGRAM, 1);
    expect(Object.keys(port).sort()).toEqual([
      'archiveProgram',
      'pauseProgram',
      'publishProgram',
      'submitProgram',
    ]);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.body).toEqual({ expectedVersion: 1 });
      expect(call.path).toMatch(/\/(submit|publish|pause|archive)$/);
    }
  });

  test('the live lifecycle module is structurally isolated from fixture code', () => {
    const source = readFileSync(
      join(__dirname, '../src/services/live/live-lifecycle-port.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/services\/mock|fixture/i);
  });
});
