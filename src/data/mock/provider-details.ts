import type { ProviderBranch } from '@/types/domain';

/**
 * Explicit provider branches — docs/20 §8.2, docs/09 §20.6. Only Blue Wave
 * has more than one location; both of its branches stay inside Al Raha so
 * every area-based count and screenshot remains byte-identical. Providers
 * absent from this record have one implicit branch at their `areaId`.
 *
 * Address lines are fictional (docs/08 §11 — no real businesses implied).
 * The full provider storefront extras join this module in the storefront
 * commit; Program Details needs only the branch metadata.
 */
export const providerBranches: Record<string, ProviderBranch[]> = {
  'blue-wave': [
    {
      id: 'blue-wave-beach',
      label: 'Al Raha Beach',
      areaId: 'al-raha',
      addressLine: 'Marina Promenade, Building 4',
      openingHours: 'Daily · 6:00 AM – 10:00 PM',
    },
    {
      id: 'blue-wave-gardens',
      label: 'Al Raha Gardens',
      areaId: 'al-raha',
      addressLine: 'Gardens Plaza, Pool Hall 2',
      openingHours: 'Daily · 7:00 AM – 9:00 PM',
    },
  ],
};
