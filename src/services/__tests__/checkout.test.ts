import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { programs } from '@/data/mock/catalogue';
import type { BookingDraft, BookingOption, BookingOptionsPage } from '@/services/contracts/booking';
import type { CheckoutPage } from '@/services/contracts/checkout';
import { MockBookingService } from '@/services/mock/mock-booking-service';
import { MockCheckoutService } from '@/services/mock/mock-checkout-service';
import type { Participant } from '@/types/domain';

const bookingService = new MockBookingService(0);
const service = new MockCheckoutService(0);

const me: Participant = { id: 'me', label: 'Me', kind: 'self' };
const adam: Participant = { id: 'adam', label: 'Adam', kind: 'child', dateOfBirth: '2018-03-14' }; // 8
const lina: Participant = { id: 'lina', label: 'Lina', kind: 'child', dateOfBirth: '2013-11-02' }; // 12
const everyone: Participant = { id: 'everyone', label: 'Everyone', kind: 'everyone' };
const household = [everyone, me, adam, lina];

function optionsFor(programId: string): BookingOptionsPage {
  const page = bookingService.buildBookingOptions({
    programId,
    participantId: 'everyone',
    participants: household,
    areaId: 'khalifa-city',
  });
  expect(page).toBeDefined();
  return page!;
}

/** A valid draft for the program — structured ids only, never guessed. */
function draftFor(
  programId: string,
  participantId: string,
  pickOption?: (options: BookingOption[]) => BookingOption,
): BookingDraft {
  const page = optionsFor(programId);
  expect(page.availability.status).toBe('bookable');
  const option = pickOption === undefined ? page.options[page.options.length - 1] : pickOption(page.options);
  const session = option.requiresSession
    ? option.sessions.find((entry) => entry.availability !== 'full')
    : undefined;
  return {
    programId,
    optionId: option.id,
    sessionId: session?.id,
    participantId,
  };
}

function pageFor(draft: BookingDraft): CheckoutPage {
  const page = service.buildCheckoutPage({ draft, participants: household, areaId: 'khalifa-city' });
  expect(page).toBeDefined();
  return page!;
}

const trialOption = (options: BookingOption[]) => options.find((entry) => entry.kind === 'trial')!;

