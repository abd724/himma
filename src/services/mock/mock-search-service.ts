import {
  activityTypes,
  areas,
  categories,
  homeBrowseEntries,
  participants,
  programs,
  providers,
} from '@/data/mock/catalogue';
import {
  initialRecentSearches,
  popularSearches,
  synonyms,
  typoCorrections,
} from '@/data/mock/search-data';
import type {
  PreSearchContent,
  SearchInput,
  SearchResultSet,
  SearchService,
  SearchSuggestion,
} from '@/services/contracts/search';
import type { Area, AreaId, Participant, Program } from '@/types/domain';
import { participantAge, suitsAdult, suitsChild } from '@/utils/eligibility';

const MAX_SUGGESTIONS = 8;

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Whole-phrase and per-token curated typo correction. */
function correctTypos(query: string): string {
  const phrase = typoCorrections[query];
  if (phrase !== undefined) return phrase;
  return query
    .split(' ')
    .map((token) => typoCorrections[token] ?? token)
    .join(' ');
}

/** Expanded matching terms: corrected query + tokens + curated synonyms. */
function expandTerms(correctedQuery: string): string[] {
  const terms = new Set<string>();
  const add = (term: string) => {
    if (term.length >= 2) terms.add(term);
  };
  add(correctedQuery);
  for (const expansion of synonyms[correctedQuery] ?? []) add(expansion);
  for (const token of correctedQuery.split(' ')) {
    add(token);
    for (const expansion of synonyms[token] ?? []) add(expansion);
  }
  return [...terms];
}

/** True when any term prefixes a word of the text or the text contains it. */
function textMatches(text: string, terms: string[]): boolean {
  const value = normalize(text);
  const words = value.split(/[^a-z0-9]+/);
  return terms.some(
    (term) => value.includes(term) || words.some((word) => word.startsWith(term)),
  );
}

/** Lower tier = stronger textual match — docs/14 §3.3 rules 1–2. */
function programMatchTier(
  program: Program,
  terms: string[],
  labels: { activity: string; category: string; provider: string; area: string },
): number | undefined {
  if (textMatches(program.title, terms)) return 0;
  if (textMatches(labels.activity, terms) || textMatches(labels.category, terms)) return 1;
  if (textMatches(labels.provider, terms)) return 2;
  if (textMatches(labels.area, terms)) return 3;
  return undefined;
}

function areaRank(areaId: AreaId, reference: Area): number {
  if (areaId === reference.id) return 0;
  const nearbyIndex = reference.nearby.indexOf(areaId);
  return nearbyIndex === -1 ? reference.nearby.length + 1 : nearbyIndex + 1;
}

const activityTypeById = new Map(activityTypes.map((a) => [a.id, a]));
const categoryById = new Map(categories.map((c) => [c.id, c]));
const providerById = new Map(providers.map((p) => [p.id, p]));
const areaById = new Map(areas.map((a) => [a.id, a]));

function participantById(id: string): Participant {
  return participants.find((p) => p.id === id) ?? participants[0];
}

export class MockSearchService implements SearchService {
  private recents: string[] = [...initialRecentSearches];

  getPreSearchContent(): PreSearchContent {
    return {
      recentSearches: [...this.recents],
      popularSearches,
      categoryShortcuts: homeBrowseEntries,
    };
  }

  addRecentSearch(query: string): void {
    const value = query.trim();
    if (value.length === 0) return;
    this.recents = [value, ...this.recents.filter((r) => normalize(r) !== normalize(value))].slice(0, 6);
  }

  clearRecentSearches(): void {
    this.recents = [];
  }

