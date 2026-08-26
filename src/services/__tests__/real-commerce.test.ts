/**
 * RI-3 — the real booking/checkout composition over API doubles: options
 * from real listing+availability truth, the S6 product boundary
 * (packages are visible but NEVER purchasable), the summary displaying
 * the server quote VERBATIM, and the checkout page derived from that
 * same quote (free vs paid).
 */
import { describe, expect, it } from '@jest/globals';
import type {
  AvailabilityUnitDto,
  DiscoveryApi,
  ListingDetailDto,
} from '@/services/api/discovery-api';
import {
  composeCheckoutPage,
  createRealBookingService,
  filsLabel,
} from '@/services/api/real-commerce-services';
import type { CommerceApi, Quote, QuoteRequest } from '@/services/contracts/commerce';
import type { Participant } from '@/types/domain';

const ME: Participant = { id: 'part-self', label: 'Me', kind: 'self' };

function listing(overrides: Partial<ListingDetailDto> = {}): ListingDetailDto {
  return {
    id: 'prog-1',
    titleEn: 'Adult Padel Open Play',
    titleAr: null,
    descriptionEn: 'desc',
    descriptionAr: null,
    setting: 'indoor',
    minAge: 16,
    maxAge: null,
    allAges: false,
    genderEligibility: 'mixed',
    skillLevel: null,
    eligibilityNotes: null,
    category: { id: 'cat', slug: 'padel-racquet', labelEn: 'Padel & racquet', labelAr: null },
    activityType: { id: 'type', slug: 'padel', labelEn: 'Padel', labelAr: null },
    provider: { id: 'org-1', displayName: 'Coastal Padel Club' },
    branches: [
      {
        id: 'branch-1',
        label: 'Al Raha Courts',
        addressLine: '14 Marina Promenade',
        areaLabel: 'Al Raha',
        geoPoint: null,
        openingHours: null,
        facilities: [],
      },
    ],
    media: [],
    priceOptions: [
      {
        id: 'po-dropin',
        kind: 'dropIn',
        amountFils: 9000,
        currency: 'AED',
        sessionsCount: null,
        labelEn: null,
        labelAr: null,
      },
      {
        id: 'po-pack',
        kind: 'package',
        amountFils: 76000,
        currency: 'AED',
        sessionsCount: 10,
        labelEn: '10-class pack',
        labelAr: null,
      },
    ],
    offers: [],
    fromPrice: { kind: 'from', amountFils: 9000, currency: 'AED' },
    ...overrides,
  };
}

const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();

function units(): AvailabilityUnitDto[] {
  return [
    {
      unitId: 'unit-1',
      kind: 'session',
      branchId: 'branch-1',
      startAt: FUTURE,
      endAt: null,
      startDate: null,
      endDate: null,
      effectiveStart: null,
      effectiveEnd: null,
      registrationCutoffAt: FUTURE,
      availability: 'available',
    },
    {
      unitId: 'unit-closed',
      kind: 'session',
      branchId: 'branch-1',
      startAt: FUTURE,
      endAt: null,
      startDate: null,
      endDate: null,
      effectiveStart: null,
      effectiveEnd: null,
      registrationCutoffAt: FUTURE,
      availability: 'closed',
    },
  ];
}

