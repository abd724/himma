import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiJsonResponse } from '../src/api/client';
import type { LiveTransport } from '../src/auth/live/live-auth-runtime';
import { createLiveCatalogueReadPorts } from '../src/services/live/live-catalogue-ports';

/**
 * Live catalogue READ ports (W2-12C1) — deterministic mapping coverage
 * over a stubbed transport: list-card row validation, price/branch
 * summary semantics, detail DTO validation fail-closed, taxonomy reads,
 * pagination parameter mapping, outcome-code translation, read-only
 * structure, and fixture isolation. The REAL backend behavior behind the
 * same ports is proven by the contract suite
 * (test-contract/catalogue-contract.test.ts on real PostgreSQL).
 */

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
  authorized: boolean;
}

function makeTransport(
  respond: (
    call: RecordedCall,
  ) => { status: number; body?: unknown; code?: string } | 'network' | 'noSession',
) {
  const calls: RecordedCall[] = [];
  const toResponse = (result: {
    status: number;
    body?: unknown;
    code?: string;
  }): ApiJsonResponse => ({
    status: result.status,
    code: result.code ?? null,
    body:
      result.body ?? (result.code !== undefined ? { code: result.code, message: 'refused' } : null),
    networkFailure: false,
  });
  const dispatch = (call: RecordedCall): ApiJsonResponse | null => {
    const result = respond(call);
    if (result === 'noSession') return null;
    if (result === 'network') {
      return { status: 0, code: null, body: null, networkFailure: true };
    }
    return toResponse(result);
  };
  const transport: LiveTransport = {
    async authorizedRequest(path, options = {}) {
      const call: RecordedCall = {
        path,
        method: options.method ?? 'GET',
        body: options.body,
        authorized: true,
      };
      calls.push(call);
      return dispatch(call);
    },
    async publicRequest(path) {
      const call: RecordedCall = { path, method: 'GET', body: undefined, authorized: false };
      calls.push(call);
      const result = dispatch(call);
      if (result === null) throw new Error('public requests never lack a session');
      return result;
    },
    notifyAccessChanged() {
      throw new Error('catalogue READS must never claim an access change');
    },
  };
  return { transport, calls };
}

const ORG = '018f0000-0000-7000-8000-00000000c001';
const PROGRAM = '018f0000-0000-7000-8000-00000000c101';

const SUMMARY_ROW = {
  id: PROGRAM,
  titleEn: 'Adult Beginner Swimming',
  listingState: 'published',
  activityType: { id: '018f0000-0000-7000-8000-00000000c201', labelEn: 'Swimming', active: true },
  version: 4,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  priceSummary: { kind: 'from', amountFils: 45_000, currency: 'AED' },
  branchSummary: { firstLabel: 'Dubai Marina pool', activeCount: 2 },
  thumbnail: { mediaRef: '018f0000-0000-7000-8000-00000000c301', altTextEn: 'Pool lanes' },
};

const DETAIL_BODY = {
  id: PROGRAM,
  organizationId: ORG,
  activityType: {
    id: '018f0000-0000-7000-8000-00000000c201',
    slug: 'swimming',
    labelEn: 'Swimming',
    active: true,
    categoryId: '018f0000-0000-7000-8000-00000000c401',
  },
  titleEn: 'Adult Beginner Swimming',
  titleAr: null,
  descriptionEn: 'Learn to swim.',
  descriptionAr: null,
  setting: 'indoor',
  minAge: 16,
  maxAge: null,
  allAges: false,
  genderEligibility: 'mixed',
  skillLevel: 'beginner',
  eligibilityNotes: null,
  listingState: 'published',
  publishedAt: '2026-08-05T10:00:00.000Z',
  archivedAt: null,
  sensitiveFieldsVersion: 2,
  version: 4,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  priceOptions: [
    {
      id: '018f0000-0000-7000-8000-00000000c501',
      kind: 'monthly',
      amountFils: 45_000,
      currency: 'AED',
      sessionsCount: 12,
      labelEn: 'Monthly',
      labelAr: null,
      sortHint: 1,
      state: 'active',
      version: 2,
    },
  ],
  branches: [
    {
      branchId: '018f0000-0000-7000-8000-00000000c601',
      label: 'Dubai Marina pool',
      branchActive: true,
      associationActive: true,
      version: 1,
    },
  ],
  media: [
    {
      id: '018f0000-0000-7000-8000-00000000c701',
      mediaRef: '018f0000-0000-7000-8000-00000000c301',
      sortHint: 1,
      altTextEn: 'Pool lanes',
      altTextAr: null,
      active: true,
      version: 1,
    },
  ],
  offers: [
    {
      id: '018f0000-0000-7000-8000-00000000c801',
      kind: 'freeTrial',
      labelEn: 'Free trial session',
      labelAr: null,
      trialAmountFils: null,
      effectiveStart: null,
      effectiveEnd: null,
      state: 'active',
      version: 1,
    },
  ],
  openRevision: null,
};

