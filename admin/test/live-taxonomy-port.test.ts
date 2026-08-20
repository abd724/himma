import { createLiveAuthRuntime } from '../src/auth/live/live-auth-runtime';
import { createLiveTaxonomyPort } from '../src/services/live/live-taxonomy-port';
import type { FetchLike } from '../src/api/client';

/**
 * The LIVE taxonomy port over a stubbed transport: certified-route
 * pass-through (paths, PATCH bodies with CAS, undefined-optional
 * stripping), fail-closed view validation across the four entity shapes,
 * and the distinct typed refusal mapping. The REAL backend is proven by
 * the backend catalogue-taxonomy-admin suite and the admin contract
 * journey.
 */

const AREA = {
  id: '018f0000-0000-7000-8000-00000000ba01',
  slug: 'dubai-marina',
  labelEn: 'Dubai Marina',
  labelAr: null,
  city: 'Dubai',
  sortHint: 10,
  active: true,
  version: 1,
};

const CATEGORY = {
  id: '018f0000-0000-7000-8000-00000000bb01',
  slug: 'water-sports',
  labelEn: 'Water Sports',
  labelAr: null,
  imageRef: null,
  sortHint: 10,
  active: true,
  version: 2,
};

const ACTIVITY_TYPE = {
  id: '018f0000-0000-7000-8000-00000000bc01',
  slug: 'swimming',
  categoryId: CATEGORY.id,
  labelEn: 'Swimming',
  labelAr: null,
  synonymsEn: ['aquatics'],
  synonymsAr: [],
  active: false,
  version: 3,
};

const COLLECTION = {
  id: '018f0000-0000-7000-8000-00000000bd01',
  titleEn: 'Summer Camps',
  titleAr: null,
  subtitleEn: null,
  subtitleAr: null,
  imageRef: null,
  presetLadiesOnly: false,
  presetChildRelevant: true,
  presetCamps: true,
  presetOffers: false,
  presetAvailableToday: false,
  presetAfterSchool: false,
  presetIndoor: false,
  audience: 'children',
  childFocused: true,
  featured: true,
  seasonalLabel: 'Summer',
  state: 'published',
  version: 2,
};

const VIEW = {
  areas: [AREA],
  categories: [CATEGORY],
  activityTypes: [ACTIVITY_TYPE],
  collections: [COLLECTION],
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
  return { port: createLiveTaxonomyPort(runtime.transport), requests };
}

describe('live taxonomy port', () => {
  test('the administration view validates all four entity shapes and keeps inactive rows', async () => {
    const ok = await signedInPort(() => jsonResponse(200, VIEW));
    const outcome = await ok.port.getTaxonomy();
    if (outcome.kind !== 'loaded') throw new Error(outcome.kind);
    expect(new URL(ok.requests[0]!.url).pathname).toBe('/admin/taxonomy');
    expect(outcome.view.areas).toEqual([AREA]);
    expect(outcome.view.activityTypes[0]!.active).toBe(false); // inactive rows stay visible
    expect(outcome.view.collections[0]!.state).toBe('published');

    const malformed = await signedInPort(() =>
      jsonResponse(200, { ...VIEW, categories: [{ ...CATEGORY, version: 'x' }] }),
    );
    await expect(malformed.port.getTaxonomy()).resolves.toEqual({ kind: 'unavailable' });

    const forbidden = await signedInPort(() =>
      jsonResponse(403, { code: 'forbidden', message: 'x' }),
    );
    await expect(forbidden.port.getTaxonomy()).resolves.toEqual({ kind: 'forbidden' });
  });

  test('creates hit the certified named routes; optional fields are stripped when unset', async () => {
    const created = await signedInPort(() =>
      jsonResponse(200, { status: 'areaCreated', area: AREA }),
    );
    await expect(
      created.port.createArea({ slug: 'business-bay', labelEn: 'Business Bay' }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(new URL(created.requests[0]!.url).pathname).toBe('/admin/taxonomy/areas');
    expect(JSON.parse(String(created.requests[0]!.init.body))).toEqual({
      slug: 'business-bay',
      labelEn: 'Business Bay',
    });

    const typed = await signedInPort(() =>
      jsonResponse(200, { status: 'activityTypeCreated', activityType: ACTIVITY_TYPE }),
    );
    await expect(
      typed.port.createActivityType({
        slug: 'kitesurfing',
        categoryId: CATEGORY.id,
        labelEn: 'Kitesurfing',
        synonymsEn: ['kiting'],
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(new URL(typed.requests[0]!.url).pathname).toBe('/admin/taxonomy/activity-types');
    expect(JSON.parse(String(typed.requests[0]!.init.body))).toEqual({
      slug: 'kitesurfing',
      categoryId: CATEGORY.id,
      labelEn: 'Kitesurfing',
      synonymsEn: ['kiting'],
    });
  });

  test('updates are PATCHes carrying CAS + the certified mutable fields only (no slug can ever ride a patch)', async () => {
    const patched = await signedInPort(() =>
      jsonResponse(200, { status: 'categoryUpdated', category: CATEGORY }),
    );
    await expect(
      patched.port.updateCategory(CATEGORY.id, {
        expectedVersion: 2,
        patch: { labelEn: 'Water & Beach Sports', active: false },
      }),
    ).resolves.toEqual({ kind: 'completed' });
    const request = patched.requests[0]!;
    expect(request.init.method).toBe('PATCH');
    expect(new URL(request.url).pathname).toBe(`/admin/taxonomy/categories/${CATEGORY.id}`);
    expect(JSON.parse(String(request.init.body))).toEqual({
      expectedVersion: 2,
      labelEn: 'Water & Beach Sports',
      active: false,
    });

    const collection = await signedInPort(() =>
      jsonResponse(200, { status: 'collectionUpdated', collection: COLLECTION }),
    );
    await expect(
      collection.port.updateCollection(COLLECTION.id, {
        expectedVersion: 2,
        patch: { state: 'archived', seasonalLabel: null },
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(JSON.parse(String(collection.requests[0]!.init.body))).toEqual({
      expectedVersion: 2,
      state: 'archived',
      seasonalLabel: null,
    });
  });

  test.each([
    [403, 'stepUpRequired', 'stepUpRequired'],
    [409, 'staleVersion', 'staleVersion'],
    [409, 'slugConflict', 'slugConflict'],
    [422, 'invalidTaxonomy', 'invalidTaxonomy'],
    [403, 'forbidden', 'forbidden'],
    [404, 'notFound', 'notFound'],
  ])('%s %s maps to its own distinct outcome (%s)', async (status, code, kind) => {
    const { port } = await signedInPort(() => jsonResponse(status, { code, message: 'x' }));
    await expect(
      port.updateArea(AREA.id, { expectedVersion: 1, patch: { active: false } }),
    ).resolves.toEqual({ kind });
  });

  test('schema-refused input is the distinct invalidInput outcome, never disguised as an outage', async () => {
    const { port } = await signedInPort(() =>
      jsonResponse(400, { code: 'badRequest', message: 'body/slug must match pattern' }),
    );
    await expect(
      port.createArea({ slug: 'Bad Slug!', labelEn: 'Bad' }),
    ).resolves.toEqual({ kind: 'invalidInput' });
  });
});
