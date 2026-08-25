import type { PriceModel, Program } from '@/types/domain';

/**
 * Customer-facing price presentation for every pricing model — docs/05 §6.
 * The amount/unit split lets cards emphasize the figure; `priceLabel` joins
 * them for single-line surfaces (details price block, sticky CTA).
 */
export function formatPrice(price: PriceModel): { amount: string; unit: string } {
  const aed = (value: number) => `AED ${value.toLocaleString('en-US')}`;
  switch (price.kind) {
    case 'dropIn':
      return { amount: aed(price.amount), unit: 'per session' };
    case 'monthly':
      return { amount: aed(price.amount), unit: '/month' };
    case 'term':
      return { amount: aed(price.amount), unit: 'per term' };
    case 'camp':
      return { amount: aed(price.amountPerWeek), unit: '/week' };
    case 'package':
      return { amount: aed(price.amount), unit: `for ${price.sessions} sessions` };
    case 'free':
      return { amount: 'Free', unit: '' };
    case 'freeTrial':
      return { amount: 'Free', unit: 'trial' };
    case 'from':
      // Server-derived minimum over the active options (docs/28 §14).
      return { amount: `From AED ${price.amount.toLocaleString('en-US')}`, unit: '' };
  }
}

/** One-line price, e.g. "AED 85 per session", "AED 450/month", "Free". */
export function priceLabel(price: PriceModel): string {
  const { amount, unit } = formatPrice(price);
  return unit === '' ? amount : `${amount} ${unit}`;
}

/**
 * Screen-reader price — currency and units in full words, never "AED" or a
 * slash: "85 dirhams per session", "450 dirhams per month".
 */
export function spokenPriceLabel(price: PriceModel): string {
  const dirhams = (value: number) => `${value.toLocaleString('en-US')} dirhams`;
  switch (price.kind) {
    case 'dropIn':
      return `${dirhams(price.amount)} per session`;
    case 'monthly':
      return `${dirhams(price.amount)} per month`;
    case 'term':
      return `${dirhams(price.amount)} per term`;
    case 'camp':
      return `${dirhams(price.amountPerWeek)} per week`;
    case 'package':
      return `${dirhams(price.amount)} for ${price.sessions} sessions`;
    case 'free':
      return 'Free';
    case 'freeTrial':
      return 'Free trial';
    case 'from':
      return `from ${dirhams(price.amount)}`;
  }
}

/**
 * Spoken form of an already-composed price label — the separator dot becomes
 * a pause and 'AED N' becomes 'N dirhams' ('Booking price · AED 85 per
 * session' → 'Booking price, 85 dirhams per session'). Single source for
 * every surface that speaks a composed label (booking summary, checkout).
 */
export function spokenLabel(label: string): string {
  return label.replaceAll(' · ', ', ').replace(/AED ([\d,]+)/g, '$1 dirhams');
}

/** Commercial-shape label for the details key-facts strip — docs/15 §2. */
export function programFormatLabel(program: Pick<Program, 'price' | 'isCamp'>): string {
  if (program.isCamp) return 'Camp';
  if (program.price === undefined) return 'Activity';
  switch (program.price.kind) {
    case 'dropIn':
      return 'Drop-in';
    case 'monthly':
      return 'Monthly program';
    case 'term':
      return 'Term program';
    case 'package':
      return 'Session package';
    case 'free':
      return 'Free session';
    case 'freeTrial':
      return 'Trial';
    case 'camp':
      return 'Camp';
    case 'from':
      return 'Activity';
  }
}
