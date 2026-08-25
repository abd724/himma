/**
 * Frontend domain types — docs/08 §9, eligibility model per docs/05 §7 and
 * docs/17 §5. Enough structure to keep the mock frontend coherent;
 * deliberately not the production data model.
 */

export type ParticipantId = 'everyone' | 'me' | string;

export interface Participant {
  id: ParticipantId;
  /** Customer-facing label, e.g. "Me", "Adam". */
  label: string;
  kind: 'everyone' | 'self' | 'child';
  /** ISO date; children only. Age derives from this against the fixed mock today. */
  dateOfBirth?: string;
  /**
   * Declared interests as activity-type ids — docs/05 §9, docs/09 §18.3.
   * Optional, set during onboarding/profile setup; drives rule-based ranking.
   */
  interests?: string[];
}

/** Canonical backend area id (UUID) in real composition; the mock fixture
 *  slugs remain valid ids for isolated tests. */
export type AreaId = string;

export interface Area {
  id: AreaId;
  label: string;
  /** Areas considered nearby for "Near me" ranking, closest first. */
  nearby: AreaId[];
}

/** Canonical backend category id (UUID) in real composition; the mock
 *  fixture slugs remain valid ids for isolated tests. */
export type CategoryId = string;

export interface Category {
  id: CategoryId;
  /** Stable slug for deterministic presentation (imagery); equals `id` in mock data. */
  slug?: string;
  label: string;
  imageKey: string;
}

export interface ActivityType {
  id: string;
  label: string;
  categoryId: CategoryId;
}

export interface Provider {
  id: string;
  name: string;
  categories: string[];
  /** Present in mock data; real rows carry `areaLabel` instead. */
  areaId?: AreaId;
  /** Public branch area label(s), joined for display — real composition. */
  areaLabel?: string;
  /**
   * Ratings have NO backend authority yet (reviews are a deferred domain).
   * Absent in real composition — surfaces render ratings only when present.
   */
  rating?: number;
  verified: boolean;
}

export type PriceModel =
  | { kind: 'dropIn'; amount: number }
  | { kind: 'monthly'; amount: number }
  | { kind: 'term'; amount: number }
  | { kind: 'camp'; amountPerWeek: number }
  | { kind: 'package'; amount: number; sessions: number }
  | { kind: 'free' }
  | { kind: 'freeTrial' }
  /** Server-derived minimum over the active options ("From AED 90") —
   *  the certified public summary price; real composition only. */
  | { kind: 'from'; amount: number };

export type GenderEligibility = 'men' | 'ladies' | 'mixed';

export type SkillLevel = 'beginner' | 'intermediate' | 'advanced' | 'all-levels';

/**
 * Provider-defined structured eligibility — docs/05 §7 (owner-confirmed).
 * Adults see all classes by default; "Ladies only" is an optional customer
 * filter over genderEligibility === 'ladies'; child suitability is purely
 * age-based against minimumAge/maximumAge/allAges.
 */
export interface Eligibility {
  minimumAge?: number;
  /** null = open-ended upper bound ("Ages 12+"). */
  maximumAge?: number | null;
  allAges: boolean;
  genderEligibility: GenderEligibility;
  skillLevel?: SkillLevel;
  eligibilityNotes?: string;
}

export interface Offer {
  kind: 'freeTrial' | 'paidTrial' | 'discount' | 'promo';
  label: string;
}

export interface Program {
  id: string;
  title: string;
  providerId: string;
  /** Provider display name — carried on real rows (the wire serves it);
   *  mock surfaces resolve it from fixtures instead. */
  providerName?: string;
  categoryId: CategoryId;
  activityTypeId: string;
  /** Present in mock data; real rows carry `areaLabel` instead. */
  areaId?: AreaId;
  /** Public branch area label(s), joined for display — real composition. */
  areaLabel?: string;
  imageKey: string;
  /**
   * Customer-facing schedule line, e.g. "Tue & Thu · 5:00 PM". No listing-
   * level schedule authority exists on the real wire (occurrences are the
   * per-unit availability projection) — absent in real composition.
   */
  scheduleLabel?: string;
  /** Time shown when the program runs on the mock "today", e.g. "7:30 PM". */
  todayTime?: string;
  /** Mock-only schedule-derived flags — no real search dimension exists. */
  availableToday?: boolean;
  runsOnWeekend?: boolean;
  runsAfterSchool?: boolean;
  isCamp: boolean;
  setting: 'indoor' | 'outdoor';
  /** Absent when a listing has no active public price — surfaces show no
   *  price rather than a fake one. */
  price?: PriceModel;
  eligibility: Eligibility;
  /** No backend authority (reviews deferred) — absent in real composition. */
  rating?: number;
  offer?: Offer;
}

