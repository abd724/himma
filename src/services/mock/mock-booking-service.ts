import type { FixtureProgram } from '@/data/mock/catalogue';
import { bookingExtras } from '@/data/mock/booking-extras';
import { programs, providers } from '@/data/mock/catalogue';
import { cancellationPolicies } from '@/data/mock/policies';
import { programDetailExtras } from '@/data/mock/program-details';
import { providerBranches } from '@/data/mock/provider-details';
import type {
  BookingOption,
  BookingOptionsInput,
  BookingOptionsPage,
  BookingService,
  BookingSummary,
  BookingSummaryInput,
  SessionAvailability,
  SessionOption,
} from '@/services/contracts/booking';
import { buildUpcomingSessions } from '@/services/mock/mock-details-service';
import type { PriceModel, SessionOccurrence } from '@/types/domain';
import { householdSuitability, MOCK_TODAY } from '@/utils/eligibility';
import { formatPrice } from '@/utils/price';

/**
 * Deterministic booking mock — docs/21 §11, owner decisions docs/09 §21.
 * All availability below is frontend demo data; the real backend owns
 * capacity, holds, and final validation later (docs/08 §14). Nothing here
 * reserves anything.
 */

function availabilityForSpots(spotsLeft: number | undefined): SessionAvailability {
  if (spotsLeft === undefined) return 'available';
  return spotsLeft === 0 ? 'full' : 'fewLeft';
}

function toSessionOption(occurrence: SessionOccurrence, branchLabel?: string): SessionOption {
  const availability = availabilityForSpots(occurrence.spotsLeft);
  return {
    id: occurrence.id,
    dayOffset: occurrence.dayOffset,
    dayLabel: occurrence.dayLabel,
    timeLabel: occurrence.timeLabel,
    branchLabel,
    availability,
    spotsLeft: availability === 'fewLeft' ? occurrence.spotsLeft : undefined,
  };
}

/**
 * Customer price line per option — cadence-labelled for recurring shapes
 * (docs/09 §21.7), never a charged-today phrasing (docs/09 §21.10).
 */
function optionPriceLabel(price: PriceModel): string {
  const amount = formatPrice(price).amount;
  if (price.kind === 'from') return amount;
  switch (price.kind) {
    case 'dropIn':
      return `${amount} per session`;
    case 'monthly':
      return `${amount} per month`;
    case 'term':
      return `${amount} per term`;
    case 'camp':
      return `${amount} per week`;
    case 'package':
      return `${amount} for ${price.sessions} sessions`;
    case 'free':
    case 'freeTrial':
      return 'Free';
  }
}

/**
 * Camp week options — docs/09 §21.7: camps book at week granularity. The
 * default single week derives from the "10–14 August · 9 AM–1 PM" schedule
 * label; multi-week camps override via booking extras.
 */
function campWeekOptions(program: FixtureProgram): SessionOption[] {
  const timeLabel = program.scheduleLabel.split('·')[1]?.trim() ?? '';
  const explicit = bookingExtras[program.id]?.campWeeks;
  if (explicit !== undefined) {
    return explicit.map((week) => ({
      id: `${program.id}-week-${week.startOffset}`,
      dayOffset: week.startOffset,
      dayLabel: week.label,
      timeLabel,
      availability: 'available' as const,
    }));
  }
  const match = /^(\d+)–(\d+) August/.exec(program.scheduleLabel);
  if (match === null) return [];
  const start = Number(match[1]);
  if (start < MOCK_TODAY.day) return [];
  return [
    {
      id: `${program.id}-week-${start - MOCK_TODAY.day}`,
      dayOffset: start - MOCK_TODAY.day,
      dayLabel: `Week of ${match[1]}–${match[2]} Aug`,
      timeLabel,
      availability: 'available',
    },
  ];
}

/**
 * Selection-block wording per program type — docs/21 §5, §8.4. Dated options
 * summarize the chosen session/week; dateless options carry their plan
 * orientation lines (schedule, start) unchanged from the option builder.
 */
function summarySelectionLines(
  option: BookingOption,
  session: SessionOption | undefined,
): string[] {
  if (session !== undefined) {
    const dated = `${session.dayLabel} · ${session.timeLabel}`;
    return session.branchLabel === undefined ? [dated] : [dated, session.branchLabel];
  }
  return option.detailLines;
}

/**
 * Price-block line per type — docs/21 §9. One line, catalogue price only:
 * no VAT, no fees, no discount arithmetic (docs/09 §21.10).
 */
