import { bookingExtras } from '@/data/mock/booking-extras';
import { programs, providers } from '@/data/mock/catalogue';
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
import type { PriceModel, Program, SessionOccurrence } from '@/types/domain';
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
function campWeekOptions(program: Program): SessionOption[] {
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

  private buildOptions(program: Program): BookingOption[] {
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

  // Implemented in Commit 14 (docs/21 §18) — the contract is declared in
  // full now so no churn lands later. Until then every draft resolves as
  // invalid and screens redirect to the flow start.
  async getBookingSummary(input: BookingSummaryInput): Promise<BookingSummary | undefined> {
    await this.delay();
    if (input.simulateFailure) throw new Error('Simulated network failure (QA only)');
    return undefined;
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

export const bookingService: BookingService = new MockBookingService();