/** Editorial grouping over the shared catalogue — docs/15 §2, docs/14 §6. */
export interface Collection {
  id: string;
  title: string;
  /** Optional editorial support line; the card falls back to its count. */
  subtitle?: string;
  imageKey: string;
  /** Simple deterministic preset resolved by services — never by cards.
   *  Real collections resolve server-side via the search `collectionId`
   *  dimension instead; absent in real composition. */
  preset?: {
    ladiesOnly?: boolean;
    childRelevant?: boolean;
    camps?: boolean;
    offers?: boolean;
    availableToday?: boolean;
    afterSchool?: boolean;
    indoor?: boolean;
  };
  /** Participant contexts the collection makes sense for (docs/16 §4). */
  audience: 'all' | 'adults' | 'children';
  /**
   * Intended participant is a child or school-age student — docs/18 §6.
   * Child-focused collections are promoted only to accounts with at least one
   * age-eligible child profile; never inferred from titles.
   */
  childFocused: boolean;
  /** Shown in Discover's editorial rail; lenses like Kids & Teens stay grid-only. */
  featuredOnDiscover: boolean;
  /** Optional seasonal framing, e.g. "Summer 2026". */
  seasonalLabel?: string;
}

/**
 * A Home/Discover browse tile. Keeps the approved Home grid visuals while
 * targets may be a category, an activity type, or a collection lens.
 */
export interface BrowseEntry {
  id: string;
  label: string;
  imageKey: string;
  target:
    | { kind: 'category'; categoryId: CategoryId }
    | { kind: 'activityType'; activityTypeId: string }
    | { kind: 'collection'; collectionId: string };
}

export interface CreditSummary {
  /** Fictional demo balance in AED. */
  availableCredit: number;
}

/**
 * A provider location. Providers without explicit branch data have one
 * implicit branch at their `areaId` (docs/20 §8.2). Branch metadata lives in
 * mock extras modules, never in the frozen catalogue arrays.
 */
export interface ProviderBranch {
  id: string;
  label: string;
  /** Present in mock data; real branches carry `areaLabel`. */
  areaId?: AreaId;
  /** Public area label — real composition. */
  areaLabel?: string;
  /** Street line; real rows show the provider's public address when present. */
  addressLine: string;
  openingHours?: string;
}

/** One dated occurrence of a program in the details session list — docs/20 §8.3. */
export interface SessionOccurrence {
  id: string;
  /**
   * Days from today. Mock schedules stay inside a two-week window (0–13);
   * real occurrences are the certified public availability projection and
   * may fall later.
   */
  dayOffset: number;
  dayLabel: string;
  timeLabel: string;
  /** Present only when places are genuinely limited; drives "4 places left". */
  spotsLeft?: number;
  /** Customer-safe availability band (D-RI-4) — real composition. Full and
   *  closed occurrences stay VISIBLE with their truthful state. */
  availability?: 'available' | 'fewLeft' | 'full' | 'closed';
  /** Branch label when the provider runs multiple locations. */
  branchLabel?: string;
}

/**
 * Mock-only cancellation preset — docs/09 §20.4. Final policy wording comes
 * from provider onboarding and backend configuration; no refund maths here.
 */
export interface CancellationPolicy {
  id: 'flex-24' | 'flex-48' | 'non-refundable';
  title: string;
  /** 2–3 concise customer-facing lines. */
  summaryLines: string[];
}
