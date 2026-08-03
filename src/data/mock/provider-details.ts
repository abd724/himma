import type { CancellationPolicy, ProviderBranch } from '@/types/domain';

/**
 * Provider Storefront extras — docs/20 §8.2, docs/09 §20.6. Keyed by provider
 * id so the frozen catalogue arrays stay byte-identical (11 providers,
 * original order). Every provider has an entry; a data-invariant test
 * enforces completeness.
 *
 * Copy rules: descriptions and addresses are fictional demo content
 * (docs/08 §11 — no real businesses or affiliations implied); policy presets
 * are mock-only pending provider onboarding and backend configuration
 * (docs/09 §20.4).
 */
export interface ProviderDetailExtras {
  description: string;
  reviewCount: number;
  /** Reuses existing demo image keys; absent = monogram banner (the design). */
  coverImageKey?: string;
  /**
   * Explicit branches for multi-branch providers. Absent = one implicit
   * branch at the provider's `areaId` built from `addressLine`/`openingHours`.
   */
  branches?: ProviderBranch[];
  /** Fictional street line for the implicit single branch. */
  addressLine?: string;
  openingHours?: string;
  facilities?: string[];
  team?: { name: string; title: string }[];
  policyId: CancellationPolicy['id'];
}

export const providerDetailExtras: Record<string, ProviderDetailExtras> = {
  gravity: {
    description:
      'A movement-first training studio for calisthenics, strength, and functional fitness. Small coached groups, clear progressions, and programmes for adults and juniors alike.',
    reviewCount: 284,
    coverImageKey: 'gym',
    addressLine: 'Khalifa Park Row, Unit 6',
    openingHours: 'Daily · 6:00 AM – 11:00 PM',
    facilities: ['Changing rooms', 'Showers', 'Ladies-only floor', 'Parking'],
    team: [
      { name: 'Yusuf Rahman', title: 'Head Coach · Calisthenics' },
      { name: 'Mariam Al Suwaidi', title: 'Strength Coach' },
      { name: 'Aisha Karim', title: 'Junior Programme Coach' },
    ],
    policyId: 'flex-24',
  },
  falcon: {
    description:
      'A combat sports academy teaching boxing, karate, and jiu-jitsu with structured belt and skills pathways. Fundamentals classes stay sparring-free, and junior programmes have dedicated coaches.',
    reviewCount: 312,
    coverImageKey: 'boxing',
    addressLine: 'Sports District, Warehouse 12',
    openingHours: 'Sat–Thu · 7:00 AM – 10:00 PM',
    facilities: ['Changing rooms', 'Showers', 'Parent viewing area', 'Parking'],
    team: [
      { name: 'Khalid Mansour', title: 'Boxing Coach' },
      { name: 'Sensei Omar Farid', title: '4th Dan · Head Instructor' },
      { name: 'Coach Rafael Lima', title: 'BJJ Black Belt · Kids Programme' },
    ],
    policyId: 'flex-24',
  },
  'blue-wave': {
    description:
      'Swim school and aquatic fitness centre with heated indoor pools at two Al Raha locations. From junior squads to adult technique clinics, every lane is coached.',
    reviewCount: 268,
    coverImageKey: 'poolLanes',
    branches: [
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
    facilities: ['Heated indoor pools', 'Family changing rooms', 'Parent seating', 'Parking'],
    team: [{ name: 'Coach Daniel Reyes', title: 'Head Swim Coach' }],
    policyId: 'flex-48',
  },
  'core-pilates': {
    description:
      'A boutique Pilates and yoga house on Al Reem with reformer beds, mat classes, and morning yoga. Sessions are small, calm, and carefully coached.',
    reviewCount: 221,
    coverImageKey: 'yogaPose',
    addressLine: 'Reem Central Walk, Unit 8',
    openingHours: 'Daily · 6:00 AM – 9:30 PM',
    facilities: ['Boutique studio', 'Changing rooms', 'Filtered water'],
    team: [
      { name: 'Elena Petrova', title: 'Lead Reformer Instructor' },
      { name: 'Huda Nasser', title: 'Mat Pilates & Yoga Instructor' },
    ],
    policyId: 'flex-48',
  },
  noor: {
    description:
      'A learning centre for Quran, Arabic, and communication skills. Structured programmes for children and adults, taught in quiet, modern classrooms.',
    reviewCount: 198,
    coverImageKey: 'quran',
    addressLine: 'Education Cluster, Block C',
    openingHours: 'Sat–Thu · 2:00 PM – 9:00 PM',
    facilities: ['Quiet classrooms', 'Parent waiting area', 'Parking'],
    team: [
      { name: 'Ustadh Ibrahim Kazi', title: 'Hifz Programme Lead' },
      { name: 'Ustadha Layla Hamdan', title: 'Arabic Language Teacher' },
      { name: 'Daniel Osei', title: 'Communication Coach' },
    ],
    policyId: 'flex-24',
  },
  'future-makers': {
    description:
      'Robotics and coding labs for young builders on Yas Island. Project-based learning in small groups, from first robots to full summer coding camps.',
    reviewCount: 143,
    coverImageKey: 'robotics',
    addressLine: 'Innovation Campus, Studio 5',
    openingHours: 'Sat & Sun · 9:00 AM – 6:00 PM',
    facilities: ['Dedicated lab', 'Air-conditioned studios', 'Parent waiting area'],
    team: [{ name: 'Eng. Priya Nair', title: 'Robotics Lab Lead' }],
    policyId: 'flex-48',
  },
  horizon: {
    description:
      'Padel club with covered courts on Al Raha. Coached beginner sessions, social nights, and open court hire for every level.',
    reviewCount: 176,
    coverImageKey: 'tennis',
    addressLine: 'Al Raha Corniche, Courts Complex',
    openingHours: 'Daily · 7:00 AM – 11:00 PM',
    facilities: ['Covered courts', 'Changing rooms', 'Café', 'Parking'],
    team: [{ name: 'Carlos Mendes', title: 'Padel Coach' }],
    policyId: 'flex-24',
  },
  restore: {
    description:
      'A recovery and wellness studio on Saadiyat — sports massage, breathwork, and stretch sessions designed around active adults.',
    reviewCount: 254,
    coverImageKey: 'wellness',
    addressLine: 'Saadiyat Retreat Plaza, Suite 3',
    openingHours: 'Daily · 9:00 AM – 9:00 PM',
    facilities: ['Private treatment rooms', 'Showers', 'Parking'],
    team: [{ name: 'Noura Al Ali', title: 'Breathwork Guide' }],
    policyId: 'flex-24',
  },
  'desert-stars': {
    description:
      'A community football academy with floodlit pitches in MBZ City. Junior age-group squads, family weekend sessions, and free community football.',
    reviewCount: 232,
    coverImageKey: 'football',
    addressLine: 'MBZ Sports Grounds, Gate 2',
    openingHours: 'Daily · 4:00 PM – 10:00 PM',
    facilities: ['Floodlit outdoor pitches', 'Parent seating', 'Parking'],
    policyId: 'flex-24',
  },
  palette: {
    description:
      'An art house on Saadiyat for pottery, painting, and creative evenings. A dedicated kids’ studio sits alongside relaxed adult classes.',
    reviewCount: 121,
    coverImageKey: 'art',
    addressLine: 'Saadiyat Arts Walk, Studio 9',
    openingHours: 'Tue–Sun · 10:00 AM – 9:00 PM',
    facilities: ['Dedicated kids’ studio', 'Kiln on site', 'Parent café'],
    team: [{ name: 'Maya Haddad', title: 'Studio Lead' }],
    policyId: 'flex-48',
  },
  'coastal-tennis': {
    description:
      'A small junior tennis academy on Yas Island. Weekend squads on shaded courts with a focus on fundamentals and fun.',
    reviewCount: 87,
    addressLine: 'Yas Marina Courts, Court 1',
    openingHours: 'Daily · 7:00 AM – 10:00 PM',
    facilities: ['Shaded courts', 'Parent seating', 'Café'],
    team: [{ name: 'Coach Anna Kovac', title: 'Junior Tennis Lead' }],
    policyId: 'flex-24',
  },
};

/**
 * Explicit-branch lookup — docs/20 §8.2, docs/09 §20.6. Only Blue Wave has
 * more than one location; both branches stay inside Al Raha so every
 * area-based count and screenshot remains byte-identical. Providers absent
 * from this record have one implicit branch at their `areaId`.
 */
export const providerBranches: Record<string, ProviderBranch[]> = Object.fromEntries(
  Object.entries(providerDetailExtras)
    .filter(([, extras]) => extras.branches !== undefined)
    .map(([id, extras]) => [id, extras.branches!]),
);
