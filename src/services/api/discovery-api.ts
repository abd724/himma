/**
 * RI-2 — the raw PUBLIC discovery wire (docs/34 §1 matrix authorities).
 *
 * Thin typed fetchers over the certified customer-public backend routes:
 * taxonomy, search, listing detail, storefront, storefront listings, and
 * the D-RI-4 public availability projection. Everything here is guest-
 * readable (`auth: false` — no bearer is ever attached to public reads).
 * DTOs mirror the certified response schemas exactly; domain mapping
 * lives in discovery-mapping.ts, never here.
 */
import type { HttpClient } from '@/services/http/http-client';

export interface TaxonomyRefDto {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
}

export interface CategoryDto {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  imageRef: string | null;
}

export interface ActivityTypeDto {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  categoryId: string;
}

export interface AreaDto {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  city: string | null;
}

export interface CollectionDto {
  id: string;
  titleEn: string;
  titleAr: string | null;
  subtitleEn: string | null;
  subtitleAr: string | null;
  imageRef: string | null;
  audience: string;
  childFocused: boolean;
  featured: boolean;
  seasonalLabel: string | null;
}

export type FromPriceDto =
  | { kind: 'free' }
  | { kind: 'from'; amountFils: number; currency: 'AED' }
  | null;

export interface MediaDto {
  mediaRef: string;
  altTextEn: string | null;
  altTextAr: string | null;
}

export interface ListingSummaryDto {
  id: string;
  titleEn: string;
  titleAr: string | null;
  setting: string;
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean;
  genderEligibility: string;
  skillLevel: string | null;
  category: TaxonomyRefDto;
  activityType: TaxonomyRefDto;
  media: MediaDto[];
  fromPrice: FromPriceDto;
  offerBadges: string[];
  areaLabels: string[];
}

export interface SearchResultDto extends ListingSummaryDto {
  provider: { id: string; displayName: string };
}

export interface ListingBranchDto {
  id: string;
  label: string;
  addressLine: string | null;
  areaLabel: string;
  geoPoint: { longitude: number; latitude: number } | null;
  openingHours: unknown;
  facilities: string[];
}

export interface PriceOptionDto {
  id: string;
  kind: string;
  amountFils: number | null;
  currency: string;
  sessionsCount: number | null;
  labelEn: string | null;
  labelAr: string | null;
}

export interface OfferDto {
  id: string;
  kind: string;
  labelEn: string;
  labelAr: string | null;
  trialAmountFils: number | null;
  currency: string;
}

export interface ListingDetailDto {
  id: string;
  titleEn: string;
  titleAr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  setting: string;
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean;
  genderEligibility: string;
  skillLevel: string | null;
  eligibilityNotes: string | null;
  category: TaxonomyRefDto;
  activityType: TaxonomyRefDto;
  provider: { id: string; displayName: string };
  branches: ListingBranchDto[];
  media: MediaDto[];
  priceOptions: PriceOptionDto[];
  offers: OfferDto[];
  fromPrice: FromPriceDto;
}

export interface StorefrontDto {
  provider: {
    id: string;
    displayName: string;
    descriptionEn: string | null;
    descriptionAr: string | null;
    verified: boolean;
    logoMediaRef: string | null;
    coverMediaRef: string | null;
    galleryMediaRefs: string[];
    publicPhone: string | null;
    publicEmail: string | null;
    publicWebsite: string | null;
    publicInstagram: string | null;
    branches: ListingBranchDto[];
  };
}

export type UnitKind = 'session' | 'campWeek' | 'enrolmentCohort';

export interface AvailabilityUnitDto {
  unitId: string;
  kind: UnitKind;
  branchId: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  /** RI-6 — venue timezone (IANA) for truthful civil presentation. */
  timezone: string;
  registrationCutoffAt: string;
  availability: 'available' | 'fewLeft' | 'full' | 'closed';
  spotsLeft?: number;
}

/** The closed server search vocabulary (docs/28 §11) — exactly what the
 *  certified `GET /search` accepts; anything else is refused, not faked. */