function summaryPriceLine(
  program: FixtureProgram,
  option: BookingOption,
  session: SessionOption | undefined,
): { label: string; value: string } {
  const amount = formatPrice(program.price).amount;
  switch (option.kind) {
    case 'single-session':
      return { label: '1 session', value: amount };
    case 'free-session':
      return { label: 'Free activity', value: 'Free' };
    case 'trial':
      // 'Free' or the structured trial amount ('AED 35') — never parsed
      // from the offer label (docs/21 §9).
      return option.priceLabel === 'Free'
        ? { label: 'Free trial session', value: 'Free' }
        : { label: 'Trial session', value: option.priceLabel };
    case 'recurring':
      return { label: 'Monthly enrolment', value: `${amount} per month` };
    case 'term':
      return { label: 'Term enrolment', value: `${amount} per term` };
    case 'camp-week':
      return { label: `1 week · ${session?.dayLabel ?? ''}`, value: `${amount} per week` };
    case 'membership':
    case 'package':
      // 'Package of N sessions' — size and price only (docs/09 §21.7).
      return { label: option.title, value: amount };
  }
}

/**
 * The summary amount label — docs/09 §21.11: always `Booking price`, never
 * `Total`, so no legally final checkout total is implied before VAT and fee
 * decisions exist. Cadences stay cadence-labelled (docs/09 §21.10).
 */
function summaryBookingPriceLabel(program: FixtureProgram, option: BookingOption): string {
  const amount = formatPrice(program.price).amount;
  switch (option.kind) {
    case 'single-session':
      return `Booking price · ${amount} per session`;
    case 'free-session':
      return 'Booking price · Free';
    case 'trial':
      return `Booking price · ${option.priceLabel}`;
    case 'recurring':
      return `Booking price · ${amount} per month`;
    case 'term':
      return `Booking price · ${amount} per term`;
    case 'camp-week':
      return `Booking price · ${amount} per week`;
    case 'membership':
    case 'package':
      return `Booking price · ${amount}`;
  }
}

export class MockBookingService implements BookingService {
  constructor(private readonly delayMs: number = 300) {}

  async getBookingOptions(input: BookingOptionsInput): Promise<BookingOptionsPage | undefined> {
    await this.delay();
    if (input.simulateFailure) throw new Error('Simulated network failure (QA only)');
    return this.buildBookingOptions(input);
  }

  /** Pure and synchronous so behavior is directly testable. */
  buildBookingOptions(input: BookingOptionsInput): BookingOptionsPage | undefined {
    const program = programs.find((entry) => entry.id === input.programId);
    if (program === undefined) return undefined;
    const provider = providers.find((entry) => entry.id === program.providerId);
    const extras = programDetailExtras[program.id];
    if (provider === undefined || extras === undefined) return undefined;

    const branch = providerBranches[provider.id]?.find(
      (entry) => entry.id === extras.branchId,
    );
    const householdEligibility = householdSuitability(program.eligibility, input.participants);
    // docs/21 §2: preselect the browsing participant only when it is a real
    // participant and eligible — never `everyone`, never an ineligible one.
    const preselectedParticipantId = householdEligibility.find(
      (entry) => entry.participantId === input.participantId && entry.suitable,
    )?.participantId;

    const base = {
      program,
      provider,
      branch,
      householdEligibility,
      preselectedParticipantId,
    };

    if (bookingExtras[program.id]?.registrationClosed === true) {
      return {
        ...base,
        availability: {
          status: 'registrationClosed',
          reason: 'Registration for this camp has closed.',
        },
        options: [],
        skipSelectionStep: false,
      };
    }

    const options = this.buildOptions(program).filter(
      (option) => !option.requiresSession || option.sessions.length > 0,
    );
    if (options.length === 0) {
      return { ...base, availability: { status: 'noSessions' }, options: [], skipSelectionStep: false };
    }

    return {
      ...base,
      availability: { status: 'bookable' },
      options,
      // docs/21 §2 skip rule: exactly one bookable option with no date choice.
      skipSelectionStep: options.length === 1 && !options[0].requiresSession,
    };
  }

