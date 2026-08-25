/**
 * RI-2 — REAL implementations of the public discovery contracts over the
 * certified backend (docs/34 §1 matrix): catalogue, search, details,
 * discover feed, home feed, map.
 *
 * Truth rules:
 * - Only server-supported dimensions are queried; nothing is simulated
 *   client-side over partial pages. Unsupported mock dimensions (when/
 *   after-school/near-me/popularity/rating) have NO code path here — their
 *   controls are gone from the screens.
 * - Counts/totals appear ONLY when exact (the last page was reached);
 *   otherwise they stay absent and surfaces hide them.
 * - The app-level "reference area" context ranks nothing here: proximity
 *   ranking has no backend authority. Only the explicit area FILTER
 *   narrows, server-side.
 * - A child browsing context becomes a server-side age filter over public
 *   programme metadata (guest-grade filtering); booking eligibility stays
 *   with the authoritative backend seam (RI-3).
 * - IDs are canonical backend UUIDs end-to-end; unknown/unpublished ids
 *   resolve to undefined and screens show their recovery states.
 */
import type { DiscoveryApi, SearchParams, SearchResultDto } from '@/services/api/discovery-api';
import {
  detailIsCamp,
  presentationImageKey,
  providerFromResults,
  searchResultToProgram,
  toDetailProgram,
  toProgram,
  toProviderBranch,
  toSessionOccurrences,
  unitKindsForOptions,
} from '@/services/api/discovery-mapping';
import type { Taxonomy, TaxonomyCache } from '@/services/api/taxonomy-cache';
import type {
  ActivityTypePage,
  AllCategoriesListing,
  CatalogueService,
  CategoryPage,
} from '@/services/contracts/catalogue';
import type {
  DetailsService,
  ProgramDetailPage,
  ProviderStorefrontPage,
} from '@/services/contracts/details';
import type {
  DiscoverFeed,
  DiscoverFeedInput,
  DiscoverFeedService,
  DiscoverProgramSection,
} from '@/services/contracts/discover-feed';
import { emptyFilters } from '@/services/contracts/filters';
import type { FilterSelection, QuickFilter } from '@/services/contracts/filters';
import type {
  HomeFeed,
  HomeFeedBuildInput,
  HomeFeedService,
  HomeSection,
} from '@/services/contracts/home-feed';
import type { MapService, MapView } from '@/services/contracts/map';
import type {
  PreSearchContent,
  ResultsPage,
  ResultsQuery,
  SearchService,
  SearchSuggestion,
} from '@/services/contracts/search';
import { currentDateParts, householdSuitability, participantSuitability } from '@/utils/eligibility';
import { providerMonogram } from '@/utils/monogram';
import type { BrowseEntry, Participant, Program, Provider } from '@/types/domain';

const PAGE_SIZE = 20;
const RAIL_SIZE = 8;
const MAP_PROBE_SIZE = 50;

/** Child browsing context → truthful server age filter; adults never filtered. */
function participantAgeParams(participant: Participant | undefined): Pick<SearchParams, 'ageMin' | 'ageMax'> {
  if (participant?.kind !== 'child' || participant.dateOfBirth === undefined) return {};
  const [year, month, day] = participant.dateOfBirth.split('-').map(Number);
  const now = new Date();
  let age = now.getFullYear() - (year ?? 0);
  const hadBirthday =
    now.getMonth() + 1 > (month ?? 1) ||
    (now.getMonth() + 1 === (month ?? 1) && now.getDate() >= (day ?? 1));
  if (!hadBirthday) age -= 1;
  if (age < 0) return {};
  return { ageMin: age, ageMax: age };
}

/** FilterSelection → the closed server vocabulary. Only supported
 *  dimensions translate; the rest never reach the wire. */