function doubles(quoteTotalFils: number) {
  const quoteRequests: QuoteRequest[] = [];
  const discovery = {
    async getListing() {
      return listing();
    },
    async getAvailability() {
      return units();
    },
    async getStorefront() {
      return { verified: true } as never;
    },
  } as unknown as DiscoveryApi;
  const commerce = {
    async requestQuote(input: QuoteRequest): Promise<Quote> {
      quoteRequests.push(input);
      return {
        quoteId: 'quote-1',
        programId: input.programId,
        participantId: input.participantId,
        optionKind: 'dropIn',
        unitKind: input.unitKind,
        unitId: input.unitId,
        totalFils: quoteTotalFils,
        currency: 'AED',
        priceKind: quoteTotalFils === 0 ? 'free' : 'oneOff',
        taxTreatment: 'notConfigured',
        lines: [
          { lineNo: 1, kind: 'base', labelEn: '1 session', amountFils: quoteTotalFils },
        ],
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
    },
  } as unknown as CommerceApi;
  return { discovery, commerce, quoteRequests };
}

describe('real booking options', () => {
  it('composes real options; the S6 package is VISIBLE but never purchasable; closed sessions are not selectable', async () => {
    const { discovery, commerce } = doubles(9000);
    const service = createRealBookingService(discovery, commerce);
    const page = await service.getBookingOptions({
      programId: 'prog-1',
      participantId: 'everyone',
      participants: [ME],
      areaId: '',
    });
    expect(page).toBeDefined();
    const dropIn = page!.options.find((option) => option.id === 'po-dropin')!;
    expect(dropIn.kind).toBe('single-session');
    expect(dropIn.priceLabel).toBe('AED 90 per session');
    expect(dropIn.sessions.map((session) => session.id)).toEqual(['unit-1']); // closed excluded
    const pack = page!.options.find((option) => option.id === 'po-pack')!;
    expect(pack.purchasable).toBe(false);
    expect(pack.unavailableNote).toContain('Coming soon');
    expect(pack.priceLabel).toBe('AED 760 for 10 sessions');
    expect(page!.availability.status).toBe('bookable');
  });
});

describe('real summary + checkout derivation', () => {
  const draft = {
    programId: 'prog-1',
    optionId: 'po-dropin',
    sessionId: 'unit-1',
    participantId: 'part-self',
  };

  it('the summary displays the SERVER quote verbatim and carries it forward', async () => {
    const { discovery, commerce, quoteRequests } = doubles(9000);
    const service = createRealBookingService(discovery, commerce);
    const summary = await service.getBookingSummary({
      draft,
      participants: [ME],
      areaId: '',
    });
    expect(summary).toBeDefined();
    expect(quoteRequests[0]).toMatchObject({
      programId: 'prog-1',
      priceOptionId: 'po-dropin',
      unitId: 'unit-1',
      participantId: 'part-self',
    });
    expect(summary!.quote?.totalFils).toBe(9000);
    expect(summary!.bookingPriceLabel).toBe('Booking price · AED 90');
    expect(summary!.priceLines).toEqual([{ label: '1 session', value: 'AED 90' }]);
    // No policy is invented (the certified snapshot arrives later).
    expect(summary!.policy).toBeUndefined();
  });

  it('checkout derives from THAT summary: paid → payment required; free → certified free path, no methods', async () => {
    const paid = doubles(9000);
    const paidService = createRealBookingService(paid.discovery, paid.commerce);
    const paidSummary = (await paidService.getBookingSummary({
      draft,
      participants: [ME],
      areaId: '',
    }))!;
    const paidPage = composeCheckoutPage(paidSummary, [ME])!;
    expect(paidPage.paymentRequired).toBe(true);
    expect(paidPage.ctaLabel).toBe('Continue to payment');
    expect(paidPage.paymentMethods).toHaveLength(1);
    expect(paidPage.price.bookingPriceLabel).toBe('Booking price · AED 90');

    const free = doubles(0);
    const freeService = createRealBookingService(free.discovery, free.commerce);
    const freeSummary = (await freeService.getBookingSummary({
      draft,
      participants: [ME],
      areaId: '',
    }))!;
    const freePage = composeCheckoutPage(freeSummary, [ME])!;
    expect(freePage.paymentRequired).toBe(false);
    expect(freePage.ctaLabel).toBe('Confirm booking');
    expect(freePage.paymentMethods).toHaveLength(0);
    expect(freePage.price.priceKind).toBe('free');
  });

  it('fils render as display strings only — no client price arithmetic beyond /100', () => {
    expect(filsLabel(9000)).toBe('AED 90');
    expect(filsLabel(76050)).toBe('AED 760.5');
  });
});
