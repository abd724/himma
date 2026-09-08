/**
 * W6-4A final correction — runtime-role provisioning is deterministic under
 * the repository's real concurrent topology (docs/38 correction record).
 *
 * Root cause proven here: the provisioned roles are CLUSTER-GLOBAL while a
 * PostgreSQL advisory lock is DATABASE-SCOPED, so the original lock (taken
 * on the caller's own `himma_test_*` database) serialized nothing across
 * suites/provisioners on different databases and concurrent `ALTER ROLE` /
 * `GRANT` raised `tuple concurrently updated` (SQLSTATE XX000). The boundary
 * now takes the lock on a session to ONE coordination database of the
 * cluster (`postgres`), so N concurrent provisioners across N databases
 * converge on the exact intended topology.
 *
 * Contention here (6 independent databases, 6 simultaneous provisioners,
 * two waves) reliably broke the previous implementation (5 of 6 failed on
 * every run when reproduced against `06e8c6e`; 8→6–7 of 8, 10→8–9 of 10,
 * 16 across 12→12–13 of 16). Sized so the proof's peak of 12 short-lived
 * sessions (two per provisioner: coordination + admin) coexists with the
 * rest of the parallel suite on a default `max_connections=100` server —
 * 20 sessions tipped it over the cap in one of three parallel runs.
 */
import { Client } from 'pg';
import { sql } from 'kysely';

import { clientOptionsFor } from '../src/db/connection-options';
import {
  DEFAULT_PROVISION_COORDINATION_DATABASE,
  PROVISION_LOCK_KEY_SQL,
  provisionRuntimeRoles,
} from '../src/db/provision-runtime-roles';
import type { ProvisionRuntimeRolesResult } from '../src/db/provision-runtime-roles';
import { createMigratedTestDb } from './helpers/test-db';
import type { TestDb } from './helpers/test-db';

jest.setTimeout(120_000);

const DATABASES = 6;
const PROVISIONERS = 6;

const passwords = {
  himma_api: 'concurrency-proof-api-password-1',
  himma_worker: 'concurrency-proof-worker-password',
  himma_maintenance_runner: 'concurrency-proof-maintenance-pw',
};

let dbs: TestDb[] = [];

// Connection footprint is deliberately small so the proof coexists with the
// parallel suite on one local server (max_connections 100): ONE pool (dbs[0])
// for the matrix queries; every other database keeps no pool — only the
// provisioners' short-lived sessions (2 each) exist during a wave.
beforeAll(async () => {
  for (let i = 0; i < DATABASES; i += 1) {
    const db = await createMigratedTestDb();
    // Kysely initializes its driver lazily, so destroying before first use is
    // a no-op: the extra databases are simply never queried through their
    // Kysely handle (every catalog query below goes through dbs[0]).
    if (i > 0) await db.db.destroy();
    dbs.push(db);
  }
});

