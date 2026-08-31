import type {
  AreaId,
  CancellationPolicy,
  Participant,
  ParticipantId,
  Program,
  Provider,
  ProviderBranch,
} from '@/types/domain';
import type { CommerceUnitKind, Quote } from '@/services/contracts/commerce';
import type { AcquisitionQuote } from '@/services/contracts/entitlements';
import type { ParticipantSuitability } from '@/utils/eligibility';

/**
 * Booking-flow boundary — docs/21 §11, owner decisions in docs/09 §21.
 * Availability here is deterministic frontend mock data behind this contract;
 * a real backend replaces the implementation without touching screens
 * (docs/08 §8, §14). Nothing in this contract may imply a reservation exists.
 */
export type SessionAvailability = 'available' | 'fewLeft' | 'full';

/** One selectable dated occurrence; extends the shared session derivation. */
export interface SessionOption {
  id: string;
  dayOffset: number;
  /** 'Today' | 'Tue 4 Aug' | 'Week of 10–14 Aug' (camp weeks). */
  dayLabel: string;
  timeLabel: string;
  branchLabel?: string;
  availability: SessionAvailability;
  /** Present for fewLeft only — drives "3 places left". */
  spotsLeft?: number;
}

export type BookingOptionKind =
  | 'single-session'
  | 'free-session'
  | 'trial'
  | 'recurring'
  | 'term'
  | 'camp-week'
  | 'package'
  | 'membership';

/** One bookable shape of a program (a program may offer several, e.g. trial + enrolment). */
export interface BookingOption {
  id: string;
  kind: BookingOptionKind;
  /** 'Single session' | 'Free trial session' | 'Monthly enrolment' | … */
  title: string;
  /** 'AED 85 per session' | 'Free' | 'AED 35' | … */
  priceLabel: string;
  /**
   * RI-3 — canonical backend identifiers for the certified quote:
   * the price option this row represents, the capacity-unit kind its
   * sessions select, and (for trials) the provider Offer applied. Real
   * composition always sets these; fixture options may omit them.
   */
  priceOptionId?: string;
  offerId?: string;
  unitKind?: CommerceUnitKind;
  /**
   * S6 product boundary (owner RI-3 §23): false for catalogue products no
   * certified flow can legally fulfil. Since RI-4 the package/membership
   * kinds ARE purchasable through the real S6 acquisition trail; this flag
   * remains for genuinely unsupported future kinds. Absent = purchasable.
   */
  purchasable?: boolean;
  /**
   * RI-4 — the option's commercial trail. `entitlementAcquisition` rows
   * ride the SAME flow screens but quote/confirm through the S6 purchase
   * APIs (unit-less, no hold, never a capacity Booking); absent = the
   * certified capacity trail.
   */
  commercial?: 'entitlementAcquisition';
  /** Customer-safe wording for a non-purchasable option ('Coming soon'). */
  unavailableNote?: string;
  /** True when choosing this option requires picking a dated session/week. */
  requiresSession: boolean;
  /** Empty when requiresSession is false. */
  sessions: SessionOption[];
  /**
   * Plan orientation for dateless options — schedule and start, e.g.
   * 'Sat & Sun · 10:00 AM', 'Starts with the next session — Sat 8 Aug'.
   * Cadence-labelled, never "charged today" (docs/09 §21.7, §21.10).
   */
  detailLines: string[];
}

export type BookingAvailability =
  | { status: 'bookable' }
  | { status: 'noSessions' }
  | { status: 'registrationClosed'; reason: string };

/** Reuses the existing suitability presentation — no parallel eligibility type. */
export type ParticipantEligibility = ParticipantSuitability;

export interface BookingOptionsPage {
  program: Program;
  provider: Provider;
  branch?: ProviderBranch;
  availability: BookingAvailability;
  /** ≥ 1 when bookable. */
  options: BookingOption[];
  /**
   * docs/21 §2 skip rule, computed once here:
   * options.length === 1 && !options[0].requiresSession.
   */
  skipSelectionStep: boolean;
  /** Every real household participant, primary first. */
  householdEligibility: ParticipantEligibility[];
  /** docs/21 §2 preselection rule result; undefined when none applies. */
  preselectedParticipantId?: ParticipantId;
}

/**
 * The temporary in-memory booking draft — docs/09 §21.13. Owned by
 * BookingSessionProvider for exactly the flow's lifetime; never persisted.
 */
export interface BookingDraft {
  programId: string;
  optionId?: string;
  /** Required iff the chosen option requiresSession. */
  sessionId?: string;
  participantId?: ParticipantId;
}

export interface BookingSummary {
  program: Program;
  provider: Provider;
  branch?: ProviderBranch;
  /** suitable === true re-asserted at build time. */
  participant: ParticipantEligibility;
  option: BookingOption;
  session?: SessionOption;
  /** docs/21 §5 per-type wording. */
  selectionLines: string[];
  priceLines: { label: string; value: string }[];
  /**
   * 'Booking price · AED 85' | 'Booking price · AED 450 per month' |
   * 'Booking price · Free' — never a "Total" (docs/09 §21.11: no legally
   * final checkout total is implied before VAT and fee decisions exist).
   */
  bookingPriceLabel: string;
  /** Informational only, no arithmetic (docs/09 §21.10). */
  offerLine?: string;
  /** Absent in real composition until the certified confirmation snapshot
   *  exposes policy content (D-8) — the section hides. */
  policy?: CancellationPolicy;
  /**
   * RI-3 — the AUTHORITATIVE server quote this summary displays. Real
   * composition always sets it; every price line above derives from it
   * verbatim (fils → AED display only, no client arithmetic).
   */
  quote?: Quote;
  /**
   * RI-4 — set INSTEAD of `quote` for entitlement-acquisition options: the
   * authoritative S6 acquisition quote (unit-less). Checkout dispatches to
   * the purchase trail when present — the two are never both set.
   */
  acquisitionQuote?: AcquisitionQuote;
}

export interface BookingOptionsInput {
  programId: string;
  /** The shared browsing participant — used for preselection only. */
  participantId: ParticipantId;
  /** Real household participants, primary first; empty for guest. */
  participants: Participant[];
  areaId: AreaId;
  /** QA/Playwright-only deterministic failure trigger — never customer-reachable. */
  simulateFailure?: boolean;
}

export interface BookingSummaryInput {
  draft: BookingDraft;
  participants: Participant[];
  areaId: AreaId;
  simulateFailure?: boolean;
}

export interface BookingService {
  /** Undefined for unknown program ids — the screen owns the recovery state. */
  getBookingOptions(input: BookingOptionsInput): Promise<BookingOptionsPage | undefined>;
  /**
   * Undefined when the draft is incomplete or invalid (missing/full session,
   * ineligible participant) — screens redirect, never render a broken summary.
   */
  getBookingSummary(input: BookingSummaryInput): Promise<BookingSummary | undefined>;
}
