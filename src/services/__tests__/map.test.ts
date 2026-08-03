import { areas, programs } from '@/data/mock/catalogue';
import { emptyFilters, type FilterSelection } from '@/services/contracts/filters';
import { MockMapService } from '@/services/mock/mock-map-service';
import { MockSearchService } from '@/services/mock/mock-search-service';
import { listDestination, needsBroadSession, parseMapOrigin } from '@/features/map/map-navigation';
import { isLadiesOnly, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const search = new MockSearchService(0);
const service = new MockMapService(search, 0);

const view = (
  overrides: Partial<{
    query: string;
    participantId: string;
    areaId: any;
    filters: FilterSelection;
    simulateFailure: boolean;
    simulateMissingCounts: boolean;
  }> = {},
) =>
  service.buildMapView({
    query: '',
    participantId: 'everyone',
    areaId: 'khalifa-city',
    filters: emptyFilters,
    sort: 'recommended',
    ...overrides,
  });

const countIn = (areaId: string, predicate: (program: (typeof programs)[number]) => boolean = () => true) =>
  programs.filter((program) => program.areaId === areaId && predicate(program)).length;

describe('Map area counts (docs/14 §7)', () => {
  test('every catalogue area appears as a node, including areas without supply', () => {
    const result = view();
    expect(result.areas.map((entry) => entry.area.id)).toEqual(areas.map((area) => area.id));
    const emptyArea = result.areas.find((entry) => entry.area.id === 'abu-dhabi-island');
    expect(emptyArea?.programCount).toBe(0);
    expect(emptyArea?.pins).toHaveLength(0);
  });

  test('counts match the catalogue truth per area and total the whole catalogue', () => {
    const result = view();
    for (const summary of result.areas) {
      expect(summary.programCount).toBe(countIn(summary.area.id));
    }
    expect(result.totalPrograms).toBe(programs.length);
    expect(result.hasAnyResults).toBe(true);
  });

  test('pins are fictional provider markers drawn from the matching programs', () => {
    const khalifa = view().areas.find((entry) => entry.area.id === 'khalifa-city');
    expect(khalifa?.pins.length).toBeGreaterThan(0);
    expect(khalifa?.pins.length).toBeLessThanOrEqual(3);
    for (const pin of khalifa?.pins ?? []) {
      expect(pin.initials).toMatch(/^[A-Z]{1,2}$/);
      expect(pin.providerName.length).toBeGreaterThan(0);
    }
    expect(khalifa?.providerCount).toBeGreaterThan(0);
  });

  test('a node reports its own supply regardless of the session area selection', () => {
    // Selecting an area narrows the list, never the map's other nodes.
    const selected = view({ filters: { ...emptyFilters, areaId: 'al-raha' } });
    for (const summary of selected.areas) {
      expect(summary.programCount).toBe(countIn(summary.area.id));
    }
  });
});

describe('Map shares the list filters exactly (docs/16 §3.1)', () => {
  test('Ladies only narrows every node to provider-classified ladies-only supply', () => {
    const result = view({ filters: { ...emptyFilters, ladiesOnly: true } });
    for (const summary of result.areas) {
      expect(summary.programCount).toBe(
        countIn(summary.area.id, (program) => isLadiesOnly(program.eligibility)),
      );
    }
    expect(result.hasAnyResults).toBe(true);
  });

  test('a child context hard-excludes out-of-age-range programs per area', () => {
    const result = view({ participantId: 'adam' });
    for (const summary of result.areas) {
      expect(summary.programCount).toBe(
        countIn(summary.area.id, (program) => suitsChild(program.eligibility, 8)),
      );
    }
  });

  test('map counts agree with the list count for the same session', () => {
    const filters: FilterSelection = { ...emptyFilters, when: 'today' };
    const result = view({ filters });
    for (const summary of result.areas) {
      const listCount = search.countResults({
        query: '',
        participantId: 'everyone',
        areaId: 'khalifa-city',
        filters: { ...filters, areaId: summary.area.id },
      });
      expect(summary.programCount).toBe(listCount);
    }
  });

  test('a text query flows into the map exactly as it does into the list', () => {
    const result = view({ query: 'swimming' });
    const total = result.areas.reduce((sum, summary) => sum + (summary.programCount ?? 0), 0);
    expect(total).toBe(
      search.buildResults({
        query: 'swimming',
        participantId: 'everyone',
        areaId: 'khalifa-city',
        filters: emptyFilters,
        sort: 'recommended',
        page: 1,
      }).totalPrograms,
    );
  });

  test('category and activity-type entry contexts scope the map', () => {
    const category = view({ filters: { ...emptyFilters, categoryId: 'martial-arts' } });
    expect(category.areas.find((entry) => entry.area.id === 'khalifa-city')?.programCount).toBe(
      countIn('khalifa-city', (program) => program.categoryId === 'martial-arts'),
    );
    const activity = view({
      filters: { ...emptyFilters, categoryId: 'martial-arts', activityTypeId: 'karate' },
    });
    expect(activity.areas.find((entry) => entry.area.id === 'khalifa-city')?.programCount).toBe(
      countIn('khalifa-city', (program) => program.activityTypeId === 'karate'),
    );
  });
});

describe('Map states (docs/16 §2)', () => {
  test('an area with no matching supply reports zero honestly, never a guess', () => {
    const result = view({ filters: { ...emptyFilters, ladiesOnly: true } });
    const withoutLadies = result.areas.find((entry) => entry.area.id === 'mbz-city');
    expect(withoutLadies?.programCount).toBe(0);
    expect(withoutLadies?.pins).toHaveLength(0);
  });

  test('no matching areas at all flags the recovery state', () => {
    // Adam (8) with Ladies only: a real conflict, resolved by recovery copy.
    const result = view({ participantId: 'adam', filters: { ...emptyFilters, ladiesOnly: true } });
    expect(result.areas.every((summary) => summary.programCount === 0)).toBe(true);
    expect(result.hasAnyResults).toBe(false);
  });

  test('the QA failure flag throws before any content', () => {
    expect(() => view({ simulateFailure: true })).toThrow();
  });

  test('the missing-count flag yields undefined counts, not zeros', () => {
    const result = view({ simulateMissingCounts: true });
    expect(result.totalPrograms).toBeUndefined();
    expect(result.hasAnyResults).toBe(false);
    for (const summary of result.areas) {
      expect(summary.programCount).toBeUndefined();
      expect(summary.providerCount).toBeUndefined();
    }
  });

  test('map data is deterministic across identical calls', () => {
    expect(view()).toEqual(view());
  });
});

describe('Map navigation contract (docs/15 §4.3)', () => {
  test('List pops back onto the Results screen the map was opened from', () => {
    expect(listDestination('results')).toEqual({ kind: 'back' });
  });

  test('List from a browsing surface opens the session list instead of stacking a second one', () => {
    for (const origin of ['discover', 'category', 'activity'] as const) {
      expect(listDestination(origin)).toEqual({ kind: 'openResults' });
    }
  });

  test('only a Discover entry without a session creates the broad one', () => {
    expect(needsBroadSession('discover', false)).toBe(true);
    expect(needsBroadSession('discover', true)).toBe(false);
    for (const origin of ['results', 'category', 'activity'] as const) {
      expect(needsBroadSession(origin, false)).toBe(false);
    }
  });

  test('an unknown or missing origin falls back to the Discover contract', () => {
    expect(parseMapOrigin('results')).toBe('results');
    expect(parseMapOrigin(undefined)).toBe('discover');
    expect(parseMapOrigin('nonsense')).toBe('discover');
  });
});
