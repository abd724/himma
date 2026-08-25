/**
 * RI-2 — deterministic DEVELOPMENT catalogue seed (docs/34 §11: "seeded
 * realistic dev catalogue/schedule data — mock fixtures graduate to
 * seeds").
 *
 * Populates a LOCAL dev database with a realistic, entirely FICTIONAL
 * public catalogue (areas, activity types, live providers with published
 * profiles/branches, published programs with price options/offers, and
 * upcoming capacity units) so the Customer App's real discovery surfaces
 * and the Playwright journeys have genuine backend truth to read.
 *
 * - REFUSES to run when NODE_ENV=production (dev tooling only; the
 *   canonical production taxonomy remains D-S4-3 / admin authority).
 * - Idempotent: exits without writing when the seed marker organization
 *   already exists (reseed = fresh dev database via db:migrate).
 * - No real providers, brands, addresses, or people; no media rows (no
 *   public media serving exists yet — the app renders its own bundled
 *   presentation imagery).
 * - Writes ONLY through the certified schema with its triggers/state
 *   machines (programs walk the §5.3 machine to published; counters are
 *   never touched).
 *
 * Run: `npm run dev:seed`.
 */
import { Pool } from 'pg';
import { sql, type Kysely } from 'kysely';

import { newId } from '../src/db/ids';
import { createDb, type DB } from '../src/db/kysely';
import { rebuildAllSearchDocuments } from '../src/modules/catalogue/services/search-projection';
import { cliConfig, fail } from './cli-env';

const SEED_TAG = '(dev seed)';

/** Upcoming instants relative to the run: n days ahead at 14:00 UTC
 *  (18:00 Asia/Dubai) so seeded schedules stay bookable for weeks. */
function at(daysAhead: number, hourUtc = 14): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

function dateOnly(daysAhead: number): string {
  return at(daysAhead).toISOString().slice(0, 10);
}

interface SeedContext {
  db: Kysely<DB>;
  areaIds: Record<string, string>;
  typeIds: Record<string, string>;
  categoryIds: Record<string, string>;
}

async function createArea(ctx: SeedContext, slug: string, label: string, sortHint: number) {
  const id = newId();
  await sql`INSERT INTO area (id, slug, label_en, city, sort_hint)
            VALUES (${id}, ${slug}, ${label}, 'Abu Dhabi', ${sortHint})`.execute(ctx.db);
  ctx.areaIds[slug] = id;
}

