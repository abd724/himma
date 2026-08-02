import { areas, programs as catalogue, recommendationOrder } from '@/data/mock/catalogue';
import type { FilterSelection, SortId } from '@/services/contracts/filters';
import type { Area, AreaId, PriceModel, Program } from '@/types/domain';
import { isChildRelevant, isLadiesOnly, suitsAdult } from '@/utils/eligibility';

export function priceValue(price: PriceModel): number {
  switch (price.kind) {
    case 'dropIn':
    case 'monthly':
    case 'term':
    case 'package':
      return price.amount;
    case 'camp':
      return price.amountPerWeek;
    case 'free':
    case 'freeTrial':
      return 0;
  }
}

function inPriceBand(program: Program, band: FilterSelection['priceBand']): boolean {
  if (band === undefined) return true;
  const value = priceValue(program.price);
  if (band === 'under-100') return value < 100;
  if (band === '100-500') return value >= 100 && value <= 500;
  return value > 500;
}

function overlapsAgeBand(program: Program, band: { min: number; max: number | null }): boolean {
  const { allAges, minimumAge, maximumAge } = program.eligibility;
  if (allAges) return true;
  const programMin = minimumAge ?? 0;
  const programMax = maximumAge ?? Number.POSITIVE_INFINITY;
  const bandMax = band.max ?? Number.POSITIVE_INFINITY;
  return programMin <= bandMax && programMax >= band.min;
}

/**
 * Applies every narrowing filter — docs/16 §3. "Near me" reorders only.
 * Ladies-only off means NO gender-based narrowing of any kind.
 */
export function passesFilters(program: Program, filters: FilterSelection): boolean {
  if (filters.ladiesOnly && !isLadiesOnly(program.eligibility)) return false;
  if (filters.audience === 'adults' && !suitsAdult(program.eligibility)) return false;
  if (filters.audience === 'children' && !isChildRelevant(program.eligibility)) return false;
  if (filters.ageBand !== undefined && !overlapsAgeBand(program, filters.ageBand)) return false;
  if (filters.when === 'today' && !program.availableToday) return false;
  if (filters.when === 'weekend' && !program.runsOnWeekend) return false;
  if (filters.afterSchool && program.runsAfterSchool !== true) return false;
  if (filters.areaId !== undefined && program.areaId !== filters.areaId) return false;
  if (filters.categoryId !== undefined && program.categoryId !== filters.categoryId) return false;
  if (filters.activityTypeId !== undefined && program.activityTypeId !== filters.activityTypeId) {
    return false;
  }
  if (filters.formats.length > 0) {
    const format = program.isCamp ? 'camp' : program.price.kind;
    if (!(filters.formats as string[]).includes(format)) return false;
  }
  if (filters.setting !== undefined && program.setting !== filters.setting) return false;
  if (!inPriceBand(program, filters.priceBand)) return false;
  if (filters.free && program.price.kind !== 'free') return false;
  if (filters.offers && program.offer === undefined) return false;
  if (
    filters.trial &&
    !(program.offer?.kind === 'freeTrial' || program.offer?.kind === 'paidTrial')
  ) {
    return false;
  }
  if (
    filters.skillLevel !== undefined &&
    program.eligibility.skillLevel !== filters.skillLevel &&
    program.eligibility.skillLevel !== 'all-levels'
  ) {
    return false;
  }
  if (filters.topRated && program.rating < 4.8) return false;
  return true;
}

function areaRank(areaId: AreaId, reference: Area): number {
  if (areaId === reference.id) return 0;
  const nearbyIndex = reference.nearby.indexOf(areaId);
  return nearbyIndex === -1 ? reference.nearby.length + 1 : nearbyIndex + 1;
}

const popularityIds = recommendationOrder.everyone;
const catalogueIndexById = new Map(catalogue.map((program, index) => [program.id, index]));

function soonness(program: Program): number {
  if (program.availableToday) return 0;
  if (program.runsOnWeekend) return 1;
  if (program.isCamp) return 3;
  return 2;
}

function popularity(program: Program): number {
  const index = popularityIds.indexOf(program.id);
  const curated = index === -1 ? popularityIds.length : index;
  return curated * 100 + Math.round((5 - program.rating) * 10);
}

/**
 * Deterministic sorting — docs/17 §10. The incoming order is the search
 * relevance order; `recommended` preserves it, every other sort falls back
 * to it for ties. "Near me" reorders by proximity on top of any sort except
 * `nearest` (which already is proximity).
 */
export function sortPrograms(
  list: Program[],
  sort: SortId,
  referenceAreaId: AreaId,
  nearMe: boolean,
): Program[] {
  const reference = areas.find((area) => area.id === referenceAreaId) ?? areas[0];
  const relevanceById = new Map(list.map((program, index) => [program.id, index]));
  const relevance = (program: Program) => relevanceById.get(program.id) ?? 0;
  const result = [...list];
  const by = (compare: (a: Program, b: Program) => number) =>
    result.sort((a, b) => compare(a, b) || relevance(a) - relevance(b));

  switch (sort) {
    case 'recommended':
      break;
    case 'nearest':
      by((a, b) => areaRank(a.areaId, reference) - areaRank(b.areaId, reference));
      break;
    case 'soonest':
      by((a, b) => soonness(a) - soonness(b));
      break;
    case 'rating':
      by((a, b) => b.rating - a.rating);
      break;
    case 'popular':
      by((a, b) => popularity(a) - popularity(b));
      break;
    case 'price':
      by((a, b) => priceValue(a.price) - priceValue(b.price));
      break;
    case 'newest':
      // Mock recency: later catalogue additions are newer.
      by((a, b) => (catalogueIndexById.get(b.id) ?? 0) - (catalogueIndexById.get(a.id) ?? 0));
      break;
  }

  if (nearMe && sort !== 'nearest') {
    by((a, b) => areaRank(a.areaId, reference) - areaRank(b.areaId, reference));
  }
  return result;
}

/** Deterministic supporting info for provider rows. */
export function providerProgramCount(providerId: string): number {
  return catalogue.filter((program) => program.providerId === providerId).length;
}
