import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveModerationPort } from '../src/services/live/live-moderation-port';
import type { FetchLike } from '../src/api/client';

/**
 * The LIVE moderation port over a stubbed transport: certified-route
 * pass-through (paths, bodies, reasonCode placement), fail-closed view
 * validation, and the distinct typed refusal mapping. The REAL backend is
 * proven by backend catalogue-moderation suites and the admin contract
 * journey.
 */

const QUEUE_ROW = {
  id: '018f0000-0000-7000-8000-00000000aa01',
  organizationId: '018f0000-0000-7000-8000-00000000ab01',
  organizationDisplayName: 'Alpha Aquatics',
  titleEn: 'Swim Basics',
  listingState: 'submitted',
  version: 2,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-18T08:00:00.000Z',
};

const DETAIL = {
  program: {
    id: QUEUE_ROW.id,
    titleEn: 'Swim Basics',
    listingState: 'published',
    version: 6,
    descriptionEn: 'Current description.',
    setting: 'indoor',
    genderEligibility: 'mixed',
    minAge: 6,
    maxAge: 12,
    allAges: false,
    skillLevel: null,
    eligibilityNotes: null,
    publishedAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-18T08:00:00.000Z',
    priceOptions: [{ kind: 'monthly', amountFils: 35000, labelEn: 'Monthly', state: 'active' }],
    branches: [{ label: 'Main Pool', associationActive: true }],
    // Extra backend fields the workspace does not consume pass through
    // harmlessly (the validator checks exactly what is rendered).
    sensitiveFieldsVersion: 3,
  },
  organization: {
    id: QUEUE_ROW.organizationId,
    displayName: 'Alpha Aquatics',
    verificationState: 'live',
  },
  revision: {
    id: '018f0000-0000-7000-8000-00000000ac01',
    programId: QUEUE_ROW.id,
    state: 'submitted',
    createdAt: '2026-08-18T08:00:00.000Z',
    version: 1,
    minAge: 7,
    maxAge: null,
    allAges: null,
    genderEligibility: null,
    skillLevel: null,
    eligibilityNotes: null,
    descriptionEn: 'Proposed description.',
    descriptionAr: null,
    option: null,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function signedInPort(handler: (url: string, init: RequestInit) => Response) {
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
  return { port: createLiveModerationPort(runtime.transport), requests };
}

describe('live moderation port', () => {
  test('queues pass the server-driven state filter through and validate rows fail-closed', async () => {
    const ok = await signedInPort(() =>
      jsonResponse(200, { listings: [QUEUE_ROW], nextCursor: null }),
    );
    await expect(ok.port.listListings({ state: 'submitted' })).resolves.toEqual({
      kind: 'loaded',
      rows: [QUEUE_ROW],
      nextCursor: null,
    });
    const url = new URL(ok.requests[0]!.url);
    expect(url.pathname).toBe('/admin/listings');
    expect(url.searchParams.get('state')).toBe('submitted');

    const malformed = await signedInPort(() =>
      jsonResponse(200, { listings: [{ id: 42 }], nextCursor: null }),
    );
    await expect(malformed.port.listListings({})).resolves.toEqual({ kind: 'unavailable' });
  });

  test('the detail view validates consumed fields (incl. the change-set) and tolerates extra backend fields', async () => {
    const { port } = await signedInPort(() => jsonResponse(200, DETAIL));
    const outcome = await port.getListing(QUEUE_ROW.id);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.view.program.titleEn).toBe('Swim Basics');
    expect(outcome.view.revision?.descriptionEn).toBe('Proposed description.');
    expect(outcome.view.organization.verificationState).toBe('live');

    const broken = await signedInPort(() =>
      jsonResponse(200, { ...DETAIL, revision: { ...DETAIL.revision, version: 'x' } }),
    );
    await expect(broken.port.getListing(QUEUE_ROW.id)).resolves.toEqual({ kind: 'unavailable' });
  });

  test('decisions hit the CERTIFIED named routes with reasonCode only where the contract carries it', async () => {
    const review = await signedInPort(() =>
      jsonResponse(200, { status: 'programReviewed', state: 'changes_requested', version: 4 }),
    );
    await expect(
      review.port.reviewListing(QUEUE_ROW.id, 'request_changes', {
        expectedVersion: 3,
        reasonCode: 'incomplete_description',
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(review.requests[0]!.url).toContain(`/admin/listings/${QUEUE_ROW.id}/review/request-changes`);
    expect(JSON.parse(String(review.requests[0]!.init.body))).toEqual({
      expectedVersion: 3,
      reasonCode: 'incomplete_description',
    });

    const revisionApprove = await signedInPort(() =>
      jsonResponse(200, { status: 'revisionApproved', programVersion: 7 }),
    );
    await expect(
      revisionApprove.port.decideRevision(QUEUE_ROW.id, DETAIL.revision.id, 'approve', {
        expectedVersion: 2,
        reasonCode: 'never_sent_on_approve',
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(revisionApprove.requests[0]!.url).toContain(
      `/revisions/${DETAIL.revision.id}/approve`,
    );
    // reasonCode rides ONLY the reject leg (the certified schema).
    expect(JSON.parse(String(revisionApprove.requests[0]!.init.body))).toEqual({
      expectedVersion: 2,
    });
  });

  test.each([
    [403, 'stepUpRequired', 'stepUpRequired'],
    [409, 'lifecycleConflict', 'lifecycleConflict'],
    [409, 'staleVersion', 'staleVersion'],
    [422, 'invalidEligibility', 'revisionInvalid'],
    [422, 'invalidPriceOption', 'revisionInvalid'],
    [403, 'forbidden', 'forbidden'],
    [404, 'notFound', 'notFound'],
  ])('%s %s maps to its own distinct outcome (%s)', async (status, code, kind) => {
    const { port } = await signedInPort(() => jsonResponse(status, { code, message: 'x' }));
    await expect(
      port.reviewListing(QUEUE_ROW.id, 'approve', { expectedVersion: 3 }),
    ).resolves.toEqual({ kind });
  });
});