describe('Checkout derivation per type (docs/22 §4, docs/09 §22)', () => {
  test('one-off session: reconciling amount, Booking price continuity, paid CTA', () => {
    const page = pageFor(draftFor('beginner-calisthenics', 'me'));
    expect(page.price.priceKind).toBe('oneOff');
    expect(page.price.amount).toBe(85);
    expect(page.price.lines).toHaveLength(1);
    expect(page.price.lines[0]).toMatchObject({ kind: 'base', label: '1 session', amount: 85 });
    expect(page.price.bookingPriceLabel).toBe('Booking price · AED 85 per session');
    expect(page.price.spokenBookingPriceLabel).toBe('Booking price, 85 dirhams per session');
    expect(page.paymentRequired).toBe(true);
    expect(page.ctaLabel).toBe('Continue to payment');
    expect(page.spokenCtaLabel).toBe('Continue to payment, Booking price, 85 dirhams per session');
  });

  test('package: one-off package amount', () => {
    const page = pageFor(draftFor('adult-swim-technique', 'me'));
    expect(page.price.priceKind).toBe('oneOff');
    expect(page.price.amount).toBe(480);
    expect(page.price.bookingPriceLabel).toBe('Booking price · AED 480');
  });

  test('camp week: one-off per-week amount with the per-week label', () => {
    const page = pageFor(draftFor('holiday-swim-camp', 'adam'));
    expect(page.price.priceKind).toBe('oneOff');
    expect(page.price.amount).toBe(850);
    expect(page.price.bookingPriceLabel).toBe('Booking price · AED 850 per week');
  });

  test('recurring: cadence keeps the per-month label and no one-off amount', () => {
    const page = pageFor(draftFor('junior-swim-squad', 'adam'));
    expect(page.price.priceKind).toBe('cadence');
    expect(page.price.amount).toBeUndefined();
    expect(page.price.bookingPriceLabel).toBe('Booking price · AED 380 per month');
    expect(page.ctaLabel).toBe('Continue to payment');
  });

  test('term: cadence per term', () => {
    const page = pageFor(draftFor('junior-karate', 'adam'));
    expect(page.price.priceKind).toBe('cadence');
    expect(page.price.amount).toBeUndefined();
    expect(page.price.bookingPriceLabel).toMatch(/^Booking price · AED [\d,]+ per term$/);
  });

  test('free booking: Free wording, Confirm booking CTA, no payment section', () => {
    const page = pageFor(draftFor('community-park-football', 'me'));
    expect(page.price.priceKind).toBe('free');
    expect(page.price.amount).toBeUndefined();
    expect(page.price.bookingPriceLabel).toBe('Booking price · Free');
    expect(page.paymentRequired).toBe(false);
    expect(page.paymentMethods).toHaveLength(0);
    expect(page.ctaLabel).toBe('Confirm booking');
    expect(page.spokenCtaLabel).toBe('Confirm booking, Booking price, Free');
  });

  test('free trial: free checkout with the trial selection', () => {
    const page = pageFor(draftFor('ladies-strength', 'me', trialOption));
    expect(page.price.priceKind).toBe('free');
    expect(page.price.bookingPriceLabel).toBe('Booking price · Free');
    expect(page.ctaLabel).toBe('Confirm booking');
  });

  test('paid trial: structured trialAmount reconciles, never parsed from copy', () => {
    const page = pageFor(draftFor('junior-football-u10', 'adam', trialOption));
    expect(page.price.priceKind).toBe('oneOff');
    expect(page.price.amount).toBe(35);
    expect(page.price.lines[0].amount).toBe(35);
    expect(page.price.bookingPriceLabel).toBe('Booking price · AED 35');
    expect(page.ctaLabel).toBe('Continue to payment');
  });

  test('discounted offer stays informational: label shown, no arithmetic', () => {
    const page = pageFor(draftFor('reformer-pilates', 'me'));
    expect(page.price.offerLine).toBe('20% off first month');
    expect(page.price.bookingPriceLabel).toBe('Booking price · AED 650 per month');
    const text = JSON.stringify(page.price);
    expect(text).not.toContain('520');
    expect(page.price.lines.every((line) => line.kind === 'base')).toBe(true);
  });
});

