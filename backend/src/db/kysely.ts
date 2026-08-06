/**
 * Kysely instance over the pg pool (owner ruling 4).
 *
 * Kysely is the type-safe query builder ONLY — never the schema authority.
 * The migrated PostgreSQL schema is authoritative; `src/db/generated/db.ts`
 * is generated from it via `npm run db:codegen` (kysely-codegen) and is
 * regenerated, never hand-edited.
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import type { DB } from './generated/db';

export type Db = Kysely<DB>;
export type { DB } from './generated/db';

export function createDb(pool: Pool): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