afterAll(async () => {
  await dbs[0]!.drop();
  const admin = new Client(clientOptionsFor({ ...dbs[0]!.config.database, database: DEFAULT_PROVISION_COORDINATION_DATABASE }));
  await admin.connect();
  try {
    for (const db of dbs.slice(1)) {
      await admin.query(`DROP DATABASE IF EXISTS ${db.config.database.database} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

function wave(): Promise<PromiseSettledResult<ProvisionRuntimeRolesResult>[]> {
  return Promise.allSettled(
    Array.from({ length: PROVISIONERS }, (_, i) =>
      provisionRuntimeRoles({ admin: dbs[i % DATABASES]!.config.database, passwords }),
    ),
  );
}

async function membershipMatrix(): Promise<{ member: string; role: string }[]> {
  const rows = await sql<{ member: string; role: string }>`
    SELECT m.rolname AS member, r.rolname AS role
    FROM pg_auth_members am
    JOIN pg_roles m ON m.oid = am.member
    JOIN pg_roles r ON r.oid = am.roleid
    WHERE m.rolname IN ('himma_api', 'himma_worker', 'himma_maintenance_runner')
       OR r.rolname IN ('himma_app', 'himma_maintenance')
    ORDER BY member, role`.execute(dbs[0]!.db);
  return rows.rows;
}

const EXACT_MATRIX = [
  { member: 'himma_api', role: 'himma_app' },
  { member: 'himma_maintenance_runner', role: 'himma_maintenance' },
  { member: 'himma_worker', role: 'himma_app' },
];

async function attributes(): Promise<
  { rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean }[]
> {
  const rows = await sql<{
    rolname: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolcanlogin: boolean;
  }>`
    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles
    WHERE rolname IN ('himma_app', 'himma_maintenance', 'himma_api', 'himma_worker', 'himma_maintenance_runner')
    ORDER BY rolname`.execute(dbs[0]!.db);
  return rows.rows;
}

const EXACT_ATTRIBUTES = [
  { rolname: 'himma_api', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true },
  { rolname: 'himma_app', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false },
  { rolname: 'himma_maintenance', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false },
  { rolname: 'himma_maintenance_runner', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true },
  { rolname: 'himma_worker', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true },
];

async function asRole(role: keyof typeof passwords, db: TestDb, statement: string): Promise<string> {
  const client = new Client({ ...clientOptionsFor(db.config.database), user: role, password: passwords[role] });
  await client.connect();
  try {
    await client.query(statement);
    return 'ALLOWED';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.end();
  }
}

describe('cluster-wide provisioning coordination', () => {
  it(`${PROVISIONERS} simultaneous provisioners across ${DATABASES} databases all succeed, never "tuple concurrently updated", and converge on the exact topology`, async () => {
    const results = await wave();
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => String(r.reason))).toEqual([]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<ProvisionRuntimeRolesResult> => r.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(PROVISIONERS);
    // Every invocation touched all three logins (created by the first, updated by the rest).
    for (const { value } of fulfilled) {
      expect([...value.created, ...value.updated].sort()).toEqual(
        ['himma_api', 'himma_maintenance_runner', 'himma_worker'],
      );
    }
    expect(await membershipMatrix()).toEqual(EXACT_MATRIX);
    expect(await attributes()).toEqual(EXACT_ATTRIBUTES);
  });

  it('a second simultaneous wave is idempotent: all updates, no creates, topology unchanged', async () => {
    const results = await wave();
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        expect(r.value.created).toEqual([]);
        expect(r.value.updated.sort()).toEqual(['himma_api', 'himma_maintenance_runner', 'himma_worker']);
      }
    }
    expect(await membershipMatrix()).toEqual(EXACT_MATRIX);
    expect(await attributes()).toEqual(EXACT_ATTRIBUTES);
  });

  it('the serialization lives in the coordination database: a provisioner blocks while the key is held there and proceeds when released', async () => {
    const holder = new Client(clientOptionsFor({ ...dbs[0]!.config.database, database: DEFAULT_PROVISION_COORDINATION_DATABASE }));
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(${PROVISION_LOCK_KEY_SQL})`);
      let settled = false;
      const pending = provisionRuntimeRoles({ admin: dbs[1]!.config.database, passwords }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await holder.query(`SELECT pg_advisory_unlock(${PROVISION_LOCK_KEY_SQL})`);
      await expect(pending).resolves.toMatchObject({ created: [] });
      expect(settled).toBe(true);
    } finally {
      await holder.end();
    }
  });

  it('fails closed when the coordination database cannot be opened — never a silent database-local lock', async () => {
    await expect(
      provisionRuntimeRoles({
        admin: dbs[0]!.config.database,
        passwords,
        coordinationDatabase: 'himma_test_no_such_coordination_db',
      }),
    ).rejects.toThrow(/coordination session on database "himma_test_no_such_coordination_db".*HIMMA_PROVISION_LOCK_DATABASE/);
    expect(await membershipMatrix()).toEqual(EXACT_MATRIX);
  });

  it('privilege boundary after concurrent provisioning: api/worker no DDL, no maintenance role, no maintenance DELETE; runner bounded; the topology is never broadened', async () => {
    const db = dbs[2]!;
    for (const role of ['himma_api', 'himma_worker'] as const) {
      expect(await asRole(role, db, 'CREATE TABLE concurrency_probe(id int)')).toMatch(/permission denied/);
      expect(await asRole(role, db, 'ALTER TABLE job_run ADD COLUMN concurrency_probe int')).toMatch(/must be owner|permission denied/);
      expect(await asRole(role, db, 'SET ROLE himma_maintenance')).toMatch(/permission denied/);
      expect(await asRole(role, db, 'DELETE FROM rate_limit_window')).toMatch(/permission denied/);
      expect(await asRole(role, db, "SELECT maintenance_prune_rate_limit_windows(interval '1 day', 10)")).toMatch(
        /permission denied/,
      );
    }
    expect(await asRole('himma_maintenance_runner', db, 'CREATE TABLE concurrency_probe(id int)')).toMatch(/permission denied/);
    expect(await asRole('himma_maintenance_runner', db, 'SET ROLE himma_app')).toMatch(/permission denied/);
    expect(await asRole('himma_maintenance_runner', db, 'DELETE FROM rate_limit_window')).toMatch(/permission denied/);
    expect(await asRole('himma_maintenance_runner', db, 'INSERT INTO pgmigrations (name, run_on) VALUES (\'9999_probe\', now())')).toMatch(
      /permission denied/,
    );
    // The migration/bootstrap authority stays separate: none of the logins owns the schema objects.
    const owners = await sql<{ owner: string }>`
      SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'public'`.execute(dbs[0]!.db);
    expect(owners.rows.map((r) => r.owner)).not.toEqual(
      expect.arrayContaining(['himma_api', 'himma_worker', 'himma_maintenance_runner', 'himma_app', 'himma_maintenance']),
    );
  });
});