async function createType(ctx: SeedContext, categorySlug: string, slug: string, label: string) {
  const id = newId();
  await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
            VALUES (${id}, ${ctx.categoryIds[categorySlug]}, ${slug}, ${label})`.execute(ctx.db);
  ctx.typeIds[slug] = id;
}

interface SeedProvider {
  orgId: string;
  branchIds: string[];
}

async function createProvider(
  ctx: SeedContext,
  input: {
    displayName: string;
    description: string;
    branches: { label: string; areaSlug: string; addressLine: string }[];
  },
): Promise<SeedProvider> {
  const orgId = newId();
  await sql`INSERT INTO organization (id, legal_name, trade_name, verification_state)
            VALUES (${orgId}, ${`${input.displayName} LLC ${SEED_TAG}`},
                    ${input.displayName}, 'live')`.execute(ctx.db);
  await sql`INSERT INTO organization_public_profile
              (organization_id, display_name, description_en, published)
            VALUES (${orgId}, ${input.displayName}, ${input.description}, true)`.execute(ctx.db);
  const branchIds: string[] = [];
  for (const branch of input.branches) {
    const branchId = newId();
    const area = await sql<{ label_en: string }>`
      SELECT label_en FROM area WHERE id = ${ctx.areaIds[branch.areaSlug]}`.execute(ctx.db);
    await sql`INSERT INTO branch (id, organization_id, label, area_id, area_label,
                                  address_line, city)
              VALUES (${branchId}, ${orgId}, ${branch.label},
                      ${ctx.areaIds[branch.areaSlug]}, ${area.rows[0]!.label_en},
                      ${branch.addressLine}, 'Abu Dhabi')`.execute(ctx.db);
    branchIds.push(branchId);
  }
  return { orgId, branchIds };
}

interface SeedProgramInput {
  provider: SeedProvider;
  branchIndexes?: number[];
  typeSlug: string;
  title: string;
  description: string;
  setting?: 'indoor' | 'outdoor';
  gender?: 'mixed' | 'women';
  minAge?: number | null;
  maxAge?: number | null;
  allAges?: boolean;
  skillLevel?: string | null;
  options: { kind: string; amountFils?: number | null; sessionsCount?: number | null; label?: string }[];
  offers?: { kind: string; label: string; trialAmountFils?: number }[];
  /** Upcoming session specs: [daysAhead, capacity]. */
  sessions?: [number, number][];
  campWeeks?: { startDaysAhead: number; capacity: number }[];
  cohort?: { capacity: number };
}

async function createSeedProgram(ctx: SeedContext, input: SeedProgramInput): Promise<string> {
  const programId = newId();
  await sql`INSERT INTO program (id, organization_id, activity_type_id, title_en,
                                 description_en, setting, gender_eligibility,
                                 min_age, max_age, all_ages, skill_level)
            VALUES (${programId}, ${input.provider.orgId}, ${ctx.typeIds[input.typeSlug]},
                    ${input.title}, ${input.description}, ${input.setting ?? 'indoor'},
                    ${input.gender ?? 'mixed'}, ${input.minAge ?? null},
                    ${input.maxAge ?? null}, ${input.allAges ?? false},
                    ${input.skillLevel ?? null})`.execute(ctx.db);
  const branchIds = (input.branchIndexes ?? [0]).map((i) => input.provider.branchIds[i]!);
  for (const branchId of branchIds) {
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id)
              VALUES (${programId}, ${branchId}, ${input.provider.orgId})`.execute(ctx.db);
  }
  for (const option of input.options) {
    await sql`INSERT INTO program_price_option (id, program_id, organization_id, kind,
                                                amount_fils, sessions_count, label_en)
              VALUES (${newId()}, ${programId}, ${input.provider.orgId}, ${option.kind},
                      ${option.amountFils ?? null}, ${option.sessionsCount ?? null},
                      ${option.label ?? null})`.execute(ctx.db);
  }
  for (const offer of input.offers ?? []) {
    await sql`INSERT INTO offer (id, organization_id, program_id, kind, label_en,
                                 trial_amount_fils, state)
              VALUES (${newId()}, ${input.provider.orgId}, ${programId}, ${offer.kind},
                      ${offer.label}, ${offer.trialAmountFils ?? null}, 'active')`.execute(ctx.db);
  }
  // The certified §5.3 listing machine — every edge is trigger-legal.
  for (const state of ['submitted', 'in_review', 'approved']) {
    await sql`UPDATE program SET listing_state = ${state} WHERE id = ${programId}`.execute(ctx.db);
  }
  await sql`UPDATE program SET listing_state = 'published', published_at = now()
            WHERE id = ${programId}`.execute(ctx.db);
  for (const [daysAhead, capacity] of input.sessions ?? []) {
    await sql`INSERT INTO session (id, program_id, organization_id, branch_id, start_at,
                                   end_at, capacity, registration_cutoff_at)
              VALUES (${newId()}, ${programId}, ${input.provider.orgId}, ${branchIds[0]},
                      ${at(daysAhead)}, ${at(daysAhead, 15)}, ${capacity},
                      ${at(daysAhead)})`.execute(ctx.db);
  }
  for (const week of input.campWeeks ?? []) {
    await sql`INSERT INTO camp_week (id, program_id, organization_id, branch_id, start_date,
                                     end_date, daily_start_time, daily_end_time, capacity,
                                     registration_cutoff_at)
              VALUES (${newId()}, ${programId}, ${input.provider.orgId}, ${branchIds[0]},
                      ${dateOnly(week.startDaysAhead)}, ${dateOnly(week.startDaysAhead + 4)},
                      '09:00', '13:00', ${week.capacity},
                      ${at(week.startDaysAhead)})`.execute(ctx.db);
  }
  if (input.cohort !== undefined) {
    await sql`INSERT INTO enrolment_cohort (id, program_id, organization_id, branch_id,
                                            effective_start, effective_end, capacity,
                                            enrolment_cutoff_at)
              VALUES (${newId()}, ${programId}, ${input.provider.orgId}, ${branchIds[0]},
                      ${dateOnly(7)}, ${dateOnly(97)}, ${input.cohort.capacity},
                      ${at(7)})`.execute(ctx.db);
  }
  return programId;
}

