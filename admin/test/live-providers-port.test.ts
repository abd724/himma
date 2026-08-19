import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveProvidersReadPort } from '../src/services/live/live-providers-port';
import type { FetchLike } from '../src/api/client';

/**
 * The LIVE provider-directory port over a stubbed transport: parameter
 * pass-through (the SERVER owns search/filter/pagination), outcome
 * mapping, and the fail-closed DTO validation. The REAL backend behavior
 * behind the same routes is proven by
 * backend/test/admin-organization-reads.test.ts on real PostgreSQL, and
 * the whole journey by the admin contract suite.
 */

const SUMMARY = {
  organizationId: '018f0000-0000-7000-8000-00000000a001',
  displayName: 'Marina Ace Tennis',
  tradeName: 'Marina Ace',
  verificationState: 'live',
  reviewState: 'none',
  storefront: { published: true, publiclyVisible: true },
  activeBranchCount: 2,
  createdAt: '2026-07-09T08:00:00.000Z',
  updatedAt: '2026-08-18T10:00:00.000Z',
};

const DETAIL = {
  organization: {
    id: '018f0000-0000-7000-8000-00000000a001',
    legalName: 'Marina Ace Sports Academy LLC',
    tradeName: 'Marina Ace',
    orgKind: 'provider',
    verificationState: 'live',
    reviewState: 'none',
    suspendedAt: null,
    offboardedAt: null,
    createdAt: '2026-07-09T08:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
    version: 4,
  },
  profile: {
    displayName: 'Marina Ace Tennis',
    descriptionEn: null,
    descriptionAr: null,
    publicPhone: null,
    publicEmail: null,
    publicWebsite: null,
    publicInstagram: null,
    published: true,
    publiclyVisible: true,
  },
  branches: [
    {
      id: '018f0000-0000-7000-8000-00000000b001',
      label: 'Marina Courts',
      addressLine: null,
      city: 'Dubai',
      areaLabel: 'Dubai Marina',
      active: true,
      createdAt: '2026-07-09T08:00:00.000Z',
    },
  ],
  team: [
    {
      membershipId: '018f0000-0000-7000-8000-00000000c001',
      displayName: 'Rania Aboud',
      role: 'owner',
      branchScopeKind: 'all',
      createdAt: '2026-07-09T08:00:00.000Z',
    },
  ],
  catalogue: {
    total: 2,
    byState: {
      draft: 1,
      submitted: 0,
      in_review: 0,
      approved: 0,
      changes_requested: 0,
      published: 1,
      paused: 0,
      archived: 0,
    },
  },
};

async function signedInPort(handler: (url: string) => { status: number; body: unknown }) {
  const requests: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/auth/csrf')) {
      return jsonResponse(200, { csrfToken: 'CSRF' });
    }
    if (url.endsWith('/auth/refresh')) {
      return jsonResponse(200, {
        status: 'authenticated',
        accessToken: 'AT',
        assurance: 'mfa',
        csrfToken: 'CSRF',
      });
    }
    requests.push(url);
    const result = handler(url);
    return jsonResponse(result.status, result.body);
  };
  const runtime = createLiveAuthRuntime({
    apiBaseUrl: 'https://api.himma.test',
    cognitoIssuer: 'https://cognito.test/pool',
    cognitoClientId: 'client-1',
    fetchImpl,
  });
  const bootstrap = await runtime.adapter.bootstrap();
  expect(bootstrap.kind).toBe('session');
  return { port: createLiveProvidersReadPort(runtime.transport), requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('live provider directory port', () => {
  test('passes search/filter/cursor through to the SERVER query string and maps the loaded page', async () => {
    const { port, requests } = await signedInPort(() => ({
      status: 200,
      body: { organizations: [SUMMARY], nextCursor: null },
    }));
    const outcome = await port.listOrganizations({
      limit: 10,
      q: 'marina',
      state: 'live',
      needsReview: true,
      cursor: '018f0000-0000-7000-8000-00000000a000',
    });
    expect(outcome).toEqual({
      kind: 'loaded',
      page: { organizations: [SUMMARY], nextCursor: null },
    });
    const url = new URL(requests[0]!);
    expect(url.pathname).toBe('/admin/organizations');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('q')).toBe('marina');
    expect(url.searchParams.get('state')).toBe('live');
    expect(url.searchParams.get('needsReview')).toBe('true');
    expect(url.searchParams.get('cursor')).toBe('018f0000-0000-7000-8000-00000000a000');
  });

  test('forbidden maps to the truthful forbidden outcome; failures are unavailable — never fixture data', async () => {
    const forbidden = await signedInPort(() => ({
      status: 403,
      body: { code: 'forbidden', message: 'refused' },
    }));
    await expect(forbidden.port.listOrganizations({ limit: 10 })).resolves.toEqual({
      kind: 'forbidden',
    });
    const failing = await signedInPort(() => ({
      status: 500,
      body: { code: 'internalError', message: 'boom' },
    }));
    await expect(failing.port.listOrganizations({ limit: 10 })).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test.each([
    ['an unknown organization state', { ...SUMMARY, verificationState: 'super_live' }],
    ['an unknown review state', { ...SUMMARY, reviewState: 'urgent' }],
    ['a missing storefront', { ...SUMMARY, storefront: undefined }],
  ])('%s fails the WHOLE list closed (no partial rows)', async (_label, row) => {
    const { port } = await signedInPort(() => ({
      status: 200,
      body: { organizations: [row], nextCursor: null },
    }));
    await expect(port.listOrganizations({ limit: 10 })).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test('maps the full detail DTO; notFound stays notFound; a malformed catalogue fails closed', async () => {
    const ok = await signedInPort(() => ({ status: 200, body: DETAIL }));
    await expect(ok.port.getOrganization(DETAIL.organization.id)).resolves.toEqual({
      kind: 'loaded',
      detail: DETAIL,
    });

    const missing = await signedInPort(() => ({
      status: 404,
      body: { code: 'notFound', message: 'not found' },
    }));
    await expect(missing.port.getOrganization(DETAIL.organization.id)).resolves.toEqual({
      kind: 'notFound',
    });

    const malformed = await signedInPort(() => ({
      status: 200,
      body: { ...DETAIL, catalogue: { total: 2, byState: { draft: 'many' } } },
    }));
    await expect(malformed.port.getOrganization(DETAIL.organization.id)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test('without a held session the port resolves unavailable without calling the API', async () => {
    const requests: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/csrf')) {
        return jsonResponse(404, { code: 'notFound' });
      }
      requests.push(url);
      return jsonResponse(200, { organizations: [], nextCursor: null });
    };
    const runtime = createLiveAuthRuntime({
      apiBaseUrl: 'https://api.himma.test',
      cognitoIssuer: 'https://cognito.test/pool',
      cognitoClientId: 'client-1',
      fetchImpl,
    });
    expect((await runtime.adapter.bootstrap()).kind).toBe('noSession');
    const port = createLiveProvidersReadPort(runtime.transport);
    await expect(port.listOrganizations({ limit: 10 })).resolves.toEqual({ kind: 'unavailable' });
    expect(requests).toEqual([]);
  });
});
