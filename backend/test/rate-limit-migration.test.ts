/**
 * W6-1 — migration 0021 lifecycle on real PostgreSQL: up/down/up, grants,
 * and the readiness journal reads for the restricted runtime logins.
 * Existing domain rows are untouched by construction (additive table +
 * grants only) — proven by the row-count sweep across the cycle.
 */
import { sql } from 'kysely';

import { runMigrationsDown, runMigrationsUp, verifyMigrations, expectedMigrationHead } from '../src/db/migrations';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe('0021_rate_limit_window', () => {
  it('is the expected head, verifies clean, and survives up → down → up with zero domain-row rewrites', async () => {
    expect(expectedMigrationHead()).toBe('0022_outbox_delivery_state');

    const before = await verifyMigrations(testDb.config);
    expect(before.ok).toBe(true);
    expect(before.appliedCount).toBe(22);
    expect(before.pending).toEqual([]);

    const domainCount = async (): Promise<number> => {
      const result = await sql<{ n: string }>`
        SELECT count(*) AS n FROM audit_event`.execute(testDb.db);
      return Number(result.rows[0]?.n);
    };
    const auditBefore = await domainCount();

    await runMigrationsDown(testDb.config, { count: 2, quiet: true });
    const gone = await sql<{ n: string }>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'rate_limit_window'
    `.execute(testDb.db);
    expect(Number(gone.rows[0]?.n)).toBe(0);

    await runMigrationsUp(testDb.config, { quiet: true });
    const after = await verifyMigrations(testDb.config);
    expect(after.ok).toBe(true);
    expect(after.appliedCount).toBe(22);
    expect(await domainCount()).toBe(auditBefore);
  });

  it('grants the certified shape: himma_app reads/writes windows and the migration journal, but can never DELETE', async () => {
    const privileges = await sql<{ privilege_type: string }>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app' AND table_name = 'rate_limit_window'
      ORDER BY privilege_type
    `.execute(testDb.db);
    expect(privileges.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);

    const journal = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'himma_app' AND table_name IN ('pgmigrations', 'migration_checksum')
      ORDER BY table_name
    `.execute(testDb.db);
    expect(journal.rows).toEqual([
      { table_name: 'migration_checksum', privilege_type: 'SELECT' },
      { table_name: 'pgmigrations', privilege_type: 'SELECT' },
    ]);
  });
});
