/**
 * RI-4 — the customer PASSES & MEMBERSHIPS contract over the certified S6
 * backend (docs/35 §8/§9/§13; docs/24 Amendments A4–A6): entitlement
 * acquisition (free + paid W5), the Passes projections, entitlement
 * reservation over the certified S5 hold, redemption credentials, and the
 * bounded unified Calendar read (RI-5: the customer's cross-provider
 * schedule surface; also camp/cohort check-in occurrence selection).
 *
 * Truth rules (binding):
 * - Every number here is SERVER-derived. The app never computes `used`,
 *   `remaining`, `reservedUpcoming`, or `availableToReserve` locally, never
 *   decrements a balance optimistically, and never constructs a canonical
 *   occurrence — occurrence identity comes verbatim from the server
 *   projection (docs/35 §28).
 * - `remaining` and `availableToReserve` are DIFFERENT truths: a credit can
 *   be unconsumed yet committed to an upcoming reservation. Presentation
 *   may simplify, but may never conflate them.
 * - The numeric display code and the opaque token are CREDENTIAL SECRETS:
 *   they exist once in the issuance response, live only in memory/UI, and
 *   are never persisted, logged, or re-fetchable (a same-key replay returns
 *   metadata WITHOUT secrets — recovery is explicit regeneration).
 * - No commission, provider share, revision id, digest, or payment
 *   internals exist anywhere in these models.
 */

export type EntitlementUsageKind = 'finite' | 'unlimited';
export type EntitlementStatus = 'active' | 'exhausted' | 'expired';

/** The four SERVER-derived finite truths (docs/35 §8) — displayed, never
 *  recomputed. `remaining = usesTotal − used`; `availableToReserve`
 *  additionally subtracts live reservation commitments. */
export interface FiniteBalance {
  usesTotal: number;
  used: number;
  remaining: number;
  reservedUpcoming: number;
  availableToReserve: number;
}

