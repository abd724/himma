import type { ApiJsonResponse } from '../../api/client';
import type { LiveTransport } from '../../auth/live/live-auth-runtime';
import type {
  ListingBranchSummary,
  ListingDetailOutcome,
  ListingPriceSummary,
  ListingsReadPort,
  ListListingsOutcome,
  OfferRecord,
  OpenRevisionRecord,
  PriceOptionRecord,
  ProgramBranchRecord,
  ProgramDetailRecord,
  ProgramMediaRecord,
  ProgramSummaryRecord,
} from '../../catalogue/contract';
import type {
  ActivityTypeReadPort,
  ActivityTypeRecord,
  CategoryReadPort,
  CategoryRecord,
} from '../../taxonomy/contract';

/**
 * LIVE catalogue READ ports (W2-12C1) — the production implementations of
 * the W2-7 read seams and the listing-taxonomy reads over the
 * authenticated W2-12A transport, route for route against the REAL
 * Slice-4 backend:
 *
 * - `GET /provider/organizations/:orgId/listings` → the provider Listings
 *   index. Since W2-12C1 each row IS the list-card projection (activity
 *   display · derived D-S4-1 price summary · branch summary · thumbnail
 *   metadata) served by ONE authoritative page query — this port never
 *   issues per-row detail/price/branch follow-ups, and the recorded
 *   W2-11 Class-B list-projection gap is resolved by that contract.
 * - `GET .../listings/:programId` → the provider listing detail
 *   (ProgramDetailViewSchema field for field).
 * - `GET /catalogue/activity-types` · `GET /catalogue/categories` → the
 *   public taxonomy reads behind the Activity Type selector (ACTIVE rows
 *   only — inactive taxonomy is simply absent from new selection; a
 *   listing referencing an inactive type keeps its truthful embedded
 *   `active: false` object on its own rows).
 *
 * Principles (same as live-domain-ports.ts):
 * - a response outside the approved DTO shape FAILS CLOSED to
 *   `unavailable` — no partial truth and no fixture fallback (fixture
 *   code is not reachable from this module at all);
 * - `/provider/me` remains the only access authority — these reads render
 *   display truth and never grant navigation;
 * - thumbnails: the wire carries real ProgramMedia METADATA (mediaRef +
 *   alt text). No media binary/storage or URL source exists yet, so live
 *   `thumbnailUrl` truthfully resolves null (the index shows its
 *   intentional placeholder) — nothing is fabricated;
 * - reads are read-only: no catalogue mutation is wired here (W2-12C2).
 */

const codeOf = (response: ApiJsonResponse): string => response.code ?? '';

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function priceSummaryFrom(raw: unknown): ListingPriceSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === 'free') return { kind: 'free' };
  if (value.kind === 'none') return { kind: 'none' };
  if (value.kind === 'from' && typeof value.amountFils === 'number' && value.currency === 'AED') {
    return { kind: 'from', amountFils: value.amountFils };
  }
  return null;
}

function branchSummaryFrom(raw: unknown): ListingBranchSummary | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isNullableString(value.firstLabel) || typeof value.activeCount !== 'number') return null;
  return { firstLabel: value.firstLabel, activeCount: value.activeCount };
}

function summaryRecordFrom(raw: unknown): ProgramSummaryRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const activityType = row.activityType as Record<string, unknown> | undefined;
  if (
    typeof row.id !== 'string' ||
    typeof row.titleEn !== 'string' ||
    typeof row.listingState !== 'string' ||
    typeof row.version !== 'number' ||
    typeof row.createdAt !== 'string' ||
    typeof row.updatedAt !== 'string' ||
    typeof activityType !== 'object' ||
    activityType === null ||
    typeof activityType.id !== 'string' ||
    typeof activityType.labelEn !== 'string' ||
    typeof activityType.active !== 'boolean'
  ) {
    return null;
  }
  const priceSummary = priceSummaryFrom(row.priceSummary);
  const branchSummary = branchSummaryFrom(row.branchSummary);
  if (priceSummary === null || branchSummary === null) return null;
  // The wire thumbnail is metadata ({mediaRef, altTextEn} | null). Its
  // presence must still be shape-valid, but no URL source exists yet, so
  // the presentation value is truthfully null either way (placeholder).
  const thumbnail = row.thumbnail;
  if (thumbnail !== null) {
    if (typeof thumbnail !== 'object') return null;
    const media = thumbnail as Record<string, unknown>;
    if (typeof media.mediaRef !== 'string' || !isNullableString(media.altTextEn)) return null;
  }
  return {
    id: row.id,
    titleEn: row.titleEn,
    listingState: row.listingState,
    activityType: {
      id: activityType.id,
      labelEn: activityType.labelEn,
      active: activityType.active,
    },
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    priceSummary,
    branchSummary,
    thumbnailUrl: null,
  };
}

