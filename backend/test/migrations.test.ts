/**
 * Migration foundation tests: migrate-from-zero, idempotent reapply,
 * verification, immutability enforcement, and clean failure with rollback.
 */
import { mkdtempSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';

import {
  defaultMigrationsDir,
  listMigrationFiles,
  runMigrationsUp,
  runMigrationsDown,
  verifyMigrations,
  MigrationPolicyError,
} from '../src/db/migrations';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function rawClient(): Promise<Client> {
  const { database } = testDb.config;
  const client = new Client({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
  });
  await client.connect();
  return client;
}

describe('migration foundation', () => {
  it('a blank database migrates from zero to current (helper ran it)', async () => {
    const report = await verifyMigrations(testDb.config);
    expect(report.ok).toBe(true);
    expect(report.appliedCount).toBeGreaterThanOrEqual(1);
    expect(report.pending).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it('all committed migrations are lexically ordered and uniquely numbered', () => {
    const files = listMigrationFiles();
    const ordinals = files.map((f) => f.filename.slice(0, 4));
    expect([...ordinals].sort()).toEqual(ordinals);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    for (const file of files) {
      expect(file.filename).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('reapplying the migration command is a safe no-op', async () => {
    const result = await runMigrationsUp(testDb.config, { quiet: true });
    expect(result.applied).toEqual([]);
    const report = await verifyMigrations(testDb.config);
    expect(report.ok).toBe(true);
  });

  it('fails closed when an applied migration file was edited (immutability)', async () => {
    const client = await rawClient();
    try {
      await client.query(
        `UPDATE migration_checksum SET sha256 = 'tampered' WHERE name = '0001_foundation'`,
      );
      await expect(runMigrationsUp(testDb.config, { quiet: true })).rejects.toThrow(
        MigrationPolicyError,
      );
      const report = await verifyMigrations(testDb.config);
      expect(report.ok).toBe(false);
      expect(report.problems.join('\n')).toContain('immutable');
    } finally {
      // Restore the true checksum for the remaining tests.
      const real = listMigrationFiles().find((f) => f.name === '0001_foundation');
      await client.query(`UPDATE migration_checksum SET sha256 = $1 WHERE name = '0001_foundation'`, [
        real?.sha256,
      ]);
      await client.end();
    }
  });

  it('a failing migration stops cleanly with nothing partially applied', async () => {
    // Copy the committed migrations into a scratch dir and append a broken one
    // that creates a table BEFORE erroring: the table must not survive.
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'himma-migrations-'));
    for (const f of readdirSync(defaultMigrationsDir())) {
      copyFileSync(path.join(defaultMigrationsDir(), f), path.join(scratchDir, f));
    }
    writeFileSync(
      path.join(scratchDir, '9999_broken.sql'),
      `-- Up Migration
CREATE TABLE should_not_survive (id int);
SELECT 1 / 0;
-- Down Migration
DROP TABLE should_not_survive;
`,
    );

    await expect(
      runMigrationsUp(testDb.config, { dir: scratchDir, quiet: true }),
    ).rejects.toThrow();

    const client = await rawClient();
    try {
      const table = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'should_not_survive'`,
      );
      expect(table.rowCount).toBe(0);
      const applied = await client.query(`SELECT name FROM pgmigrations ORDER BY id`);
      expect(applied.rows.map((r) => r.name)).toEqual(
        listMigrationFiles().map((f) => f.name),
      );
    } finally {
      await client.end();
    }
  });

  it('down migration reverts the latest migration and re-apply restores (dev/test only)', async () => {
    const scratch = await createMigratedTestDb();
    const files = listMigrationFiles();
    const latest = files[files.length - 1]?.name;
    try {
      await runMigrationsDown(scratch.config, { quiet: true });
      const afterDown = await verifyMigrations(scratch.config);
      expect(afterDown.ok).toBe(false);
      expect(afterDown.pending).toEqual([latest]);

      const reapplied = await runMigrationsUp(scratch.config, { quiet: true });
      expect(reapplied.applied).toEqual([latest]);
      const report = await verifyMigrations(scratch.config);
      expect(report.ok).toBe(true);
    } finally {
      await scratch.drop();
    }
  });

  it('down migrations are refused in production', async () => {
    await expect(
      runMigrationsDown({
        nodeEnv: 'production',
        database: testDb.config.database,
      }),
    ).rejects.toThrow(MigrationPolicyError);
  });
});
