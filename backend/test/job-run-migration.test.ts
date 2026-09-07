/**
 * W6-3 — migration 0023 lifecycle on real PostgreSQL: up → down → up with
 * zero domain-row rewrites, `db:verify` green, the `job_run` grant shape,
 * and the maintenance authority model: `himma_maintenance` holds NO direct
 * DELETE anywhere, the bounded SECURITY DEFINER functions are executable by
 * the maintenance role ONLY (PUBLIC/himma_app refused), and every function
 * refuses a horizon below its floor INSIDE the database.
 */
import { sql } from 'kysely';

import { expectedMigrationHead, runMigrationsDown, runMigrationsUp, verifyMigrations } from '../src/db/migrations';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;

const FUNCTIONS = [
  'maintenance_prune_rate_limit_windows(interval, integer)',
  'maintenance_prune_redemption_lookup_attempts(interval, integer)',
  'maintenance_prune_idempotency_keys(interval, integer)',
  'maintenance_prune_published_outbox(interval, integer)',
  'maintenance_prune_job_runs(interval, integer)',
  'maintenance_unquarantine_outbox(uuid)',
];

const RETENTION_TABLES = ['rate_limit_window', 'redemption_lookup_attempt', 'idempotency_key', 'outbox_event', 'inbox_event', 'job_run'];

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function tablePrivilege(role: string, table: string, privilege: string): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`
    SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS ok`.execute(testDb.db);
  return result.rows[0]?.ok === true;
}

async function functionPrivilege(role: string, fn: string): Promise<boolean> {
  const result = await sql<{ ok: boolean }>`
    SELECT has_function_privilege(${role}, ${fn}, 'EXECUTE') AS ok`.execute(testDb.db);
  return result.rows[0]?.ok === true;
}

