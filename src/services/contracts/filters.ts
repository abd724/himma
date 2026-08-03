import type { QuickFilterId } from '@/services/contracts/home-feed';
import type { AreaId, CategoryId, Collection, SkillLevel } from '@/types/domain';

/** Program-format filter values; `camp` matches camp-format programs. */
export type ProgramFormatFilter = 'dropIn' | 'monthly' | 'term' | 'package' | 'camp';

export type PriceBand = 'under-100' | '100-500' | 'over-500';

export type WhenFilter = 'today' | 'tomorrow' | 'weekend';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/**
 * One typed source of truth for Results and the future Map — docs/16 §3.1.
 * Every customer-facing filter control writes here; quick chips, the sheet,
 * count badges, active chips, and result counts all read the same object.
 * Fields without mock-data support yet (tomorrow, dayOfWeek, timeOfDay,
 * dateRange, distanceBand, accessibilitySupport, instantBooking) exist for
 * contract completeness; their controls appear once data can satisfy them —
 * no disabled rows are rendered (docs/17 §10).
 */
export interface FilterSelection {
  /** The single optional customer-facing gender filter (docs/05 §7). */
  ladiesOnly: boolean;
  audience?: 'adults' | 'children';
  ageBand?: { min: number; max: number | null };
  when?: WhenFilter;
  afterSchool: boolean;
  dayOfWeek?: string[];
  timeOfDay?: TimeOfDay;
  dateRange?: { startLabel: string; endLabel: string };
  areaId?: AreaId;
  /** Reorders by proximity; never narrows (docs/11 §6). */
  nearMe: boolean;
  distanceBand?: 'walking' | 'short-drive' | 'anywhere';
  categoryId?: CategoryId;
  activityTypeId?: string;
  formats: ProgramFormatFilter[];
  setting?: 'indoor' | 'outdoor';
  priceBand?: PriceBand;
  free: boolean;
  offers: boolean;
  trial: boolean;
  skillLevel?: Exclude<SkillLevel, 'all-levels'>;
  topRated: boolean;
  accessibilitySupport?: boolean;
  instantBooking?: boolean;
}

export const emptyFilters: FilterSelection = {
  ladiesOnly: false,
  afterSchool: false,
  nearMe: false,
  formats: [],
  free: false,
  offers: false,
  trial: false,
  topRated: false,
};

/**
 * The one place a Discover quick chip translates into a FilterSelection —
 * used to seed the filter sheet from the active chip (docs/16 §3) and to
 * open quick-chip-equivalent Results sessions. Deterministic and total.
 */
export function quickFilterSelection(quickFilterId?: QuickFilterId): FilterSelection {
  switch (quickFilterId) {
    case undefined:
      return emptyFilters;
    case 'today':
      return { ...emptyFilters, when: 'today' };
    case 'weekend':
      return { ...emptyFilters, when: 'weekend' };
    case 'near-me':
      return { ...emptyFilters, nearMe: true };
    case 'ladies-only':
      return { ...emptyFilters, ladiesOnly: true };
    case 'camps':
      return { ...emptyFilters, formats: ['camp'] };
    case 'offers':
      return { ...emptyFilters, offers: true };
  }
}

/**
 * Resolves an editorial collection's preset into the shared FilterSelection —
 * collections are data; no card ever hard-codes filtering (docs/15 §2).
 */
export function collectionFilterSelection(collection: Collection): FilterSelection {
  const { preset } = collection;
  return {
    ...emptyFilters,
    ladiesOnly: preset.ladiesOnly === true,
    audience: preset.childRelevant === true ? 'children' : undefined,
    formats: preset.camps === true ? ['camp'] : [],
    offers: preset.offers === true,
    when: preset.availableToday === true ? 'today' : undefined,
    afterSchool: preset.afterSchool === true,
    setting: preset.indoor === true ? 'indoor' : undefined,
  };
}

/** Number of active filter dimensions — drives count badges everywhere. */
export function activeFilterCount(filters: FilterSelection): number {
  let count = 0;
  if (filters.ladiesOnly) count += 1;
  if (filters.audience !== undefined) count += 1;
  if (filters.ageBand !== undefined) count += 1;
  if (filters.when !== undefined) count += 1;
  if (filters.afterSchool) count += 1;
  if (filters.areaId !== undefined) count += 1;
  if (filters.nearMe) count += 1;
  if (filters.categoryId !== undefined) count += 1;
  if (filters.activityTypeId !== undefined) count += 1;
  if (filters.formats.length > 0) count += 1;
  if (filters.setting !== undefined) count += 1;
  if (filters.priceBand !== undefined) count += 1;
  if (filters.free) count += 1;
  if (filters.offers) count += 1;
  if (filters.trial) count += 1;
  if (filters.skillLevel !== undefined) count += 1;
  if (filters.topRated) count += 1;
  return count;
}

export type SortId =
  | 'recommended'
  | 'nearest'
  | 'soonest'
  | 'rating'
  | 'popular'
  | 'price'
  | 'newest';

export const sortOptions: { id: SortId; label: string }[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'nearest', label: 'Nearest' },
  { id: 'soonest', label: 'Soonest available' },
  { id: 'rating', label: 'Highest rated' },
  { id: 'popular', label: 'Most popular' },
  { id: 'price', label: 'Lowest price' },
  { id: 'newest', label: 'Newest' },
];