async function main(): Promise<void> {
  const config = cliConfig();
  if (config.nodeEnv === 'production') {
    throw new Error('dev-seed is development-only tooling and refuses to run in production.');
  }
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    ...(config.database.password !== undefined ? { password: config.database.password } : {}),
  });
  const db = createDb(pool);

  const existing = await sql<{ id: string }>`
    SELECT id FROM organization WHERE legal_name LIKE ${`%${SEED_TAG}`} LIMIT 1`.execute(db);
  if (existing.rows.length > 0) {
    // Heal projection drift even when the rows already exist (the certified
    // search engine reads program_search_document, maintained by the
    // service layer — the seed writes rows directly).
    const { refreshed } = await rebuildAllSearchDocuments({ db });
    console.log(
      `dev-seed: catalogue already seeded — search documents rebuilt (${refreshed}).`,
    );
    await pool.end();
    return;
  }

  const categories = await sql<{ id: string; slug: string }>`
    SELECT id, slug FROM category`.execute(db);
  const ctx: SeedContext = {
    db,
    areaIds: {},
    typeIds: {},
    categoryIds: Object.fromEntries(categories.rows.map((row) => [row.slug, row.id])),
  };

  // Areas (fictional placements in real Abu Dhabi districts — labels only).
  await createArea(ctx, 'khalifa-city', 'Khalifa City', 10);
  await createArea(ctx, 'al-raha', 'Al Raha', 20);
  await createArea(ctx, 'mbz-city', 'MBZ City', 30);
  await createArea(ctx, 'yas-island', 'Yas Island', 40);
  await createArea(ctx, 'al-reem', 'Al Reem Island', 50);
  await createArea(ctx, 'saadiyat', 'Saadiyat Island', 60);
  await createArea(ctx, 'abu-dhabi-island', 'Abu Dhabi Island', 70);

  // Activity types across the canonical categories.
  await createType(ctx, 'fitness', 'gym-training', 'Gym training');
  await createType(ctx, 'fitness', 'crossfit', 'CrossFit');
  await createType(ctx, 'martial-arts', 'brazilian-jiu-jitsu', 'Brazilian Jiu-Jitsu');
  await createType(ctx, 'martial-arts', 'boxing', 'Boxing');
  await createType(ctx, 'swimming', 'learn-to-swim', 'Learn to swim');
  await createType(ctx, 'swimming', 'swim-squad', 'Swim squad');
  await createType(ctx, 'padel-racquet', 'padel', 'Padel');
  await createType(ctx, 'pilates-yoga', 'reformer-pilates', 'Reformer Pilates');
  await createType(ctx, 'pilates-yoga', 'yoga', 'Yoga');
  await createType(ctx, 'team-outdoor', 'football', 'Football');
  await createType(ctx, 'tech-stem', 'robotics', 'Robotics');
  await createType(ctx, 'tech-stem', 'coding', 'Coding');
  await createType(ctx, 'quran', 'tajweed', 'Tajweed');
  await createType(ctx, 'arts-creativity', 'art-club', 'Art club');

  const coastal = await createProvider(ctx, {
    displayName: 'Coastal Padel Club',
    description:
      'Purpose-built padel courts with coached sessions and open play for every level.',
    branches: [
      { label: 'Al Raha Courts', areaSlug: 'al-raha', addressLine: '14 Marina Promenade' },
      { label: 'Yas Sports Hub', areaSlug: 'yas-island', addressLine: '2 Stadium Boulevard' },
    ],
  });
  await createSeedProgram(ctx, {
    provider: coastal,
    branchIndexes: [0, 1],
    typeSlug: 'padel',
    title: 'Adult Padel Open Play',
    description: 'Coached open-play evenings. Rackets and balls provided — just bring court shoes.',
    minAge: 16,
    options: [{ kind: 'dropIn', amountFils: 9000, label: 'Per session' }],
    sessions: [
      [2, 12],
      [4, 12],
      [6, 2],
      [9, 12],
      [11, 12],
    ],
  });
  await createSeedProgram(ctx, {
    provider: coastal,
    typeSlug: 'padel',
    title: 'Padel Fundamentals Course',
    description: 'A progressive four-week fundamentals block for new players.',
    minAge: 16,
    skillLevel: 'beginner',
    options: [{ kind: 'monthly', amountFils: 60000, label: 'Monthly' }],
    cohort: { capacity: 12 },
  });

  const ironTide = await createProvider(ctx, {
    displayName: 'Iron Tide Fitness',
    description: 'Strength and conditioning coaching in a spacious, well-equipped gym.',
    branches: [
      { label: 'Khalifa City Gym', areaSlug: 'khalifa-city', addressLine: '31 Souk Street' },
    ],
  });
  await createSeedProgram(ctx, {
    provider: ironTide,
    typeSlug: 'gym-training',
    title: 'Open Gym Session',
    description: 'Full-floor access with a coach on hand for form checks and programming help.',
    minAge: 16,
    options: [{ kind: 'dropIn', amountFils: 5000, label: 'Per visit' }],
    sessions: [
      [1, 20],
      [2, 20],
      [3, 20],
      [5, 20],
      [8, 20],
    ],
  });
  await createSeedProgram(ctx, {
    provider: ironTide,
    typeSlug: 'crossfit',
    title: 'CrossFit Foundations',
    description: 'Small-group foundations classes covering the core lifts and conditioning.',
    minAge: 16,
    skillLevel: 'beginner',
    options: [{ kind: 'monthly', amountFils: 45000, label: 'Monthly' }],
    offers: [{ kind: 'freeTrial', label: 'Free trial class' }],
    cohort: { capacity: 10 },
    sessions: [
      [2, 10],
      [4, 3],
    ],
  });

  const serenity = await createProvider(ctx, {
    displayName: 'Serenity Pilates House',
    description: 'A calm reformer and mat studio with small classes and attentive coaching.',
    branches: [
      { label: 'Al Reem Studio', areaSlug: 'al-reem', addressLine: '5 Gate Tower Podium' },
    ],
  });
  await createSeedProgram(ctx, {
    provider: serenity,
    typeSlug: 'reformer-pilates',
    title: 'Ladies Reformer Pilates',
    description: 'Ladies-only reformer classes for posture, mobility, and strength.',
    gender: 'women',
    minAge: 16,
    options: [
      { kind: 'dropIn', amountFils: 8500, label: 'Per class' },
      { kind: 'package', amountFils: 76000, sessionsCount: 10, label: '10-class pack' },
    ],
    sessions: [
      [1, 8],
      [3, 8],
      [5, 2],
      [7, 8],
    ],
  });
  await createSeedProgram(ctx, {
    provider: serenity,
    typeSlug: 'yoga',
    title: 'Sunrise Yoga Flow',
    description: 'A gentle morning vinyasa flow open to all levels.',
    allAges: true,
    options: [{ kind: 'dropIn', amountFils: 6000, label: 'Per class' }],
    sessions: [
      [2, 14],
      [4, 14],
      [6, 14],
    ],
  });

  const littlePearls = await createProvider(ctx, {
    displayName: 'Little Pearls Swim Academy',
    description: 'Certified swim instructors teaching confident, safe swimming from age four.',
    branches: [
      { label: 'Saadiyat Pool', areaSlug: 'saadiyat', addressLine: '9 Cultural District Way' },
      { label: 'Khalifa City Pool', areaSlug: 'khalifa-city', addressLine: '18 Garden Avenue' },
    ],
  });
  await createSeedProgram(ctx, {
    provider: littlePearls,
    branchIndexes: [0, 1],
    typeSlug: 'learn-to-swim',
    title: 'Kids Learn-to-Swim',
    description: 'Progressive small-group lessons with a maximum of four swimmers per coach.',
    minAge: 4,
    maxAge: 10,
    options: [{ kind: 'monthly', amountFils: 40000, label: 'Monthly (2 lessons/week)' }],
    offers: [{ kind: 'paidTrial', label: 'Trial lesson', trialAmountFils: 2500 }],
    cohort: { capacity: 8 },
  });
  await createSeedProgram(ctx, {
    provider: littlePearls,
    typeSlug: 'swim-squad',
    title: 'Junior Swim Squad',
    description: 'Structured squad training for confident swimmers building technique and stamina.',
    minAge: 8,
    maxAge: 14,
    skillLevel: 'intermediate',
    options: [{ kind: 'monthly', amountFils: 35000, label: 'Monthly' }],
    cohort: { capacity: 3 },
  });

  const harbor = await createProvider(ctx, {
    displayName: 'Harbor Martial Arts',
    description: 'Traditional coaching in Brazilian Jiu-Jitsu and boxing for adults and kids.',
    branches: [
      { label: 'MBZ City Dojo', areaSlug: 'mbz-city', addressLine: '44 Baniyas Road' },
    ],
  });
  await createSeedProgram(ctx, {
    provider: harbor,
    typeSlug: 'brazilian-jiu-jitsu',
    title: 'Adult BJJ Fundamentals',
    description: 'Fundamentals classes covering positions, escapes, and controlled sparring.',
    minAge: 16,
    options: [
      { kind: 'dropIn', amountFils: 7000, label: 'Per class' },
      { kind: 'package', amountFils: 60000, sessionsCount: 10, label: '10-class pack' },
    ],
    sessions: [
      [1, 16],
      [3, 16],
      [5, 16],
      [8, 16],
    ],
  });
  await createSeedProgram(ctx, {
    provider: harbor,
    typeSlug: 'boxing',
    title: 'Kids Boxing Club',
    description: 'Non-contact boxing fitness for kids — footwork, pads, and discipline.',
    minAge: 8,
    maxAge: 12,
    options: [{ kind: 'monthly', amountFils: 30000, label: 'Monthly' }],
    cohort: { capacity: 14 },
    sessions: [
      [2, 14],
      [4, 14],
    ],
  });

  const brightMinds = await createProvider(ctx, {
    displayName: 'Bright Minds Studio',
    description: 'Hands-on STEM and creative programs run by specialist instructors.',
    branches: [
      { label: 'Yas Learning Lab', areaSlug: 'yas-island', addressLine: '7 Discovery Walk' },
    ],
  });
  await createSeedProgram(ctx, {
    provider: brightMinds,
    typeSlug: 'robotics',
    title: 'Junior Robotics Camp',
    description: 'A week of building and programming robots, ending with a family showcase.',
    minAge: 7,
    maxAge: 12,
    options: [{ kind: 'camp', amountFils: 90000, label: 'Per week' }],
    campWeeks: [
      { startDaysAhead: 14, capacity: 12 },
      { startDaysAhead: 21, capacity: 12 },
    ],
  });
  await createSeedProgram(ctx, {
    provider: brightMinds,
    typeSlug: 'art-club',
    title: 'Kids Art Club',
    description: 'Weekly mixed-media art sessions — drawing, painting, and clay.',
    minAge: 5,
    maxAge: 10,
    options: [{ kind: 'dropIn', amountFils: 8000, label: 'Per session' }],
    sessions: [
      [3, 10],
      [10, 10],
    ],
  });
  // A published listing with NO upcoming units — the truthful
  // "no upcoming sessions" discovery state.
  await createSeedProgram(ctx, {
    provider: brightMinds,
    typeSlug: 'coding',
    title: 'Scratch Coding Basics',
    description: 'A playful introduction to programming concepts with Scratch.',
    minAge: 7,
    maxAge: 11,
    options: [{ kind: 'dropIn', amountFils: 8000, label: 'Per session' }],
  });

  const noor = await createProvider(ctx, {
    displayName: 'Noor Learning Center',
    description: 'Quran recitation and tajweed circles for all ages in a welcoming setting.',
    branches: [
      {
        label: 'Abu Dhabi Island Center',
        areaSlug: 'abu-dhabi-island',
        addressLine: '12 Corniche Road East',
      },
    ],
  });
  await createSeedProgram(ctx, {
    provider: noor,
    typeSlug: 'tajweed',
    title: 'Community Tajweed Circle',
    description: 'A free weekly community circle improving recitation with qualified teachers.',
    allAges: true,
    options: [{ kind: 'free' }],
    sessions: [
      [5, 30],
      [12, 30],
    ],
  });

  // The certified search engine reads the derived search documents; build
  // them exactly the way the owning service does.
  await rebuildAllSearchDocuments({ db });

  const summary = await sql<{ programs: string; sessions: string }>`
    SELECT (SELECT count(*) FROM program WHERE listing_state = 'published') AS programs,
           (SELECT count(*) FROM session) AS sessions`.execute(db);
  console.log(
    `dev-seed: seeded fictional catalogue — ${summary.rows[0]!.programs} published programs, ` +
      `${summary.rows[0]!.sessions} sessions (env=${config.nodeEnv}, db=${config.database.database}).`,
  );
  await pool.end();
}

main().catch(fail);
