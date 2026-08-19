import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import type { FetchLike } from '../src/api/client';

/**
 * The live `/admin/me` access port over a stubbed transport: outcome
 * mapping (resolved / noAccess / stepUpRequired / unavailable) and the
 * fail-closed DTO validation. The REAL backend behavior behind the same
 * route is proven by backend/test/admin-me.test.ts on real PostgreSQL.
 */

const ACCESS_BODY = {
  user: { id: '018f0000-0000-7000-8000-00000000f001', displayName: 'Layla Operations' },
  roles: ['operations'],
  capabilities: ['providers.operate', 'catalogue.moderate', 'taxonomy.manage'],
};

function runtimeWith(handler: (url: string) => { status: number; body: unknown }) {
  const fetchImpl: FetchLike = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const result = handler(url);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: 'https://api.himma.test',
    cognitoIssuer: 'https://cognito.test/pool',
    cognitoClientId: 'client-1',
    fetchImpl,
  });
  return runtime;
}

/** Establish a held session through the continuity bootstrap so the
 *  authorized transport is live (the same seam the portal suites use). */
async function signedInRuntime(handler: (url: string) => { status: number; body: unknown }) {
  const runtime = runtimeWith((url) => {
    if (url.endsWith('/auth/csrf')) return { status: 200, body: { csrfToken: 'CSRF' } };
    if (url.endsWith('/auth/refresh')) {
      return {
        status: 200,
        body: { status: 'authenticated', accessToken: 'AT', assurance: 'mfa', csrfToken: 'CSRF' },
      };
    }
    return handler(url);
  });
  const bootstrap = await runtime.adapter.bootstrap();
  expect(bootstrap.kind).toBe('session');
  return runtime;
}

describe('live /admin/me outcome mapping', () => {
  test('a 200 with the exact DTO resolves the access projection', async () => {
    const runtime = await signedInRuntime(() => ({ status: 200, body: ACCESS_BODY }));
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({
      kind: 'resolved',
      access: ACCESS_BODY,
    });
  });

  test('forbidden (no active admin role) is the truthful noAccess outcome', async () => {
    const runtime = await signedInRuntime(() => ({
      status: 403,
      body: { code: 'forbidden', message: 'refused' },
    }));
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'noAccess' });
  });

  test.each([
    ['stepUpRequired', 'stepUpRequired'],
    ['mfaRequired', 'stepUpRequired'],
  ])('%s maps to the dedicated step-up outcome — never a bypass, never noAccess', async (code, kind) => {
    const runtime = await signedInRuntime(() => ({
      status: 403,
      body: { code, message: 'refused' },
    }));
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind });
  });

  test.each([
    ['an unknown role', { ...ACCESS_BODY, roles: ['superadmin'] }],
    ['an unknown capability', { ...ACCESS_BODY, capabilities: ['everything.*'] }],
    ['a missing user object', { roles: [], capabilities: [] }],
  ])('%s fails the WHOLE resolution closed (no partial access truth)', async (_label, body) => {
    const runtime = await signedInRuntime(() => ({ status: 200, body }));
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });

  test('a backend failure is unavailable — never fixture access', async () => {
    const runtime = await signedInRuntime(() => ({
      status: 500,
      body: { code: 'internalError', message: 'boom' },
    }));
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
  });

  test('without a held session the port resolves unavailable without fetching /admin/me', async () => {
    let adminMeCalls = 0;
    const runtime = runtimeWith((url) => {
      if (url.endsWith('/auth/csrf')) return { status: 404, body: { code: 'notFound' } };
      if (url.includes('/admin/me')) adminMeCalls += 1;
      return { status: 200, body: ACCESS_BODY };
    });
    const bootstrap = await runtime.adapter.bootstrap();
    expect(bootstrap.kind).toBe('noSession');
    await expect(runtime.accessPort.resolveAccess()).resolves.toEqual({ kind: 'unavailable' });
    expect(adminMeCalls).toBe(0);
  });
});
