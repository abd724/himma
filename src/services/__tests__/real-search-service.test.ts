/**
 * RI-2 — the real search adapter's truth rules over a scripted API double:
 * cursor pagination accumulates via the server, totals appear ONLY when the
 * last page was reached, unsupported mock dimensions never reach the wire,
 * a child browsing context becomes a server age filter, and providers/
 * categories derive from the real rows.
 */
import { describe, expect, it } from '@jest/globals';
import type {
  DiscoveryApi,
  SearchParams,
  SearchResultDto,
} from '@/services/api/discovery-api';
import { createRealSearchService } from '@/services/api/real-discovery-services';
import { createTaxonomyCache } from '@/services/api/taxonomy-cache';
import { emptyFilters } from '@/services/contracts/filters';

function resultRow(id: string, provider = 'org-1'): SearchResultDto {
  return {
    id,
    titleEn: `Listing ${id}`,
    titleAr: null,
    setting: 'indoor',
    minAge: null,
    maxAge: null,
    allAges: true,
    genderEligibility: 'mixed',
    skillLevel: null,
    category: { id: 'cat-1', slug: 'fitness', labelEn: 'Fitness & gyms', labelAr: null },
    activityType: { id: 'type-1', slug: 'gym-training', labelEn: 'Gym training', labelAr: null },
    media: [],
    fromPrice: { kind: 'from', amountFils: 5000, currency: 'AED' },
    offerBadges: [],
    areaLabels: ['Khalifa City'],
    provider: { id: provider, displayName: `Provider ${provider}` },
  };
}

function apiDouble(pages: { results: SearchResultDto[]; nextCursor: string | null }[]) {
  const calls: SearchParams[] = [];
  let call = 0;
  const api: DiscoveryApi = {
    async getCategories() {
      return [
        { id: 'cat-1', slug: 'fitness', labelEn: 'Fitness & gyms', labelAr: null, imageRef: null },
      ];
    },
    async getActivityTypes() {
      return [];
    },
    async getAreas() {
      return [];
    },
    async getCollections() {
      return [];
    },
    async search(params) {
      calls.push(params);
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return page;
    },
    async getListing() {
      return undefined;
    },
    async getStorefront() {
      return undefined;
    },
    async getStorefrontListings() {
      return undefined;
    },
    async getAvailability() {
      return undefined;
    },
  };
  return { api, calls };
}

const QUERY = {
  query: 'gym',
  participantId: 'everyone',
  areaId: '',
  filters: emptyFilters,
  sort: 'recommended' as const,
  page: 1,
};

describe('real search adapter', () => {
  it('totals appear ONLY when the server reached its last page', async () => {
    const { api } = apiDouble([
      { results: [resultRow('a'), resultRow('b')], nextCursor: 'more' },
    ]);
    const service = createRealSearchService(api, createTaxonomyCache(api));
    const partial = await service.getResults(QUERY);
    expect(partial.hasMorePrograms).toBe(true);
    expect(partial.totalPrograms).toBeUndefined();
    expect(partial.totalProviders).toBeUndefined();
  });

  it('load-more accumulates through the server cursor and completes with exact totals', async () => {
    const { api, calls } = apiDouble([
      { results: [resultRow('a'), resultRow('b', 'org-1')], nextCursor: 'cursor-2' },
      { results: [resultRow('c', 'org-2')], nextCursor: null },
    ]);
    const service = createRealSearchService(api, createTaxonomyCache(api));
    await service.getResults(QUERY);
    const full = await service.getResults({ ...QUERY, page: 2 });
    expect(full.programs.map((program) => program.id)).toEqual(['a', 'b', 'c']);
    expect(full.hasMorePrograms).toBe(false);
    expect(full.totalPrograms).toBe(3);
    // Providers/categories derive from the REAL rows.
    expect(full.providers.map((provider) => provider.id).sort()).toEqual(['org-1', 'org-2']);
    expect(full.totalProviders).toBe(2);
    expect(full.categories.map((category) => category.id)).toEqual(['cat-1']);
    // The second fetch carried the server cursor.
    expect(calls[1]?.cursor).toBe('cursor-2');
  });

  it('unsupported mock dimensions NEVER reach the wire; supported ones map 1:1', async () => {
    const { api, calls } = apiDouble([{ results: [], nextCursor: null }]);
    const service = createRealSearchService(api, createTaxonomyCache(api));
    await service.getResults({
      ...QUERY,
      filters: {
        ...emptyFilters,
        ladiesOnly: true,
        trial: true,
        setting: 'indoor',
        // Unsupported mock-era dimensions (no backend authority):
        when: 'today',
        afterSchool: true,
        nearMe: true,
        offers: true,
        topRated: true,
      },
    });
    const sent = calls[0]!;
    expect(sent.ladiesOnly).toBe(true);
    expect(sent.trial).toBe(true);
    expect(sent.setting).toBe('indoor');
    expect(JSON.stringify(sent)).not.toMatch(/when|afterSchool|nearMe|offers|topRated/);
  });

  it('a child browsing context becomes a truthful server-side age filter; adults are never filtered', async () => {
    const { api, calls } = apiDouble([{ results: [], nextCursor: null }]);
    const service = createRealSearchService(api, createTaxonomyCache(api));
    await service.getResults({
      ...QUERY,
      participantId: 'child-1',
      participant: { id: 'child-1', label: 'Ahmed', kind: 'child', dateOfBirth: '2018-03-01' },
    });
    expect(calls[0]?.ageMin).toBeDefined();
    expect(calls[0]?.ageMin).toBe(calls[0]?.ageMax);
    await service.getResults({
      ...QUERY,
      query: 'gym adult',
      participantId: 'me',
      participant: { id: 'me', label: 'Me', kind: 'self' },
    });
    expect(calls[1]?.ageMin).toBeUndefined();
  });

  it('suggestions come from the real taxonomy; popularity content is empty (no authority)', async () => {
    const { api } = apiDouble([{ results: [], nextCursor: null }]);
    const service = createRealSearchService(api, createTaxonomyCache(api));
    const rows = await service.getSuggestions({ query: 'fit', participantId: 'everyone', areaId: '' });
    expect(rows.some((row) => row.kind === 'category' && row.label === 'Fitness & gyms')).toBe(
      true,
    );
    const preSearch = await service.getPreSearchContent();
    expect(preSearch.popularSearches).toEqual([]);
  });
});
