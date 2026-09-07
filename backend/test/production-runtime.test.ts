/**
 * W6-1 — the canonical production bootstrap on real PostgreSQL (docs/37
 * §2/§6/§7/§8/§28): role provisioning, the startup DB-identity assertion,
 * the API/worker NEGATIVE privilege proofs on their EXACT runtime
 * connections, readiness semantics (identity/migration-head/drain), and
 * graceful shutdown that never loses committed work.
 *
 * W6-3 made the maintenance authority REAL (migration 0023 — the
 * `himma_maintenance` privilege role + bounded SECURITY DEFINER retention
 * functions); the API/worker negative proofs below therefore run against
 * the genuine grants, including EXECUTE refusal on the retention functions.
 */
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { Pool } from 'pg';

import { composeProductionRuntime, createShutdown, ProductionRuntimeError } from '../src/app/production-runtime';
import type { RuntimeConfig } from '../src/config/runtime';
import { DEFAULT_MAINTENANCE_POLICY, DEFAULT_SCHEDULER_POLICY } from '../src/config/runtime';
import { createDb } from '../src/db/kysely';
import { expectedMigrationHead } from '../src/db/migrations';
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import { buildApp } from '../src/app/build-app';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    nodeEnv: 'production',
    database: {
      host: testDb.config.database.host,
      port: testDb.config.database.port,
      database: testDb.config.database.database,
      user: 'himma_api',
      password: apiPassword,
    },
    role: 'api',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'error',
    shutdownDrainMs: 5_000,
    paymentsMode: 'disabled',
    worker: { outboxPollMs: 200, outboxBatchSize: 100, outboxMaxAttempts: 8, paymentPollMs: 30_000 },
    scheduler: { ...DEFAULT_SCHEDULER_POLICY },
    maintenance: { ...DEFAULT_MAINTENANCE_POLICY },
    ...overrides,
  };
}

function poolFor(user: string, password: string): Pool {
  return new Pool({
    host: testDb.config.database.host,
    port: testDb.config.database.port,
    database: testDb.config.database.database,
    user,
    password,
    options: '-c TimeZone=UTC',
  });
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const result = await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword },
  });
  expect([...result.created, ...result.updated].sort()).toEqual(['himma_api', 'himma_worker']);
  // Idempotency: a second run updates rather than failing, and stays clean.
  const again = await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword },
  });
  expect(again.created).toEqual([]);
  expect(again.updated.sort()).toEqual(['himma_api', 'himma_worker']);
  // W6-3: the maintenance privilege role is REAL now (migration 0023) — the
  // negative proofs below run against the genuine production grants, not a
  // fixture (docs/37 §38: re-run of the W6-1 negatives once the grants exist).
  const maintenanceRole = await sql<{ n: string }>`
    SELECT count(*) AS n FROM pg_roles WHERE rolname = 'himma_maintenance'`.execute(testDb.db);
  expect(Number(maintenanceRole.rows[0]?.n)).toBe(1);
});

afterAll(async () => {
  await testDb.drop();
});

describe('runtime DB identity assertion (docs/37 §6/§28)', () => {
  it('the api role composes only when connected as himma_api; a mispasted credential refuses startup', async () => {
    const wrong = runtimeConfig({
      database: { ...testDb.config.database },
    });
    await expect(composeProductionRuntime(wrong, {})).rejects.toThrow(ProductionRuntimeError);
    await expect(composeProductionRuntime(wrong, {})).rejects.toThrow(/himma_api/);
  });

  it('non-api roles are refused by the W6-1 bootstrap (worker/maintenance arrive in W6-2/W6-3)', async () => {
    await expect(
      composeProductionRuntime(runtimeConfig({ role: 'worker' }), {}),
    ).rejects.toThrow(/W6-2/);
  });
});

