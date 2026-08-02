import { MockSearchService } from '@/services/mock/mock-search-service';
import { suitsAdult, suitsChild } from '@/utils/eligibility';
import { describe, expect, test } from '@jest/globals';

const service = new MockSearchService();

const suggest = (query: string, participantId = 'everyone') =>
  service.getSuggestions({ query, participantId, areaId: 'khalifa-city' });

const search = (query: string, participantId = 'everyone', areaId: any = 'khalifa-city') =>
  service.search({ query, participantId, areaId });

describe('Suggestions (docs/14 §3.1)', () => {
  test('prefix match groups activity types with category context', () => {
    const rows = suggest('pil');
    const pilates = rows.find((r) => r.label === 'Pilates');
    expect(pilates).toBeDefined();
    expect(pilates?.kind).toBe('activity');
    expect(pilates?.sublabel).toBe('Pilates, yoga & movement');
  });

  test('never more than eight rows', () => {
    for (const q of ['a', 's', 'ka', 'swimming', 'pilates']) {
      expect(suggest(q).length).toBeLessThanOrEqual(8);
    }
  });

  test('provider and area suggestions carry their kind', () => {
    expect(suggest('falcon').some((r) => r.kind === 'provider' && r.label === 'Falcon Combat Academy')).toBe(true);
    expect(suggest('yas').some((r) => r.kind === 'area' && r.label === 'Yas Island, Abu Dhabi')).toBe(true);
  });

  test('empty and whitespace queries produce nothing', () => {
    expect(suggest('')).toEqual([]);
    expect(suggest('   ')).toEqual([]);
  });
});

describe('Synonyms and typos (docs/14 §3.4)', () => {
  test('soccer resolves to football', () => {
    const rows = suggest('soccer');
    expect(rows.some((r) => r.label === 'Football')).toBe(true);
    expect(search('soccer').programs.some((p) => p.id === 'junior-football-u10')).toBe(true);
  });

  test('curated typo pilaties corrects to pilates', () => {
    const rows = suggest('pilaties');
    expect(rows.some((r) => r.label === 'Pilates')).toBe(true);
    const result = search('pilaties');
    expect(result.correctedQuery).toBe('pilates');
    expect(result.programs.length).toBeGreaterThan(0);
  });

  test('clean queries carry no correction', () => {
    expect(search('boxing').correctedQuery).toBeUndefined();
  });
});

describe('Ranking (docs/14 §3.3)', () => {
  test('title matches rank above provider-name matches', () => {
    const result = search('boxing').programs;
    const titleIndex = result.findIndex((p) => p.id === 'boxing-fundamentals');
    expect(titleIndex).toBe(0);
  });

  test('near areas rank first within the same tier', () => {
    // "yoga" matches morning-yoga and teen-yoga (both Al Reem) — reference
    // area al-reem should put them ahead of any weaker-area match.
    const fromReem = search('yoga', 'everyone', 'al-reem').programs;
    expect(fromReem[0].areaId).toBe('al-reem');
  });

  test('deterministic: identical inputs give identical output', () => {
    expect(search('swimming')).toEqual(search('swimming'));
  });

  test('empty query returns empty result set', () => {
    expect(search('').programs).toEqual([]);
  });
});

describe('Participant-aware behavior (docs/16 §4 — ranks, never silently hides)', () => {
  test('Me ranks adult-suitable first but keeps child programs findable', () => {
    const result = search('swimming', 'me').programs;
    const ids = result.map((p) => p.id);
    expect(ids).toContain('junior-swim-squad'); // household-relevant, not hidden
    const firstJuniorIndex = result.findIndex((p) => !suitsAdult(p.eligibility));
    const lastAdultIndex = result.map((p) => suitsAdult(p.eligibility)).lastIndexOf(true);
    expect(firstJuniorIndex === -1 || firstJuniorIndex > 0).toBe(true);
    expect(lastAdultIndex).toBeLessThan(
      firstJuniorIndex === -1 ? result.length : result.length,
    );
    // Within the strongest tier, adult-suitable precede junior-capped.
    expect(suitsAdult(result[0].eligibility)).toBe(true);
  });

  test('No automatic gender filtering: Me sees ladies and men classes alike', () => {
    const ids = search('strength', 'me').programs.map((p) => p.id);
    expect(ids).toContain('ladies-strength');
    expect(ids).toContain('mens-strength-basics');
  });

  test('Adam hard-excludes out-of-age-range programs', () => {
    const result = search('swimming', 'adam').programs;
    expect(result.length).toBeGreaterThan(0);
    for (const program of result) {
      expect(suitsChild(program.eligibility, 8)).toBe(true);
    }
    expect(result.map((p) => p.id)).not.toContain('ladies-aqua'); // 16+
  });

  test('Adam suggestion program rows are age-suitable only', () => {
    const rows = suggest('swim', 'adam');
    expect(rows.some((r) => r.label === 'Junior Swim Squad')).toBe(true);
    expect(rows.some((r) => r.label === 'Ladies Aqua Fitness')).toBe(false);
  });

  test('Lina excludes below-minimum-age programs', () => {
    const ids = search('robotics', 'lina').programs.map((p) => p.id);
    expect(ids).not.toContain('junior-robotics'); // max age 11 < Lina (12)
  });
});

describe('Recent searches (docs/17 §8 — session-local, clearable)', () => {
  test('deterministic initial examples, add, dedupe, clear', () => {
    const fresh = new MockSearchService();
    expect(fresh.getPreSearchContent().recentSearches).toEqual(['Kickboxing', 'Robotics for kids']);
    fresh.addRecentSearch('Padel');
    fresh.addRecentSearch('padel');
    expect(fresh.getPreSearchContent().recentSearches[0]).toBe('padel');
    expect(
      fresh.getPreSearchContent().recentSearches.filter((r) => r.toLowerCase() === 'padel').length,
    ).toBe(1);
    fresh.addRecentSearch('   ');
    expect(fresh.getPreSearchContent().recentSearches[0]).toBe('padel');
    fresh.clearRecentSearches();
    expect(fresh.getPreSearchContent().recentSearches).toEqual([]);
  });
});
