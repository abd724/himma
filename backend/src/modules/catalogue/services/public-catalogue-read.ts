/**
 * Customer-public catalogue read models (docs/28 §5/§6/§10/§14/§16.1/§19) —
 * Slice 4 public reads.
 *
 * STRUCTURAL public/private separation, exactly the S3-4 storefront
 * discipline: every query selects ONLY the explicitly enumerated columns
 * below — `organization` contributes nothing but the id and its liveness
 * state, `organization_public_profile` contributes the display name and the
 * `published` predicate, and `program` contributes its customer-facing
 * catalogue fields with `listing_state` used strictly as a predicate. There
 * is no `select *` anywhere, so a future private column cannot leak by
 * existing (the catalogue-public suite locks this structurally).
 *
 * Visibility is the docs/28 §6 compound predicate evaluated against LIVE
 * database state on every request (no denormalized projection exists yet):
 *   program.listing_state = 'published'
 *   AND organization.verification_state = 'live'
 *   AND organization_public_profile.published = true
 *   AND ≥ 1 ACTIVE program_branch association to an ACTIVE branch.
 * Everything else — draft, submitted, in_review, approved-but-unpublished
 * (D-S4-2), changes_requested, paused, archived, suspended/non-live
 * providers, unpublished storefronts, or nonexistent ids — is the SAME
 * not-found; no oracle reveals which condition failed, and a provider
 * suspension or storefront unpublish bites on the very next request.
 *
 * Price is the D-S4-1 option model: there is NO Program.price anywhere.
 * The §14 derived-field boundary is implemented exactly — a from-price is
 * derived at read time over the listing's ACTIVE options (a free option
 * derives `Free`), option summaries carry stable ids for the future booking
 * draft, and nothing derived is ever stored.
 */
import type { Db } from '../../../db/kysely';
import { withTransaction, type Trx } from '../../../db/transaction';

/**
 * The complete, closed list of columns the public catalogue projections may
 * touch. Predicate-only columns (`listing_state`, `verification_state`,
 * `published`, `active`, `state`, effective windows, `sort_hint` ordering
 * inputs) are never serialized. The catalogue-public suite asserts these
 * sets against the live schema; widening them is an owner-visible diff
 * here, never a silent query change.
 */
export const PUBLIC_LISTING_SOURCES = {
  organization: ['id', 'verification_state'],
  organization_public_profile: ['organization_id', 'display_name', 'published'],
  program: [
    'id',
    'organization_id',
    'activity_type_id',
    'title_en',
    'title_ar',
    'description_en',
    'description_ar',
    'setting',
    'min_age',
    'max_age',
    'all_ages',
    'gender_eligibility',
    'skill_level',
    'eligibility_notes',
    'listing_state',
  ],
  activity_type: ['id', 'category_id', 'slug', 'label_en', 'label_ar', 'active'],
  category: ['id', 'slug', 'label_en', 'label_ar', 'image_ref', 'sort_hint', 'active'],
  program_branch: ['program_id', 'branch_id', 'active'],
  branch: [
    'id',
    'organization_id',
    'label',
    'address_line',
    'area_label',
    'geo_point',
    'opening_hours',
    'facilities',
    'active',
  ],
  program_price_option: [
    'id',
    'program_id',
    'kind',
    'amount_fils',
    'currency',
    'sessions_count',
    'label_en',
    'label_ar',
    'sort_hint',
    'state',
  ],
  program_media: ['program_id', 'media_ref', 'sort_hint', 'alt_text_en', 'alt_text_ar', 'active'],
  offer: [
    'id',
    'program_id',
    'kind',
    'label_en',
    'label_ar',
    'trial_amount_fils',
    'currency',
    'effective_start',
    'effective_end',
    'state',
  ],
  area: ['id', 'slug', 'label_en', 'label_ar', 'city', 'sort_hint', 'active'],
  collection: [
    'id',
    'title_en',
    'title_ar',
    'subtitle_en',
    'subtitle_ar',
    'image_ref',
    'audience',
    'child_focused',
    'featured',
    'seasonal_label',
    'state',
    'created_at',
  ],
} as const;

// -- public view shapes -------------------------------------------------------

export interface PublicTaxonomyRef {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
}