describe('Checkout pricing integrity across the catalogue (docs/22 §6)', () => {
  /** Every bookable program × option with a suitable household participant. */
  function allCheckoutPages(): CheckoutPage[] {
    const pages: CheckoutPage[] = [];
    for (const program of programs) {
      const options = bookingService.buildBookingOptions({
        programId: program.id,
        participantId: 'everyone',
        participants: household,
        areaId: 'khalifa-city',
      });
      if (options === undefined || options.availability.status !== 'bookable') continue;
      const suitable = options.householdEligibility.find((entry) => entry.suitable);
      if (suitable === undefined) continue;
      for (const option of options.options) {
        const session = option.requiresSession
          ? option.sessions.find((entry) => entry.availability !== 'full')
          : undefined;
        if (option.requiresSession && session === undefined) continue;
        const page = service.buildCheckoutPage({
          draft: {
            programId: program.id,
            optionId: option.id,
            sessionId: session?.id,
            participantId: suitable.participantId,
          },
          participants: household,
          areaId: 'khalifa-city',
        });
        expect(page).toBeDefined();
        pages.push(page!);
      }
    }
    expect(pages.length).toBeGreaterThan(30);
    return pages;
  }

  const pages = allCheckoutPages();

  test('every visible line reconciles to the one-off amount', () => {
    for (const page of pages) {
      if (page.price.priceKind === 'oneOff') {
        expect(page.price.amount).toBeGreaterThan(0);
        const sum = page.price.lines.reduce((total, line) => total + (line.amount ?? 0), 0);
        expect(sum).toBe(page.price.amount);
      } else {
        expect(page.price.amount).toBeUndefined();
        expect(page.price.lines.every((line) => line.amount === undefined)).toBe(true);
      }
    }
  });

  test('no Total wording, no VAT, no fees, no non-base lines, tax notConfigured', () => {
    for (const page of pages) {
      const rendered = [
        page.price.bookingPriceLabel,
        page.price.spokenBookingPriceLabel,
        page.ctaLabel,
        page.spokenCtaLabel,
        page.price.offerLine ?? '',
        ...page.price.lines.flatMap((line) => [line.label, line.value]),
        ...page.summary.selectionLines,
      ].join(' | ');
      expect(rendered).not.toMatch(/\bTotal\b/);
      expect(rendered).not.toMatch(/VAT/i);
      expect(rendered).not.toMatch(/\bfees?\b/i);
      expect(rendered).not.toMatch(/charged|reserv|holding/i);
      expect(page.price.lines.every((line) => line.kind === 'base')).toBe(true);
      expect(page.price.taxTreatment).toBe('notConfigured');
      expect(page.validation).toEqual({ ok: true });
    }
  });

  test('free amounts read Free, never AED 0', () => {
    for (const page of pages) {
      const rendered = [
        page.price.bookingPriceLabel,
        ...page.price.lines.flatMap((line) => [line.label, line.value]),
      ].join(' | ');
      expect(rendered).not.toContain('AED 0');
      if (page.price.priceKind === 'free') {
        expect(page.price.bookingPriceLabel).toBe('Booking price · Free');
        expect(page.ctaLabel).toBe('Confirm booking');
        expect(page.paymentRequired).toBe(false);
      } else {
        expect(page.ctaLabel).toBe('Continue to payment');
        expect(page.paymentRequired).toBe(true);
      }
    }
  });

  test('booking price labels continue the summary labels verbatim', () => {
    for (const page of pages) {
      expect(page.price.bookingPriceLabel).toBe(page.summary.bookingPriceLabel);
      expect(page.price.bookingPriceLabel.startsWith('Booking price · ')).toBe(true);
    }
  });
});

describe('Payment-method contract composition (Commit 17, docs/09 §22.6)', () => {
  test('paid booking composes exactly the one generic Card payment contract method', () => {
    const page = pageFor(draftFor('beginner-calisthenics', 'me'));
    expect(page.paymentMethods).toEqual([
      { id: 'card', kind: 'card', label: 'Card payment', availability: { status: 'contractOnly' } },
    ]);
  });

  test('free bookings compose no payment methods at all (docs/22 §4/§7.6)', () => {
    expect(pageFor(draftFor('community-park-football', 'me')).paymentMethods).toEqual([]);
    expect(pageFor(draftFor('ladies-strength', 'me', trialOption)).paymentMethods).toEqual([]);
  });

  test('across the catalogue: method presence mirrors paymentRequired; never Apple/Google Pay', () => {
    for (const program of programs) {
      const options = bookingService.buildBookingOptions({
        programId: program.id,
        participantId: 'everyone',
        participants: household,
        areaId: 'khalifa-city',
      });
      if (options === undefined || options.availability.status !== 'bookable') continue;
      const suitable = options.householdEligibility.find((entry) => entry.suitable);
      if (suitable === undefined) continue;
      for (const option of options.options) {
        const session = option.requiresSession
          ? option.sessions.find((entry) => entry.availability !== 'full')
          : undefined;
        if (option.requiresSession && session === undefined) continue;
        const page = service.buildCheckoutPage({
          draft: {
            programId: program.id,
            optionId: option.id,
            sessionId: session?.id,
            participantId: suitable.participantId,
          },
          participants: household,
          areaId: 'khalifa-city',
        });
        expect(page).toBeDefined();
        if (page!.paymentRequired) {
          expect(page!.paymentMethods).toHaveLength(1);
          expect(page!.paymentMethods[0].kind).toBe('card');
          expect(page!.paymentMethods[0].availability).toEqual({ status: 'contractOnly' });
        } else {
          expect(page!.paymentMethods).toHaveLength(0);
        }
        // applePay/googlePay stay declared-only — never composed (docs/09 §22.6).
        expect(page!.paymentMethods.every((method) => method.kind === 'card')).toBe(true);
      }
    }
  });

  test('the method carries no card details of any kind', () => {
    const page = pageFor(draftFor('beginner-calisthenics', 'me'));
    const method = page.paymentMethods[0];
    expect(method.label).toBe('Card payment');
    // No last-four digits, expiry, cardholder, token, or masking artifacts.
    expect(JSON.stringify(method)).not.toMatch(/\d{4}|expir|cvv|cardholder|token|•|\*{2,}/i);
    expect(Object.keys(method).sort()).toEqual(['availability', 'id', 'kind', 'label']);
  });
});