describe('0023_job_run_and_maintenance_authority', () => {
  it('is the expected head, verifies clean, and survives up → down → up with zero domain-row rewrites', async () => {
    expect(expectedMigrationHead()).toBe('0023_job_run_and_maintenance_authority');
    const before = await verifyMigrations(testDb.config);
    expect(before.ok).toBe(true);
    expect(before.appliedCount).toBe(23);

    const auditCount = async (): Promise<number> => {
      const result = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(testDb.db);
      return Number(result.rows[0]?.n);
    };
    const auditBefore = await auditCount();

    await runMigrationsDown(testDb.config, { count: 1, quiet: true });
    const gone = await sql<{ n: string }>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'job_run'`.execute(testDb.db);
    expect(Number(gone.rows[0]?.n)).toBe(0);
    const functionsGone = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'maintenance_%'`.execute(testDb.db);
    expect(Number(functionsGone.rows[0]?.n)).toBe(0);
    // The cluster-global privilege role is intentionally NOT dropped (0001 precedent).
    const roleStays = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_roles WHERE rolname = 'himma_maintenance'`.execute(testDb.db);
    expect(Number(roleStays.rows[0]?.n)).toBe(1);
    const verifiedDown = await verifyMigrations(testDb.config);
    expect(verifiedDown.pending).toEqual(['0023_job_run_and_maintenance_authority']);
    expect(verifiedDown.problems).toEqual([]);

    await runMigrationsUp(testDb.config, { quiet: true });
    const after = await verifyMigrations(testDb.config);
    expect(after.ok).toBe(true);
    expect(after.appliedCount).toBe(23);
    expect(await auditCount()).toBe(auditBefore);
  });

  it('job_run grant shape: the app role inserts/reads and updates ONLY the completion columns; nobody but the definer can delete', async () => {
    expect(await tablePrivilege('himma_app', 'job_run', 'SELECT')).toBe(true);
    expect(await tablePrivilege('himma_app', 'job_run', 'INSERT')).toBe(true);
    expect(await tablePrivilege('himma_app', 'job_run', 'DELETE')).toBe(false);
    const columns = await sql<{ column: string; ok: boolean }>`
      SELECT c AS column, has_column_privilege('himma_app', 'job_run', c, 'UPDATE') AS ok
      FROM unnest(ARRAY['finished_at','outcome','error_code','items','facts','duration_ms','id','job_name','runtime_role','run_id','started_at']) AS c
    `.execute(testDb.db);
    const updatable = columns.rows.filter((row) => row.ok).map((row) => row.column).sort();
    expect(updatable).toEqual(['duration_ms', 'error_code', 'facts', 'finished_at', 'items', 'outcome']);
    // Bounded shapes are enforced by the database.
    await expect(
      sql`INSERT INTO job_run (id, job_name, runtime_role, run_id, outcome)
          VALUES (gen_random_uuid(), 'Bad Name!', 'worker', gen_random_uuid(), 'running')`.execute(testDb.db),
    ).rejects.toBeTruthy();
    await expect(
      sql`INSERT INTO job_run (id, job_name, runtime_role, run_id, outcome)
          VALUES (gen_random_uuid(), 'probe', 'api', gen_random_uuid(), 'running')`.execute(testDb.db),
    ).rejects.toBeTruthy();
    await expect(
      sql`INSERT INTO job_run (id, job_name, runtime_role, run_id, outcome, finished_at)
          VALUES (gen_random_uuid(), 'probe', 'worker', gen_random_uuid(), 'succeeded', NULL)`.execute(testDb.db),
    ).rejects.toBeTruthy();
  });

  it('himma_maintenance holds NO direct DELETE on any table and no application DML beyond the enumerated reads/projection writes', async () => {
    const deletes = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'himma_maintenance' AND privilege_type = 'DELETE'`.execute(testDb.db);
    expect(deletes.rows).toEqual([]);
    for (const table of RETENTION_TABLES) {
      expect(await tablePrivilege('himma_maintenance', table, 'DELETE')).toBe(false);
      expect(await tablePrivilege('himma_maintenance', table, 'SELECT')).toBe(true);
    }
    // No general application DML: authoritative domain tables are not even readable.
    for (const table of ['booking', 'payment_intent', 'payment_transaction', 'audit_event', 'app_user', 'entitlement']) {
      expect(await tablePrivilege('himma_maintenance', table, 'SELECT')).toBe(false);
      expect(await tablePrivilege('himma_maintenance', table, 'INSERT')).toBe(false);
    }
    expect(await tablePrivilege('himma_maintenance', 'program_search_document', 'INSERT')).toBe(true);
    expect(await tablePrivilege('himma_maintenance', 'program_search_document', 'DELETE')).toBe(false);
    expect(await tablePrivilege('himma_maintenance', 'program', 'UPDATE')).toBe(false);
  });

  it('the bounded retention functions are executable by himma_maintenance ONLY — PUBLIC and himma_app are refused', async () => {
    for (const fn of FUNCTIONS) {
      expect(await functionPrivilege('himma_maintenance', fn)).toBe(true);
      expect(await functionPrivilege('himma_app', fn)).toBe(false);
    }
    const acls = await sql<{ proname: string; proacl: string | null }>`
      SELECT proname, proacl::text FROM pg_proc WHERE proname LIKE 'maintenance_%'`.execute(testDb.db);
    expect(acls.rows).toHaveLength(FUNCTIONS.length);
    for (const row of acls.rows) {
      // No `=X/…` entry = no PUBLIC execute.
      expect(row.proacl ?? '').not.toMatch(/(^|[{,])=X/);
      expect(row.proacl ?? '').toContain('himma_maintenance=X');
    }
    const definers = await sql<{ proname: string; prosecdef: boolean }>`
      SELECT proname, prosecdef FROM pg_proc WHERE proname LIKE 'maintenance_%'`.execute(testDb.db);
    expect(definers.rows.every((row) => row.prosecdef)).toBe(true);
  });

  it('every retention function refuses a horizon below its floor and an out-of-bound batch INSIDE the database', async () => {
    const floors: Array<[string, string, string]> = [
      ['maintenance_prune_rate_limit_windows', '23 hours', '1 day'],
      ['maintenance_prune_redemption_lookup_attempts', '1 hour', '1 day'],
      ['maintenance_prune_idempotency_keys', '29 days', '30 days'],
      ['maintenance_prune_published_outbox', '6 days', '7 days'],
      ['maintenance_prune_job_runs', '1 day', '7 days'],
    ];
    for (const [fn, tooShort, floor] of floors) {
      await expect(
        sql`SELECT ${sql.raw(fn)}(${tooShort}::interval, 10)`.execute(testDb.db),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        sql`SELECT ${sql.raw(fn)}(${floor}::interval, 0)`.execute(testDb.db),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        sql`SELECT ${sql.raw(fn)}(${floor}::interval, 10001)`.execute(testDb.db),
      ).rejects.toMatchObject({ code: '23514' });
      const ok = await sql<{ n: number }>`SELECT ${sql.raw(fn)}(${floor}::interval, 10) AS n`.execute(testDb.db);
      expect(Number(ok.rows[0]?.n)).toBe(0);
    }
    await expect(sql`SELECT maintenance_unquarantine_outbox(NULL)`.execute(testDb.db)).rejects.toMatchObject({
      code: '23514',
    });
  });
});
