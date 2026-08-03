import { activityTypes, categories, programs } from '@/data/mock/catalogue';
import { MockCatalogueService } from '@/services/mock/mock-catalogue-service';
import { isChildRelevant, suitsAdult, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const service = new MockCatalogueService(0);

const categoryPage = (categoryId: string, participantId = 'everyone', areaId: any = 'khalifa-city') =>
  service.buildCategoryPage({ categoryId: categoryId as any, participantId, areaId });

const activityPage = (activityTypeId: string, participantId = 'everyone', areaId: any = 'khalifa-city') =>
  service.buildActivityTypePage({ activityTypeId, participantId, areaId });

describe('All Categories — supply-aware ordering (docs/04 HMA-011, docs/17 §11)', () => {
  const listing = service.buildAllCategories();

  test('lists the full 11-category taxonomy plus the two browse lenses', () => {
    expect(listing.categories).toHaveLength(categories.length);
    expect(listing.lenses.map((lens) => lens.collectionId)).toEqual(['kids-teens', 'camps']);
  });

  test('orders categories by program count descending with taxonomy-order ties', () => {
    const counts = listing.categories.map((entry) => entry.programCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    const taxonomyIndex = new Map(categories.map((category, index) => [category.id, index]));
    for (let i = 1; i < listing.categories.length; i += 1) {
      if (counts[i] === counts[i - 1]) {
        expect(taxonomyIndex.get(listing.categories[i].category.id)!).toBeGreaterThan(
          taxonomyIndex.get(listing.categories[i - 1].category.id)!,
        );
      }
    }
  });

  test('counts match the catalogue truth for every category', () => {
    for (const entry of listing.categories) {
      expect(entry.programCount).toBe(
        programs.filter((program) => program.categoryId === entry.category.id).length,
      );
      expect(entry.programCount).toBeGreaterThan(0);
    }
  });

  test('lens counts resolve their presets over the shared catalogue', () => {
    const kidsTeens = listing.lenses.find((lens) => lens.collectionId === 'kids-teens');
    expect(kidsTeens?.programCount).toBe(
      programs.filter((program) => isChildRelevant(program.eligibility)).length,
    );
    const camps = listing.lenses.find((lens) => lens.collectionId === 'camps');
    expect(camps?.programCount).toBe(programs.filter((program) => program.isCamp).length);
  });
});

describe('Category page — content and honest supply (docs/04 HMA-012, docs/16 §2)', () => {
  test('unknown category id returns undefined for screen-level recovery', () => {
    expect(categoryPage('not-a-category')).toBeUndefined();
  });

  test('featured activity types cover the category, are supply-ordered, and omit zero rows', () => {
    const page = categoryPage('martial-arts')!;
    expect(page.activityTypes.length).toBeGreaterThan(0);
    for (const entry of page.activityTypes) {
      expect(entry.activityType.categoryId).toBe('martial-arts');
      expect(entry.programCount).toBeGreaterThan(0);
    }
    const counts = page.activityTypes.map((entry) => entry.programCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  test('popular programs and offers stay inside the category and its caps', () => {
    for (const categoryId of ['fitness', 'martial-arts', 'swimming'] as const) {
      const page = categoryPage(categoryId)!;
      expect(page.popularPrograms.length).toBeGreaterThan(0);
      expect(page.popularPrograms.length).toBeLessThanOrEqual(6);
      expect(page.offerPrograms.length).toBeLessThanOrEqual(4);
      for (const program of [...page.popularPrograms, ...page.offerPrograms]) {
        expect(program.categoryId).toBe(categoryId);
      }
      for (const program of page.offerPrograms) {
        expect(program.offer).toBeDefined();
      }
    }
  });

  test('providers are the category operators, rating-ranked and capped', () => {
    const page = categoryPage('martial-arts')!;
    expect(page.providers.length).toBeGreaterThan(0);
    expect(page.providers.length).toBeLessThanOrEqual(4);
    const operatorIds = new Set(
      programs
        .filter((program) => program.categoryId === 'martial-arts')
        .map((program) => program.providerId),
    );
    for (const provider of page.providers) {
      expect(operatorIds.has(provider.id)).toBe(true);
    }
    for (let i = 1; i < page.providers.length; i += 1) {
      expect(page.providers[i].rating).toBeLessThanOrEqual(page.providers[i - 1].rating);
    }
  });

  test('weak-supply categories report an honest low visible count (docs/16 §2)', () => {
    // Secondary categories are deliberately thin (docs/14 §8).
    for (const categoryId of ['wellness', 'quran', 'tech-stem'] as const) {
      const page = categoryPage(categoryId)!;
      expect(page.visibleProgramCount).toBeLessThanOrEqual(2);
      expect(page.visibleProgramCount).toBeGreaterThan(0);
    }
    expect(categoryPage('fitness')!.visibleProgramCount).toBeGreaterThan(2);
  });

  test('child context hard-excludes out-of-range programs everywhere on the page', () => {
    const page = categoryPage('martial-arts', 'adam')!;
    for (const program of [...page.popularPrograms, ...page.offerPrograms]) {
      expect(suitsChild(program.eligibility, 8)).toBe(true);
    }
    // Adam (8): only the junior 6–12 programs survive in martial arts.
    expect(page.visibleProgramCount).toBe(
      programs.filter(
        (program) =>
          program.categoryId === 'martial-arts' && suitsChild(program.eligibility, 8),
      ).length,
    );
    // Activity-type chips reflect the child-visible supply, no zero rows.
    for (const entry of page.activityTypes) {
      expect(entry.programCount).toBeGreaterThan(0);
    }
  });

  test('a child context can empty a category and the count says so honestly', () => {
    // Wellness is 18+ only, so Adam sees none.
    const page = categoryPage('wellness', 'adam')!;
    expect(page.visibleProgramCount).toBe(0);
    expect(page.popularPrograms).toHaveLength(0);
    expect(page.activityTypes).toHaveLength(0);
  });

  test('Me ranks adult-suitable programs first without hiding junior programs', () => {
    const page = categoryPage('martial-arts', 'me')!;
    const suitability = page.popularPrograms.map((program) => suitsAdult(program.eligibility));
    const firstChildOnly = suitability.indexOf(false);
    if (firstChildOnly !== -1) {
      expect(suitability.slice(firstChildOnly)).not.toContain(true);
    }
    // Junior programs remain reachable — never invisibly excluded.
    expect(page.visibleProgramCount).toBe(
      programs.filter((program) => program.categoryId === 'martial-arts').length,
    );
  });

  test('ranking is simple and deterministic: rating desc then proximity then stable order', () => {
    const page = categoryPage('fitness')!;
    for (let i = 1; i < page.popularPrograms.length; i += 1) {
      expect(page.popularPrograms[i].rating).toBeLessThanOrEqual(
        page.popularPrograms[i - 1].rating,
      );
    }
    // Same inputs, same output — twice.
    expect(categoryPage('fitness')).toEqual(page);
  });
});

describe('Activity-type page — single catalogue proof (docs/15 §8.5, HMA-013)', () => {
  test('unknown activity type returns undefined for screen-level recovery', () => {
    expect(activityPage('not-a-type')).toBeUndefined();
  });

  test('adult and junior variants of one activity type share the page under Everyone', () => {
    for (const activityTypeId of ['karate', 'swimming', 'calisthenics', 'yoga'] as const) {
      const page = activityPage(activityTypeId)!;
      const adult = page.programs.some((program) => suitsAdult(program.eligibility));
      const junior = page.programs.some((program) => isChildRelevant(program.eligibility));
      expect(adult).toBe(true);
      expect(junior).toBe(true);
    }
  });

  test('the page carries its category context and every catalogue program of the type', () => {
    const page = activityPage('karate')!;
    expect(page.category.id).toBe('martial-arts');
    expect(page.programs.map((program) => program.activityTypeId)).toEqual(
      page.programs.map(() => 'karate'),
    );
    expect(page.programs).toHaveLength(
      programs.filter((program) => program.activityTypeId === 'karate').length,
    );
  });

  test('providers listed are exactly those operating the activity type', () => {
    const page = activityPage('swimming')!;
    const operatorIds = new Set(
      programs
        .filter((program) => program.activityTypeId === 'swimming')
        .map((program) => program.providerId),
    );
    expect(new Set(page.providers.map((provider) => provider.id))).toEqual(operatorIds);
  });

  test('child context filters the programs list by provider-defined age range', () => {
    const page = activityPage('karate', 'adam')!;
    expect(page.programs.length).toBeGreaterThan(0);
    for (const program of page.programs) {
      expect(suitsChild(program.eligibility, 8)).toBe(true);
    }
    // The adult foundations class (16+) is excluded for Adam.
    expect(page.programs.map((program) => program.id)).not.toContain('karate-foundations');
  });

  test('every taxonomy activity type resolves to a non-empty page under Everyone', () => {
    for (const activityType of activityTypes) {
      const page = activityPage(activityType.id)!;
      expect(page.programs.length).toBeGreaterThan(0);
      expect(page.providers.length).toBeGreaterThan(0);
    }
  });
});
