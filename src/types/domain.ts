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

export type AreaId =
  | 'khalifa-city'
  | 'al-raha'
  | 'mbz-city'
  | 'yas-island'
  | 'al-reem'
  | 'saadiyat'
  | 'abu-dhabi-island';

export interface Area {
  id: AreaId;
  label: string;
  /** Areas considered nearby for "Near me" ranking, closest first. */
  nearby: AreaId[];
}

/** Full customer-visible taxonomy — docs/15 §3. */
export type CategoryId =
  | 'fitness'
  | 'martial-arts'
  | 'swimming'
  | 'padel-racquet'
  | 'pilates-yoga'
  | 'team-outdoor'
  | 'wellness'
  | 'learning'
  | 'quran'
  | 'tech-stem'
  | 'arts-creativity';

export interface Category {
  id: CategoryId;
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
  areaId: AreaId;
  rating: number;
  verified: boolean;
}

export type PriceModel =
  | { kind: 'dropIn'; amount: number }
  | { kind: 'monthly'; amount: number }
  | { kind: 'term'; amount: number }
  | { kind: 'camp'; amountPerWeek: number }
  | { kind: 'package'; amount: number; sessions: number }
  | { kind: 'free' }
  | { kind: 'freeTrial' };

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
  categoryId: CategoryId;
  activityTypeId: string;
  areaId: AreaId;
  imageKey: string;
  /** Customer-facing schedule line, e.g. "Tue & Thu · 5:00 PM". */
  scheduleLabel: string;
  /** Time shown when the program runs on the mock "today", e.g. "7:30 PM". */
  todayTime?: string;
  availableToday: boolean;
  runsOnWeekend: boolean;
  runsAfterSchool?: boolean;
  isCamp: boolean;
  setting: 'indoor' | 'outdoor';
  price: PriceModel;
  eligibility: Eligibility;
  rating: number;
  offer?: Offer;
}

/** Editorial grouping over the shared catalogue — docs/15 §2, docs/14 §6. */
export interface Collection {
  id: string;
  title: string;
  /** Optional editorial support line; the card falls back to its count. */
  subtitle?: string;
  imageKey: string;
  /** Simple deterministic preset resolved by services — never by cards. */
  preset: {
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
  areaId: AreaId;
  /** Fictional street line for realism — never a real address. */
  addressLine: string;
  openingHours?: string;
}

/** One dated occurrence of a program in the details session list — docs/20 §8.3. */
export interface SessionOccurrence {
  id: string;
  /**
   * Days after MOCK_TODAY. Recurring schedules stay inside a two-week window
   * (0–13); a camp's single start entry falls on its real start date, which
   * may be later in the month.
   */
  dayOffset: number;
  dayLabel: string;
  timeLabel: string;
  /** Present only when places are genuinely limited; drives "4 places left". */
  spotsLeft?: number;
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
