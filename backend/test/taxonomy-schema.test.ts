/**
 * S4-1 — Taxonomy and reference schema (migration 0007; docs/28 §9 "0007",
 * D-S4-3; docs/24 §2.1; docs/15 §3). Real PostgreSQL: the deterministic
 * twelve-entry launch seed (11 categories + the two entry-12 collection/
 * format lenses), stable ids/slugs, slug immutability, active/inactive
 * state, English-only sufficiency, the branch.area_id FK completion, and
 * himma_app grants. No taxonomy services or routes exist in S4-1.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

/**
 * The canonical deterministic seed (docs/15 §3 entries 1–11 in order).
 * Ids are fixed literals in migration 0007 so migrate-from-zero always
 * produces the identical canonical taxonomy (D-S4-3).
 */
const SEEDED_CATEGORIES = [
  { id: '01986aa0-0000-7000-8000-000000000101', slug: 'fitness', label: 'Fitness & gyms' },
  { id: '01986aa0-0000-7000-8000-000000000102', slug: 'martial-arts', label: 'Martial arts & combat' },
  { id: '01986aa0-0000-7000-8000-000000000103', slug: 'swimming', label: 'Swimming & water' },
  { id: '01986aa0-0000-7000-8000-000000000104', slug: 'padel-racquet', label: 'Padel & racquet' },
  { id: '01986aa0-0000-7000-8000-000000000105', slug: 'pilates-yoga', label: 'Pilates, yoga & movement' },
  { id: '01986aa0-0000-7000-8000-000000000106', slug: 'team-outdoor', label: 'Team & outdoor sports' },
  { id: '01986aa0-0000-7000-8000-000000000107', slug: 'wellness', label: 'Wellness & recovery' },
  { id: '01986aa0-0000-7000-8000-000000000108', slug: 'learning', label: 'Learning & languages' },
  { id: '01986aa0-0000-7000-8000-000000000109', slug: 'quran', label: 'Quran & Islamic learning' },
  { id: '01986aa0-0000-7000-8000-00000000010a', slug: 'tech-stem', label: 'Technology & STEM' },
  { id: '01986aa0-0000-7000-8000-00000000010b', slug: 'arts-creativity', label: 'Arts, music & creativity' },
];

/** docs/15 §3 entry 12 — the two lenses seeded as collections, never categories. */
const SEEDED_COLLECTIONS = [
  { id: '01986aa0-0000-7000-8000-000000000201', title: 'Kids & Teens' },
  { id: '01986aa0-0000-7000-8000-000000000202', title: 'Camps & seasonal' },
];