/** Shared with the W2-12C2 live editor port — the SAME fail-closed DTO
 *  validators verify mutation responses (option/media/offer echoes). */
export function priceOptionFrom(raw: unknown): PriceOptionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.kind !== 'string' ||
    !(row.amountFils === null || typeof row.amountFils === 'number') ||
    typeof row.currency !== 'string' ||
    !(row.sessionsCount === null || typeof row.sessionsCount === 'number') ||
    !isNullableString(row.labelEn) ||
    !isNullableString(row.labelAr) ||
    typeof row.sortHint !== 'number' ||
    typeof row.state !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    amountFils: row.amountFils,
    currency: row.currency,
    sessionsCount: row.sessionsCount,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    sortHint: row.sortHint,
    state: row.state,
    version: row.version,
  };
}

function programBranchFrom(raw: unknown): ProgramBranchRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.branchId !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.branchActive !== 'boolean' ||
    typeof row.associationActive !== 'boolean' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    branchId: row.branchId,
    label: row.label,
    branchActive: row.branchActive,
    associationActive: row.associationActive,
    version: row.version,
  };
}

export function programMediaFrom(raw: unknown): ProgramMediaRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.mediaRef !== 'string' ||
    typeof row.sortHint !== 'number' ||
    !isNullableString(row.altTextEn) ||
    !isNullableString(row.altTextAr) ||
    typeof row.active !== 'boolean' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    mediaRef: row.mediaRef,
    sortHint: row.sortHint,
    altTextEn: row.altTextEn,
    altTextAr: row.altTextAr,
    active: row.active,
    version: row.version,
  };
}

export function offerFrom(raw: unknown): OfferRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.labelEn !== 'string' ||
    !isNullableString(row.labelAr) ||
    !(row.trialAmountFils === null || typeof row.trialAmountFils === 'number') ||
    !isNullableString(row.effectiveStart) ||
    !isNullableString(row.effectiveEnd) ||
    typeof row.state !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    labelEn: row.labelEn,
    labelAr: row.labelAr,
    trialAmountFils: row.trialAmountFils,
    effectiveStart: row.effectiveStart,
    effectiveEnd: row.effectiveEnd,
    state: row.state,
    version: row.version,
  };
}

function openRevisionFrom(raw: unknown): OpenRevisionRecord | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.state !== 'string' ||
    typeof row.createdAt !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return undefined;
  }
  return { id: row.id, state: row.state, createdAt: row.createdAt, version: row.version };
}

/** Field-for-field validation of the real ProgramDetailViewSchema — any
 *  contract violation fails the WHOLE read closed. */