const ACTIVITY_TYPES_BODY = {
  activityTypes: [
    {
      id: '018f0000-0000-7000-8000-00000000c201',
      slug: 'swimming',
      labelEn: 'Swimming',
      labelAr: 'سباحة',
      categoryId: '018f0000-0000-7000-8000-00000000c401',
    },
    {
      id: '018f0000-0000-7000-8000-00000000c202',
      slug: 'karate',
      labelEn: 'Karate',
      labelAr: null,
      categoryId: '018f0000-0000-7000-8000-00000000c402',
    },
  ],
};

const CATEGORIES_BODY = {
  categories: [
    {
      id: '018f0000-0000-7000-8000-00000000c401',
      slug: 'aquatics',
      labelEn: 'Aquatics',
      labelAr: null,
      imageRef: null,
    },
  ],
};

describe('live listings index (the W2-12C1 list-card projection)', () => {
  test('maps a full page field for field; the wire limit/cursor ride the query string', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { programs: [SUMMARY_ROW], nextCursor: PROGRAM },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await listingsPort.listListings(ORG, { limit: 10, cursor: PROGRAM });
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(calls[0]!.path).toBe(
      `/provider/organizations/${ORG}/listings?limit=10&cursor=${PROGRAM}`,
    );
    expect(outcome.page.nextCursor).toBe(PROGRAM);
    expect(outcome.page.programs).toEqual([
      {
        id: PROGRAM,
        titleEn: 'Adult Beginner Swimming',
        listingState: 'published',
        activityType: SUMMARY_ROW.activityType,
        version: 4,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-10T10:00:00.000Z',
        priceSummary: { kind: 'from', amountFils: 45_000 },
        branchSummary: { firstLabel: 'Dubai Marina pool', activeCount: 2 },
        // Wire thumbnails are METADATA; no media binary/URL source exists,
        // so live presentation truthfully resolves null (placeholder) —
        // nothing is fabricated.
        thumbnailUrl: null,
      },
    ]);
  });

  test('omitted pagination params produce the bare collection path', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { programs: [], nextCursor: null },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await listingsPort.listListings(ORG);
    expect(outcome.kind).toBe('loaded');
    expect(calls[0]!.path).toBe(`/provider/organizations/${ORG}/listings`);
  });

  test.each([
    ['free', { kind: 'free' }, { kind: 'free' }],
    ['none', { kind: 'none' }, { kind: 'none' }],
    [
      'from',
      { kind: 'from', amountFils: 500, currency: 'AED' },
      { kind: 'from', amountFils: 500 },
    ],
  ])('price summary %s maps deterministically', async (_label, wire, mapped) => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { programs: [{ ...SUMMARY_ROW, priceSummary: wire }], nextCursor: null },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await listingsPort.listListings(ORG);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.page.programs[0]!.priceSummary).toEqual(mapped);
  });

  test.each([
    ['a price summary outside the semantic union', { ...SUMMARY_ROW, priceSummary: { kind: 'range', minFils: 1, maxFils: 2 } }],
    ['a from-summary missing its amount', { ...SUMMARY_ROW, priceSummary: { kind: 'from', currency: 'AED' } }],
    ['a missing branch summary', { ...SUMMARY_ROW, branchSummary: undefined }],
    ['a malformed activity object', { ...SUMMARY_ROW, activityType: { id: 'x' } }],
    ['a malformed thumbnail object', { ...SUMMARY_ROW, thumbnail: { altTextEn: 'no ref' } }],
  ])('%s fails the WHOLE page read closed (no partial rows)', async (_label, row) => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { programs: [row], nextCursor: null },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    await expect(listingsPort.listListings(ORG)).resolves.toEqual({ kind: 'unavailable' });
  });

  test('an inactive historical activity type stays representable on the row', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: {
        programs: [
          { ...SUMMARY_ROW, activityType: { ...SUMMARY_ROW.activityType, active: false } },
        ],
        nextCursor: null,
      },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await listingsPort.listListings(ORG);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.page.programs[0]!.activityType.active).toBe(false);
    expect(outcome.page.programs[0]!.activityType.labelEn).toBe('Swimming');
  });

  test.each([
    ['forbidden', { status: 403, code: 'forbidden' }, 'forbidden'],
    ['mfaRequired (cannot occur behind the guard chain)', { status: 403, code: 'mfaRequired' }, 'forbidden'],
    ['notFound (foreign/unknown org)', { status: 404, code: 'notFound' }, 'notFound'],
    ['backend failure', { status: 500, code: 'internalError' }, 'unavailable'],
    ['network failure', 'network' as const, 'unavailable'],
    ['no session', 'noSession' as const, 'unavailable'],
  ])('list outcome: %s → %s', async (_label, wire, kind) => {
    const { transport } = makeTransport(() => wire);
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    await expect(listingsPort.listListings(ORG)).resolves.toEqual({ kind });
  });
});