describe('Checkout guardian context (docs/09 §22.8)', () => {
  test('child bookings carry the guardian context line', () => {
    const page = pageFor(draftFor('junior-swim-squad', 'adam'));
    expect(page.guardianContextLine).toBe('Booked by you');
  });

  test('adult bookings carry no guardian context and no consent artifacts', () => {
    const page = pageFor(draftFor('beginner-calisthenics', 'me'));
    expect(page.guardianContextLine).toBeUndefined();
  });

  test('synthetic child names derive from the participant list, never demo names', () => {
    const omar: Participant = { id: 'p1', label: 'Omar', kind: 'child', dateOfBirth: '2017-05-01' };
    const dana: Participant = { id: 'p0', label: 'Dana', kind: 'self' };
    const draft = draftFor('junior-swim-squad', 'adam');
    const page = service.buildCheckoutPage({
      draft: { ...draft, participantId: 'p1' },
      participants: [dana, omar],
      areaId: 'khalifa-city',
    });
    expect(page).toBeDefined();
    expect(page!.guardianContextLine).toBe('Booked by you');
    expect(page!.summary.participant.label).toBe('Omar');
  });
});

describe('Checkout invalid-draft rejection (docs/22 §2, §3.3)', () => {
  const valid = draftFor('beginner-calisthenics', 'me');

  test.each<[string, BookingDraft]>([
    ['missing option', { programId: 'beginner-calisthenics', participantId: 'me' }],
    ['unknown option', { ...valid, optionId: 'other-option' }],
    ['missing session', { ...valid, sessionId: undefined }],
    ['unknown session', { ...valid, sessionId: 'other-session' }],
    ['missing participant', { ...valid, participantId: undefined }],
    ['ineligible participant', { ...draftFor('junior-swim-squad', 'adam'), participantId: 'me' }],
    ['foreign program id', { ...valid, programId: 'junior-swim-squad' }],
    ['unknown program', { ...valid, programId: 'does-not-exist' }],
  ])('%s resolves undefined — screens redirect, never render broken', (_name, draft) => {
    expect(
      service.buildCheckoutPage({ draft, participants: household, areaId: 'khalifa-city' }),
    ).toBeUndefined();
  });

  test('a full session cannot reach checkout', () => {
    const options = optionsFor('morning-yoga');
    const option = options.options[0];
    const full = option.sessions.find((entry) => entry.availability === 'full');
    expect(full).toBeDefined();
    expect(
      service.buildCheckoutPage({
        draft: {
          programId: 'morning-yoga',
          optionId: option.id,
          sessionId: full!.id,
          participantId: 'me',
        },
        participants: household,
        areaId: 'khalifa-city',
      }),
    ).toBeUndefined();
  });

  test('guest (empty household) cannot compose a checkout page', () => {
    expect(
      service.buildCheckoutPage({ draft: valid, participants: [], areaId: 'khalifa-city' }),
    ).toBeUndefined();
  });
});

