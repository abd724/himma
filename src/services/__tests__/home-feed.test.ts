import { MockHomeFeedService } from '@/services/mock/mock-home-feed-service';
import { isLadiesOnly, suitsAdult, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const service = new MockHomeFeedService(0);

const feed = (participantId: string, quickFilterId?: any, areaId: any = 'khalifa-city') =>
  service.buildFeed({ areaId, participantId, quickFilterId });

describe('Home feed — participant context (docs/11 §5)', () => {
  test('Everyone shows "for you" and Adam sections, in order', () => {
    const result = feed('everyone');
    const ids = result.programSections.map((s) => s.id);
    expect(ids).toEqual(['recommended-me', 'recommended-adam', 'available-today', 'offers-trials']);
    expect(result.isEmpty).toBe(false);
  });

  test('Me hides the child section and only contains adult-suitable programs (never gender-filtered)', () => {
    const result = feed('me');
    expect(result.programSections.some((s) => s.id === 'recommended-adam')).toBe(false);
    const all = result.programSections.flatMap((s) => s.programs);
    for (const program of all) {
      expect(suitsAdult(program.eligibility)).toBe(true);
    }
    // Adults see ladies-classified classes by default — no automatic gender filter.
    expect(all.some((p) => p.eligibility.genderEligibility === 'ladies')).toBe(true);
  });

  test('Selecting Adam leads with his section and filters everything to the provider-defined age range', () => {
    const result = feed('adam');
    expect(result.programSections[0].id).toBe('recommended-adam');
    expect(result.programSections.some((s) => s.id === 'recommended-me')).toBe(false);
    for (const section of result.programSections) {
      for (const program of section.programs) {
        expect(suitsChild(program.eligibility, 8)).toBe(true);
      }
    }
  });

  test('Lina gets her own section with age-12-suitable programs', () => {
    const result = feed('lina');
    expect(result.programSections[0].id).toBe('recommended-lina');
    expect(result.programSections[0].title).toBe('Recommended for Lina');
    const linaIds = result.programSections[0].programs.map((p) => p.id);
    expect(linaIds).toContain('arabic-teens');
    expect(linaIds).not.toContain('junior-robotics'); // max age 11
    expect(linaIds).not.toContain('junior-football-u10'); // max age 10
  });
});

describe('Home feed — quick filters (docs/11 §6)', () => {
  test('Today keeps only programs available today', () => {
    const result = feed('everyone', 'today');
    const all = result.programSections.flatMap((s) => s.programs);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => p.availableToday)).toBe(true);
  });

  test('This weekend keeps only weekend programs', () => {
    const all = feed('everyone', 'weekend').programSections.flatMap((s) => s.programs);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => p.runsOnWeekend)).toBe(true);
  });

  test('Ladies only keeps only provider-classified ladies programs', () => {
    const all = feed('everyone', 'ladies-only').programSections.flatMap((s) => s.programs);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => isLadiesOnly(p.eligibility))).toBe(true);
  });

  test('Camps keeps only camps and Offers keeps only offers', () => {
    const camps = feed('everyone', 'camps').programSections.flatMap((s) => s.programs);
    expect(camps.length).toBeGreaterThan(0);
    expect(camps.every((p) => p.isCamp)).toBe(true);

    const offers = feed('everyone', 'offers').programSections.flatMap((s) => s.programs);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((p) => p.offer !== undefined)).toBe(true);
  });

  test('Near me reorders instead of filtering: same section sizes, closest first', () => {
    const unfiltered = feed('everyone');
    const nearMe = feed('everyone', 'near-me');
    // Reordering must not shrink the feed — every section keeps its size
    // (within caps, the closest programs win the capped slots).
    expect(nearMe.programSections.map((s) => ({ id: s.id, n: s.programs.length }))).toEqual(
      unfiltered.programSections.map((s) => ({ id: s.id, n: s.programs.length })),
    );

    // Khalifa City reference: every section starts with the closest available program.
    for (const section of nearMe.programSections) {
      const ranks = section.programs.map((p) =>
        p.areaId === 'khalifa-city' ? 0 : ['al-raha', 'mbz-city'].indexOf(p.areaId) + 1 || 3,
      );
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });

  test('Sections with no matches collapse; empty combinations report isEmpty', () => {
    // Adam (8, child audience only) + Ladies only → nothing can match.
    const result = feed('adam', 'ladies-only');
    expect(result.programSections).toEqual([]);
    expect(result.providers).toEqual([]);
    expect(result.isEmpty).toBe(true);
  });

  test('Feed is deterministic: identical inputs give identical output', () => {
    expect(feed('everyone', 'offers')).toEqual(feed('everyone', 'offers'));
  });

  test('Section length budgets respected (docs/11 §10)', () => {
    const result = feed('everyone');
    for (const section of result.programSections) {
      const cap = section.id.startsWith('recommended') ? 5 : 4;
      expect(section.programs.length).toBeLessThanOrEqual(cap);
      expect(section.programs.length).toBeGreaterThanOrEqual(3);
    }
    expect(result.providers.length).toBeLessThanOrEqual(4);
    expect(result.categories.length).toBe(8);
  });
});