function detailRecordFrom(raw: unknown): ProgramDetailRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const activityType = row.activityType as Record<string, unknown> | undefined;
  if (
    typeof row.id !== 'string' ||
    typeof row.organizationId !== 'string' ||
    typeof activityType !== 'object' ||
    activityType === null ||
    typeof activityType.id !== 'string' ||
    typeof activityType.slug !== 'string' ||
    typeof activityType.labelEn !== 'string' ||
    typeof activityType.active !== 'boolean' ||
    typeof activityType.categoryId !== 'string' ||
    typeof row.titleEn !== 'string' ||
    !isNullableString(row.titleAr) ||
    !isNullableString(row.descriptionEn) ||
    !isNullableString(row.descriptionAr) ||
    typeof row.setting !== 'string' ||
    !(row.minAge === null || typeof row.minAge === 'number') ||
    !(row.maxAge === null || typeof row.maxAge === 'number') ||
    typeof row.allAges !== 'boolean' ||
    typeof row.genderEligibility !== 'string' ||
    !isNullableString(row.skillLevel) ||
    !isNullableString(row.eligibilityNotes) ||
    typeof row.listingState !== 'string' ||
    !isNullableString(row.publishedAt) ||
    !isNullableString(row.archivedAt) ||
    typeof row.sensitiveFieldsVersion !== 'number' ||
    typeof row.version !== 'number' ||
    typeof row.createdAt !== 'string' ||
    typeof row.updatedAt !== 'string' ||
    !Array.isArray(row.priceOptions) ||
    !Array.isArray(row.branches) ||
    !Array.isArray(row.media) ||
    !Array.isArray(row.offers)
  ) {
    return null;
  }
  const priceOptions: PriceOptionRecord[] = [];
  for (const entry of row.priceOptions) {
    const option = priceOptionFrom(entry);
    if (option === null) return null;
    priceOptions.push(option);
  }
  const branches: ProgramBranchRecord[] = [];
  for (const entry of row.branches) {
    const branch = programBranchFrom(entry);
    if (branch === null) return null;
    branches.push(branch);
  }
  const media: ProgramMediaRecord[] = [];
  for (const entry of row.media) {
    const item = programMediaFrom(entry);
    if (item === null) return null;
    media.push(item);
  }
  const offers: OfferRecord[] = [];
  for (const entry of row.offers) {
    const offer = offerFrom(entry);
    if (offer === null) return null;
    offers.push(offer);
  }
  const openRevision = openRevisionFrom(row.openRevision);
  if (openRevision === undefined) return null;
  // W3-8: the provider-safe correction feedback — validated fail-closed.
  let latestDecision: ProgramDetailRecord['latestDecision'] = null;
  if (row.latestDecision !== null && row.latestDecision !== undefined) {
    const decision = row.latestDecision as Record<string, unknown>;
    if (
      !(typeof decision.reasonCode === 'string' || decision.reasonCode === null) ||
      !(typeof decision.providerMessage === 'string' || decision.providerMessage === null) ||
      typeof decision.decidedAt !== 'string'
    ) {
      return null;
    }
    latestDecision = {
      reasonCode: decision.reasonCode,
      providerMessage: decision.providerMessage,
      decidedAt: decision.decidedAt,
    };
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    activityType: {
      id: activityType.id,
      slug: activityType.slug,
      labelEn: activityType.labelEn,
      active: activityType.active,
      categoryId: activityType.categoryId,
    },
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    setting: row.setting,
    minAge: row.minAge,
    maxAge: row.maxAge,
    allAges: row.allAges,
    genderEligibility: row.genderEligibility,
    skillLevel: row.skillLevel,
    eligibilityNotes: row.eligibilityNotes,
    listingState: row.listingState,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    sensitiveFieldsVersion: row.sensitiveFieldsVersion,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    priceOptions,
    branches,
    media,
    offers,
    openRevision,
    latestDecision,
  };
}

export interface LiveCatalogueReadPorts {
  readonly listingsPort: ListingsReadPort;
  readonly activityTypePort: ActivityTypeReadPort;
  readonly categoryPort: CategoryReadPort;
}