export interface PublicListingBranch {
  id: string;
  label: string;
  addressLine: string | null;
  areaLabel: string;
  geoPoint: { longitude: number; latitude: number } | null;
  openingHours: unknown;
  facilities: string[];
}

/** §14(c): stable-id option summaries — the future booking draft selects an
 *  option BY ID. sessions_count is catalogue description (docs/28 §9.6b). */
export interface PublicPriceOptionView {
  id: string;
  kind: string;
  amountFils: number | null;
  currency: string;
  sessionsCount: number | null;
  labelEn: string | null;
  labelAr: string | null;
}

export interface PublicOfferView {
  id: string;
  kind: string;
  labelEn: string;
  labelAr: string | null;
  trialAmountFils: number | null;
  currency: string;
}

export interface PublicMediaView {
  mediaRef: string;
  altTextEn: string | null;
  altTextAr: string | null;
}

/** §14(a): derived at read time over ACTIVE options, never stored. */
export type PublicFromPrice =
  | { kind: 'free' }
  | { kind: 'from'; amountFils: number; currency: 'AED' }
  | null;

export interface PublicListingDetail {
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
  category: PublicTaxonomyRef;
  activityType: PublicTaxonomyRef;
  /** Safe storefront navigation identity — the S3-4 `GET /providers/:id`
   *  contract is one hop away by construction. */
  provider: { id: string; displayName: string };
  branches: PublicListingBranch[];
  media: PublicMediaView[];
  priceOptions: PublicPriceOptionView[];
  offers: PublicOfferView[];
  fromPrice: PublicFromPrice;
}

export interface PublicListingSummary {
  id: string;
  titleEn: string;
  titleAr: string | null;
  setting: string;
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean;
  genderEligibility: string;
  skillLevel: string | null;
  category: PublicTaxonomyRef;
  activityType: PublicTaxonomyRef;
  media: PublicMediaView[];
  fromPrice: PublicFromPrice;
  /** Deduplicated kinds of currently applicable offers — badge data only. */
  offerBadges: string[];
}

export type ReadPublicListingResult =
  | { kind: 'listing'; listing: PublicListingDetail }
  | { kind: 'notFound' };

export type ListStorefrontListingsResult =
  | {
      kind: 'listings';
      provider: { id: string; displayName: string };
      listings: PublicListingSummary[];
      nextCursor: string | null;
    }
  | { kind: 'notFound' }
  | { kind: 'invalidCursor' };

// -- opaque cursor (docs/24 §11.4) --------------------------------------------

const CURSOR_PREFIX = 'plc1:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeListingCursor(programId: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${programId}`, 'utf8').toString('base64url');
}

/** Returns the anchor listing id, or undefined for any malformed cursor —
 *  opacity is part of the contract; clients never see or send raw ids. */
export function decodeListingCursor(cursor: string): string | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const anchor = decoded.slice(CURSOR_PREFIX.length);
  return UUID_PATTERN.test(anchor) ? anchor : undefined;
}

// -- shared query pieces ------------------------------------------------------

const LISTING_ROW_COLUMNS = [
  'program.id as id',
  'program.organization_id as organization_id',
  'program.title_en as title_en',
  'program.title_ar as title_ar',
  'program.description_en as description_en',
  'program.description_ar as description_ar',
  'program.setting as setting',
  'program.min_age as min_age',
  'program.max_age as max_age',
  'program.all_ages as all_ages',
  'program.gender_eligibility as gender_eligibility',
  'program.skill_level as skill_level',
  'program.eligibility_notes as eligibility_notes',
  'organization_public_profile.display_name as display_name',
  'activity_type.id as activity_type_id',
  'activity_type.slug as activity_type_slug',
  'activity_type.label_en as activity_type_label_en',
  'activity_type.label_ar as activity_type_label_ar',
  'category.id as category_id',
  'category.slug as category_slug',
  'category.label_en as category_label_en',
  'category.label_ar as category_label_ar',
] as const;

/**
 * THE single definition of customer-public listing visibility (docs/28 §6),
 * as a reusable id subquery over live authoritative state: published
 * listing AND live organization AND published storefront AND ≥ 1 active
 * association to an active branch. The detail/storefront reads AND the
 * search read-port all consume this one predicate — search documents are
 * never trusted for visibility (docs/28 §13c).
 */