function toSearchParams(
  filters: FilterSelection,
  participant: Participant | undefined,
): SearchParams {
  const params: SearchParams = {
    ...(filters.ladiesOnly ? { ladiesOnly: true } : {}),
    ...(filters.audience !== undefined ? { audience: filters.audience } : {}),
    ...(filters.ageBand !== undefined
      ? {
          ageMin: filters.ageBand.min,
          ...(filters.ageBand.max !== null ? { ageMax: filters.ageBand.max } : {}),
        }
      : participantAgeParams(participant)),
    ...(filters.areaId !== undefined ? { areaId: filters.areaId } : {}),
    ...(filters.categoryId !== undefined ? { categoryId: filters.categoryId } : {}),
    ...(filters.activityTypeId !== undefined ? { activityTypeId: filters.activityTypeId } : {}),
    ...(filters.formats.length > 0 ? { formats: filters.formats } : {}),
    ...(filters.collectionId !== undefined ? { collectionId: filters.collectionId } : {}),
    ...(filters.setting !== undefined ? { setting: filters.setting } : {}),
    ...(filters.priceBand !== undefined ? { priceBand: filters.priceBand } : {}),
    ...(filters.free ? { free: true } : {}),
    ...(filters.trial ? { trial: true } : {}),
    ...(filters.skillLevel !== undefined ? { skillLevel: filters.skillLevel } : {}),
  };
  return params;
}

function distinctProviders(rows: SearchResultDto[]): Provider[] {
  const byProvider = new Map<string, { identity: { id: string; displayName: string }; rows: SearchResultDto[] }>();
  for (const row of rows) {
    const entry = byProvider.get(row.provider.id) ?? { identity: row.provider, rows: [] };
    entry.rows.push(row);
    byProvider.set(row.provider.id, entry);
  }
  return [...byProvider.values()].map((entry) => providerFromResults(entry.identity, entry.rows));
}

