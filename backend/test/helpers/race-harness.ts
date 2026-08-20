/**
 * True DB-level contention harness (docs/32 §15): N independent PostgreSQL
 * connections drive N concurrent service-layer transactions, released
 * together after every connection is established — the database's row locks,
 * not JavaScript scheduling, decide the winners.
 */
import { Pool } from 'pg';

import type { BackendConfig } from '../../src/config/env';
import { createDb, type Db } from '../../src/db/kysely';
import { assertSafeTestDatabase } from '../../src/db/safety';
import { sql } from 'kysely';

export interface RacePool {
  db: Db;
  destroy: () => Promise<void>;
}

/** A pool sized for the contender count (pg default max is 10 — too small). */
export async function createRacePool(config: BackendConfig, size: number): Promise<RacePool> {
  assertSafeTestDatabase(config.database);
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    max: size,
    options: '-c TimeZone=UTC',
  });
  const db = createDb(pool);
  // Barrier precondition: open every connection BEFORE the race fires, so the
  // release below is genuinely simultaneous at the database.
  await Promise.all(
    Array.from({ length: size }, () => sql`SELECT 1`.execute(db)),
  );
  return { db, destroy: () => db.destroy() };
}

/** Fires all thunks in one release and returns their settled results. */
export async function race<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(thunks.map((thunk) => thunk()));
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
