import type { CancellationPolicy, SessionOccurrence } from '@/types/domain';

/**
 * Program Details extras — docs/20 §8.2. Keyed by program id so the frozen
 * catalogue arrays stay byte-identical (36 programs, original order). Every
 * program has an entry; a data-invariant test enforces completeness.
 *
 * Copy rules: descriptions are fictional demo copy (docs/08 §11), direct and
 * specific (docs/06 §14), never medical claims (docs/09 §16) and never
 * invented testimonials (docs/09 §20.3).
 */
export interface ProgramDetailExtras {
  description: string;
  reviewCount: number;
  policyId: CancellationPolicy['id'];
  included?: string[];
  bring?: string[];
  instructorName?: string;
  instructorTitle?: string;
  safetyNote?: string;
  /** Facilities at the hosting venue relevant to this program. */
  facilities?: string[];
  /** Multi-branch providers only — joins `providerBranches`. */
  branchId?: string;
  /**
   * Session presentation override — docs/09 §20.9 (informational only).
   * 'none' = no upcoming sessions listed; an array replaces derivation;
   * absent = deterministic derivation from the schedule fields.
   */
  sessions?: 'none' | SessionOccurrence[];
  /** Applied to the first derived occurrence — honest weak availability. */
  spotsLeft?: number;
}

