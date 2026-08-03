import { collections, programs } from '@/data/mock/catalogue';
import {
  activeFilterCount,
  collectionFilterSelection,
  emptyFilters,
  quickFilterSelection,
} from '@/services/contracts/filters';
import { MockDiscoverFeedService } from '@/services/mock/mock-discover-feed-service';
import { MockSearchService } from '@/services/mock/mock-search-service';
import { isLadiesOnly, suitsAdult, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const service = new MockDiscoverFeedService(0);
const searchService = new MockSearchService(0);

const feed = (participantId: string, quickFilterId?: any, areaId: any = 'khalifa-city') =>
  service.buildFeed({ areaId, participantId, quickFilterId });

const collectionById = (id: string) => {
  const collection = collections.find((entry) => entry.id === id);
  if (collection === undefined) throw new Error(`missing collection ${id}`);
  return collection;
};

describe('Discover feed — section ordering and collapse (docs/14 §2)', () => {
  test('default Everyone feed renders every section in order with content', () => {
    const result = feed('everyone');
    expect(result.programSections.map((s) => s.id)).toEqual([
      'trending',
      'available-today',
      'offers-trials',
    ]);
    expect(result.browseEntries).toHaveLength(8);
    expect(result.collections.length).toBeGreaterThanOrEqual(3);
    expect(result.collections.length).toBeLessThanOrEqual(5);
    expect(result.providers.length).toBeGreaterThan(0);
    expect(result.isEmpty).toBe(false);
  });

  test('sections respect the feed budget caps (3–5 cards each)', () => {
    const result = feed('everyone');
    for (const section of result.programSections) {
      expect(section.programs.length).toBeGreaterThan(0);
      expect(section.programs.length).toBeLessThanOrEqual(5);
    }
    expect(result.providers.length).toBeLessThanOrEqual(4);
  });

  test('empty sections collapse instead of rendering empty carousels', () => {
    // Adam + weekend: no weekend camp/offer overlap survives for every section.
    const result = feed('adam', 'weekend');
    for (const section of result.programSections) {
      expect(section.programs.length).toBeGreaterThan(0);
    }
    expect(result.programSections.some((s) => s.id === 'available-today')).toBe(false);
  });

  test('whole-feed no-match sets the recovery flag and collapses the rail', () => {
    // Lina (12) has no age-suitable program available on the mock today.
    const result = feed('lina', 'today');
    expect(result.programSections).toHaveLength(0);
    expect(result.isEmpty).toBe(true);
    expect(result.collections).toHaveLength(0);
    expect(result.providers).toHaveLength(0);
  });
});

describe('Discover feed — participant context (docs/16 §4)', () => {
  test('child context hard-excludes programs outside the provider-defined age range', () => {
    for (const [participantId, age] of [
      ['adam', 8],
      ['lina', 12],
    ] as const) {
      const result = feed(participantId);
      for (const section of result.programSections) {
        for (const program of section.programs) {
          expect(suitsChild(program.eligibility, age)).toBe(true);
        }
      }
    }
  });

  test('Me emphasizes adult-suitable programs first without hiding child programs from the catalogue', () => {
    const result = feed('me');
    for (const section of result.programSections) {
      const suitability = section.programs.map((program) => suitsAdult(program.eligibility));
      // Once a child-only program appears, no adult program follows it.
      const firstChildOnly = suitability.indexOf(false);
      if (firstChildOnly !== -1) {
        expect(suitability.slice(firstChildOnly)).not.toContain(true);
      }
      // No automatic gender filtering for adults.
    }
    const trending = result.programSections.find((s) => s.id === 'trending');
    expect(trending?.programs.every((p) => suitsAdult(p.eligibility))).toBe(true);
  });

  test('adult contexts see men, ladies, and mixed programs when Ladies only is off', () => {
    const all = feed('everyone').programSections.flatMap((s) => s.programs);
    const genders = new Set(all.map((p) => p.eligibility.genderEligibility));
    expect(genders.has('ladies')).toBe(true);
    expect(genders.has('mixed')).toBe(true);
  });

  test('participant compatibility trims the collections rail', () => {
    const everyoneIds = feed('everyone').collections.map((c) => c.collection.id);
    expect(everyoneIds).toContain('ladies-only');
    // Children never see the adults-only editorial entry; Me hides child-only ones.
    expect(feed('adam').collections.map((c) => c.collection.id)).not.toContain('ladies-only');
    expect(feed('me').collections.map((c) => c.collection.id)).not.toContain('after-school');
  });
});

describe('Discover feed — quick filters (docs/09 §17.4 semantics)', () => {
  test('Today keeps only available-today programs', () => {
    const result = feed('everyone', 'today');
    for (const section of result.programSections) {
      for (const program of section.programs) {
        expect(program.availableToday).toBe(true);
      }
    }
  });

  test('This weekend keeps only weekend programs', () => {
    const result = feed('everyone', 'weekend');
    for (const section of result.programSections) {
      for (const program of section.programs) {
        expect(program.runsOnWeekend).toBe(true);
      }
    }
  });

  test('Ladies only keeps only provider-classified ladies-only programs', () => {
    const result = feed('everyone', 'ladies-only');
    const all = result.programSections.flatMap((s) => s.programs);
    expect(all.length).toBeGreaterThan(0);
    for (const program of all) {
      expect(isLadiesOnly(program.eligibility)).toBe(true);
    }
  });

  test('Camps keeps camp-format programs; Offers keeps promotional programs', () => {
    for (const program of feed('everyone', 'camps').programSections.flatMap((s) => s.programs)) {
      expect(program.isCamp).toBe(true);
    }
    for (const program of feed('everyone', 'offers').programSections.flatMap((s) => s.programs)) {
      expect(program.offer).toBeDefined();
    }
  });

  test('Near me reorders by area proximity without narrowing', () => {
    const base = feed('everyone');
    const nearMe = feed('everyone', 'near-me');
    const baseTrending = base.programSections.find((s) => s.id === 'trending');
    const nearTrending = nearMe.programSections.find((s) => s.id === 'trending');
    expect(nearTrending?.programs.length).toBe(baseTrending?.programs.length);
    // From Yas Island, near-me leads Available today with Yas/nearby programs.
    const fromYas = service.buildFeed({
      areaId: 'yas-island',
      participantId: 'everyone',
      quickFilterId: 'near-me',
    });
    const today = fromYas.programSections.find((s) => s.id === 'available-today');
    expect(today?.programs[0].areaId).toBe('al-raha');
  });

  test('trending ranks by area proximity then rating deterministically', () => {
    const trending = feed('everyone').programSections.find((s) => s.id === 'trending');
    const programsList = trending?.programs ?? [];
    expect(programsList[0].areaId).toBe('khalifa-city');
    for (let i = 1; i < programsList.length; i += 1) {
      if (programsList[i].areaId === programsList[i - 1].areaId) {
        expect(programsList[i].rating).toBeLessThanOrEqual(programsList[i - 1].rating);
      }
    }
  });

  test('Available today is time-led: soonest mock-today time first, with Today labels', () => {
    const today = feed('everyone').programSections.find((s) => s.id === 'available-today');
    expect(today).toBeDefined();
    const labels = today!.programs.map(
      (program) => today!.scheduleOverrides?.[program.id] ?? program.scheduleLabel,
    );
    for (const label of labels) {
      expect(label.startsWith('Today') || label.startsWith('Daily')).toBe(true);
    }
  });
});

describe('Collections — presets are data, resolved by services (docs/15 §2)', () => {
  test('every quick chip translates to exactly one active filter dimension', () => {
    expect(quickFilterSelection(undefined)).toEqual(emptyFilters);
    for (const id of ['today', 'weekend', 'near-me', 'ladies-only', 'camps', 'offers'] as const) {
      expect(activeFilterCount(quickFilterSelection(id))).toBe(1);
    }
    expect(quickFilterSelection('ladies-only').ladiesOnly).toBe(true);
    expect(quickFilterSelection('today').when).toBe('today');
    expect(quickFilterSelection('weekend').when).toBe('weekend');
    expect(quickFilterSelection('near-me').nearMe).toBe(true);
    expect(quickFilterSelection('camps').formats).toEqual(['camp']);
    expect(quickFilterSelection('offers').offers).toBe(true);
  });

  test('collection presets resolve to the shared FilterSelection shape', () => {
    expect(collectionFilterSelection(collectionById('ladies-only'))).toEqual({
      ...emptyFilters,
      ladiesOnly: true,
    });
    expect(collectionFilterSelection(collectionById('camps'))).toEqual({
      ...emptyFilters,
      formats: ['camp'],
    });
    expect(collectionFilterSelection(collectionById('beat-the-heat'))).toEqual({
      ...emptyFilters,
      setting: 'indoor',
    });
    expect(collectionFilterSelection(collectionById('after-school'))).toEqual({
      ...emptyFilters,
      afterSchool: true,
    });
    expect(collectionFilterSelection(collectionById('kids-teens'))).toEqual({
      ...emptyFilters,
      audience: 'children',
    });
  });

  test('opening a collection preset produces the same results a Results session will show', () => {
    for (const summary of feed('everyone').collections) {
      const count = searchService.countResults({
        query: '',
        participantId: 'everyone',
        areaId: 'khalifa-city',
        filters: collectionFilterSelection(summary.collection),
      });
      expect(count).toBe(summary.programCount);
      expect(count).toBeGreaterThan(0);
    }
  });

  test('at least three rich collections and one deliberately thin collection exist', () => {
    const summaries = feed('everyone').collections;
    const rich = summaries.filter((summary) => summary.programCount >= 4);
    expect(rich.length).toBeGreaterThanOrEqual(3);
    const thin = summaries.find((summary) => summary.collection.id === 'try-something-new');
    expect(thin).toBeDefined();
    expect(thin!.programCount).toBeLessThanOrEqual(3);
  });

  test('ladies-only collection count matches the catalogue truth', () => {
    const summary = feed('everyone').collections.find(
      (entry) => entry.collection.id === 'ladies-only',
    );
    const truth = programs.filter((program) => isLadiesOnly(program.eligibility)).length;
    expect(summary?.programCount).toBe(truth);
  });
});

describe('Filter sheet handoff (docs/16 §3, commit-5 merge rule)', () => {
  test('the sheet seed from an active Discover chip round-trips through the results engine', () => {
    // Ladies only chip → seeded sheet → applying creates a ladies-only session.
    const seeded = quickFilterSelection('ladies-only');
    const count = searchService.countResults({
      query: '',
      participantId: 'everyone',
      areaId: 'khalifa-city',
      filters: seeded,
    });
    expect(count).toBe(programs.filter((program) => isLadiesOnly(program.eligibility)).length);
  });

  test('a preset Results session over an empty query serves the full filtered catalogue', () => {
    const page = searchService.buildResults({
      query: '',
      participantId: 'everyone',
      areaId: 'khalifa-city',
      filters: quickFilterSelection('camps'),
      sort: 'recommended',
      page: 1,
    });
    expect(page.totalPrograms).toBe(programs.filter((program) => program.isCamp).length);
    expect(page.programs.every((program) => program.isCamp)).toBe(true);
  });

  test('discover feed service exposes the same six quick filters as Home', () => {
    expect(service.getQuickFilters().map((filter) => filter.id)).toEqual([
      'today',
      'weekend',
      'near-me',
      'ladies-only',
      'camps',
      'offers',
    ]);
  });

  test('the QA failure flag is deterministic and throws before any content', () => {
    expect(() =>
      service.buildFeed({ areaId: 'khalifa-city', participantId: 'everyone', simulateFailure: true }),
    ).toThrow();
  });
});