export function visibleProgramIds(trx: Trx) {
  return trx
    .selectFrom('program')
    .innerJoin('organization', 'organization.id', 'program.organization_id')
    .innerJoin(
      'organization_public_profile',
      'organization_public_profile.organization_id',
      'program.organization_id',
    )
    .select('program.id')
    .where('program.listing_state', '=', 'published')
    .where('organization.verification_state', '=', 'live')
    .where('organization_public_profile.published', '=', true)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('program_branch')
          .innerJoin('branch', 'branch.id', 'program_branch.branch_id')
          .select('program_branch.program_id')
          .whereRef('program_branch.program_id', '=', 'program.id')
          .where('program_branch.active', '=', true)
          .where('branch.active', '=', true),
      ),
    );
}

/** Visible-listing base query: the §6 predicate (via visibleProgramIds)
 *  joined to the approved public column sources. Every column named here
 *  is in PUBLIC_LISTING_SOURCES. */
function visibleListingQuery(trx: Trx) {
  return trx
    .selectFrom('program')
    .innerJoin('organization', 'organization.id', 'program.organization_id')
    .innerJoin(
      'organization_public_profile',
      'organization_public_profile.organization_id',
      'program.organization_id',
    )
    .innerJoin('activity_type', 'activity_type.id', 'program.activity_type_id')
    .innerJoin('category', 'category.id', 'activity_type.category_id')
    .select(LISTING_ROW_COLUMNS)
    .where('program.id', 'in', visibleProgramIds(trx));
}

interface ListingRow {
  id: string;
  organization_id: string;
  title_en: string;
  title_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  setting: string;
  min_age: number | null;
  max_age: number | null;
  all_ages: boolean;
  gender_eligibility: string;
  skill_level: string | null;
  eligibility_notes: string | null;
  display_name: string;
  activity_type_id: string;
  activity_type_slug: string;
  activity_type_label_en: string;
  activity_type_label_ar: string | null;
  category_id: string;
  category_slug: string;
  category_label_en: string;
  category_label_ar: string | null;
}

interface OptionRow {
  id: string;
  program_id: string;
  kind: string;
  amount_fils: string | number | bigint | null;
  currency: string;
  sessions_count: number | null;
  label_en: string | null;
  label_ar: string | null;
}

async function activeOptionsFor(trx: Trx, programIds: string[]): Promise<OptionRow[]> {
  if (programIds.length === 0) return [];
  return trx
    .selectFrom('program_price_option')
    .select([
      'id',
      'program_id',
      'kind',
      'amount_fils',
      'currency',
      'sessions_count',
      'label_en',
      'label_ar',
    ])
    .where('program_id', 'in', programIds)
    .where('state', '=', 'active')
    .orderBy('sort_hint')
    .orderBy('id')
    .execute();
}

interface MediaRow {
  program_id: string;
  media_ref: string;
  alt_text_en: string | null;
  alt_text_ar: string | null;
}

async function activeMediaFor(trx: Trx, programIds: string[]): Promise<MediaRow[]> {
  if (programIds.length === 0) return [];
  return trx
    .selectFrom('program_media')
    .select(['program_id', 'media_ref', 'alt_text_en', 'alt_text_ar'])
    .where('program_id', 'in', programIds)
    .where('active', '=', true)
    .orderBy('sort_hint')
    .orderBy('id')
    .execute();
}

interface OfferRow {
  id: string;
  program_id: string;
  kind: string;
  label_en: string;
  label_ar: string | null;
  trial_amount_fils: string | number | bigint | null;
  currency: string;
}

/** Currently applicable informational offers: active AND inside their
 *  effective window (open bounds pass) — evaluated at request time. */