  getSuggestions(input: SearchInput): SearchSuggestion[] {
    const query = normalize(input.query);
    if (query.length === 0) return [];
    const corrected = correctTypos(query);
    const terms = expandTerms(corrected);
    const participant = participantById(input.participantId);
    const age = participantAge(participant);

    const activityRows: SearchSuggestion[] = activityTypes
      .filter((activity) => textMatches(activity.label, terms))
      .slice(0, 3)
      .map((activity) => ({
        id: `type-${activity.id}`,
        kind: 'activity',
        label: activity.label,
        sublabel: categoryById.get(activity.categoryId)?.label,
        query: activity.label,
        targetId: activity.id,
      }));

    // Program titles surface under Activities; a child context hard-excludes
    // out-of-age-range programs, "Me" reorders without removing (docs/16 §4).
    let matchedPrograms = programs.filter((program) => textMatches(program.title, terms));
    if (participant.kind === 'child') {
      matchedPrograms = matchedPrograms.filter((program) =>
        suitsChild(program.eligibility, age ?? 0),
      );
    } else if (participant.kind === 'self') {
      matchedPrograms = [...matchedPrograms].sort(
        (a, b) => Number(suitsAdult(b.eligibility)) - Number(suitsAdult(a.eligibility)),
      );
    }
    const programRows: SearchSuggestion[] = matchedPrograms.slice(0, 3).map((program) => ({
      id: `program-${program.id}`,
      kind: 'activity',
      label: program.title,
      sublabel: providerById.get(program.providerId)?.name,
      query: program.title,
      targetId: program.id,
    }));

    const providerRows: SearchSuggestion[] = providers
      .filter((provider) =>
        textMatches(provider.name, terms) || textMatches(provider.categories.join(' '), terms),
      )
      .slice(0, 2)
      .map((provider) => ({
        id: `provider-${provider.id}`,
        kind: 'provider',
        label: provider.name,
        sublabel: provider.categories.join(' · '),
        query: provider.name,
        targetId: provider.id,
      }));

    const categoryRows: SearchSuggestion[] = categories
      .filter((category) => textMatches(category.label, terms))
      .slice(0, 2)
      .map((category) => ({
        id: `category-${category.id}`,
        kind: 'category',
        label: category.label,
        query: category.label,
        targetId: category.id,
      }));

    const areaRows: SearchSuggestion[] = areas
      .filter((area) => textMatches(area.label, terms))
      .slice(0, 1)
      .map((area) => ({
        id: `area-${area.id}`,
        kind: 'area',
        label: `${area.label}, Abu Dhabi`,
        query: area.label,
        targetId: area.id,
      }));

    return [...activityRows, ...programRows, ...providerRows, ...categoryRows, ...areaRows].slice(
      0,
      MAX_SUGGESTIONS,
    );
  }

  search(input: SearchInput): SearchResultSet {
    const query = normalize(input.query);
    if (query.length === 0) return { programs: [], providers: [], categories: [] };
    const corrected = correctTypos(query);
    const terms = expandTerms(corrected);
    const participant = participantById(input.participantId);
    const age = participantAge(participant);
    const referenceArea = areaById.get(input.areaId) ?? areas[0];

    const scored = programs
      .map((program, index) => {
        const tier = programMatchTier(program, terms, {
          activity: activityTypeById.get(program.activityTypeId)?.label ?? '',
          category: categoryById.get(program.categoryId)?.label ?? '',
          provider: providerById.get(program.providerId)?.name ?? '',
          area: areaById.get(program.areaId)?.label ?? '',
        });
        return tier === undefined ? undefined : { program, tier, index };
      })
      .filter((entry): entry is { program: Program; tier: number; index: number } => entry !== undefined);

    // Child context: hard-exclude out-of-age-range. Never gender-filtered.
    const eligible =
      participant.kind === 'child'
        ? scored.filter((entry) => suitsChild(entry.program.eligibility, age ?? 0))
        : scored;

    const adultFirst = (entry: { program: Program }) =>
      participant.kind === 'self' && !suitsAdult(entry.program.eligibility) ? 1 : 0;

    const rankedPrograms = [...eligible]
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          adultFirst(a) - adultFirst(b) ||
          areaRank(a.program.areaId, referenceArea) - areaRank(b.program.areaId, referenceArea) ||
          b.program.rating - a.program.rating ||
          a.index - b.index,
      )
      .map((entry) => entry.program);

    const matchedProviders = providers.filter(
      (provider) =>
        textMatches(provider.name, terms) ||
        textMatches(provider.categories.join(' '), terms) ||
        rankedPrograms.some((program) => program.providerId === provider.id),
    );

    const matchedCategories = categories.filter((category) => textMatches(category.label, terms));

    return {
      programs: rankedPrograms,
      providers: matchedProviders,
      categories: matchedCategories,
      correctedQuery: corrected !== query ? corrected : undefined,
    };
  }
}

export const searchService: SearchService = new MockSearchService();