function distinctCategories(rows: SearchResultDto[], taxonomy: Taxonomy) {
  const ids = [...new Set(rows.map((row) => row.category.id))];
  return ids
    .map((id) => taxonomy.categoryById.get(id))
    .filter((category): category is NonNullable<typeof category> => category !== undefined);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface CachedResultSet {
  rows: SearchResultDto[];
  /** Cursor for the NEXT page; null = complete. */
  nextCursor: string | null;
  pagesLoaded: number;
}

export function createRealSearchService(
  api: DiscoveryApi,
  taxonomy: TaxonomyCache,
): SearchService {
  const recents: string[] = [];
  // Accumulated pages per (query+filters+sort) key so "Load more" appends
  // via the server cursor. Availability never lives here.
  const resultCache = new Map<string, CachedResultSet>();

  function cacheKey(query: ResultsQuery): string {
    return JSON.stringify([
      query.query.trim().toLowerCase(),
      query.sort,
      toSearchParams(query.filters, query.participant),
    ]);
  }

  return {
    async getPreSearchContent(): Promise<PreSearchContent> {
      const { categories } = await taxonomy.get();
      const categoryShortcuts: BrowseEntry[] = categories.slice(0, 8).map((category) => ({
        id: `category-${category.id}`,
        label: category.label,
        imageKey: category.imageKey,
        target: { kind: 'category', categoryId: category.id },
      }));
      return {
        recentSearches: [...recents],
        // Popularity has no backend authority — the section hides.
        popularSearches: [],
        categoryShortcuts,
      };
    },

    addRecentSearch(query: string): void {
      const normalized = query.trim();
      if (normalized === '') return;
      const existing = recents.indexOf(normalized);
      if (existing !== -1) recents.splice(existing, 1);
      recents.unshift(normalized);
      recents.splice(6);
    },

    clearRecentSearches(): void {
      recents.splice(0);
    },

    async getSuggestions(input): Promise<SearchSuggestion[]> {
      const needle = input.query.trim().toLowerCase();
      if (needle.length < 2) return [];
      const { categories, activityTypes, categoryById } = await taxonomy.get();
      const suggestions: SearchSuggestion[] = [];
      for (const category of categories) {
        if (category.label.toLowerCase().includes(needle)) {
          suggestions.push({
            id: `category-${category.id}`,
            kind: 'category',
            label: category.label,
            query: category.label,
            targetId: category.id,
          });
        }
      }
      for (const type of activityTypes) {
        if (type.label.toLowerCase().includes(needle)) {
          const category = categoryById.get(type.categoryId);
          suggestions.push({
            id: `activity-${type.id}`,
            kind: 'activity',
            label: type.label,
            ...(category !== undefined ? { sublabel: category.label } : {}),
            query: type.label,
            targetId: type.id,
          });
        }
      }
      return suggestions.slice(0, 8);
    },

    async getResults(query: ResultsQuery): Promise<ResultsPage> {
      const key = cacheKey(query);
      const targetPages = Math.max(1, query.page);
      let cached = resultCache.get(key);
      if (cached === undefined) {
        const first = await api.search({
          ...(query.query.trim() !== '' ? { q: query.query.trim() } : {}),
          sort: query.sort === 'price' || query.sort === 'newest' ? query.sort : 'recommended',
          ...toSearchParams(query.filters, query.participant),
          limit: PAGE_SIZE,
        });
        cached = { rows: first.results, nextCursor: first.nextCursor, pagesLoaded: 1 };
        resultCache.set(key, cached);
      }
      while (cached.pagesLoaded < targetPages && cached.nextCursor !== null) {
        const next = await api.search({
          ...(query.query.trim() !== '' ? { q: query.query.trim() } : {}),
          sort: query.sort === 'price' || query.sort === 'newest' ? query.sort : 'recommended',
          ...toSearchParams(query.filters, query.participant),
          limit: PAGE_SIZE,
          cursor: cached.nextCursor,
        });
        cached.rows = [...cached.rows, ...next.results];
        cached.nextCursor = next.nextCursor;
        cached.pagesLoaded += 1;
      }
      const complete = cached.nextCursor === null;
      const categories = distinctCategories(cached.rows, await taxonomy.get());
      const providers = distinctProviders(cached.rows);
      return {
        programs: cached.rows.map(searchResultToProgram),
        hasMorePrograms: !complete,
        providers,
        hasMoreProviders: !complete,
        categories,
        ...(complete
          ? { totalPrograms: cached.rows.length, totalProviders: providers.length }
          : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export function createRealCatalogueService(
  api: DiscoveryApi,
  taxonomy: TaxonomyCache,
): CatalogueService {
  return {
    async getAllCategories(): Promise<AllCategoriesListing> {
      const { categories, collections } = await taxonomy.get();
      return {
        // Canonical taxonomy order — no catalogue-wide counts exist, so
        // supply-ordering (a mock behavior) is not simulated.
        categories: categories.map((category) => ({ category })),
        lenses: collections.map((collection) => ({
          collectionId: collection.id,
          label: collection.title,
          imageKey: collection.imageKey,
        })),
      };
    },

    async getCategoryPage(input): Promise<CategoryPage | undefined> {
      const { categoryById, activityTypes } = await taxonomy.get();
      const category = categoryById.get(input.categoryId);
      if (category === undefined) return undefined;
      const base = toSearchParams(
        { ...emptyFilters, categoryId: input.categoryId },
        input.participant,
      );
      const [main, offers] = await Promise.all([
        api.search({ ...base, limit: MAP_PROBE_SIZE }),
        api.search({ ...base, trial: true, limit: RAIL_SIZE }),
      ]);
      const complete = main.nextCursor === null;
      const typeIdsWithSupply = new Set(main.results.map((row) => row.activityType.id));
      return {
        category,
        // Chips: types with visible supply first (counts only when exact).
        activityTypes: activityTypes
          .filter((type) => type.categoryId === input.categoryId)
          .filter((type) => !complete || typeIdsWithSupply.has(type.id))
          .map((type) => ({
            activityType: type,
            ...(complete
              ? {
                  programCount: main.results.filter((row) => row.activityType.id === type.id)
                    .length,
                }
              : {}),
          })),
        popularPrograms: main.results.slice(0, RAIL_SIZE).map(searchResultToProgram),
        providers: distinctProviders(main.results),
        offerPrograms: offers.results.map(searchResultToProgram),
        ...(complete ? { visibleProgramCount: main.results.length } : {}),
      };
    },

    async getActivityTypePage(input): Promise<ActivityTypePage | undefined> {
      const { activityTypeById, categoryById } = await taxonomy.get();
      const activityType = activityTypeById.get(input.activityTypeId);
      const category = activityType === undefined ? undefined : categoryById.get(activityType.categoryId);
      if (activityType === undefined || category === undefined) return undefined;
      const results = await api.search({
        ...toSearchParams({ ...emptyFilters, activityTypeId: input.activityTypeId }, input.participant),
        limit: MAP_PROBE_SIZE,
      });
      return {
        activityType,
        category,
        programs: results.results.map(searchResultToProgram),
        providers: distinctProviders(results.results),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export function createRealDetailsService(api: DiscoveryApi): DetailsService {
  return {
    async getProgramDetailPage(input): Promise<ProgramDetailPage | undefined> {
      const listing = await api.getListing(input.programId);
      if (listing === undefined) return undefined;
      const program = toDetailProgram(listing);
      // The public storefront read supplies the provider's real public
      // identity (verified flag) for the provider strip.
      const storefront = await api.getStorefront(listing.provider.id);
      const provider: Provider = {
        id: listing.provider.id,
        name: listing.provider.displayName,
        categories: [listing.category.labelEn],
        verified: storefront?.verified ?? false,
      };
      const branchLabelById = new Map(listing.branches.map((branch) => [branch.id, branch.label]));
      const kinds = unitKindsForOptions(listing.priceOptions);
      const availability = (
        await Promise.all(kinds.map((kind) => api.getAvailability(input.programId, kind)))
      ).flatMap((units) => units ?? []);
      const sessions = toSessionOccurrences(availability, branchLabelById);

      // REAL participants: ages compute on the real calendar date.
      const today = currentDateParts();
      const participant = input.participants.find((p) => p.id === input.participantId);
      const suitability =
        participant === undefined || participant.kind === 'everyone'
          ? undefined
          : participantSuitability(program.eligibility, participant, today);
      const firstBranch = listing.branches[0];

      // More from this provider — real storefront listings, excluding this one.
      const storefrontListings = await api.getStorefrontListings(listing.provider.id, { limit: 5 });
      const moreFromProvider = (storefrontListings?.listings ?? [])
        .filter((row) => row.id !== listing.id)
        .slice(0, 4)
        .map((row) => toProgram(row, listing.provider));

      return {
        program,
        provider,
        extras: {
          description: listing.descriptionEn ?? '',
          ...(firstBranch !== undefined && firstBranch.facilities.length > 0
            ? { facilities: firstBranch.facilities }
            : {}),
        },
        ageLabel: ageLabelFor(listing),
        formatLabel: formatLabelFor(listing),
        priceLabel: priceLabelFor(program),
        sessions,
        ...(firstBranch !== undefined ? { branch: toProviderBranch(firstBranch) } : {}),
        ...(suitability !== undefined ? { suitability } : {}),
        householdSuitability: householdSuitability(program.eligibility, input.participants, today),
        areaLabel: program.areaLabel ?? '',
        moreFromProvider,
      };
    },

    async getProviderStorefrontPage(input): Promise<ProviderStorefrontPage | undefined> {
      const provider = await api.getStorefront(input.providerId);
      if (provider === undefined) return undefined;

      // The complete published listing set (paged to exhaustion, bounded).
      const listings: SearchResultDto[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const batch = await api.getStorefrontListings(input.providerId, {
          limit: 50,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (batch === undefined) break;
        listings.push(
          ...batch.listings.map((row) => ({
            ...row,
            provider: { id: provider.id, displayName: provider.displayName },
          })),
        );
        if (batch.nextCursor === null) break;
        cursor = batch.nextCursor;
      }

      const programs = listings.map((row) => searchResultToProgram(row));
      const participant = input.participants.find((p) => p.id === input.participantId);
      const isChildContext = participant?.kind === 'child';
      const childAgeYears = (() => {
        if (!isChildContext || participant?.dateOfBirth === undefined) return undefined;
        const [year, month, day] = participant.dateOfBirth.split('-').map(Number);
        const now = new Date();
        let age = now.getFullYear() - (year ?? 0);
        if (
          now.getMonth() + 1 < (month ?? 1) ||
          (now.getMonth() + 1 === (month ?? 1) && now.getDate() < (day ?? 1))
        ) {
          age -= 1;
        }
        return age;
      })();

      const eligible: Program[] = [];
      const ineligible: Program[] = [];
      for (const program of programs) {
        if (childAgeYears !== undefined) {
          const { allAges, minimumAge, maximumAge } = program.eligibility;
          const fits =
            allAges ||
            ((minimumAge === undefined || childAgeYears >= minimumAge) &&
              (maximumAge === undefined || maximumAge === null || childAgeYears <= maximumAge));
          (fits ? eligible : ineligible).push(program);
        } else {
          eligible.push(program);
        }
      }

      const taxonomyOrder = new Map(listings.map((row) => [row.category.id, row.category]));
      const groups = [...taxonomyOrder.values()].map((categoryRef) => ({
        category: {
          id: categoryRef.id,
          slug: categoryRef.slug,
          label: categoryRef.labelEn,
          imageKey: presentationImageKey(categoryRef.slug, categoryRef.id),
        },
        programs: eligible.filter((program) => program.categoryId === categoryRef.id),
      }));

      const branches = provider.branches.map(toProviderBranch);
      const selectedBranch =
        branches.find((branch) => branch.id === input.branchId) ?? branches[0] ?? {
          id: 'primary',
          label: provider.displayName,
          addressLine: '',
        };

      const activityTypeRefs = new Map(listings.map((row) => [row.activityType.id, row.activityType]));
      const eligibleParticipants = input.participants
        .filter((p) => p.kind !== 'everyone')
        .filter((p) => {
          if (p.kind !== 'child') return true;
          return programs.some((program) => {
            const { allAges, minimumAge, maximumAge } = program.eligibility;
            if (p.dateOfBirth === undefined) return allAges;
            const [year] = p.dateOfBirth.split('-').map(Number);
            const age = new Date().getFullYear() - (year ?? 0);
            return (
              allAges ||
              ((minimumAge === undefined || age >= minimumAge) &&
                (maximumAge === undefined || maximumAge === null || age <= maximumAge))
            );
          });
        })
        .map((p) => ({ participantId: p.id, label: p.label }));

      return {
        provider: {
          id: provider.id,
          name: provider.displayName,
          categories: [...taxonomyOrder.values()].map((ref) => ref.labelEn),
          verified: provider.verified,
          ...(branches[0]?.areaLabel !== undefined ? { areaLabel: branches[0].areaLabel } : {}),
        },
        extras: {
          description: provider.descriptionEn ?? '',
          ...(() => {
            const branchDto = provider.branches.find((b) => b.id === selectedBranch.id);
            return branchDto !== undefined && branchDto.facilities.length > 0
              ? { facilities: branchDto.facilities }
              : {};
          })(),
        },
        monogram: providerMonogram(provider.displayName),
        categories: groups.map((group) => group.category),
        activityTypes: [...activityTypeRefs.values()].map((ref) => ({
          id: ref.id,
          label: ref.labelEn,
          categoryId: '',
        })),
        branches,
        selectedBranch,
        programGroups: groups.filter((group) => group.programs.length > 0),
        ineligiblePrograms: ineligible,
        offerPrograms: eligible.filter((program) => program.offer !== undefined),
        programCount: programs.length,
        eligibleProgramCount: eligible.length,
        eligibleParticipants,
        areaLabel: selectedBranch.areaLabel ?? '',
      };
    },
  };
}

function ageLabelFor(listing: { minAge: number | null; maxAge: number | null; allAges: boolean }): string {
  if (listing.allAges) return 'All ages';
  if (listing.minAge !== null && listing.maxAge !== null) return `Ages ${listing.minAge}–${listing.maxAge}`;
  if (listing.minAge !== null) return `Ages ${listing.minAge}+`;
  if (listing.maxAge !== null) return `Up to age ${listing.maxAge}`;
  return 'All ages';
}

function formatLabelFor(listing: { priceOptions: { kind: string }[] }): string {
  if (detailIsCamp({ priceOptions: listing.priceOptions } as never)) return 'Camp';
  const kinds = new Set(listing.priceOptions.map((option) => option.kind));
  if (kinds.has('dropIn')) return 'Drop-in';
  if (kinds.has('monthly')) return 'Monthly program';
  if (kinds.has('term')) return 'Term program';
  if (kinds.has('package')) return 'Session package';
  if (kinds.has('free')) return 'Free session';
  return 'Activity';
}

function priceLabelFor(program: Program): string {
  if (program.price === undefined) return '';
  switch (program.price.kind) {
    case 'dropIn':
      return `AED ${program.price.amount.toLocaleString('en-US')} per session`;
    case 'monthly':
      return `AED ${program.price.amount.toLocaleString('en-US')}/month`;
    case 'term':
      return `AED ${program.price.amount.toLocaleString('en-US')} per term`;
    case 'camp':
      return `AED ${program.price.amountPerWeek.toLocaleString('en-US')}/week`;
    case 'package':
      return `AED ${program.price.amount.toLocaleString('en-US')} for ${program.price.sessions} sessions`;
    case 'free':
      return 'Free';
    case 'freeTrial':
      return 'Free trial';
    case 'from':
      return `From AED ${program.price.amount.toLocaleString('en-US')}`;
  }
}

// ---------------------------------------------------------------------------
// Discover feed
// ---------------------------------------------------------------------------

const QUICK_FILTERS: QuickFilter[] = [
  {
    id: 'ladies-only',
    label: 'Ladies only',
    activeDescription: 'Showing ladies-only activities',
  },
  { id: 'camps', label: 'Camps', activeDescription: 'Showing camps' },
  {
    id: 'offers',
    label: 'Trial offers',
    activeDescription: 'Showing activities with trial offers',
  },
];

export function createRealDiscoverFeedService(
  api: DiscoveryApi,
  taxonomy: TaxonomyCache,
): DiscoverFeedService {
  return {
    getQuickFilters(): QuickFilter[] {
      // Exactly the chips the server vocabulary supports (ladies-only,
      // camp format, trial offers). Today/weekend/near-me have no
      // schedule/proximity authority and are not offered.
      return QUICK_FILTERS;
    },

    async getDiscoverFeed(input: DiscoverFeedInput): Promise<DiscoverFeed> {
      const { categories, collections } = await taxonomy.get();
      const quick: SearchParams =
        input.quickFilterId === 'ladies-only'
          ? { ladiesOnly: true }
          : input.quickFilterId === 'camps'
            ? { formats: ['camp'] }
            : input.quickFilterId === 'offers'
              ? { trial: true }
              : {};
      const participant =
        input.childParticipants?.find((p) => p.id === input.participantId) ?? undefined;
      const age = participantAgeParams(participant);

      const [newest, trials] = await Promise.all([
        api.search({ sort: 'newest', limit: RAIL_SIZE, ...quick, ...age }),
        input.quickFilterId === 'offers'
          ? Promise.resolve(undefined)
          : api.search({ trial: true, limit: RAIL_SIZE, ...quick, ...age }),
      ]);

      const sections: DiscoverProgramSection[] = [];
      if (newest.results.length > 0) {
        sections.push({
          id: 'new',
          title: 'New on Himma',
          programs: newest.results.map(searchResultToProgram),
        });
      }
      if (trials !== undefined && trials.results.length > 0) {
        sections.push({
          id: 'offers-trials',
          title: 'Offers & free trials',
          programs: trials.results.map(searchResultToProgram),
        });
      }

      const browseEntries: BrowseEntry[] = categories.slice(0, 8).map((category) => ({
        id: `category-${category.id}`,
        label: category.label,
        imageKey: category.imageKey,
        target: { kind: 'category', categoryId: category.id },
      }));

      // Editorial rail: featured collections only, audience/child-gated
      // (docs/18 §6) — counts are not fabricated.
      const hasEligibleChild = (input.childParticipants ?? []).length > 0;
      const rail = collections
        .filter((collection) => collection.featuredOnDiscover)
        .filter((collection) => !collection.childFocused || hasEligibleChild)
        .map((collection) => ({ collection }));

      const sectionRows = sections.flatMap((section) => section.programs);
      const providerIds = new Set<string>();
      const providers: Provider[] = [];
      for (const result of [...newest.results, ...(trials?.results ?? [])]) {
        if (providerIds.has(result.provider.id)) continue;
        providerIds.add(result.provider.id);
        providers.push(providerFromResults(result.provider, [result]));
      }

      return {
        browseEntries,
        collections: rail,
        programSections: sections,
        providers,
        isEmpty: sectionRows.length === 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Home feed
// ---------------------------------------------------------------------------

export function createRealHomeFeedService(
  api: DiscoveryApi,
  taxonomy: TaxonomyCache,
): HomeFeedService {
  return {
    async getAreas() {
      return (await taxonomy.get()).areas;
    },

    async getHomeFeed(input: HomeFeedBuildInput): Promise<HomeFeed> {
      const sections: HomeSection[] = [];
      const isGuest = input.account === null;

      if (isGuest) {
        sections.push({
          kind: 'welcome',
          content: {
            eyebrow: 'Activities in Abu Dhabi',
            title: 'Find your next activity',
            subtitle: 'Classes, courts, pools and camps — for you and the family.',
            actionLabel: 'Browse indoor picks',
            imageKey: 'poolLanes',
            actionFilters: { ...emptyFilters, setting: 'indoor' },
          },
        });
      }

      // Real schedule surfaces (upcoming/week/plans) render only from real
      // account truth — empty until RI-3/RI-5 wire bookings/passes.
      if (input.scheduleEntries.length > 0) {
        const first = input.scheduleEntries[0]!;
        sections.push({ kind: 'upcoming', entry: first });
      }
      if (input.activePlans.length > 0) {
        sections.push({ kind: 'plans', plans: input.activePlans });
      }

      const [newest, trials] = await Promise.all([
        api.search({ sort: 'newest', limit: RAIL_SIZE }),
        api.search({ trial: true, limit: RAIL_SIZE }),
      ]);
      if (newest.results.length > 0) {
        sections.push({
          kind: 'programs',
          id: 'new',
          title: 'New on Himma',
          programs: newest.results.map(searchResultToProgram),
        });
      }
      if (trials.results.length > 0) {
        sections.push({
          kind: 'programs',
          id: 'trials',
          title: 'Offers & free trials',
          programs: trials.results.map(searchResultToProgram),
        });
      }

      if (isGuest) {
        sections.push({
          kind: 'action',
          id: 'setup',
          title: 'Make Himma yours',
          body: 'Create an account to book activities for you and your family.',
        });
      }

      return { sections };
    },
  };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export function createRealMapService(api: DiscoveryApi, taxonomy: TaxonomyCache): MapService {
  return {
    async getMapView(query): Promise<MapView> {
      const { areas } = await taxonomy.get();
      const params: SearchParams = {
        ...(query.query.trim() !== '' ? { q: query.query.trim() } : {}),
        ...toSearchParams(query.filters, query.participant),
      };
      const perArea = await Promise.all(
        areas.map(async (area) => {
          const outcome = await api.search({
            ...params,
            areaId: area.id,
            limit: MAP_PROBE_SIZE,
          });
          const complete = outcome.nextCursor === null;
          const providerRows = distinctProviders(outcome.results);
          return {
            area,
            // Counts only when EXACT — the screen states missing counts
            // honestly rather than guessing (docs/16 §2).
            ...(complete
              ? { programCount: outcome.results.length, providerCount: providerRows.length }
              : {}),
            pins: providerRows.slice(0, 4).map((provider) => ({
              providerId: provider.id,
              initials: providerMonogram(provider.name),
              providerName: provider.name,
            })),
          };
        }),
      );
      const allExact = perArea.every((entry) => entry.programCount !== undefined);
      const total = perArea.reduce((sum, entry) => sum + (entry.programCount ?? 0), 0);
      return {
        areas: perArea,
        ...(allExact ? { totalPrograms: total } : {}),
        hasAnyResults: perArea.some(
          (entry) => entry.pins.length > 0 || (entry.programCount ?? 0) > 0,
        ),
      };
    },
  };
}
