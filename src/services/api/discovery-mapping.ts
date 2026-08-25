/**
 * RI-2 — pure wire→domain mapping for the public discovery family.
 *
 * Server truth maps 1:1; nothing is invented. Fields with no backend
 * authority (ratings, schedule lines, availability-today flags) are left
 * ABSENT — surfaces hide them. Presentation imagery is deterministic
 * bundled photography keyed by category slug (no public media serving
 * exists yet; media refs are recorded, not fetched).
 */
import type {
  ActivityType,
  Area,
  Category,
  Collection,
  Eligibility,
  Offer,
  PriceModel,
  Program,
  Provider,
  ProviderBranch,
  SessionOccurrence,
} from '@/types/domain';
import type {
  ActivityTypeDto,
  AreaDto,
  AvailabilityUnitDto,
  CategoryDto,
  CollectionDto,
  FromPriceDto,
  ListingBranchDto,
  ListingDetailDto,
  ListingSummaryDto,
  PriceOptionDto,
  SearchResultDto,
} from '@/services/api/discovery-api';

// -- deterministic presentation imagery (bundled, docs/08 §11) ---------------

const CATEGORY_IMAGE_KEYS: Record<string, string[]> = {
  fitness: ['gym', 'fitnessWoman'],
  'martial-arts': ['boxing', 'karate'],
  swimming: ['poolLanes', 'swimRace'],
  'padel-racquet': ['tennis'],
  'pilates-yoga': ['yogaPose', 'yogaCalm'],
  'team-outdoor': ['football'],
  wellness: ['wellness'],
  learning: ['books', 'library'],
  quran: ['quran'],
  'tech-stem': ['robotics', 'coding'],
  'arts-creativity': ['art'],
};