async function currentOffersFor(trx: Trx, programIds: string[]): Promise<OfferRow[]> {
  if (programIds.length === 0) return [];
  const now = new Date();
  return trx
    .selectFrom('offer')
    .select(['id', 'program_id', 'kind', 'label_en', 'label_ar', 'trial_amount_fils', 'currency'])
    .where('program_id', 'in', programIds)
    .where('state', '=', 'active')
    .where((eb) =>
      eb.or([eb('effective_start', 'is', null), eb('effective_start', '<=', now)]),
    )
    .where((eb) => eb.or([eb('effective_end', 'is', null), eb('effective_end', '>', now)]))
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

function toOptionView(row: OptionRow): PublicPriceOptionView {
  return {
    id: row.id,
    kind: row.kind,
    amountFils: row.amount_fils === null ? null : Number(row.amount_fils),
    currency: row.currency,
    sessionsCount: row.sessions_count,
    labelEn: row.label_en,
    labelAr: row.label_ar,
  };
}

function toOfferView(row: OfferRow): PublicOfferView {
  return {
    id: row.id,
    kind: row.kind,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    trialAmountFils: row.trial_amount_fils === null ? null : Number(row.trial_amount_fils),
    currency: row.currency,
  };
}

function toMediaView(row: MediaRow): PublicMediaView {
  return { mediaRef: row.media_ref, altTextEn: row.alt_text_en, altTextAr: row.alt_text_ar };
}

/** docs/28 §14(a): min amount over ACTIVE options; a free option derives
 *  `Free`; a listing with no active option derives nothing. */
export function deriveFromPrice(options: PublicPriceOptionView[]): PublicFromPrice {
  if (options.some((option) => option.kind === 'free')) return { kind: 'free' };
  const amounts = options
    .map((option) => option.amountFils)
    .filter((amount): amount is number => amount !== null);
  if (amounts.length === 0) return null;
  return { kind: 'from', amountFils: Math.min(...amounts), currency: 'AED' };
}

function toTaxonomyRefs(row: ListingRow): {
  category: PublicTaxonomyRef;
  activityType: PublicTaxonomyRef;
} {
  return {
    category: {
      id: row.category_id,
      slug: row.category_slug,
      labelEn: row.category_label_en,
      labelAr: row.category_label_ar,
    },
    activityType: {
      id: row.activity_type_id,
      slug: row.activity_type_slug,
      labelEn: row.activity_type_label_en,
      labelAr: row.activity_type_label_ar,
    },
  };
}

// -- public listing detail (docs/28 §16.1) ------------------------------------

export async function readPublicListing(
  deps: { db: Db },
  programId: string,
): Promise<ReadPublicListingResult> {
  return withTransaction(deps.db, async (trx) => {
    const row: ListingRow | undefined = await visibleListingQuery(trx)
      .where('program.id', '=', programId)
      .executeTakeFirst();
    if (row === undefined) return { kind: 'notFound' as const };

    // Public branches: ACTIVE associations to ACTIVE branches only, in
    // stable creation (UUIDv7 id) order — the S3-4 branch shape verbatim.
    const branches = await trx
      .selectFrom('program_branch')
      .innerJoin('branch', 'branch.id', 'program_branch.branch_id')
      .select([
        'branch.id as id',
        'branch.label as label',
        'branch.address_line as address_line',
        'branch.area_label as area_label',
        'branch.geo_point as geo_point',
        'branch.opening_hours as opening_hours',
        'branch.facilities as facilities',
      ])
      .where('program_branch.program_id', '=', programId)
      .where('program_branch.active', '=', true)
      .where('branch.active', '=', true)
      .orderBy('branch.id')
      .execute();

    const [options, media, offers] = [
      await activeOptionsFor(trx, [programId]),
      await activeMediaFor(trx, [programId]),
      await currentOffersFor(trx, [programId]),
    ];
    const optionViews = options.map(toOptionView);

    return {
      kind: 'listing' as const,
      listing: {
        id: row.id,
        titleEn: row.title_en,
        titleAr: row.title_ar,
        descriptionEn: row.description_en,
        descriptionAr: row.description_ar,
        setting: row.setting,
        minAge: row.min_age,
        maxAge: row.max_age,
        allAges: row.all_ages,
        genderEligibility: row.gender_eligibility,
        skillLevel: row.skill_level,
        eligibilityNotes: row.eligibility_notes,
        ...toTaxonomyRefs(row),
        provider: { id: row.organization_id, displayName: row.display_name },
        branches: branches.map((branch) => ({
          id: branch.id,
          label: branch.label,
          addressLine: branch.address_line,
          areaLabel: branch.area_label,
          geoPoint:
            branch.geo_point === null
              ? null
              : { longitude: branch.geo_point.x, latitude: branch.geo_point.y },
          openingHours: branch.opening_hours,
          facilities: branch.facilities,
        })),
        media: media.map(toMediaView),
        priceOptions: optionViews,
        offers: offers.map(toOfferView),
        fromPrice: deriveFromPrice(optionViews),
      },
    };
  });
}

// -- public storefront listings (docs/28 §19) ---------------------------------

const DEFAULT_PAGE_SIZE = 20;

export async function listStorefrontListings(
  deps: { db: Db },
  input: { organizationId: string; limit?: number; cursor?: string },
): Promise<ListStorefrontListingsResult> {
  let anchor: string | undefined;
  if (input.cursor !== undefined) {
    anchor = decodeListingCursor(input.cursor);
    if (anchor === undefined) return { kind: 'invalidCursor' };
  }
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), 50);

  return withTransaction(deps.db, async (trx) => {
    // The storefront itself must be publicly visible (the S3-4 rule); an
    // ineligible or unknown organization is the same not-found.
    const storefront = await trx
      .selectFrom('organization')
      .innerJoin(
        'organization_public_profile',
        'organization_public_profile.organization_id',
        'organization.id',
      )
      .select(['organization.id as id', 'organization_public_profile.display_name as display_name'])
      .where('organization.id', '=', input.organizationId)
      .where('organization.verification_state', '=', 'live')
      .where('organization_public_profile.published', '=', true)
      .executeTakeFirst();
    if (storefront === undefined) return { kind: 'notFound' as const };

    let pageQuery = visibleListingQuery(trx)
      .where('program.organization_id', '=', input.organizationId)
      .orderBy('program.id')
      .limit(limit + 1);
    if (anchor !== undefined) {
      pageQuery = pageQuery.where('program.id', '>', anchor);
    }
    const rows: ListingRow[] = await pageQuery.execute();
    const page = rows.slice(0, limit);
    const summarized = await summarizeListingRowsInTrx(trx, page);

    return {
      kind: 'listings' as const,
      provider: { id: storefront.id, displayName: storefront.display_name },
      listings: summarized.map((entry) => entry.summary),
      nextCursor:
        rows.length > limit ? encodeListingCursor(page[page.length - 1]!.id) : null,
    };
  });
}