export const programDetailExtras: Record<string, ProgramDetailExtras> = {
  'beginner-calisthenics': {
    description:
      'Learn the foundations of bodyweight training in a small coached group. Each session builds pulling, pushing, and core control step by step, so complete beginners progress safely.',
    reviewCount: 124,
    policyId: 'flex-24',
    included: ['Coached 60-minute session', 'All training equipment', 'Progress check every 4 weeks'],
    bring: ['Comfortable sportswear', 'Water bottle'],
    instructorName: 'Yusuf Rahman',
    instructorTitle: 'Head Coach · Calisthenics',
    facilities: ['Changing rooms', 'Showers', 'Parking'],
  },
  'ladies-strength': {
    description:
      'A ladies-only strength circuit that mixes free weights and functional stations. Coaches adjust every station to your level, from first session to confident lifter.',
    reviewCount: 96,
    policyId: 'flex-48',
    included: ['Coached circuit session', 'All equipment', 'Beginner onboarding session'],
    bring: ['Training shoes', 'Water bottle'],
    instructorName: 'Mariam Al Suwaidi',
    instructorTitle: 'Strength Coach',
    facilities: ['Ladies-only floor', 'Changing rooms', 'Showers', 'Parking'],
  },
  'boxing-fundamentals': {
    description:
      'Stance, guard, and the first punch combinations — taught properly from day one. Pad work and footwork drills keep every round moving without sparring pressure.',
    reviewCount: 143,
    policyId: 'flex-24',
    included: ['Coached 60-minute class', 'Loan gloves and wraps for your first month'],
    bring: ['Sportswear', 'Water bottle', 'Own wraps if you have them'],
    instructorName: 'Khalid Mansour',
    instructorTitle: 'Boxing Coach',
    facilities: ['Changing rooms', 'Showers', 'Parking'],
    safetyNote: 'No sparring in fundamentals classes.',
  },
  'ladies-boxing': {
    description:
      'High-energy boxing fitness for ladies — pads, bags, and conditioning rounds with no sparring. A supportive group with coaching that meets you at your pace.',
    reviewCount: 88,
    policyId: 'flex-48',
    included: ['Coached class', 'Loan gloves and wraps'],
    bring: ['Sportswear', 'Water bottle'],
    instructorName: 'Sara Haddad',
    instructorTitle: 'Boxing Fitness Coach',
    facilities: ['Ladies-only sessions', 'Changing rooms', 'Showers'],
    safetyNote: 'No sparring — pads and bags only.',
  },
  'junior-karate': {
    description:
      'A structured belts programme that builds discipline, focus, and confidence across the school year. Gradings follow a clear syllabus, and parents receive progress notes each term.',
    reviewCount: 157,
    policyId: 'flex-48',
    included: ['Two coached sessions per week', 'Termly grading', 'Progress reports'],
    bring: ['Karate gi (starter sets available)', 'Water bottle'],
    instructorName: 'Sensei Omar Farid',
    instructorTitle: '4th Dan · Junior Programme Lead',
    facilities: ['Parent viewing area', 'Changing rooms', 'Parking'],
    safetyNote: 'All juniors train in age-matched groups.',
  },
  'junior-swim-squad': {
    description:
      'Weekend squad training for young swimmers who can already swim one length. Stroke technique, starts, and turns in lane groups matched by ability, with a coach on deck for every lane.',
    reviewCount: 201,
    policyId: 'flex-48',
    included: ['Two weekend sessions', 'Lane group placement', 'Quarterly time trials'],
    bring: ['Swimsuit and goggles', 'Towel', 'Swim cap'],
    instructorName: 'Coach Daniel Reyes',
    instructorTitle: 'Head Swim Coach',
    facilities: ['Heated indoor pool', 'Family changing rooms', 'Parent seating'],
    safetyNote: 'Lifeguard on duty at every session.',
    branchId: 'blue-wave-beach',
  },
  'ladies-aqua': {
    description:
      'Evening aqua fitness for ladies — low-impact resistance work in the water that is easy on joints and genuinely hard work. No swimming ability needed beyond confidence in the pool.',
    reviewCount: 64,
    policyId: 'flex-24',
    included: ['Coached 45-minute session', 'All aqua equipment'],
    bring: ['Swimsuit', 'Towel'],
    facilities: ['Ladies-only evening sessions', 'Heated indoor pool', 'Changing rooms'],
    branchId: 'blue-wave-gardens',
  },
  'holiday-swim-camp': {
    description:
      'A week of morning swim camp for the school holidays: technique, water safety, and games, grouped by age and ability. Ends with a family showcase on the last day.',
    reviewCount: 73,
    policyId: 'non-refundable',
    included: ['Five camp mornings', 'Water-safety session', 'Camp certificate'],
    bring: ['Swimsuit, goggles, and towel', 'Snack and water bottle'],
    instructorName: 'Coach Daniel Reyes',
    instructorTitle: 'Head Swim Coach',
    facilities: ['Heated indoor pool', 'Family changing rooms'],
    safetyNote: 'Lifeguard on duty; maximum 8 children per coach.',
    branchId: 'blue-wave-beach',
  },
  'reformer-pilates': {
    description:
      'Reformer fundamentals in a fully equipped studio — controlled, precise, and surprisingly demanding. Classes cap at eight so the instructor refines every movement.',
    reviewCount: 168,
    policyId: 'flex-24',
    included: ['Reformer machine session', 'Grip socks for your first class'],
    bring: ['Fitted sportswear', 'Grip socks after your first class'],
    instructorName: 'Elena Petrova',
    instructorTitle: 'Lead Reformer Instructor',
    facilities: ['Boutique studio', 'Changing rooms', 'Filtered water'],
    spotsLeft: 3,
  },
  'ladies-evening-pilates': {
    description:
      'A calm, ladies-only mat class to end the day — core control, mobility, and breathing without any performance pressure. Suitable from your very first class.',
    reviewCount: 92,
    policyId: 'flex-24',
    included: ['Mat and props', 'Coached 55-minute class'],
    bring: ['Comfortable clothing', 'Water bottle'],
    instructorName: 'Huda Nasser',
    instructorTitle: 'Mat Pilates Instructor',
    facilities: ['Ladies-only evening studio', 'Changing rooms'],
  },
  'quran-juz-amma': {
    description:
      'After-school Quran memorisation focused on Juz Amma, with correct Tajweed from the first surah. Small circles grouped by age, and weekly notes home on each child’s progress.',
    reviewCount: 134,
    policyId: 'flex-48',
    included: ['Two after-school circles per week', 'Weekly progress notes', 'Revision plan'],
    bring: ['Own mushaf if preferred (copies provided)'],
    instructorName: 'Ustadh Ibrahim Kazi',
    instructorTitle: 'Hifz Programme Lead',
    facilities: ['Quiet classrooms', 'Parent waiting area', 'Parking'],
  },
  'arabic-teens': {
    description:
      'Saturday conversation classes that get teenagers actually speaking Arabic — discussions, games, and real-life topics rather than worksheets. Placement chat before the first class.',
    reviewCount: 58,
    policyId: 'flex-48',
    included: ['Weekly 90-minute class', 'Placement assessment', 'Course materials'],
    instructorName: 'Ustadha Layla Hamdan',
    instructorTitle: 'Arabic Language Teacher',
    facilities: ['Modern classrooms', 'Parent waiting area'],
  },
  'public-speaking': {
    description:
      'A six-session course that takes young speakers from nervous to confident: structure, voice, and stage presence, finishing with a short speech to a friendly audience.',
    reviewCount: 41,
    policyId: 'flex-48',
    included: ['Six coached sessions', 'Speech feedback video', 'Completion certificate'],
    instructorName: 'Daniel Osei',
    instructorTitle: 'Communication Coach',
    facilities: ['Presentation room', 'Parent showcase seating'],
    sessions: 'none',
  },
  'junior-robotics': {
    description:
      'Build, code, and test real robots in a hands-on Saturday lab. Each block ends with a challenge day where the robots compete — engineering thinking without the lecture.',
    reviewCount: 112,
    policyId: 'flex-48',
    included: ['All robotics kits and laptops', 'Weekly lab session', 'Challenge-day entry'],
    instructorName: 'Eng. Priya Nair',
    instructorTitle: 'Robotics Lab Lead',
    facilities: ['Dedicated lab', 'Parent waiting area', 'Parking'],
  },
  'teen-coding-camp': {
    description:
      'A one-week summer intensive where teens build and publish a real project — from first line of code to a working app demo on Friday. No prior coding needed.',
    reviewCount: 87,
    policyId: 'non-refundable',
    included: ['Five camp mornings', 'Laptops and materials', 'Project showcase'],
    bring: ['Snack and water bottle'],
    instructorName: 'Eng. Priya Nair',
    instructorTitle: 'Robotics Lab Lead',
    facilities: ['Dedicated lab', 'Air-conditioned studios'],
  },
  'padel-beginners': {
    description:
      'Your first padel sessions on covered courts: serves, wall play, and scoring, coached in groups of four so everyone gets court time. Rackets and balls provided.',
    reviewCount: 76,
    policyId: 'flex-24',
    included: ['Coached 60-minute session', 'Racket and balls', 'Court fees'],
    bring: ['Sports shoes', 'Water bottle'],
    instructorName: 'Carlos Mendes',
    instructorTitle: 'Padel Coach',
    facilities: ['Covered courts', 'Changing rooms', 'Café', 'Parking'],
    spotsLeft: 2,
  },
  'ladies-padel-social': {
    description:
      'Thursday-night social padel for ladies — rotating doubles, relaxed coaching tips, and a friendly crowd. Come alone or with friends; pairings rotate every few games.',
    reviewCount: 54,
    policyId: 'flex-24',
    included: ['Court fees and balls', 'Loan rackets', 'Organized rotations'],
    bring: ['Sports shoes'],
    facilities: ['Covered courts', 'Ladies-only evening', 'Café'],
  },
  'sports-massage': {
    description:
      'Targeted sports and recovery massage with qualified therapists. Sessions focus on the areas your training loads most — booked by appointment to fit your day.',
    reviewCount: 189,
    policyId: 'flex-24',
    included: ['60-minute session', 'Short movement assessment'],
    facilities: ['Private treatment rooms', 'Showers', 'Parking'],
    safetyNote: 'Wellness service, not a medical treatment.',
    sessions: [
      { id: 'sports-massage-0', dayOffset: 0, dayLabel: 'Today', timeLabel: 'By appointment' },
      { id: 'sports-massage-1', dayOffset: 1, dayLabel: 'Tomorrow', timeLabel: 'By appointment' },
      { id: 'sports-massage-2', dayOffset: 2, dayLabel: 'Tue 4 Aug', timeLabel: 'By appointment' },
    ],
  },
  'sunrise-breathwork': {
    description:
      'Weekend sunrise sessions on the beach lawn: guided breathwork and a full-body stretch before the heat arrives. Bring a towel and start the weekend clear-headed.',
    reviewCount: 67,
    policyId: 'flex-24',
    included: ['Guided 60-minute session', 'Mats provided'],
    bring: ['Towel', 'Light layer for after'],
    instructorName: 'Noura Al Ali',
    instructorTitle: 'Breathwork Guide',
    facilities: ['Outdoor lawn venue', 'Nearby parking'],
    safetyNote: 'Relaxation practice, not a medical therapy.',
  },
  'junior-football-u10': {
    description:
      'Structured football for under-10s: ball mastery, small-sided games, and real coaching in a positive team environment. Squads are grouped by age and kept small.',
    reviewCount: 176,
    policyId: 'flex-48',
    included: ['Two coached sessions per week', 'Training bib', 'End-of-term mini tournament'],
    bring: ['Shin pads and boots', 'Water bottle'],
    instructorName: 'Coach Marco Silva',
    instructorTitle: 'Youth Academy Coach',
    facilities: ['Floodlit outdoor pitches', 'Parent seating', 'Parking'],
    safetyNote: 'Evening sessions in summer; water breaks every 15 minutes.',
  },
  'active-summer-camp': {
    description:
      'Three weeks of active mornings for ages 6–12: movement games, gymnastics basics, and team challenges, all indoors and out of the heat. Join for one week or all three.',
    reviewCount: 95,
    policyId: 'non-refundable',
    included: ['Camp mornings 8:30–1:00', 'All activities and equipment', 'Camp T-shirt'],
    bring: ['Snack and water bottle', 'Indoor sports shoes'],
    instructorName: 'Yusuf Rahman',
    instructorTitle: 'Head Coach · Camps',
    facilities: ['Air-conditioned halls', 'Changing rooms', 'Parking'],
  },
  'mens-strength-basics': {
    description:
      'A men’s beginner strength class covering the main lifts with strict coaching on form. Small groups, steady progression, no gym-floor guesswork.',
    reviewCount: 49,
    policyId: 'flex-48',
    included: ['Two coached sessions per week', 'All equipment', 'Technique review'],
    bring: ['Training shoes', 'Water bottle'],
    instructorName: 'Yusuf Rahman',
    instructorTitle: 'Head Coach · Calisthenics',
    facilities: ['Changing rooms', 'Showers', 'Parking'],
  },
  'junior-calisthenics': {
    description:
      'After-school bodyweight training for ages 8–14 — climbing, hanging, and controlled strength work that builds real athleticism. Energy welcome; coaching keeps it safe.',
    reviewCount: 61,
    policyId: 'flex-48',
    included: ['Two after-school sessions per week', 'All equipment'],
    bring: ['Sportswear', 'Water bottle'],
    instructorName: 'Aisha Karim',
    instructorTitle: 'Junior Programme Coach',
    facilities: ['Parent viewing area', 'Changing rooms', 'Parking'],
    safetyNote: 'Spotters on all elevated equipment.',
  },
  'karate-foundations': {
    description:
      'Adult karate from zero: stances, blocks, and first kata in a patient, technical Saturday class. A serious martial art taught without intimidation.',
    reviewCount: 38,
    policyId: 'flex-24',
    included: ['Coached 75-minute class', 'Loan gi for your first month'],
    bring: ['Comfortable sportswear', 'Water bottle'],
    instructorName: 'Sensei Omar Farid',
    instructorTitle: '4th Dan · Head Instructor',
    facilities: ['Changing rooms', 'Showers', 'Parking'],
  },
  'junior-jiujitsu': {
    description:
      'Fundamentals of jiu-jitsu for ages 6–12: safe falling, positions, and controlled drilling with a heavy emphasis on respect and discipline. Gi provided for beginners.',
    reviewCount: 84,
    policyId: 'flex-48',
    included: ['Two after-school sessions per week', 'Loan gi for beginners'],
    bring: ['Water bottle', 'Flip-flops for matside'],
    instructorName: 'Coach Rafael Lima',
    instructorTitle: 'BJJ Black Belt · Kids Programme',
    facilities: ['Full mat hall', 'Parent viewing area', 'Changing rooms'],
    safetyNote: 'No submissions for under-8s; age-matched pairing.',
  },
  'adult-swim-technique': {
    description:
      'A six-session clinic for adults who can swim but want to swim well — filmed stroke analysis, drills, and pacing work in a small lane group.',
    reviewCount: 57,
    policyId: 'flex-48',
    included: ['Six coached sessions', 'Two filmed stroke analyses', 'Personal drill plan'],
    bring: ['Swimsuit, goggles, and cap', 'Towel'],
    instructorName: 'Coach Daniel Reyes',
    instructorTitle: 'Head Swim Coach',
    facilities: ['Heated indoor pool', 'Changing rooms', 'Showers'],
    branchId: 'blue-wave-beach',
  },
  'morning-yoga': {
    description:
      'A daily sunrise flow that wakes the body up gently — mobility, balance, and breath in under an hour, before the day begins. All levels, every day.',
    reviewCount: 141,
    policyId: 'flex-24',
    included: ['Mats and props', '60-minute guided flow'],
    bring: ['Water bottle'],
    facilities: ['Boutique studio', 'Changing rooms', 'Filtered water'],
  },
  'teen-yoga-mobility': {
    description:
      'Saturday yoga and mobility built for teenagers — posture, flexibility, and stress relief without the pressure of an adult class. Great alongside sport or study.',
    reviewCount: 33,
    policyId: 'flex-48',
    included: ['Weekly 60-minute class', 'Mats and props'],
    instructorName: 'Huda Nasser',
    instructorTitle: 'Yoga & Mobility Instructor',
    facilities: ['Boutique studio', 'Parent waiting area'],
  },
  'adult-tajweed-circle': {
    description:
      'An evening Tajweed circle for adults — recitation rules applied verse by verse in a supportive small group. Suitable whether you are correcting habits or starting fresh.',
    reviewCount: 78,
    policyId: 'flex-48',
    included: ['Two evening circles per week', 'Tajweed workbook'],
    instructorName: 'Ustadh Ibrahim Kazi',
    instructorTitle: 'Qira’at Specialist',
    facilities: ['Quiet classrooms', 'Parking'],
  },
  'family-football-weekend': {
    description:
      'Casual Saturday football where parents and children play on the same pitch — small games, mixed teams, and a coach to keep it flowing. Turn up and play together.',
    reviewCount: 45,
    policyId: 'flex-24',
    included: ['Organized small-sided games', 'Bibs and balls'],
    bring: ['Sports shoes', 'Water bottles'],
    facilities: ['Outdoor community pitches', 'Parking'],
  },
  'junior-tennis-stars': {
    description:
      'Weekend tennis for ages 6–12 using age-sized courts, rackets, and balls, so juniors rally from week one. Term blocks build technique into real match play.',
    reviewCount: 52,
    policyId: 'flex-48',
    included: ['Two weekend sessions', 'Loan rackets', 'End-of-term mini matches'],
    bring: ['Sports shoes', 'Cap and water bottle'],
    instructorName: 'Coach Anna Kovac',
    instructorTitle: 'Junior Tennis Lead',
    facilities: ['Shaded courts', 'Parent seating', 'Café'],
    safetyNote: 'Early-morning sessions in summer heat.',
  },
  'junior-pottery': {
    description:
      'Six hands-on pottery sessions for young makers — pinch pots, coil work, and glazing, with every piece fired and sent home. Aprons on, screens off.',
    reviewCount: 39,
    policyId: 'flex-48',
    included: ['Six sessions', 'All clay, tools, and firing', 'Apron'],
    bring: ['Clothes that can get messy'],
    instructorName: 'Maya Haddad',
    instructorTitle: 'Ceramics Studio Lead',
    facilities: ['Dedicated kids’ studio', 'Kiln on site', 'Parent café'],
  },
  'watercolour-evenings': {
    description:
      'A relaxed evening watercolour class for adults — one guided painting per session, materials included, no experience expected. Leave with something worth framing.',
    reviewCount: 71,
    policyId: 'flex-24',
    included: ['All paints, brushes, and paper', 'Guided 2-hour session'],
    instructorName: 'Maya Haddad',
    instructorTitle: 'Studio Lead',
    facilities: ['Evening studio', 'Café', 'Parking'],
  },
  'arabic-adults-evenings': {
    description:
      'Evening conversational Arabic for adults living in the UAE — practical phrases, real dialogues, and cultural context you can use the next morning.',
    reviewCount: 66,
    policyId: 'flex-48',
    included: ['Two evening classes per week', 'Course materials', 'Placement chat'],
    instructorName: 'Ustadha Layla Hamdan',
    instructorTitle: 'Arabic Language Teacher',
    facilities: ['Modern classrooms', 'Parking'],
  },
  'teen-arabic-summer': {
    description:
      'A two-week summer intensive that lifts teens’ Arabic through morning immersion — conversation labs, media projects, and daily speaking practice.',
    reviewCount: 29,
    policyId: 'non-refundable',
    included: ['Ten camp mornings', 'All materials', 'Progress report'],
    bring: ['Notebook', 'Water bottle'],
    instructorName: 'Ustadha Layla Hamdan',
    instructorTitle: 'Arabic Language Teacher',
    facilities: ['Modern classrooms', 'Air-conditioned campus'],
  },
  'community-park-football': {
    description:
      'A free Saturday-morning community football session — open games on the park pitches before the heat, organized by volunteer coaches. Everyone plays.',
    reviewCount: 58,
    policyId: 'flex-24',
    included: ['Organized open games', 'Bibs and balls'],
    bring: ['Sports shoes', 'Water bottle'],
    facilities: ['Public park pitches', 'Free parking'],
  },
};