/** Stable per-entity pick from the category's bundled image set. */
export function presentationImageKey(categorySlug: string, entityId: string): string {
  const keys = CATEGORY_IMAGE_KEYS[categorySlug] ?? ['gym'];
  let hash = 0;
  for (const char of entityId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return keys[hash % keys.length]!;
}

// -- taxonomy ----------------------------------------------------------------

export function toCategory(dto: CategoryDto): Category {
  return {
    id: dto.id,
    slug: dto.slug,
    label: dto.labelEn,
    imageKey: presentationImageKey(dto.slug, dto.id),
  };
}

export function toActivityType(dto: ActivityTypeDto): ActivityType {
  return { id: dto.id, label: dto.labelEn, categoryId: dto.categoryId };
}

export function toArea(dto: AreaDto): Area {
  // Proximity ordering has no backend authority — `nearby` stays empty and
  // "Near me" surfaces stay hidden rather than pretending distance truth.
  return { id: dto.id, label: dto.labelEn, nearby: [] };
}

export function toCollection(dto: CollectionDto): Collection {
  return {
    id: dto.id,
    title: dto.titleEn,
    ...(dto.subtitleEn !== null ? { subtitle: dto.subtitleEn } : {}),
    imageKey: dto.childFocused ? 'art' : 'football',
    audience: dto.audience === 'adults' ? 'adults' : dto.audience === 'children' ? 'children' : 'all',
    childFocused: dto.childFocused,
    featuredOnDiscover: dto.featured,
    ...(dto.seasonalLabel !== null ? { seasonalLabel: dto.seasonalLabel } : {}),
  };
}

// -- listing rows ------------------------------------------------------------

function toEligibility(dto: {
  minAge: number | null;
  maxAge: number | null;
  allAges: boolean;
  genderEligibility: string;
  skillLevel: string | null;
  eligibilityNotes?: string | null;
}): Eligibility {
  // Server vocabulary women|men|girls|boys|mixed; `women` presents as the
  // approved "Ladies only" wording.
  const gender =
    dto.genderEligibility === 'women'
      ? ('ladies' as const)
      : dto.genderEligibility === 'men'
        ? ('men' as const)
        : ('mixed' as const);
  return {
    ...(dto.minAge !== null ? { minimumAge: dto.minAge } : {}),
    ...(dto.maxAge !== null ? { maximumAge: dto.maxAge } : {}),
    allAges: dto.allAges,
    genderEligibility: gender,
    ...(dto.skillLevel !== null && dto.skillLevel !== undefined
      ? { skillLevel: dto.skillLevel as Eligibility['skillLevel'] }
      : {}),
    ...(dto.eligibilityNotes !== null && dto.eligibilityNotes !== undefined
      ? { eligibilityNotes: dto.eligibilityNotes }
      : {}),
  };
}

export function fromPriceToModel(fromPrice: FromPriceDto): PriceModel | undefined {
  if (fromPrice === null) return undefined;
  if (fromPrice.kind === 'free') return { kind: 'free' };
  return { kind: 'from', amount: Math.round(fromPrice.amountFils / 100) };
}

/** The single card badge from the server's deduplicated offer kinds. */
export function offerFromBadges(offerBadges: string[]): Offer | undefined {
  if (offerBadges.includes('freeTrial')) return { kind: 'freeTrial', label: 'Free trial' };
  if (offerBadges.includes('paidTrial')) return { kind: 'paidTrial', label: 'Trial offer' };
  const first = offerBadges[0];
  if (first === undefined) return undefined;
  return { kind: 'promo', label: 'Offer' };
}

function areaLabelOf(areaLabels: string[]): string | undefined {
  const first = areaLabels[0];
  if (first === undefined) return undefined;
  return areaLabels.length === 1 ? first : `${first} +${areaLabels.length - 1}`;
}

export function toProgram(
  dto: ListingSummaryDto,
  provider?: { id: string; displayName: string },
): Program {
  const offer = offerFromBadges(dto.offerBadges);
  const price = fromPriceToModel(dto.fromPrice);
  const areaLabel = areaLabelOf(dto.areaLabels);
  return {
    id: dto.id,
    title: dto.titleEn,
    providerId: provider?.id ?? '',
    ...(provider !== undefined ? { providerName: provider.displayName } : {}),
    categoryId: dto.category.id,
    activityTypeId: dto.activityType.id,
    ...(areaLabel !== undefined ? { areaLabel } : {}),
    imageKey: presentationImageKey(dto.category.slug, dto.id),
    isCamp: false,
    setting: dto.setting === 'outdoor' ? 'outdoor' : 'indoor',
    ...(price !== undefined ? { price } : {}),
    eligibility: toEligibility(dto),
    ...(offer !== undefined ? { offer } : {}),
  };
}

export function searchResultToProgram(dto: SearchResultDto): Program {
  return toProgram(dto, dto.provider);
}

/** A provider row derived from its listing rows — truthful subset data. */
export function providerFromResults(
  provider: { id: string; displayName: string },
  rows: ListingSummaryDto[],
): Provider {
  // Human-readable category labels — the domain Provider carries labels.
  const categories = [...new Set(rows.map((row) => row.category.labelEn))];
  const labels = [...new Set(rows.flatMap((row) => row.areaLabels))];
  const areaLabel = areaLabelOf(labels);
  return {
    id: provider.id,
    name: provider.displayName,
    categories,
    ...(areaLabel !== undefined ? { areaLabel } : {}),
    verified: false,
  };
}

// -- detail pieces -----------------------------------------------------------

const OPTION_PRICE_KIND: Record<string, (option: PriceOptionDto) => PriceModel | undefined> = {
  dropIn: (o) => (o.amountFils === null ? undefined : { kind: 'dropIn', amount: Math.round(o.amountFils / 100) }),
  monthly: (o) => (o.amountFils === null ? undefined : { kind: 'monthly', amount: Math.round(o.amountFils / 100) }),
  term: (o) => (o.amountFils === null ? undefined : { kind: 'term', amount: Math.round(o.amountFils / 100) }),
  camp: (o) => (o.amountFils === null ? undefined : { kind: 'camp', amountPerWeek: Math.round(o.amountFils / 100) }),
  package: (o) =>
    o.amountFils === null || o.sessionsCount === null
      ? undefined
      : { kind: 'package', amount: Math.round(o.amountFils / 100), sessions: o.sessionsCount },
  free: () => ({ kind: 'free' }),
};

/** The detail-surface price: one active option shows its precise shape;
 *  several fall back to the server-derived from-price. */
export function detailPriceModel(dto: ListingDetailDto): PriceModel | undefined {
  if (dto.priceOptions.length === 1) {
    const option = dto.priceOptions[0]!;
    const mapped = OPTION_PRICE_KIND[option.kind]?.(option);
    if (mapped !== undefined) return mapped;
  }
  return fromPriceToModel(dto.fromPrice);
}

export function detailIsCamp(dto: ListingDetailDto): boolean {
  return dto.priceOptions.some((option) => option.kind === 'camp');
}

export function toDetailProgram(dto: ListingDetailDto): Program {
  const offer = offerFromBadges(dto.offers.map((o) => o.kind));
  const price = detailPriceModel(dto);
  const areaLabel = areaLabelOf([...new Set(dto.branches.map((b) => b.areaLabel))]);
  return {
    id: dto.id,
    title: dto.titleEn,
    providerId: dto.provider.id,
    providerName: dto.provider.displayName,
    categoryId: dto.category.id,
    activityTypeId: dto.activityType.id,
    ...(areaLabel !== undefined ? { areaLabel } : {}),
    imageKey: presentationImageKey(dto.category.slug, dto.id),
    isCamp: detailIsCamp(dto),
    setting: dto.setting === 'outdoor' ? 'outdoor' : 'indoor',
    ...(price !== undefined ? { price } : {}),
    eligibility: toEligibility(dto),
    ...(offer !== undefined ? { offer } : {}),
  };
}

export function toProviderBranch(dto: ListingBranchDto): ProviderBranch {
  return {
    id: dto.id,
    label: dto.label,
    areaLabel: dto.areaLabel,
    addressLine: dto.addressLine ?? '',
    ...(typeof dto.openingHours === 'string' && dto.openingHours !== ''
      ? { openingHours: dto.openingHours }
      : {}),
  };
}

// -- occurrences (D-RI-4) ----------------------------------------------------

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayOffsetFrom(now: Date, date: Date): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

function dayLabelFor(now: Date, date: Date): string {
  const offset = dayOffsetFrom(now, date);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

function timeLabelFor(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function shortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

/**
 * The certified public availability projection → display occurrences.
 * Bands pass through UNCHANGED (full/closed stay visible — owner §11);
 * `spotsLeft` exists only where the server put it (fewLeft). Units whose
 * start already passed are dropped; nothing else is filtered.
 */
export function toSessionOccurrences(
  units: AvailabilityUnitDto[],
  branchLabelById: Map<string, string>,
  now: Date = new Date(),
): SessionOccurrence[] {
  const occurrences: SessionOccurrence[] = [];
  for (const unit of units) {
    let start: Date | null = null;
    let dayLabel = '';
    let timeLabel = '';
    if (unit.kind === 'session' && unit.startAt !== null) {
      start = new Date(unit.startAt);
      dayLabel = dayLabelFor(now, start);
      timeLabel = timeLabelFor(start);
    } else if (unit.kind === 'campWeek' && unit.startDate !== null) {
      start = new Date(`${unit.startDate}T00:00:00`);
      dayLabel =
        unit.endDate !== null
          ? `${shortDate(start)} – ${shortDate(new Date(`${unit.endDate}T00:00:00`))}`
          : shortDate(start);
      timeLabel = 'Camp week';
    } else if (unit.kind === 'enrolmentCohort' && unit.effectiveStart !== null) {
      start = new Date(`${unit.effectiveStart}T00:00:00`);
      dayLabel = `Starts ${shortDate(start)}`;
      timeLabel =
        unit.effectiveEnd !== null ? `Until ${shortDate(new Date(`${unit.effectiveEnd}T00:00:00`))}` : '';
    }
    if (start === null || startOfDay(start).getTime() < startOfDay(now).getTime()) continue;
    const branchLabel = branchLabelById.get(unit.branchId);
    occurrences.push({
      id: unit.unitId,
      dayOffset: dayOffsetFrom(now, start),
      dayLabel,
      timeLabel,
      availability: unit.availability,
      ...(unit.spotsLeft !== undefined ? { spotsLeft: unit.spotsLeft } : {}),
      ...(branchLabel !== undefined && branchLabelById.size > 1 ? { branchLabel } : {}),
    });
  }
  return occurrences.sort((a, b) => a.dayOffset - b.dayOffset);
}

/** Which capacity-unit kinds a listing's active price options imply. */
export function unitKindsForOptions(
  options: PriceOptionDto[],
): ('session' | 'campWeek' | 'enrolmentCohort')[] {
  const kinds = new Set<'session' | 'campWeek' | 'enrolmentCohort'>();
  for (const option of options) {
    if (option.kind === 'dropIn' || option.kind === 'free' || option.kind === 'package') {
      kinds.add('session');
    } else if (option.kind === 'camp') {
      kinds.add('campWeek');
    } else if (option.kind === 'monthly' || option.kind === 'term') {
      kinds.add('enrolmentCohort');
    }
  }
  if (kinds.size === 0) kinds.add('session');
  return [...kinds];
}