// -- shared public summary hydration (storefront listings + search) -----------

export interface PublicProviderRef {
  id: string;
  displayName: string;
}

/** A search result is the public listing summary plus the provider
 *  storefront identity every result must navigate back to (Amendment A1). */
export interface PublicSearchResult extends PublicListingSummary {
  provider: PublicProviderRef;
}

/** Builds the public summary projection (+ provider identity) for visible
 *  listing rows, preserving the given row order. */
async function summarizeListingRowsInTrx(
  trx: Trx,
  rows: ListingRow[],
): Promise<{ summary: PublicListingSummary; provider: PublicProviderRef }[]> {
  const programIds = rows.map((row) => row.id);
  const [options, media, offers] = [
    await activeOptionsFor(trx, programIds),
    await activeMediaFor(trx, programIds),
    await currentOffersFor(trx, programIds),
  ];
  const optionsByProgram = new Map<string, PublicPriceOptionView[]>();
  for (const row of options) {
    const list = optionsByProgram.get(row.program_id) ?? [];
    list.push(toOptionView(row));
    optionsByProgram.set(row.program_id, list);
  }
  const mediaByProgram = new Map<string, PublicMediaView[]>();
  for (const row of media) {
    const list = mediaByProgram.get(row.program_id) ?? [];
    list.push(toMediaView(row));
    mediaByProgram.set(row.program_id, list);
  }
  const badgesByProgram = new Map<string, string[]>();
  for (const row of offers) {
    const badges = badgesByProgram.get(row.program_id) ?? [];
    if (!badges.includes(row.kind)) badges.push(row.kind);
    badgesByProgram.set(row.program_id, badges);
  }

  return rows.map((row) => {
    const optionViews = optionsByProgram.get(row.id) ?? [];
    return {
      provider: { id: row.organization_id, displayName: row.display_name },
      summary: {
        id: row.id,
        titleEn: row.title_en,
        titleAr: row.title_ar,
        setting: row.setting,
        minAge: row.min_age,
        maxAge: row.max_age,
        allAges: row.all_ages,
        genderEligibility: row.gender_eligibility,
        skillLevel: row.skill_level,
        ...toTaxonomyRefs(row),
        media: mediaByProgram.get(row.id) ?? [],
        fromPrice: deriveFromPrice(optionViews),
        offerBadges: (badgesByProgram.get(row.id) ?? []).sort(),
      },
    };
  });
}