describe('QA revalidation states (Commit 18, docs/22 §7.10, docs/09 §22.10)', () => {
  const allCodes = [
    'sessionFull',
    'registrationClosed',
    'priceChanged',
    'offerExpired',
    'participantIneligible',
    'branchUnavailable',
    'invalidDraft',
  ] as const;

  test('qaRevalidate attaches a typed not-ok validation carrying exactly that code', () => {
    for (const code of allCodes) {
      const page = service.buildCheckoutPage({
        draft: draftFor('beginner-calisthenics', 'me'),
        participants: household,
        areaId: 'khalifa-city',
        qaRevalidate: code,
      });
      expect(page).toBeDefined();
      expect(page!.validation.ok).toBe(false);
      if (!page!.validation.ok) {
        expect(page!.validation.issues).toHaveLength(1);
        expect(page!.validation.issues[0].code).toBe(code);
        expect(page!.validation.issues[0].message.length).toBeGreaterThan(0);
      }
    }
  });

  test('a revalidation page is otherwise identical — pricing, methods, CTA untouched', () => {
    const draft = draftFor('beginner-calisthenics', 'me');
    const normal = pageFor(draft);
    const revalidated = service.buildCheckoutPage({
      draft,
      participants: household,
      areaId: 'khalifa-city',
      qaRevalidate: 'priceChanged',
    });
    expect(revalidated).toBeDefined();
    expect({ ...revalidated!, validation: undefined }).toEqual({
      ...normal,
      validation: undefined,
    });
  });

  test('priceChanged shows old → new composed from structured amounts only', () => {
    const page = service.buildCheckoutPage({
      draft: draftFor('beginner-calisthenics', 'me'),
      participants: household,
      areaId: 'khalifa-city',
      qaRevalidate: 'priceChanged',
    });
    expect(page!.validation.ok).toBe(false);
    if (!page!.validation.ok) {
      // QA demo previous = current − 10 (display fixture); current is the
      // true catalogue price — the payable amount is never fabricated.
      expect(page!.validation.issues[0].message).toBe(
        'The booking price changed from AED 75 per session to AED 85 per session while you were checking out.',
      );
    }
    expect(page!.price.bookingPriceLabel).toBe('Booking price · AED 85 per session');
    expect(page!.price.amount).toBe(85);
  });

  test('priceChanged on a free booking carries no amounts (nothing invented)', () => {
    const page = service.buildCheckoutPage({
      draft: draftFor('community-park-football', 'me'),
      participants: household,
      areaId: 'khalifa-city',
      qaRevalidate: 'priceChanged',
    });
    expect(page!.validation.ok).toBe(false);
    if (!page!.validation.ok) {
      expect(page!.validation.issues[0].message).toBe(
        'The booking price changed while you were checking out.',
      );
      expect(page!.validation.issues[0].message).not.toMatch(/AED/);
    }
  });

  test('priceChanged carries the structured old → new comparison (never parsed from copy)', () => {
    const page = service.buildCheckoutPage({
      draft: draftFor('beginner-calisthenics', 'me'),
      participants: household,
      areaId: 'khalifa-city',
      qaRevalidate: 'priceChanged',
    });
    expect(page!.validation.ok).toBe(false);
    if (!page!.validation.ok) {
      expect(page!.validation.issues[0].priceComparison).toEqual({
        previousLabel: 'AED 75 per session',
        updatedLabel: 'AED 85 per session',
      });
    }
  });

  test('the comparison is absent for free bookings and non-price codes', () => {
    const freePage = service.buildCheckoutPage({
      draft: draftFor('community-park-football', 'me'),
      participants: household,
      areaId: 'khalifa-city',
      qaRevalidate: 'priceChanged',
    });
    expect(freePage!.validation.ok).toBe(false);
    if (!freePage!.validation.ok) {
      expect(freePage!.validation.issues[0].priceComparison).toBeUndefined();
    }
    for (const code of allCodes.filter((entry) => entry !== 'priceChanged')) {
      const page = service.buildCheckoutPage({
        draft: draftFor('beginner-calisthenics', 'me'),
        participants: household,
        areaId: 'khalifa-city',
        qaRevalidate: code,
      });
      expect(page!.validation.ok).toBe(false);
      if (!page!.validation.ok) {
        expect(page!.validation.issues[0].priceComparison).toBeUndefined();
      }
    }
  });

  test('sessionFull uses the spec copy verbatim (docs/22 §7.10)', () => {
    const page = service.buildCheckoutPage({
      draft: draftFor('beginner-calisthenics', 'me'),
      participants: household,
      areaId: 'khalifa-city',
      qaRevalidate: 'sessionFull',
    });
    expect(page!.validation.ok).toBe(false);
    if (!page!.validation.ok) {
      expect(page!.validation.issues[0].message).toBe(
        'This session filled up while you were checking out.',
      );
    }
  });

  test('every issue message stays honest — no success, reservation, or pricing claims', () => {
    for (const code of allCodes) {
      const page = service.buildCheckoutPage({
        draft: draftFor('beginner-calisthenics', 'me'),
        participants: household,
        areaId: 'khalifa-city',
        qaRevalidate: code,
      });
      expect(page!.validation.ok).toBe(false);
      if (!page!.validation.ok) {
        const message = page!.validation.issues[0].message;
        expect(message).not.toMatch(/\bTotal\b/);
        expect(message).not.toMatch(/VAT|\bfees?\b/i);
        expect(message).not.toContain('AED 0');
        expect(message).not.toMatch(/reserv|holding|charged|confirmed|success|receipt/i);
        expect(message).not.toMatch(/i agree|i accept|by continuing/i);
      }
    }
  });

  test('access-policy rejection takes precedence over qaRevalidate', () => {
    expect(
      service.buildCheckoutPage({
        draft: { programId: 'beginner-calisthenics', participantId: 'me' },
        participants: household,
        areaId: 'khalifa-city',
        qaRevalidate: 'priceChanged',
      }),
    ).toBeUndefined();
    expect(
      service.buildCheckoutPage({
        draft: draftFor('beginner-calisthenics', 'me'),
        participants: [],
        areaId: 'khalifa-city',
        qaRevalidate: 'sessionFull',
      }),
    ).toBeUndefined();
  });
});

