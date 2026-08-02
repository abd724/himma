/**
 * Curated search language data — docs/14 §3.4. Bilingual-ready: each synonym
 * set can later carry an `ar` array without structural change.
 */

/** term → expansion terms used for matching (English now; Arabic later). */
export const synonyms: Record<string, string[]> = {
  soccer: ['football'],
  footy: ['football'],
  reformer: ['pilates', 'reformer'],
  'mat pilates': ['pilates'],
  hifz: ['quran', 'memorisation'],
  tajweed: ['quran', 'tajweed'],
  memorization: ['memorisation'],
  bjj: ['jiu-jitsu'],
  'jiu jitsu': ['jiu-jitsu'],
  jiujitsu: ['jiu-jitsu'],
  gym: ['fitness', 'strength', 'calisthenics'],
  workout: ['fitness', 'strength'],
  ladies: ['ladies'],
  'ladies only': ['ladies'],
  'women only': ['ladies'],
  stem: ['robotics', 'coding'],
  swim: ['swimming'],
  art: ['pottery', 'painting', 'art'],
};

/** Curated misspelling map — no fuzzy engine in the mock (docs/14 §3.4). */
export const typoCorrections: Record<string, string> = {
  pilaties: 'pilates',
  pilatis: 'pilates',
  swiming: 'swimming',
  swimmimg: 'swimming',
  padle: 'padel',
  paddel: 'padel',
  qran: 'quran',
  quaran: 'quran',
  robotix: 'robotics',
  calesthenics: 'calisthenics',
  calistenics: 'calisthenics',
  yogaa: 'yoga',
  massge: 'massage',
};

/** Deterministic popular searches; Ladies only stays prominent (docs/06 §9). */
export const popularSearches: string[] = [
  'Ladies only pilates',
  'Swimming for kids',
  'Padel',
  'Quran memorisation',
  'Boxing',
  'Summer camps',
];

/** Deterministic initial recents — session-local, clearable (docs/17 §8). */
export const initialRecentSearches: string[] = ['Kickboxing', 'Robotics for kids'];
