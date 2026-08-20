import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveRolesPort } from '../src/services/live/live-roles-port';
import { createLiveAuditPort } from '../src/services/live/live-audit-port';
import type { FetchLike } from '../src/api/client';

/**
 * The LIVE W3-9 ports over a stubbed transport: certified-route
 * pass-through (paths, methods, CAS bodies, filters), fail-closed
 * validation, and the distinct typed refusal mapping — incl. the
 * dual-control violation. The REAL backend is proven by the backend
 * admin-routes/security suites and the admin contract journeys.
 */

const ASSIGNMENT = {
  id: '018f0000-0000-7000-8000-00000000da01',
  userId: '018f0000-0000-7000-8000-00000000db01',
  role: 'finance',
  state: 'requested',
  requestedBy: '018f0000-0000-7000-8000-00000000dc01',
  approvedBy: null,
  expiresAt: null,
  createdAt: '2026-08-18T09:00:00.000Z',
  version: 1,
};

const EVENT = {
  id: '018f0000-0000-7000-8000-00000000dd01',
  actorType: 'user',
  actorId: '018f0000-0000-7000-8000-00000000de01',
  action: 'listing.approved',
  entityType: 'program',
  entityId: '018f0000-0000-7000-8000-00000000df01',
  occurredAt: '2026-08-19T10:00:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function signedIn(handler: (url: string, init: RequestInit) => Response) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'CSRF' });
    if (url.endsWith('/auth/refresh')) {
      return jsonResponse(200, {
        status: 'authenticated',
        accessToken: 'AT',
        assurance: 'mfa',
        csrfToken: 'CSRF',
      });
    }
    requests.push({ url, init });
    return handler(url, init);
  };
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: 'https://api.himma.test',
    cognitoIssuer: 'https://cognito.test/pool',
    cognitoClientId: 'client-1',
    fetchImpl,
  });
  expect((await runtime.adapter.bootstrap()).kind).toBe('session');
  return {
    rolesPort: createLiveRolesPort(runtime.transport),
    auditPort: createLiveAuditPort(runtime.transport),
    requests,
  };
}

describe('live roles port', () => {
  test('lists assignments with server-side filters and validates rows fail-closed', async () => {
    const ok = await signedIn(() => jsonResponse(200, { assignments: [ASSIGNMENT] }));
    await expect(ok.rolesPort.listAssignments({ state: 'requested' })).resolves.toEqual({
      kind: 'loaded',
      assignments: [ASSIGNMENT],
    });
    const url = new URL(ok.requests[0]!.url);
    expect(url.pathname).toBe('/admin/role-assignments');
    expect(url.searchParams.get('state')).toBe('requested');

    const malformed = await signedIn(() =>
      jsonResponse(200, { assignments: [{ ...ASSIGNMENT, version: 'x' }] }),
    );
    await expect(malformed.rolesPort.listAssignments({})).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test('decisions hit the CERTIFIED named routes with CAS bodies (approve/deny POST, revoke DELETE)', async () => {
    const approve = await signedIn(() => jsonResponse(200, { status: 'roleActivated' }));
    await expect(
      approve.rolesPort.approveRequest(ASSIGNMENT.id, { expectedVersion: 1 }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(approve.requests[0]!.url).toContain(`/admin/role-requests/${ASSIGNMENT.id}/approve`);
    expect(JSON.parse(String(approve.requests[0]!.init.body))).toEqual({ expectedVersion: 1 });

    const revoke = await signedIn(() => jsonResponse(200, { status: 'roleRevoked' }));
    await expect(
      revoke.rolesPort.revokeAssignment(ASSIGNMENT.id, { expectedVersion: 2 }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(revoke.requests[0]!.init.method).toBe('DELETE');
    expect(revoke.requests[0]!.url).toContain(`/admin/role-assignments/${ASSIGNMENT.id}`);
  });

  test.each([
    [403, 'stepUpRequired', 'stepUpRequired'],
    [409, 'dualControlViolation', 'dualControlViolation'],
    [409, 'assignmentAlreadyFinalized', 'alreadyFinalized'],
    [409, 'roleConflict', 'roleConflict'],
    [409, 'staleVersion', 'staleVersion'],
    [403, 'forbidden', 'forbidden'],
    [404, 'notFound', 'notFound'],
  ])('%s %s maps to its own distinct outcome (%s)', async (status, code, kind) => {
    const { rolesPort } = await signedIn(() => jsonResponse(status, { code, message: 'x' }));
    await expect(
      rolesPort.approveRequest(ASSIGNMENT.id, { expectedVersion: 1 }),
    ).resolves.toEqual({ kind });
  });
});

describe('live audit port', () => {
  test('passes filters/cursor through, validates the bounded projection fail-closed', async () => {
    const ok = await signedIn(() => jsonResponse(200, { events: [EVENT], nextCursor: null }));
    await expect(
      ok.auditPort.listEvents({ entityType: 'program', action: 'listing.approved', limit: 25 }),
    ).resolves.toEqual({ kind: 'loaded', events: [EVENT], nextCursor: null });
    const url = new URL(ok.requests[0]!.url);
    expect(url.pathname).toBe('/admin/audit-events');
    expect(url.searchParams.get('entityType')).toBe('program');
    expect(url.searchParams.get('action')).toBe('listing.approved');
    expect(url.searchParams.get('limit')).toBe('25');

    const malformed = await signedIn(() =>
      jsonResponse(200, { events: [{ ...EVENT, occurredAt: 7 }], nextCursor: null }),
    );
    await expect(malformed.auditPort.listEvents({})).resolves.toEqual({ kind: 'unavailable' });

    const forbidden = await signedIn(() => jsonResponse(403, { code: 'forbidden', message: 'x' }));
    await expect(forbidden.auditPort.listEvents({})).resolves.toEqual({ kind: 'forbidden' });
  });
});
