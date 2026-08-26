/**
 * RI-3 — REAL implementations of the booking/checkout page contracts over
 * the certified backend: options compose from the public listing + the
 * D-RI-4 availability projection; the summary displays the AUTHORITATIVE
 * server quote verbatim; checkout derives from that same summary. No
 * client-side price arithmetic exists anywhere here — fils become display
 * strings and nothing else.
 *
 * S6 boundary (owner RI-3 §23): package/pass/membership price options are
 * composed as NON-purchasable rows ('Coming soon') — never forced into a
 * capacity Booking.
 */
import type { DiscoveryApi, ListingDetailDto, PriceOptionDto } from '@/services/api/discovery-api';
import {
  toDetailProgram,
  toProviderBranch,
  toSessionOccurrences,
} from '@/services/api/discovery-mapping';
import type {
  BookingOption,
  BookingOptionsInput,
  BookingOptionsPage,
  BookingService,
  BookingSummary,
  BookingSummaryInput,
  SessionOption,
} from '@/services/contracts/booking';
import type { CheckoutPage } from '@/services/contracts/checkout';
import type { CommerceApi, CommerceUnitKind, Quote } from '@/services/contracts/commerce';
import type { Participant, Provider } from '@/types/domain';
import { currentDateParts, participantSuitability } from '@/utils/eligibility';
import { spokenLabel } from '@/utils/price';