  private buildOptions(program: FixtureProgram): BookingOption[] {
    const extras = programDetailExtras[program.id];
    const branchLabel = providerBranches[program.providerId]?.find(
      (entry) => entry.id === extras.branchId,
    )?.label;
    const sessions = program.isCamp
      ? campWeekOptions(program)
      : buildUpcomingSessions(program, extras, bookingExtras[program.id]).map((occurrence) =>
          toSessionOption(occurrence, branchLabel),
        );
    const nextSession = sessions.find((session) => session.availability !== 'full');
    const startLine =
      nextSession === undefined
        ? undefined
        : `Starts with the next session — ${nextSession.dayLabel}`;

    const options: BookingOption[] = [];

    // Trials first: the lowest-commitment way in, matching the details CTA.
    if (program.offer?.kind === 'freeTrial') {
      options.push({
        id: `${program.id}-trial`,
        kind: 'trial',
        title: 'Free trial session',
        priceLabel: 'Free',
        requiresSession: true,
        sessions,
        detailLines: [],
      });
    } else if (program.offer?.kind === 'paidTrial') {
      const trialAmount = bookingExtras[program.id]?.trialAmount;
      if (trialAmount !== undefined) {
        options.push({
          id: `${program.id}-trial`,
          kind: 'trial',
          title: 'Trial session',
          priceLabel: `AED ${trialAmount}`,
          requiresSession: true,
          sessions,
          detailLines: [],
        });
      }
    }

    const priceLine = optionPriceLabel(program.price);
    switch (program.price.kind) {
      case 'dropIn':
        options.push({
          id: `${program.id}-session`,
          kind: 'single-session',
          title: 'Single session',
          priceLabel: priceLine,
          requiresSession: true,
          sessions,
          detailLines: [],
        });
        break;
      case 'free':
        options.push({
          id: `${program.id}-session`,
          kind: 'free-session',
          title: 'Free session',
          priceLabel: 'Free',
          requiresSession: true,
          sessions,
          detailLines: [],
        });
        break;
      case 'monthly':
        options.push({
          id: `${program.id}-enrolment`,
          kind: 'recurring',
          title: 'Monthly enrolment',
          priceLabel: priceLine,
          requiresSession: false,
          sessions: [],
          detailLines: [program.scheduleLabel, ...(startLine === undefined ? [] : [startLine])],
        });
        break;
      case 'term':
        options.push({
          id: `${program.id}-enrolment`,
          kind: 'term',
          title: 'Term enrolment',
          priceLabel: priceLine,
          requiresSession: false,
          sessions: [],
          detailLines: [program.scheduleLabel, ...(startLine === undefined ? [] : [startLine])],
        });
        break;
      case 'camp':
        options.push({
          id: `${program.id}-week`,
          kind: 'camp-week',
          title: 'Camp week',
          priceLabel: priceLine,
          requiresSession: true,
          sessions,
          detailLines: [],
        });
        break;
      case 'package':
        options.push({
          id: `${program.id}-package`,
          kind: 'package',
          title: `Package of ${program.price.sessions} sessions`,
          priceLabel: priceLine,
          requiresSession: false,
          // Schedule orientation only — no expiry or redemption rules
          // (docs/09 §21.7).
          sessions: [],
          detailLines: [program.scheduleLabel],
        });
        break;
      case 'freeTrial':
        // Unused price kind in the catalogue (docs/21 §12 gap note); trials
        // are represented as offers above.
        break;
    }

    return options;
  }

  async getBookingSummary(input: BookingSummaryInput): Promise<BookingSummary | undefined> {
    await this.delay();
    if (input.simulateFailure) throw new Error('Simulated network failure (QA only)');
    return this.buildBookingSummary(input);
  }

  /**
   * Pure and synchronous so behavior is directly testable. Re-validates the
   * whole draft against the same options derivation the flow rendered from
   * (docs/21 §11): unknown program, missing/unknown option, missing or full
   * session, and missing/ineligible participants all resolve undefined —
   * screens redirect, a broken summary can never compose.
   */
  buildBookingSummary(input: BookingSummaryInput): BookingSummary | undefined {
    const { draft } = input;
    if (draft.optionId === undefined || draft.participantId === undefined) return undefined;

    const page = this.buildBookingOptions({
      programId: draft.programId,
      participantId: draft.participantId,
      participants: input.participants,
      areaId: input.areaId,
    });
    if (page === undefined || page.availability.status !== 'bookable') return undefined;

    // The option must belong to this program's current derivation — a draft
    // carried over from any other program can never resolve.
    const option = page.options.find((entry) => entry.id === draft.optionId);
    if (option === undefined) return undefined;

    let session: SessionOption | undefined;
    if (option.requiresSession) {
      session = option.sessions.find((entry) => entry.id === draft.sessionId);
      if (session === undefined || session.availability === 'full') return undefined;
    }

    // Eligibility re-asserted at build time (docs/21 §8.3) — the §6 check is
    // authoritative here too, not just on the participant step.
    const participant = page.householdEligibility.find(
      (entry) => entry.participantId === draft.participantId,
    );
    if (participant === undefined || !participant.suitable) return undefined;

    const policy = cancellationPolicies[programDetailExtras[draft.programId].policyId];
    if (policy === undefined) return undefined;

    // Discount/promo offers stay informational lines with no arithmetic
    // (docs/09 §21.10); trial offers are booking options, not offer lines.
    const offer = page.program.offer;
    const offerLine =
      offer !== undefined && (offer.kind === 'discount' || offer.kind === 'promo')
        ? offer.label
        : undefined;

    return {
      program: page.program,
      provider: page.provider,
      branch: page.branch,
      participant,
      option,
      session,
      selectionLines: summarySelectionLines(option, session),
      // The mock page is always built from fixture rows.
      priceLines: [summaryPriceLine(page.program as FixtureProgram, option, session)],
      bookingPriceLabel: summaryBookingPriceLabel(page.program as FixtureProgram, option),
      offerLine,
      policy,
    };
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

export const bookingService: BookingService = new MockBookingService();