describe('live listing detail', () => {
  test('maps the real ProgramDetailView field for field', async () => {
    const { transport, calls } = makeTransport(() => ({
      status: 200,
      body: { program: DETAIL_BODY },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await listingsPort.loadListing(ORG, PROGRAM);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(calls[0]!.path).toBe(`/provider/organizations/${ORG}/listings/${PROGRAM}`);
    expect(outcome.program).toEqual(DETAIL_BODY);
  });

  test('an open protected revision maps only what the read contract exposes', async () => {
    const openRevision = {
      id: '018f0000-0000-7000-8000-00000000c901',
      state: 'submitted',
      createdAt: '2026-08-11T10:00:00.000Z',
      version: 1,
    };
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { program: { ...DETAIL_BODY, openRevision } },
    }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await listingsPort.loadListing(ORG, PROGRAM);
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(outcome.program.openRevision).toEqual(openRevision);
  });

  test.each([
    ['a malformed price option', { ...DETAIL_BODY, priceOptions: [{ id: 'x' }] }],
    ['a malformed branch association', { ...DETAIL_BODY, branches: [{ branchId: 'x' }] }],
    ['a malformed media row', { ...DETAIL_BODY, media: [{ id: 'x' }] }],
    ['a malformed offer', { ...DETAIL_BODY, offers: [{ id: 'x' }] }],
    ['a malformed open revision', { ...DETAIL_BODY, openRevision: { id: 'x' } }],
    ['a missing lifecycle state', { ...DETAIL_BODY, listingState: undefined }],
  ])('%s fails the WHOLE detail read closed', async (_label, program) => {
    const { transport } = makeTransport(() => ({ status: 200, body: { program } }));
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    await expect(listingsPort.loadListing(ORG, PROGRAM)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  test.each([
    ['forbidden', { status: 403, code: 'forbidden' }, 'forbidden'],
    ['notFound (foreign/out-of-scope/ghost — one shape)', { status: 404, code: 'notFound' }, 'notFound'],
    ['backend failure', { status: 500, code: 'internalError' }, 'unavailable'],
    ['network failure', 'network' as const, 'unavailable'],
    ['no session', 'noSession' as const, 'unavailable'],
  ])('detail outcome: %s → %s', async (_label, wire, kind) => {
    const { transport } = makeTransport(() => wire);
    const { listingsPort } = createLiveCatalogueReadPorts(transport);
    await expect(listingsPort.loadListing(ORG, PROGRAM)).resolves.toEqual({ kind });
  });
});

describe('live taxonomy reads (public routes, W2-12A transport)', () => {
  test('activity types map field for field over the UNAUTHENTICATED public request', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 200, body: ACTIVITY_TYPES_BODY }));
    const { activityTypePort } = createLiveCatalogueReadPorts(transport);
    const outcome = await activityTypePort.listActivityTypes();
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(calls[0]).toEqual({
      path: '/catalogue/activity-types',
      method: 'GET',
      body: undefined,
      authorized: false,
    });
    expect(outcome.activityTypes).toEqual(ACTIVITY_TYPES_BODY.activityTypes);
  });

  test('categories map field for field over the UNAUTHENTICATED public request', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 200, body: CATEGORIES_BODY }));
    const { categoryPort } = createLiveCatalogueReadPorts(transport);
    const outcome = await categoryPort.listCategories();
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(calls[0]!.path).toBe('/catalogue/categories');
    expect(calls[0]!.authorized).toBe(false);
    expect(outcome.categories).toEqual(CATEGORIES_BODY.categories);
  });

  test.each([
    ['activity types', (ports: ReturnType<typeof createLiveCatalogueReadPorts>) => ports.activityTypePort.listActivityTypes()],
    ['categories', (ports: ReturnType<typeof createLiveCatalogueReadPorts>) => ports.categoryPort.listCategories()],
  ])('a %s backend failure fails closed to unavailable — never to fixture data', async (_label, read) => {
    for (const wire of [{ status: 500, code: 'internalError' }, 'network' as const]) {
      const { transport } = makeTransport(() => wire);
      await expect(read(createLiveCatalogueReadPorts(transport))).resolves.toEqual({
        kind: 'unavailable',
      });
    }
  });

  test('a malformed taxonomy row fails the WHOLE read closed', async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      body: { activityTypes: [{ id: 'only-an-id' }] },
    }));
    const { activityTypePort } = createLiveCatalogueReadPorts(transport);
    await expect(activityTypePort.listActivityTypes()).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('structural guarantees', () => {
  test('every catalogue read is a GET — this module can never mutate', async () => {
    const { transport, calls } = makeTransport(() => ({ status: 500, code: 'internalError' }));
    const ports = createLiveCatalogueReadPorts(transport);
    await ports.listingsPort.listListings(ORG, { limit: 5 });
    await ports.listingsPort.loadListing(ORG, PROGRAM);
    await ports.activityTypePort.listActivityTypes();
    await ports.categoryPort.listCategories();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.method).toBe('GET');
      expect(call.body).toBeUndefined();
    }
  });

  test('the live catalogue module is structurally isolated from fixture code', () => {
    const source = readFileSync(
      join(__dirname, '../src/services/live/live-catalogue-ports.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/services\/mock|fixture/i);
    expect(source).not.toMatch(/FIXTURE_MEDIA_PREVIEWS/);
  });
});
