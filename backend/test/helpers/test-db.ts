/**
 * Test-database provisioning (owner ruling 7; docs/25 §8).
 *
 * Each caller gets a fresh, fully migrated `himma_test_<random>` database on
 * the local PostgreSQL server and MUST call `drop()` in afterAll. The safety
 * guards are asserted at every layer (config, pool, migration runner), so a
 * test can never target a non-local host or a non-`himma_test` database.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';

import type { Kysely } from 'kysely';
import { Client } from 'pg';

import type { BackendConfig } from '../../src/config/env';
import type { DB } from '../../src/db/kysely';
import { createDb } from '../../src/db/kysely';
import { runMigrationsUp } from '../../src/db/migrations';
import { createPool } from '../../src/db/pool';
import { assertSafeTestDatabase, TEST_DATABASE_PREFIX } from '../../src/db/safety';

const HOST = process.env.PGHOST ?? 'localhost';
const PORT = Number(process.env.PGPORT ?? 5432);
const USER = process.env.PGUSER ?? os.userInfo().username;

async function adminClient(): Promise<Client> {
  const client = new Client({ host: HOST, port: PORT, user: USER, database: 'postgres' });
  await client.connect();
  return client;
}

export interface TestDb {
  config: BackendConfig;
  db: Kysely<DB>;
  drop: () => Promise<void>;
}

export async function createMigratedTestDb(): Promise<TestDb> {
  const name = `${TEST_DATABASE_PREFIX}_${randomBytes(6).toString('hex')}`;
  const config: BackendConfig = {
    nodeEnv: 'test',
    database: { host: HOST, port: PORT, database: name, user: USER },
  };
  assertSafeTestDatabase(config.database);

  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Unexpected test database name: ${name}`);
  }
  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  await runMigrationsUp(config, { quiet: true });
  const pool = createPool(config);
  const db = createDb(pool);

  return {
    config,
    db,
    drop: async () => {
      await db.destroy();
      const cleanup = await adminClient();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
