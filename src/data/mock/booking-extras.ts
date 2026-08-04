/**
 * Booking-specific mock extras — docs/21 §12. Sparse keyed overrides only;
 * the catalogue arrays stay frozen (36 programs, 11 providers, original
 * order) and `program-details.ts` stays the home of evaluation-surface data.
 *
 * Everything here is deterministic frontend demo data behind the
 * BookingService boundary — never presented to the customer as live
 * availability (docs/08 §14).
 */
export interface BookingExtras {
  /** Structured paid-trial price — no parsing offer labels (docs/21 §9). */
  trialAmount?: number;
  /** Program-level closed state (docs/21 §7). */
  registrationClosed?: boolean;
  /**
   * Per-occurrence places by derived-session index; 0 = full. Supersedes the
   * single first-occurrence `spotsLeft` in program-details extras where an
   * index is present. Feeds the shared derivation so Program Details and the
   * booking flow can never disagree (docs/09 §21.5).
   */
  sessionSpots?: Record<number, number>;
  /**
   * Session-requiring no-sessions demo (docs/21 §4). Feeds the shared
   * derivation, so Program Details shows its honest empty-sessions message
   * for the same program — one availability truth on both surfaces.
   */
  noUpcomingSessions?: boolean;
  /**
   * Camp week options where a camp offers more than one start week.
   * Absent = a single week derived from the schedule label.
   */
  campWeeks?: { startOffset: number; label: string }[];
}

export const bookingExtras: Record<string, BookingExtras> = {
  // Paid trial price as structured data (offer label: "Trial session AED 35").
  'junior-football-u10': { trialAmount: 35 },
  // Registration-closed entry state demo (docs/21 §4).
  'teen-arabic-summer': { registrationClosed: true },
  // Full-session demo: today's 6:45 AM class is full; later days are open.
  'morning-yoga': { sessionSpots: { 0: 0 } },
  // Session-requiring no-sessions demo: the weekend circle is between blocks.
  'sunrise-breathwork': { noUpcomingSessions: true },
  // "10–28 August" genuinely spans three camp weeks — honest week selection.
  'active-summer-camp': {
    campWeeks: [
      { startOffset: 8, label: 'Week of 10–14 Aug' },
      { startOffset: 15, label: 'Week of 17–21 Aug' },
      { startOffset: 22, label: 'Week of 24–28 Aug' },
    ],
  },
};