describe('docs/15 §3 twelve-entry launch seed (D-S4-3)', () => {
  it('seeds exactly the eleven approved categories, deterministically ordered and identified', async () => {
    const rows = await sql<{
      id: string;
      slug: string;
      label_en: string;
      label_ar: string | null;
      active: boolean;
      version: number;
    }>`SELECT id, slug, label_en, label_ar, active, version
       FROM category ORDER BY sort_hint, slug`.execute(testDb.db);
    expect(rows.rows.map((r) => ({ id: r.id, slug: r.slug, label: r.label_en }))).toEqual(
      SEEDED_CATEGORIES,
    );
    for (const row of rows.rows) {
      // English-only launch content: Arabic optional, active, version 1.
      expect(row.label_ar).toBeNull();
      expect(row.active).toBe(true);
      expect(row.version).toBe(1);
    }
  });

  it('seeds entry 12 as the two collection/format lenses, never as categories (docs/15 §2)', async () => {
    const collections = await sql<{
      id: string;
      title_en: string;
      preset_child_relevant: boolean;
      preset_camps: boolean;
      child_focused: boolean;
      state: string;
    }>`SELECT id, title_en, preset_child_relevant, preset_camps, child_focused, state
       FROM collection ORDER BY id`.execute(testDb.db);
    expect(collections.rows.map((r) => ({ id: r.id, title: r.title_en }))).toEqual(
      SEEDED_COLLECTIONS,
    );
    const kidsTeens = collections.rows[0];
    const camps = collections.rows[1];
    expect(kidsTeens?.preset_child_relevant).toBe(true);
    expect(kidsTeens?.child_focused).toBe(true);
    expect(camps?.preset_camps).toBe(true);
    expect(collections.rows.every((r) => r.state === 'published')).toBe(true);
    // No "kids" or "camps" category exists — lenses are not duplicate trees.
    const lensCategories = await sql<{ n: string }>`
      SELECT count(*) AS n FROM category WHERE slug ~ '(kids|camp)'`.execute(testDb.db);
    expect(Number(lensCategories.rows[0]?.n)).toBe(0);
  });

  it('keeps the taxonomy at exactly two visible levels: no parent columns beyond category_id', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('category', 'activity_type')
        AND column_name ~ '(parent|hierarchy|depth|tree)'`.execute(testDb.db);
    expect(columns.rows).toEqual([]);
  });
});

describe('taxonomy integrity', () => {
  it('slugs are unique and immutable after insert; labels stay editable with CAS conventions', async () => {
    await expect(
      sql`INSERT INTO category (id, slug, label_en, sort_hint)
          VALUES (${newId()}, 'fitness', 'Duplicate', 999)`.execute(testDb.db),
    ).rejects.toThrow();

    const fitness = SEEDED_CATEGORIES[0]!.id;
    await expect(
      sql`UPDATE category SET slug = 'renamed-fitness' WHERE id = ${fitness}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);

    // Label edit works and bumps version + updated_at (admin data is mutable).
    await sql`UPDATE category SET label_ar = ${'اللياقة'} WHERE id = ${fitness}`.execute(testDb.db);
    const after = await sql<{ version: number }>`
      SELECT version FROM category WHERE id = ${fitness}`.execute(testDb.db);
    expect(after.rows[0]?.version).toBe(2);

    // CAS: a stale writer affects zero rows.
    const stale = await sql`UPDATE category SET label_en = 'Stale' WHERE id = ${fitness} AND version = 1`.execute(
      testDb.db,
    );
    expect(stale.numAffectedRows).toBe(0n);
    await sql`UPDATE category SET label_ar = NULL WHERE id = ${fitness}`.execute(testDb.db);
  });

  it('future taxonomy additions are additive data changes, English-only content suffices', async () => {
    const categoryId = newId();
    await sql`INSERT INTO category (id, slug, label_en, sort_hint)
              VALUES (${categoryId}, 'test-new-category', 'New Category', 900)`.execute(testDb.db);
    const typeId = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en, synonyms_en)
              VALUES (${typeId}, ${categoryId}, 'test-new-type', 'New Type',
                      ${sql.raw(`ARRAY['newtype','new type']::text[]`)})`.execute(testDb.db);
    const row = await sql<{ label_ar: string | null; synonyms_ar: string[] }>`
      SELECT label_ar, synonyms_ar FROM activity_type WHERE id = ${typeId}`.execute(testDb.db);
    expect(row.rows[0]?.label_ar).toBeNull();
    expect(row.rows[0]?.synonyms_ar).toEqual([]);
    // Deactivation, never deletion (the app role holds no DELETE grant).
    await sql`UPDATE activity_type SET active = false WHERE id = ${typeId}`.execute(testDb.db);
    await expect(
      withTransaction(testDb.db, async (trx) => {
        await sql`SET LOCAL ROLE himma_app`.execute(trx);
        await sql`DELETE FROM activity_type WHERE id = ${typeId}`.execute(trx);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('activity types require a valid parent category and unique immutable slugs', async () => {
    await expect(
      sql`INSERT INTO activity_type (id, category_id, slug, label_en)
          VALUES (${newId()}, ${newId()}, 'orphan-type', 'Orphan')`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);

    const category = SEEDED_CATEGORIES[1]!.id;
    const a = newId();
    await sql`INSERT INTO activity_type (id, category_id, slug, label_en)
              VALUES (${a}, ${category}, 'test-jiu-jitsu', 'Jiu-jitsu')`.execute(testDb.db);
    await expect(
      sql`INSERT INTO activity_type (id, category_id, slug, label_en)
          VALUES (${newId()}, ${category}, 'test-jiu-jitsu', 'Jiu-jitsu 2')`.execute(testDb.db),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE activity_type SET slug = 'test-bjj' WHERE id = ${a}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects invalid collection audience and state values', async () => {
    await expect(
      sql`INSERT INTO collection (id, title_en, audience) VALUES (${newId()}, 'Bad', 'schools')`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO collection (id, title_en, state) VALUES (${newId()}, 'Bad', 'live')`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
  });
});