describe('API negative privilege proofs on the EXACT runtime connection (docs/37 §28/§38)', () => {
  let apiPool: Pool;

  beforeAll(() => {
    apiPool = poolFor('himma_api', apiPassword);
  });

  afterAll(async () => {
    await apiPool.end();
  });

  it('current_user is himma_api and ordinary application DML works', async () => {
    const who = await apiPool.query('SELECT current_user AS u');
    expect(who.rows[0].u).toBe('himma_api');
    const inserted = await apiPool.query(
      `INSERT INTO audit_event (id, actor_type, action, entity_type, entity_id)
       VALUES (gen_random_uuid(), 'system', 'w6.test_probe', 'w6', 'probe') RETURNING id`,
    );
    expect(inserted.rowCount).toBe(1);
    const read = await apiPool.query('SELECT count(*) FROM program');
    expect(read.rowCount).toBe(1);
  });

  it('maintenance-class DELETE fails with a PostgreSQL permission denial', async () => {
    await expect(apiPool.query('DELETE FROM rate_limit_window')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(apiPool.query('DELETE FROM audit_event')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('SET ROLE himma_maintenance fails — the API login can never assume maintenance authority', async () => {
    await expect(apiPool.query('SET ROLE himma_maintenance')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('W6-3: the bounded retention functions are not executable by the API login', async () => {
    await expect(
      apiPool.query(`SELECT maintenance_prune_rate_limit_windows(interval '7 days', 10)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiPool.query(`SELECT maintenance_prune_published_outbox(interval '30 days', 10)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('DELETE FROM job_run')).rejects.toMatchObject({ code: '42501' });
  });

  it('arbitrary DDL fails and schema ownership is absent', async () => {
    await expect(apiPool.query('CREATE TABLE w6_rogue (id int)')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(apiPool.query('DROP TABLE rate_limit_window')).rejects.toBeTruthy();
    const owners = await apiPool.query(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );
    for (const row of owners.rows as { tableowner: string }[]) {
      expect(row.tableowner).not.toBe('himma_api');
    }
  });
});

describe('worker login foundation (docs/37 §28; owner item 10)', () => {
  let workerPool: Pool;

  beforeAll(() => {
    workerPool = poolFor('himma_worker', workerPassword);
  });

  afterAll(async () => {
    await workerPool.end();
  });

  it('current_user is himma_worker; app DML and the bounded outbox column update work; nothing destructive does', async () => {
    const who = await workerPool.query('SELECT current_user AS u');
    expect(who.rows[0].u).toBe('himma_worker');
    const inserted = await workerPool.query(
      `INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload)
       VALUES (gen_random_uuid(), 'w6test', 'w6-worker-probe', 1, 'w6.test', '{}'::jsonb) RETURNING id`,
    );
    const outboxId = (inserted.rows[0] as { id: string }).id;
    // The pre-granted relay columns are updatable…
    const marked = await workerPool.query(
      `UPDATE outbox_event SET published_at = now(), publish_attempts = 1 WHERE id = $1`,
      [outboxId],
    );
    expect(marked.rowCount).toBe(1);
    // …and ONLY those columns (the column-restricted grant holds live).
    await expect(
      workerPool.query(`UPDATE outbox_event SET event_type = 'x' WHERE id = $1`, [outboxId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('DELETE FROM rate_limit_window')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(workerPool.query('SET ROLE himma_maintenance')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(workerPool.query('CREATE TABLE w6_rogue2 (id int)')).rejects.toMatchObject({
      code: '42501',
    });
    // W6-3: the worker records job runs but can neither delete them nor
    // execute the maintenance retention functions.
    await expect(
      workerPool.query(`SELECT maintenance_prune_job_runs(interval '30 days', 10)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('DELETE FROM job_run')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('composed production runtime: readiness, correlation surface, shutdown (docs/37 §7/§8)', () => {
  it('boots as himma_api, reports ready, fails readiness while draining, and drains in-flight work on shutdown', async () => {
    const runtime = await composeProductionRuntime(runtimeConfig(), {});
    try {
      // A public slow route stands in for a long in-flight request (policy
      // guard requires the explicit declaration exactly like real routes).
      runtime.app.get(
        '/internal/w6-slow-probe',
        { config: { authPolicy: 'public' } },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { done: true };
        },
      );
      await runtime.app.ready();

      const live = await runtime.app.inject({ method: 'GET', url: '/internal/live' });
      expect(live.statusCode).toBe(200);
      const ready = await runtime.app.inject({ method: 'GET', url: '/internal/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready' });

      // The dev identity surface does not exist and bearers fail closed
      // (unconfigured verifier — never the dev stand-in).
      const dev = await runtime.app.inject({ method: 'POST', url: '/dev/identity/signin', payload: {} });
      expect(dev.statusCode).toBe(404);
      const me = await runtime.app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: 'Bearer forged' },
      });
      expect(me.statusCode).toBe(401);

      // Shutdown over a REAL listener: an in-flight request drains to a
      // 200, readiness flips, new connections stop, the pool closes.
      await runtime.app.listen({ host: '127.0.0.1', port: 0 });
      const address = runtime.app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const slow = fetch(`http://127.0.0.1:${port}/internal/w6-slow-probe`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const controller = createShutdown(runtime, {
        drainMs: 5_000,
        exit: ((code: number) => {
          throw new Error(`unexpected force exit ${code}`);
        }) as (code: number) => never,
      });
      const drainStarted = controller.shutdown();
      expect(runtime.drainSignal.draining).toBe(true);
      const slowResult = await slow;
      expect(slowResult.status).toBe(200);
      expect(await slowResult.json()).toEqual({ done: true });
      await drainStarted;
      await expect(
        fetch(`http://127.0.0.1:${port}/internal/live`),
      ).rejects.toThrow();
      await expect(runtime.pool.query('SELECT 1')).rejects.toThrow();
    } finally {
      await runtime.pool.end().catch(() => undefined);
    }
  });

  it('readiness reports a migration-head mismatch without killing the process (docs/37 §23-readiness contract)', async () => {
    const apiPool = poolFor('himma_api', apiPassword);
    const db = createDb(apiPool);
    const app = buildApp({
      identity: {
        db,
        accessTokenVerifier: new FakeAccessTokenVerifier(),
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
      },
      runtime: {
        readiness: {
          db,
          expectedMigrationHead: '9999_future_migration',
          expectedDbIdentity: 'himma_api',
        },
      },
    });
    try {
      await app.ready();
      const ready = await app.inject({ method: 'GET', url: '/internal/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({
        status: 'unready',
        reasons: ['migrationHeadMismatch'],
      });
      const live = await app.inject({ method: 'GET', url: '/internal/live' });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it('readiness reports a wrong database identity (mispasted credential, second wall behind the startup refusal)', async () => {
    const app = buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: new FakeAccessTokenVerifier(),
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
      },
      runtime: {
        readiness: {
          db: testDb.db,
          expectedMigrationHead: expectedMigrationHead(),
          expectedDbIdentity: 'himma_api',
        },
      },
    });
    try {
      await app.ready();
      const ready = await app.inject({ method: 'GET', url: '/internal/ready' });
      expect(ready.statusCode).toBe(503);
      expect((ready.json() as { reasons: string[] }).reasons).toEqual(['wrongDatabaseIdentity']);
    } finally {
      await app.close();
    }
  });
});