export interface EntitlementScheduleTerm {
  weekday: number; // 0 = Sunday … 6 = Saturday
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

/** One of the customer's own Passes/Memberships — the certified S6-3
 *  projection, verbatim. */
export interface CustomerEntitlement {
  entitlementId: string;
  participant: { id: string; firstName: string };
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  productLabel: string;
  optionKind: string;
  usageKind: EntitlementUsageKind;
  /** SERVER status authority — never inferred from device time. */
  status: EntitlementStatus;
  validFrom: string;
  validUntil: string | null;
  walkInAllowed: boolean;
  reservationRequired: boolean;
  /** Finite products only — unlimited passes carry NO counters. */
  finite?: FiniteBalance;
  scheduleTerms: EntitlementScheduleTerm[];
  nextReservedSessionAt: string | null;
}

export interface EntitlementAttendanceRow {
  attendanceId: string;
  occurredAt: string;
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  sessionStartAt: string | null;
  targetKind: string;
}

/** The authenticated Entitlement-specific reservable projection — seat
 *  availability and CREDIT availability arrive separately (docs/35 §8). */
export interface ReservableSession {
  sessionId: string;
  branchId: string;
  startAt: string;
  endAt: string;
  registrationCutoffAt: string;
  availability: 'available' | 'fewLeft' | 'full' | 'closed';
  spotsLeft?: number;
}

/** The zero-total reservation quote — bound server-side to the exact
 *  Entitlement; never a payment object. */
export interface ReservationQuote {
  quoteId: string;
  entitlementId: string;
  sessionId: string;
  totalFils: 0;
  expiresAt: string;
  finite?: FiniteBalance;
}

export interface ConfirmedReservation {
  bookingId: string;
  referenceCode: string;
  entitlementId: string;
  sessionId: string;
  confirmedAt: string;
  finite?: FiniteBalance;
}

// ---------------------------------------------------------------------------
// Acquisition (S6-1 + W5): the unit-less purchase trail — NEVER a Booking.
// ---------------------------------------------------------------------------

export interface AcquisitionFulfillmentTerms {
  usageKind: EntitlementUsageKind;
  usesTotal?: number;
  validityKind: 'daysFromConfirmation' | 'fixedEndDate' | 'none';
  validityDays?: number;
  validityEndDate?: string;
  reservationRequired: boolean;
  walkInAllowed: boolean;
}

/** The authoritative server acquisition quote — displayed verbatim. */
export interface AcquisitionQuote {
  quoteId: string;
  programId: string;
  participantId: string;
  optionKind: string;
  totalFils: number;
  currency: 'AED';
  lines: { lineNo: number; kind: 'base'; labelEn: string; amountFils: number }[];
  expiresAt: string;
  fulfillment: AcquisitionFulfillmentTerms;
}

export interface EntitlementPurchaseView {
  purchaseId: string;
  referenceCode: string | null;
  state: string;
  programId: string;
  participantId: string;
  totalFils: number;
  confirmedAt: string | null;
  entitlement?: { entitlementId: string };
}

/** The W5 hosted-checkout start for a PAID acquisition — navigation only. */
export interface AcquisitionCheckoutStart {
  purchaseId: string;
  redirectUrl: string;
  expiresAt: string;
}

/** The converged D-RI-5 payment vocabulary — shared with Bookings. */
export interface AcquisitionPaymentStatus {
  status:
    | 'awaitingPayment'
    | 'processing'
    | 'confirmed'
    | 'expired'
    | 'compensationPending'
    | 'compensated';
  purchaseExpiresAt?: string;
  referenceCode?: string;
}

// ---------------------------------------------------------------------------
// Redemption credentials (S6-2/0020)
// ---------------------------------------------------------------------------

/** The canonical scheduled occurrence a multi-occurrence Booking credential
 *  targets — SERVER-derived values passed back verbatim, never constructed
 *  by the app (docs/35 §29). */
export interface OccurrenceSelection {
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
}

/** A freshly issued (or replayed) credential. `displayCode`/`token` are
 *  present ONLY on the executing issuance — treat as secrets. */
export interface IssuedCredential {
  credentialId: string;
  state: 'live';
  expiresAt: string;
  displayCode?: string;
  token?: string;
  replayed: boolean;
}

/** Initial issuance found a live credential: metadata only, NO secret —
 *  recovery is explicit regeneration by id (S6-2 rules A/E). */
export interface CredentialAlreadyLive {
  credentialId: string;
  expiresAt: string;
  alreadyLive: true;
}

export type IssueCredentialOutcome =
  | { kind: 'issued'; credential: IssuedCredential }
  | { kind: 'alreadyLive'; credential: CredentialAlreadyLive };

export interface CredentialStatus {
  credentialId: string;
  /** EFFECTIVE server state — a lapsed live credential reads `expired`. */
  state: 'live' | 'used' | 'superseded' | 'expired';
  expiresAt: string;
  redeemedAt?: string;
  /** The frozen canonical occurrence (camp/cohort credentials). */
  occurrence?: OccurrenceSelection;
}

// ---------------------------------------------------------------------------
// The bounded unified Calendar read (S6-3 §12; RI-5) — the ONE aggregation
// authority for the customer's cross-provider schedule. The server derives
// every event (confirmed Session Bookings, camp daily occurrences, cohort
// recurring occurrences minus exceptions, immutable membership schedule
// occurrences); the app renders the list verbatim and NEVER merges
// Bookings/Passes/recurring rules into a competing calendar client-side.
// RI-4 additionally uses it for camp/cohort check-in occurrence selection.
// ---------------------------------------------------------------------------

export type CalendarSourceType =
  | 'sessionBooking'
  | 'campWeekOccurrence'
  | 'cohortOccurrence'
  | 'membershipOccurrence';

/** Customer-facing meaning: an ordinarily booked activity, a session
 *  included with a Pass (`reservedWithPass` — ONE event, never a Booking
 *  event plus a Pass event), or a purchased membership schedule occurrence
 *  (`includedSchedule`). */
export type CalendarEventContext = 'booked' | 'reservedWithPass' | 'includedSchedule';

export interface CalendarOccurrence {
  /** OPAQUE server identity — usable as a React key / for deduplication
   *  ONLY. The app never parses its components; the canonical occurrence
   *  authority arrives in the explicit `occurrence` field below and
   *  navigation uses the explicit `bookingId`/`entitlementId`. */
  eventKey: string;
  sourceType: CalendarSourceType;
  context: CalendarEventContext;
  participant: { id: string; firstName: string };
  program: { id: string; titleEn: string };
  provider: { id: string; displayName: string };
  branch: { id: string; label: string } | null;
  startAt: string;
  endAt: string;
  /** CampWeek presentation metadata: the overall span each daily
   *  occurrence belongs to — never a replacement for occurrence truth and
   *  never a source to generate dates from. */
  span?: { startDate: string; endDate: string; dailyStartTime: string; dailyEndTime: string };
  /** The EXPLICIT canonical occurrence pair (camp/cohort Booking
   *  occurrences) — authored by the backend occurrence authority and
   *  passed back to credential issuance VERBATIM: no parsing, no timezone
   *  arithmetic, no reconstruction. */
  occurrence?: OccurrenceSelection;
  bookingId?: string;
  entitlementId?: string;
}

export interface EntitlementsApi {
  listEntitlements(input?: { limit?: number; cursor?: string }): Promise<{
    entitlements: CustomerEntitlement[];
    nextCursor: string | null;
  }>;
  getEntitlement(entitlementId: string): Promise<CustomerEntitlement | undefined>;
  listAttendance(
    entitlementId: string,
    input?: { limit?: number; cursor?: string },
  ): Promise<{ attendance: EntitlementAttendanceRow[]; nextCursor: string | null }>;
  listReservableSessions(
    entitlementId: string,
    input?: { from?: string; to?: string },
  ): Promise<{ sessions: ReservableSession[]; finite?: FiniteBalance }>;
  requestReservationQuote(entitlementId: string, sessionId: string): Promise<ReservationQuote>;
  confirmReservation(holdId: string, idempotencyKey: string): Promise<ConfirmedReservation>;

  requestAcquisitionQuote(input: {
    programId: string;
    priceOptionId: string;
    participantId: string;
  }): Promise<AcquisitionQuote>;
  confirmFreeAcquisition(quoteId: string, idempotencyKey: string): Promise<EntitlementPurchaseView>;
  initiateAcquisition(quoteId: string, idempotencyKey: string): Promise<AcquisitionCheckoutStart>;
  acquisitionPaymentStatus(purchaseId: string): Promise<AcquisitionPaymentStatus>;
  getPurchase(purchaseId: string): Promise<EntitlementPurchaseView | undefined>;

  issueBookingCredential(
    bookingId: string,
    input: {
      idempotencyKey: string;
      occurrence?: OccurrenceSelection;
      regenerateCredentialId?: string;
    },
  ): Promise<IssueCredentialOutcome>;
  issueEntitlementCredential(
    entitlementId: string,
    input: { idempotencyKey: string; regenerateCredentialId?: string },
  ): Promise<IssueCredentialOutcome>;
  credentialStatus(credentialId: string): Promise<CredentialStatus | undefined>;

  /** The bounded unified Calendar read — max 62 days per request; the
   *  server is the one aggregation/deduplication authority. */
  listOccurrences(input: { from: string; to: string }): Promise<CalendarOccurrence[]>;
}