describe('area reference table and the S3-1 branch.area_id completion', () => {
  it('areas carry unique immutable slugs and optional Arabic labels', async () => {
    const id = newId();
    await sql`INSERT INTO area (id, slug, label_en, city, sort_hint)
              VALUES (${id}, 'test-khalifa-city', 'Khalifa City', 'Abu Dhabi', 10)`.execute(testDb.db);
    await expect(
      sql`INSERT INTO area (id, slug, label_en) VALUES (${newId()}, 'test-khalifa-city', 'Dup')`.execute(
        testDb.db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE area SET slug = 'test-kc' WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/immutable/);
  });

  it('branch.area_id now enforces the canonical Area FK without redesigning Branch', async () => {
    const org = newId();
    await sql`INSERT INTO organization (id, legal_name, trade_name)
              VALUES (${org}, 'Area Test LLC', 'Area Test')`.execute(testDb.db);

    const area = newId();
    await sql`INSERT INTO area (id, slug, label_en)
              VALUES (${area}, 'test-al-reem', 'Al Reem Island')`.execute(testDb.db);

    // Valid area reference works; area_label remains as denormalized display.
    await sql`INSERT INTO branch (id, organization_id, label, area_label, area_id)
              VALUES (${newId()}, ${org}, 'B1', 'Al Reem Island', ${area})`.execute(testDb.db);
    // NULL area_id remains allowed until reconciliation completes.
    await sql`INSERT INTO branch (id, organization_id, label, area_label)
              VALUES (${newId()}, ${org}, 'B2', 'Somewhere')`.execute(testDb.db);
    // A dangling area reference is refused.
    await expect(
      sql`INSERT INTO branch (id, organization_id, label, area_label, area_id)
          VALUES (${newId()}, ${org}, 'B3', 'Nowhere', ${newId()})`.execute(testDb.db),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('application-role permissions (taxonomy)', () => {
  it('himma_app can select/insert/update taxonomy tables but never delete', async () => {
    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      const id = newId();
      await sql`INSERT INTO area (id, slug, label_en)
                VALUES (${id}, 'test-app-area', 'App Area')`.execute(trx);
      await sql`UPDATE area SET label_en = 'App Area 2' WHERE id = ${id}`.execute(trx);
      await sql`SELECT count(*) FROM category`.execute(trx);
      await sql`SELECT count(*) FROM activity_type`.execute(trx);
      await sql`SELECT count(*) FROM collection`.execute(trx);
    });
    for (const table of ['area', 'category', 'activity_type', 'collection']) {
      await expect(
        withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await sql.raw(`DELETE FROM ${table}`).execute(trx);
        }),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('himma_app cannot disable the taxonomy integrity triggers', async () => {
    await expect(
      withTransaction(testDb.db, async (trx) => {
        await sql`SET LOCAL ROLE himma_app`.execute(trx);
        await sql`ALTER TABLE category DISABLE TRIGGER ALL`.execute(trx);
      }),
    ).rejects.toThrow(/must be owner|permission denied/i);
  });
});
