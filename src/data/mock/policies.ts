import type { CancellationPolicy } from '@/types/domain';

/**
 * The three approved cancellation presets — docs/09 §20.4. This wording is
 * MOCK-ONLY placeholder copy: final policy text arrives with provider
 * onboarding and backend configuration. Deliberately no partial-refund
 * calculations, wallet-credit rules, provider penalties, or exception rules.
 */
export const cancellationPolicies: Record<CancellationPolicy['id'], CancellationPolicy> = {
  'flex-24': {
    id: 'flex-24',
    title: 'Flexible cancellation',
    summaryLines: [
      'Free cancellation up to 24 hours before the session.',
      'Full details are confirmed at booking.',
    ],
  },
  'flex-48': {
    id: 'flex-48',
    title: 'Standard cancellation',
    summaryLines: [
      'Free cancellation up to 48 hours before the session.',
      'Full details are confirmed at booking.',
    ],
  },
  'non-refundable': {
    id: 'non-refundable',
    title: 'Non-refundable',
    summaryLines: [
      'This booking is non-refundable after confirmation.',
      'Full details are confirmed at booking.',
    ],
  },
};
