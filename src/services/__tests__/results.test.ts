import { activeFilterCount, emptyFilters, type FilterSelection } from '@/services/contracts/filters';
import { MockSearchService } from '@/services/mock/mock-search-service';
import { priceValue } from '@/services/mock/results-engine';
import { isLadiesOnly, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const service = new MockSearchService(0);

const results = (
  query: string,
  overrides: Partial<FilterSelection> = {},
  extra: { participantId?: string; page?: number; sort?: any; areaId?: any } = {},
) =>
  service.buildResults({
    query,
    participantId: extra.participantId ?? 'everyone',
    areaId: extra.areaId ?? 'khalifa-city',
    filters: { ...emptyFilters, ...overrides },
    sort: extra.sort ?? 'recommended',
    page: extra.page ?? 1,
  });

describe('Ladies-only filter (docs/05 §7 confirmed model)', () => {
  test('off: men, ladies, and mixed classes all present', () => {
    const page = results('', {}, { page: 99 }); // whole catalogue
    const genders = new Set(page.programs.map((p) => p.eligibility.genderEligibility));
    expect(genders).toEqual(new Set(['men', 'ladies', 'mixed']));
  });

  test('on: only provider-classified ladies programs', () => {
    const page = results('', { ladiesOnly: true });
    expect(page.totalPrograms).toBeGreaterThan(0);
    expect(page.programs.every((p) => isLadiesOnly(p.eligibility))).toBe(true);
  });

  test('ladies-only + child age with no matches reports zero for recovery', () => {
    const page = results('', { ladiesOnly: true }, { participantId: 'adam' });
    expect(page.totalPrograms).toBe(0);
    expect(page.programs).toEqual([]);
  });
});

describe('Combined filters and counts', () => {
  test('today + ladies-only combine on one FilterSelection', () => {
    const page = results('', { when: 'today', ladiesOnly: true });
    expect(page.totalPrograms).toBeGreaterThan(0);
    for (const program of page.programs) {
      expect(program.availableToday).toBe(true);
      expect(isLadiesOnly(program.eligibility)).toBe(true);
    }
  });

  test('countResults agrees with buildResults totals', () => {
    const filters = { ...emptyFilters, offers: true };
    const count = service.countResults({
      query: '',
      participantId: 'everyone',
      areaId: 'khalifa-city',
      filters,
    });
    expect(count).toBe(results('', { offers: true }).totalPrograms);
    expect(count).toBeGreaterThan(0);
  });

  test('every satisfiable dimension narrows: free, setting, format, price band, skill', () => {
    expect(results('', { free: true }).programs.every((p) => p.price!.kind === 'free')).toBe(true);
    expect(results('', { setting: 'outdoor' }).programs.every((p) => p.setting === 'outdoor')).toBe(true);
    expect(
      results('', { formats: ['camp'] }).programs.every((p) => p.isCamp),
    ).toBe(true);
    expect(
      results('', { priceBand: 'under-100' }).programs.every((p) => priceValue(p.price!) < 100),
    ).toBe(true);
    const beginner = results('', { skillLevel: 'beginner' }).programs;
    expect(beginner.length).toBeGreaterThan(0);
    expect(
      beginner.every((p) => ['beginner', 'all-levels'].includes(p.eligibility.skillLevel ?? '')),
    ).toBe(true);
  });

  test('activeFilterCount counts dimensions, and clear-all resets to zero', () => {
    const filters: FilterSelection = {
      ...emptyFilters,
      ladiesOnly: true,
      when: 'today',
      formats: ['dropIn'],
    };
    expect(activeFilterCount(filters)).toBe(3);
    expect(activeFilterCount(emptyFilters)).toBe(0);
  });
});

describe('Participant behavior on results', () => {
  test('child context hard-excludes and keeps only age-suitable programs', () => {
    const page = results('swimming', {}, { participantId: 'adam' });
    expect(page.totalPrograms).toBeGreaterThan(0);
    expect(page.programs.every((p) => suitsChild(p.eligibility, 8))).toBe(true);
  });

  test('me keeps household-relevant programs findable lower in the list', () => {
    const ids = results('swimming', {}, { participantId: 'me' }).programs.map((p) => p.id);
    expect(ids).toContain('junior-swim-squad');
    expect(ids.indexOf('adult-swim-technique')).toBeLessThan(ids.indexOf('junior-swim-squad'));
  });
});

describe('Sorting (deterministic)', () => {
  test('lowest price sorts ascending', () => {
    const prices = results('', {}, { sort: 'price' }).programs.map((p) => priceValue(p.price!));
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  test('highest rated sorts descending', () => {
    const ratings = results('', {}, { sort: 'rating' }).programs.map((p) => p.rating!);
    expect([...ratings].sort((a, b) => b - a)).toEqual(ratings);
  });

  test('nearest puts the reference area first', () => {
    const first = results('', {}, { sort: 'nearest', areaId: 'saadiyat' }).programs[0];
    expect(first.areaId).toBe('saadiyat');
  });

  test('sort preserves the filtered set', () => {
    const recommended = results('', { offers: true });
    const byPrice = results('', { offers: true }, { sort: 'price' });
    expect(new Set(byPrice.programs.map((p) => p.id))).toEqual(
      new Set(recommended.programs.map((p) => p.id)),
    );
  });
});

describe('Pagination', () => {
  test('page 1 caps programs at 12 with hasMore, page 2+ loads the rest deterministically', () => {
    const pageOne = results('');
    expect(pageOne.programs.length).toBe(12);
    expect(pageOne.hasMorePrograms).toBe(true);
    expect(pageOne.totalPrograms).toBeGreaterThan(12);

    const lastPage = Math.ceil(pageOne.totalPrograms! / 12);
    const full = results('', {}, { page: lastPage });
    expect(full.programs.length).toBe(full.totalPrograms);
    expect(full.hasMorePrograms).toBe(false);
    expect(full.programs.slice(0, 12)).toEqual(pageOne.programs); // stable prefix
  });
});

describe('Typo correction and failure flag', () => {
  test('typo query corrects and reports correctedQuery', () => {
    const page = results('pilaties');
    expect(page.correctedQuery).toBe('pilates');
    expect(page.totalPrograms).toBeGreaterThan(0);
  });

  test('QA failure flag throws deterministically', () => {
    expect(() =>
      service.buildResults({
        query: 'x',
        participantId: 'everyone',
        areaId: 'khalifa-city',
        filters: emptyFilters,
        sort: 'recommended',
        page: 1,
        simulateFailure: true,
      }),
    ).toThrow();
    expect(() =>
      service.countResults({
        query: 'x',
        participantId: 'everyone',
        areaId: 'khalifa-city',
        filters: emptyFilters,
        simulateFailure: true,
      }),
    ).toThrow();
  });
});