/**
 * Hydrates public search results for ranked program ids, preserving the
 * given order. Rows are re-read through visibleListingQuery, so the §6
 * predicate applies AGAIN at hydration time — an id from a stale search
 * document simply drops out.
 */
export async function loadPublicSearchResultsInTrx(
  trx: Trx,
  programIds: string[],
): Promise<PublicSearchResult[]> {
  if (programIds.length === 0) return [];
  const rows: ListingRow[] = await visibleListingQuery(trx)
    .where('program.id', 'in', programIds)
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = programIds
    .map((id) => byId.get(id))
    .filter((row): row is ListingRow => row !== undefined);
  const summarized = await summarizeListingRowsInTrx(trx, ordered);
  return summarized.map((entry) => ({ ...entry.summary, provider: entry.provider }));
}

// -- public taxonomy reads (docs/28 §16.1; D-S4-3) ----------------------------

export interface PublicCategoryView {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  imageRef: string | null;
}

export interface PublicActivityTypeView {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  categoryId: string;
}

export interface PublicCollectionView {
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

export interface PublicAreaView {
  id: string;
  slug: string;
  labelEn: string;
  labelAr: string | null;
  city: string | null;
}

/** Active categories in canonical (sort_hint, slug) order. Missing Arabic
 *  never suppresses a row (D-S4-3); admin version/CAS metadata never
 *  serializes. */
export async function listPublicCategories(deps: { db: Db }): Promise<PublicCategoryView[]> {
  const rows = await deps.db
    .selectFrom('category')
    .select(['id', 'slug', 'label_en', 'label_ar', 'image_ref'])
    .where('active', '=', true)
    .orderBy('sort_hint')
    .orderBy('slug')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    imageRef: row.image_ref,
  }));
}

/** Active activity types whose parent category is also active — the public
 *  two-level relationship never dangles onto an invisible category.
 *  Synonym arrays are search-internal data and never serialize here. */
export async function listPublicActivityTypes(deps: {
  db: Db;
}): Promise<PublicActivityTypeView[]> {
  const rows = await deps.db
    .selectFrom('activity_type')
    .innerJoin('category', 'category.id', 'activity_type.category_id')
    .select([
      'activity_type.id as id',
      'activity_type.slug as slug',
      'activity_type.label_en as label_en',
      'activity_type.label_ar as label_ar',
      'activity_type.category_id as category_id',
    ])
    .where('activity_type.active', '=', true)
    .where('category.active', '=', true)
    .orderBy('category.sort_hint')
    .orderBy('category.slug')
    .orderBy('activity_type.slug')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    categoryId: row.category_id,
  }));
}

/** Published collections (editorial display data only): preset resolution
 *  to result sets is the later search commit's server-side concern — the
 *  preset booleans are never a public contract. */
export async function listPublicCollections(deps: {
  db: Db;
}): Promise<PublicCollectionView[]> {
  const rows = await deps.db
    .selectFrom('collection')
    .select([
      'id',
      'title_en',
      'title_ar',
      'subtitle_en',
      'subtitle_ar',
      'image_ref',
      'audience',
      'child_focused',
      'featured',
      'seasonal_label',
    ])
    .where('state', '=', 'published')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    titleEn: row.title_en,
    titleAr: row.title_ar,
    subtitleEn: row.subtitle_en,
    subtitleAr: row.subtitle_ar,
    imageRef: row.image_ref,
    audience: row.audience,
    childFocused: row.child_focused,
    featured: row.featured,
    seasonalLabel: row.seasonal_label,
  }));
}

/** Active areas in canonical (sort_hint, slug) order. */
export async function listPublicAreas(deps: { db: Db }): Promise<PublicAreaView[]> {
  const rows = await deps.db
    .selectFrom('area')
    .select(['id', 'slug', 'label_en', 'label_ar', 'city'])
    .where('active', '=', true)
    .orderBy('sort_hint')
    .orderBy('slug')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    city: row.city,
  }));
}