export interface SearchParams {
  q?: string;
  sort?: 'recommended' | 'price' | 'newest';
  ladiesOnly?: boolean;
  audience?: 'adults' | 'children';
  ageMin?: number;
  ageMax?: number;
  areaId?: string;
  categoryId?: string;
  activityTypeId?: string;
  formats?: ('dropIn' | 'monthly' | 'term' | 'package' | 'camp')[];
  setting?: 'indoor' | 'outdoor';
  priceBand?: 'under-100' | '100-500' | 'over-500';
  free?: boolean;
  trial?: boolean;
  skillLevel?: 'beginner' | 'intermediate' | 'advanced';
  collectionId?: string;
  limit?: number;
  cursor?: string;
}

function searchQueryString(params: SearchParams): string {
  const query = new URLSearchParams();
  const set = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) query.set(key, String(value));
  };
  set('q', params.q);
  set('sort', params.sort);
  set('ladiesOnly', params.ladiesOnly);
  set('audience', params.audience);
  set('ageMin', params.ageMin);
  set('ageMax', params.ageMax);
  set('areaId', params.areaId);
  set('categoryId', params.categoryId);
  set('activityTypeId', params.activityTypeId);
  if (params.formats !== undefined && params.formats.length > 0) {
    query.set('formats', params.formats.join(','));
  }
  set('setting', params.setting);
  set('priceBand', params.priceBand);
  set('free', params.free);
  set('trial', params.trial);
  set('skillLevel', params.skillLevel);
  set('collectionId', params.collectionId);
  set('limit', params.limit);
  set('cursor', params.cursor);
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export interface DiscoveryApi {
  getCategories(): Promise<CategoryDto[]>;
  getActivityTypes(): Promise<ActivityTypeDto[]>;
  getAreas(): Promise<AreaDto[]>;
  getCollections(): Promise<CollectionDto[]>;
  search(params: SearchParams): Promise<{ results: SearchResultDto[]; nextCursor: string | null }>;
  getListing(programId: string): Promise<ListingDetailDto | undefined>;
  getStorefront(organizationId: string): Promise<StorefrontDto['provider'] | undefined>;
  getStorefrontListings(
    organizationId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<
    | {
        provider: { id: string; displayName: string };
        listings: ListingSummaryDto[];
        nextCursor: string | null;
      }
    | undefined
  >;
  getAvailability(programId: string, kind: UnitKind): Promise<AvailabilityUnitDto[] | undefined>;
}

/** 404 → undefined (the screens own recovery states); everything else throws. */
async function orUndefined<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'status' in error && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export function createDiscoveryApi(client: HttpClient): DiscoveryApi {
  return {
    async getCategories() {
      const body = await client.request<{ categories: CategoryDto[] }>(
        'GET',
        '/catalogue/categories',
        { auth: false },
      );
      return body.categories;
    },
    async getActivityTypes() {
      const body = await client.request<{ activityTypes: ActivityTypeDto[] }>(
        'GET',
        '/catalogue/activity-types',
        { auth: false },
      );
      return body.activityTypes;
    },
    async getAreas() {
      const body = await client.request<{ areas: AreaDto[] }>('GET', '/catalogue/areas', {
        auth: false,
      });
      return body.areas;
    },
    async getCollections() {
      const body = await client.request<{ collections: CollectionDto[] }>(
        'GET',
        '/catalogue/collections',
        { auth: false },
      );
      return body.collections;
    },
    async search(params) {
      return client.request('GET', `/search${searchQueryString(params)}`, { auth: false });
    },
    async getListing(programId) {
      const body = await orUndefined(
        client.request<{ listing: ListingDetailDto }>('GET', `/listings/${programId}`, {
          auth: false,
        }),
      );
      return body?.listing;
    },
    async getStorefront(organizationId) {
      const body = await orUndefined(
        client.request<StorefrontDto>('GET', `/providers/${organizationId}`, { auth: false }),
      );
      return body?.provider;
    },
    async getStorefrontListings(organizationId, options = {}) {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      if (options.cursor !== undefined) query.set('cursor', options.cursor);
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      return orUndefined(
        client.request('GET', `/providers/${organizationId}/listings${suffix}`, { auth: false }),
      );
    },
    async getAvailability(programId, kind) {
      const body = await orUndefined(
        client.request<{ units: AvailabilityUnitDto[] }>(
          'GET',
          `/listings/${programId}/availability?kind=${kind}`,
          { auth: false },
        ),
      );
      return body?.units;
    },
  };
}
