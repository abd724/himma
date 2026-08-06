/**
 * Whole-database secret sweep: proves a sensitive value appears in NO row of
 * ANY public table (every column, via each row's JSON form) — the B2-6B
 * secret-hygiene boundary check for TOTP material, raw recovery codes,
 * provider tokens, and peppers.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../src/db/kysely';

export interface SweepHit {
  table: string;
  value: string;
}

export async function sweepDatabaseForValues(
  db: Kysely<DB>,
  values: string[],
): Promise<SweepHit[]> {
  const tables = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`.execute(db);
  const hits: SweepHit[] = [];
  for (const { table_name } of tables.rows) {
    if (!/^[a-z0-9_]+$/.test(table_name)) throw new Error(`Unexpected table: ${table_name}`);
    for (const value of values) {
      const result = await sql<{ found: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM ${sql.raw(table_name)} t
          WHERE to_jsonb(t)::text ILIKE ${'%' + value + '%'}
        ) AS found`.execute(db);
      if (result.rows[0]?.found === true) hits.push({ table: table_name, value });
    }
  }
  return hits;
}