/** Display-only fils→AED formatting (integer fils; no arithmetic beyond /100). */
export function filsLabel(amountFils: number): string {
  const aed = amountFils / 100;
  return `AED ${aed.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const OPTION_UNIT_KIND: Record<string, CommerceUnitKind> = {
  dropIn: 'session',
  free: 'session',
  camp: 'campWeek',
  monthly: 'enrolmentCohort',
  term: 'enrolmentCohort',
};

function optionTitle(option: PriceOptionDto): string {
  if (option.labelEn !== null && option.labelEn !== '') return option.labelEn;
  switch (option.kind) {
    case 'dropIn':
      return 'Single session';
    case 'free':
      return 'Free session';
    case 'camp':
      return 'Camp week';
    case 'monthly':
      return 'Monthly enrolment';
    case 'term':
      return 'Term enrolment';
    case 'package':
      return 'Session package';
    default:
      return 'Activity';
  }
}

function optionPriceLabel(option: PriceOptionDto): string {
  if (option.kind === 'free') return 'Free';
  if (option.amountFils === null) return '';
  const amount = filsLabel(option.amountFils);
  switch (option.kind) {
    case 'dropIn':
      return `${amount} per session`;
    case 'camp':
      return `${amount} per week`;
    case 'monthly':
      return `${amount} per month`;
    case 'term':
      return `${amount} per term`;
    case 'package':
      return option.sessionsCount === null
        ? amount
        : `${amount} for ${option.sessionsCount} sessions`;
    default:
      return amount;
  }
}

/** Availability occurrences → selectable session rows. Closed registration
 *  is not selectable; full stays VISIBLE (disabled by the screens). */
function toSessionOptions(
  occurrences: ReturnType<typeof toSessionOccurrences>,
): SessionOption[] {
  return occurrences
    .filter((occurrence) => occurrence.availability !== 'closed')
    .map((occurrence) => ({
      id: occurrence.id,
      dayOffset: occurrence.dayOffset,
      dayLabel: occurrence.dayLabel,
      timeLabel: occurrence.timeLabel,
      ...(occurrence.branchLabel !== undefined ? { branchLabel: occurrence.branchLabel } : {}),
      availability:
        occurrence.availability === 'fewLeft'
          ? ('fewLeft' as const)
          : occurrence.availability === 'full'
            ? ('full' as const)
            : ('available' as const),
      ...(occurrence.spotsLeft !== undefined ? { spotsLeft: occurrence.spotsLeft } : {}),
    }));
}

interface ComposedOptions {
  listing: ListingDetailDto;
  options: BookingOption[];
}

async function composeOptions(
  api: DiscoveryApi,
  programId: string,
): Promise<ComposedOptions | undefined> {
  const listing = await api.getListing(programId);
  if (listing === undefined) return undefined;
  const branchLabelById = new Map(listing.branches.map((branch) => [branch.id, branch.label]));

  // One availability read per unit kind the active options imply.
  const kinds = new Set<CommerceUnitKind>();
  for (const option of listing.priceOptions) {
    const kind = OPTION_UNIT_KIND[option.kind];
    if (kind !== undefined) kinds.add(kind);
  }
  if (listing.offers.length > 0) kinds.add('session');
  const sessionsByKind = new Map<CommerceUnitKind, SessionOption[]>();
  await Promise.all(
    [...kinds].map(async (kind) => {
      const units = (await api.getAvailability(programId, kind)) ?? [];
      sessionsByKind.set(kind, toSessionOptions(toSessionOccurrences(units, branchLabelById)));
    }),
  );

  const options: BookingOption[] = [];
  for (const option of listing.priceOptions) {
    if (option.kind === 'package') {
      // S6 boundary: representable, browsable, NOT purchasable yet.
      options.push({
        id: option.id,
        kind: 'package',
        title: optionTitle(option),
        priceLabel: optionPriceLabel(option),
        priceOptionId: option.id,
        purchasable: false,
        unavailableNote: 'Coming soon — not yet bookable in the app',
        requiresSession: false,
        sessions: [],
        detailLines: [],
      });
      continue;
    }
    const unitKind = OPTION_UNIT_KIND[option.kind];
    if (unitKind === undefined) continue; // unknown future kinds never fake a flow
    const sessions = sessionsByKind.get(unitKind) ?? [];
    options.push({
      id: option.id,
      kind:
        option.kind === 'dropIn'
          ? 'single-session'
          : option.kind === 'free'
            ? 'free-session'
            : option.kind === 'camp'
              ? 'camp-week'
              : option.kind === 'monthly'
                ? 'recurring'
                : 'term',
      title: optionTitle(option),
      priceLabel: optionPriceLabel(option),
      priceOptionId: option.id,
      unitKind,
      requiresSession: true,
      sessions,
      detailLines: [],
    });
  }

  // Provider trial Offers ride a base price option + session selection; the
  // server quote applies the trial pricing (D-10 redemption stays server
  // authority — `trialAlreadyRedeemed` maps to customer copy).
  const baseForTrial = listing.priceOptions.find(
    (option) => OPTION_UNIT_KIND[option.kind] !== undefined,
  );
  if (baseForTrial !== undefined) {
    for (const offer of listing.offers) {
      if (offer.kind !== 'freeTrial' && offer.kind !== 'paidTrial') continue;
      const sessions = sessionsByKind.get('session') ?? [];
      if (sessions.length === 0) continue;
      options.push({
        id: `offer-${offer.id}`,
        kind: 'trial',
        title: offer.labelEn !== '' ? offer.labelEn : 'Trial session',
        priceLabel:
          offer.kind === 'freeTrial'
            ? 'Free'
            : offer.trialAmountFils !== null
              ? filsLabel(offer.trialAmountFils)
              : '',
        priceOptionId: baseForTrial.id,
        offerId: offer.id,
        unitKind: 'session',
        requiresSession: true,
        sessions,
        detailLines: [],
      });
    }
  }
  return { listing, options };
}

function toEligibility(
  listing: ListingDetailDto,
  participants: Participant[],
): BookingOptionsPage['householdEligibility'] {
  const today = currentDateParts();
  const eligibility = {
    ...(listing.minAge !== null ? { minimumAge: listing.minAge } : {}),
    ...(listing.maxAge !== null ? { maximumAge: listing.maxAge } : {}),
    allAges: listing.allAges,
    genderEligibility:
      listing.genderEligibility === 'women' ? ('ladies' as const) : ('mixed' as const),
  };
  return participants
    .filter((participant) => participant.kind !== 'everyone')
    .map((participant) => participantSuitability(eligibility, participant, today));
}

export function createRealBookingService(
  api: DiscoveryApi,
  commerce: CommerceApi,
): BookingService {
  async function buildPage(
    input: BookingOptionsInput,
  ): Promise<{ page: BookingOptionsPage; listing: ListingDetailDto } | undefined> {
    const composed = await composeOptions(api, input.programId);
    if (composed === undefined) return undefined;
    const { listing, options } = composed;
    const program = toDetailProgram(listing);
    const storefront = await api.getStorefront(listing.provider.id);
    const provider: Provider = {
      id: listing.provider.id,
      name: listing.provider.displayName,
      categories: [listing.category.labelEn],
      verified: storefront?.verified ?? false,
    };
    const householdEligibility = toEligibility(listing, input.participants);
    const purchasable = options.filter((option) => option.purchasable !== false);
    const actionable = purchasable.some(
      (option) => !option.requiresSession || option.sessions.length > 0,
    );
    const availability: BookingOptionsPage['availability'] =
      options.length === 0 || (purchasable.length > 0 && !actionable)
        ? { status: 'noSessions' }
        : { status: 'bookable' };

    // docs/21 §2 preselection: the browsing participant when suitable,
    // else a single suitable household member.
    const browsing = householdEligibility.find(
      (entry) => entry.participantId === input.participantId && entry.suitable,
    );
    const suitable = householdEligibility.filter((entry) => entry.suitable);
    const preselected =
      browsing?.participantId ?? (suitable.length === 1 ? suitable[0]!.participantId : undefined);

    const firstBranch = listing.branches[0];
    const page: BookingOptionsPage = {
      program,
      provider,
      ...(firstBranch !== undefined ? { branch: toProviderBranch(firstBranch) } : {}),
      availability,
      options,
      skipSelectionStep:
        options.length === 1 &&
        options[0]!.purchasable !== false &&
        !options[0]!.requiresSession,
      householdEligibility,
      ...(preselected !== undefined ? { preselectedParticipantId: preselected } : {}),
    };
    return { page, listing };
  }

  return {
    async getBookingOptions(input) {
      const built = await buildPage(input);
      return built?.page;
    },

    async getBookingSummary(input: BookingSummaryInput): Promise<BookingSummary | undefined> {
      const { draft } = input;
      if (draft.optionId === undefined || draft.participantId === undefined) return undefined;
      const built = await buildPage({
        programId: draft.programId,
        participantId: draft.participantId,
        participants: input.participants,
        areaId: input.areaId,
      });
      if (built === undefined) return undefined;
      const { page, listing } = built;
      const option = page.options.find((entry) => entry.id === draft.optionId);
      if (option === undefined || option.purchasable === false) return undefined;
      if (option.priceOptionId === undefined || option.unitKind === undefined) return undefined;
      const session = option.sessions.find((entry) => entry.id === draft.sessionId);
      if (option.requiresSession && (session === undefined || session.availability === 'full')) {
        return undefined;
      }
      const participant = page.householdEligibility.find(
        (entry) => entry.participantId === draft.participantId && entry.suitable,
      );
      if (participant === undefined || session === undefined) return undefined;

      // THE authoritative quote — server-derived money, displayed verbatim.
      const quote: Quote = await commerce.requestQuote({
        programId: draft.programId,
        priceOptionId: option.priceOptionId,
        unitKind: option.unitKind,
        unitId: session.id,
        participantId: String(draft.participantId),
        ...(option.offerId !== undefined ? { offerId: option.offerId } : {}),
      });

      const offer = listing.offers.find((entry) => entry.id === option.offerId);
      const priceLines = quote.lines.map((line) => ({
        label: line.labelEn,
        value: line.amountFils === 0 ? 'Free' : filsLabel(line.amountFils),
      }));
      const bookingPriceLabel =
        quote.totalFils === 0
          ? 'Booking price · Free'
          : `Booking price · ${filsLabel(quote.totalFils)}`;

      return {
        program: page.program,
        provider: page.provider,
        ...(page.branch !== undefined ? { branch: page.branch } : {}),
        participant,
        option,
        session,
        selectionLines: [
          `${session.dayLabel} · ${session.timeLabel}`,
          ...(session.branchLabel !== undefined ? [session.branchLabel] : []),
        ],
        priceLines,
        bookingPriceLabel,
        ...(offer !== undefined ? { offerLine: offer.labelEn } : {}),
        quote,
      };
    },
  };
}

/**
 * Pure checkout presentation over the FLOW'S stored summary — the ONE
 * authoritative quote travels summary → hold → checkout; checkout never
 * re-derives a quote behind the customer's back (owner RI-3 §7).
 */
export function composeCheckoutPage(
  summary: BookingSummary,
  participants: Participant[],
): CheckoutPage | undefined {
  {
      if (summary.quote === undefined) return undefined;
      const quote = summary.quote;
      const free = quote.totalFils === 0;
      const bookingPriceLabel = summary.bookingPriceLabel;
      const ctaLabel = free ? ('Confirm booking' as const) : ('Continue to payment' as const);
      const participant = participants.find(
        (entry) => entry.id === summary.participant.participantId,
      );
      return {
        summary,
        price: {
          lines: quote.lines.map((line) => ({
            id: `line-${line.lineNo}`,
            kind: 'base',
            label: line.labelEn,
            value: line.amountFils === 0 ? 'Free' : filsLabel(line.amountFils),
            ...(line.amountFils > 0 ? { amount: line.amountFils / 100 } : {}),
          })),
          ...(summary.offerLine !== undefined ? { offerLine: summary.offerLine } : {}),
          priceKind: free ? 'free' : 'oneOff',
          ...(free ? {} : { amount: quote.totalFils / 100 }),
          bookingPriceLabel,
          spokenBookingPriceLabel: spokenLabel(bookingPriceLabel),
          taxTreatment: 'notConfigured',
        },
        ...(participant?.kind === 'child' ? { guardianContextLine: 'Booked by you' } : {}),
        paymentMethods: free
          ? []
          : [
              {
                id: 'card',
                kind: 'card',
                label: 'Card payment',
                availability: { status: 'contractOnly' },
              },
            ],
        paymentRequired: !free,
        validation: { ok: true },
        ctaLabel,
        spokenCtaLabel: free ? 'Confirm booking' : 'Continue to payment',
      };
  }
}