describe('Payment-submit guard: no submission path can execute (docs/09 §22.11, docs/23 §19)', () => {
  /** Every app source file, so a submit call site can never hide. */
  function appSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        files.push(...appSourceFiles(full));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
    return files;
  }

  const srcRoot = join(__dirname, '..', '..');
  const files = appSourceFiles(srcRoot);

  test('the source tree is actually scanned', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('PaymentSubmitRequest/PaymentSubmitResult exist only as contract declarations', () => {
    for (const file of files) {
      const rel = relative(srcRoot, file).split(sep).join('/');
      if (rel === 'services/contracts/checkout.ts') continue;
      const source = readFileSync(file, 'utf8');
      expect({ rel, mentionsSubmitTypes: /PaymentSubmit(Request|Result)/.test(source) }).toEqual({
        rel,
        mentionsSubmitTypes: false,
      });
    }
  });

  test('no service or screen exposes or calls a payment-submit function', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(srcRoot, file).split(sep).join('/');
      expect({ rel, hasSubmitCall: /submitPayment|payNow|processPayment|capturePayment/i.test(source) }).toEqual({
        rel,
        hasSubmitCall: false,
      });
    }
  });

  test('the checkout service surface is getCheckoutPage only', () => {
    const ownMethods = Object.getOwnPropertyNames(MockCheckoutService.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(ownMethods.sort()).toEqual(['buildCheckoutPage', 'delay', 'getCheckoutPage']);
  });
});