export function createLiveCatalogueReadPorts(transport: LiveTransport): LiveCatalogueReadPorts {
  const orgPath = (organizationId: string, suffix = '') =>
    `/provider/organizations/${encodeURIComponent(organizationId)}${suffix}`;

  const listingsPort: ListingsReadPort = {
    async listListings(organizationId, params): Promise<ListListingsOutcome> {
      const search = new URLSearchParams();
      if (params?.limit !== undefined) search.set('limit', String(params.limit));
      if (params?.cursor !== undefined) search.set('cursor', params.cursor);
      // Authoritative server-side filtering (W2-12C1 final correction):
      // search/status go to the backend, which applies them to the
      // complete authorized set BEFORE pagination — never client-filtered
      // over a loaded page. Blank search is no predicate.
      if (params?.q !== undefined && params.q.trim() !== '') search.set('q', params.q.trim());
      if (params?.status !== undefined) search.set('status', params.status);
      const encoded = search.toString();
      const query = encoded === '' ? '' : `?${encoded}`;
      const response = await transport.authorizedRequest(
        orgPath(organizationId, `/listings${query}`),
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const body = response.body as { programs?: unknown; nextCursor?: unknown } | null;
        if (
          body === null ||
          !Array.isArray(body.programs) ||
          !isNullableStringCursor(body.nextCursor)
        ) {
          return { kind: 'unavailable' };
        }
        const programs: ProgramSummaryRecord[] = [];
        for (const entry of body.programs) {
          const record = summaryRecordFrom(entry);
          if (record === null) return { kind: 'unavailable' };
          programs.push(record);
        }
        return { kind: 'loaded', page: { programs, nextCursor: body.nextCursor } };
      }
      switch (codeOf(response)) {
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },

    async loadListing(organizationId, programId): Promise<ListingDetailOutcome> {
      const response = await transport.authorizedRequest(
        orgPath(organizationId, `/listings/${encodeURIComponent(programId)}`),
      );
      if (response === null || response.networkFailure) return { kind: 'unavailable' };
      if (response.status === 200) {
        const program = detailRecordFrom(
          (response.body as { program?: unknown } | null)?.program,
        );
        return program === null ? { kind: 'unavailable' } : { kind: 'loaded', program };
      }
      switch (codeOf(response)) {
        case 'forbidden':
        case 'mfaRequired':
          return { kind: 'forbidden' };
        case 'notFound':
          return { kind: 'notFound' };
        default:
          return { kind: 'unavailable' };
      }
    },
  };

  const activityTypePort: ActivityTypeReadPort = {
    /** The REAL public taxonomy read — ACTIVE rows only (D-S4-3); the
     *  selector offers exactly this collection and never invents rows. */
    async listActivityTypes() {
      const response = await transport.publicRequest('/catalogue/activity-types');
      if (response.status !== 200) return { kind: 'unavailable' };
      const rows = (response.body as { activityTypes?: unknown } | null)?.activityTypes;
      if (!Array.isArray(rows)) return { kind: 'unavailable' };
      const activityTypes: ActivityTypeRecord[] = [];
      for (const entry of rows) {
        if (typeof entry !== 'object' || entry === null) return { kind: 'unavailable' };
        const raw = entry as Record<string, unknown>;
        if (
          typeof raw.id !== 'string' ||
          typeof raw.slug !== 'string' ||
          typeof raw.labelEn !== 'string' ||
          typeof raw.categoryId !== 'string'
        ) {
          return { kind: 'unavailable' };
        }
        activityTypes.push({
          id: raw.id,
          slug: raw.slug,
          labelEn: raw.labelEn,
          labelAr: typeof raw.labelAr === 'string' ? raw.labelAr : null,
          categoryId: raw.categoryId,
        });
      }
      return { kind: 'loaded', activityTypes };
    },
  };

  const categoryPort: CategoryReadPort = {
    /** The REAL public category read — the activity selector's catalogue
     *  context ("Swimming — Aquatics"); providers never author taxonomy. */
    async listCategories() {
      const response = await transport.publicRequest('/catalogue/categories');
      if (response.status !== 200) return { kind: 'unavailable' };
      const rows = (response.body as { categories?: unknown } | null)?.categories;
      if (!Array.isArray(rows)) return { kind: 'unavailable' };
      const categories: CategoryRecord[] = [];
      for (const entry of rows) {
        if (typeof entry !== 'object' || entry === null) return { kind: 'unavailable' };
        const raw = entry as Record<string, unknown>;
        if (
          typeof raw.id !== 'string' ||
          typeof raw.slug !== 'string' ||
          typeof raw.labelEn !== 'string'
        ) {
          return { kind: 'unavailable' };
        }
        categories.push({
          id: raw.id,
          slug: raw.slug,
          labelEn: raw.labelEn,
          labelAr: typeof raw.labelAr === 'string' ? raw.labelAr : null,
          imageRef: typeof raw.imageRef === 'string' ? raw.imageRef : null,
        });
      }
      return { kind: 'loaded', categories };
    },
  };

  return { listingsPort, activityTypePort, categoryPort };
}

function isNullableStringCursor(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
