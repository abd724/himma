/**
 * W6-3 — the bounded maintenance runtime on real PostgreSQL under the EXACT
 * `himma_maintenance_runner` login (docs/37 §18/§19/§28/§38): provisioning
 * (idempotent; sole membership), fail-closed composition, the allow-list,
 * every engineering-scoped retention job with its boundary predicates,
 * batch bounds, stop-at-batch-boundary, crash/restart resumption,
 * concurrent invocations, the repair commands, and the full privilege
 * matrix (API/worker/maintenance positive + negative on their exact
 * connections, re-run now that the maintenance grants exist).
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { sql } from 'kysely';
import { Client, Pool } from 'pg';

import { ProductionRuntimeError } from '../src/app/production-runtime';
import type { RuntimeConfig } from '../src/config/runtime';
import { DEFAULT_MAINTENANCE_POLICY, DEFAULT_SCHEDULER_POLICY } from '../src/config/runtime';
import { newId } from '../src/db/ids';
import { clientOptionsFor } from '../src/db/connection-options';
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import {
  composeMaintenanceRuntime,
  listMaintenanceJobs,
  MaintenanceUsageError,
  runMaintenance,
  type MaintenanceRuntime,
} from '../src/maintenance/maintenance-runtime';
import { lockKeyFor, SimulatedProcessDeath } from '../src/worker/scheduler';
import { createBookingFixture, publishProgram, type BookingFixture } from './helpers/booking-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(180_000);

let testDb: TestDb;
let fixture: BookingFixture;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;
const maintenancePassword = `maint-${randomBytes(18).toString('base64url')}`;

function config(overrides: Partial<RuntimeConfig> = {}, maintenance: Partial<RuntimeConfig['maintenance']> = {}): RuntimeConfig {
  return {
    nodeEnv: 'production',
    database: {
      host: testDb.config.database.host,
      port: testDb.config.database.port,
      database: testDb.config.database.database,
      user: 'himma_maintenance_runner',
      password: maintenancePassword,
    },
    role: 'maintenance',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    shutdownDrainMs: 5_000,
    paymentsMode: 'disabled',
    worker: { outboxPollMs: 200, outboxBatchSize: 100, outboxMaxAttempts: 8, paymentPollMs: 30_000 },
    scheduler: { ...DEFAULT_SCHEDULER_POLICY },
    maintenance: { ...DEFAULT_MAINTENANCE_POLICY, ...maintenance },
    ...overrides,
  };
}

function captured(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, lines };
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

async function compose(
  overrides: Partial<RuntimeConfig['maintenance']> = {},
  options: Parameters<typeof composeMaintenanceRuntime>[1] = {},
): Promise<MaintenanceRuntime> {
  return composeMaintenanceRuntime(config({}, overrides), options);
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const result = await query.execute(testDb.db);
  return Number((result.rows[0] as { n: string }).n);
}

// ---- seeds (as the schema owner; the maintenance runner cannot insert) ----

async function seedRateLimitWindows(old: number, fresh: number, tag = 'w'): Promise<void> {
  for (let i = 0; i < old; i += 1) {
    await sql`INSERT INTO rate_limit_window (limiter_key, window_start, hits)
              VALUES (${`${tag}old${i}`}, now() - interval '10 days' - make_interval(secs => ${i}), 1)`.execute(testDb.db);
  }
  for (let i = 0; i < fresh; i += 1) {
    await sql`INSERT INTO rate_limit_window (limiter_key, window_start, hits)
              VALUES (${`${tag}new${i}`}, now() - make_interval(secs => ${i}), 1)`.execute(testDb.db);
  }
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  fixture = await createBookingFixture(testDb.db);
  const first = await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword, himma_maintenance_runner: maintenancePassword },
  });
  expect([...first.created, ...first.updated].sort()).toEqual(['himma_api', 'himma_maintenance_runner', 'himma_worker']);
  const again = await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword, himma_maintenance_runner: maintenancePassword },
  });
  expect(again.created).toEqual([]);
  expect(again.updated.sort()).toEqual(['himma_api', 'himma_maintenance_runner', 'himma_worker']);
});

afterAll(async () => {
  await testDb.drop();
});

describe('provisioning and identity (docs/37 §19/§28)', () => {
  it('himma_maintenance_runner is the SOLE member of himma_maintenance and holds no himma_app membership; api/worker are members of himma_app only', async () => {
    const members = await sql<{ member: string; role: string }>`
      SELECT m.rolname AS member, r.rolname AS role
      FROM pg_auth_members am
      JOIN pg_roles m ON m.oid = am.member
      JOIN pg_roles r ON r.oid = am.roleid
      WHERE m.rolname IN ('himma_api', 'himma_worker', 'himma_maintenance_runner')
      ORDER BY member, role`.execute(testDb.db);
    expect(members.rows).toEqual([
      { member: 'himma_api', role: 'himma_app' },
      { member: 'himma_maintenance_runner', role: 'himma_maintenance' },
      { member: 'himma_worker', role: 'himma_app' },
    ]);
    const attrs = await sql<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>`
      SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles
      WHERE rolname IN ('himma_maintenance', 'himma_maintenance_runner') ORDER BY rolname`.execute(testDb.db);
    expect(attrs.rows).toEqual([
      { rolname: 'himma_maintenance', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false },
      { rolname: 'himma_maintenance_runner', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true },
    ]);
  });

  it('composes ONLY as himma_maintenance_runner with RUNTIME_ROLE=maintenance at the shipped migration head', async () => {
    await expect(composeMaintenanceRuntime(config({ role: 'worker' }))).rejects.toThrow(ProductionRuntimeError);
    await expect(
      composeMaintenanceRuntime(config({ database: { ...testDb.config.database, user: 'himma_api', password: apiPassword } })),
    ).rejects.toThrow(/himma_maintenance_runner/);
    await sql`INSERT INTO pgmigrations (name, run_on) VALUES ('9999_future_migration', now())`.execute(testDb.db);
    try {
      await expect(compose()).rejects.toThrow(/migration head mismatch/);
    } finally {
      await sql`DELETE FROM pgmigrations WHERE name = '9999_future_migration'`.execute(testDb.db);
    }
    const runtime = await compose();
    try {
      const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(runtime.db);
      expect(who.rows[0]?.u).toBe('himma_maintenance_runner');
      expect(runtime.requiredMigrationHead).toBe('0023_job_run_and_maintenance_authority');
    } finally {
      await runtime.pool.end();
    }
  });

  it('the allow-list is closed: unknown jobs and missing arguments are usage errors BEFORE any lock or bookkeeping', async () => {
    const runtime = await compose();
    try {
      expect(listMaintenanceJobs().map((job) => job.name)).toEqual([
        'retention.rate-limit-windows',
        'retention.redemption-lookup-attempts',
        'retention.idempotency-keys',
        'retention.outbox-published',
        'retention.job-runs',
        'repair.rebuild-search',
        'repair.unquarantine-outbox',
      ]);
      await expect(runMaintenance(runtime, 'retention.audit-events')).rejects.toThrow(MaintenanceUsageError);
      await expect(runMaintenance(runtime, 'DROP TABLE booking')).rejects.toThrow(MaintenanceUsageError);
      await expect(runMaintenance(runtime, 'repair.unquarantine-outbox')).rejects.toThrow(/--event-id/);
      await expect(runMaintenance(runtime, 'repair.unquarantine-outbox', { eventId: 'not-a-uuid' })).rejects.toThrow(/--event-id/);
      expect(await count(sql`SELECT count(*) AS n FROM job_run`)).toBe(0);
    } finally {
      await runtime.pool.end();
    }
  });
});

describe('retention jobs — boundary predicates, batching, bookkeeping', () => {
  it('rate-limit windows: only rows beyond the horizon go, in bounded batches; fresh rows stay; a second pass finds nothing', async () => {
    await seedRateLimitWindows(5, 2, 'rl');
    const { stream, lines } = captured();
    const runtime = await compose({ batchSize: 2 }, { logDestination: stream });
    try {
      const result = await runMaintenance(runtime, 'retention.rate-limit-windows');
      expect(result.exitCode).toBe(0);
      expect(result.outcomes[0]).toMatchObject({ job: 'retention.rate-limit-windows', outcome: 'ran', items: 5 });
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'rlold%'`)).toBe(0);
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'rlnew%'`)).toBe(2);
      const run = await sql<{ runtime_role: string; outcome: string; facts: Record<string, unknown> }>`
        SELECT runtime_role, outcome, facts FROM job_run WHERE job_name = 'retention.rate-limit-windows' ORDER BY started_at DESC LIMIT 1
      `.execute(testDb.db);
      expect(run.rows[0]?.runtime_role).toBe('maintenance');
      expect(run.rows[0]?.outcome).toBe('succeeded');
      expect(run.rows[0]?.facts).toMatchObject({ batches: 3, deleted: 5, horizonDays: 7, batchSize: 2, exhausted: true, stoppedEarly: false });
      const again = await runMaintenance(runtime, 'retention.rate-limit-windows');
      expect(again.outcomes[0]).toMatchObject({ outcome: 'ran', items: 0 });
      const joined = lines.join('');
      expect(joined).toContain('"role":"maintenance"');
      expect(joined).toContain('retention batch');
      expect(joined).not.toContain(maintenancePassword);
      // Counts only — never row contents.
      expect(joined).not.toContain('rlold0');
    } finally {
      await runtime.pool.end();
    }
  });

  it('the batch ceiling bounds one invocation; the next invocation resumes from live truth', async () => {
    await seedRateLimitWindows(5, 0, 'cap');
    const runtime = await compose({ batchSize: 1, maxBatches: 2 });
    try {
      const bounded = await runMaintenance(runtime, 'retention.rate-limit-windows');
      expect(bounded.outcomes[0]).toMatchObject({ outcome: 'ran', items: 2 });
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'capold%'`)).toBe(3);
      const facts = await sql<{ facts: Record<string, unknown> }>`
        SELECT facts FROM job_run WHERE job_name = 'retention.rate-limit-windows' ORDER BY started_at DESC LIMIT 1`.execute(testDb.db);
      expect(facts.rows[0]?.facts).toMatchObject({ batches: 2, exhausted: false, stoppedEarly: false });
    } finally {
      await runtime.pool.end();
    }
    const resume = await compose({ batchSize: 10 });
    try {
      const rest = await runMaintenance(resume, 'retention.rate-limit-windows');
      expect(rest.outcomes[0]).toMatchObject({ outcome: 'ran', items: 3 });
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'capold%'`)).toBe(0);
    } finally {
      await resume.pool.end();
    }
  });

  it('redemption-lookup windows: horizon-bounded deletion; recent windows and the organization stay', async () => {
    const org = fixture.org.orgId;
    for (let i = 0; i < 3; i += 1) {
      await sql`INSERT INTO redemption_lookup_attempt (principal_ref, organization_id, window_start, failures)
                VALUES (${`staff:old${i}`}, ${org}, now() - interval '9 days' - make_interval(secs => ${i}), 2)`.execute(testDb.db);
    }
    await sql`INSERT INTO redemption_lookup_attempt (principal_ref, organization_id, window_start, failures)
              VALUES ('staff:fresh', ${org}, now(), 1)`.execute(testDb.db);
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'retention.redemption-lookup-attempts');
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 3 });
      expect(await count(sql`SELECT count(*) AS n FROM redemption_lookup_attempt`)).toBe(1);
      expect(await count(sql`SELECT count(*) AS n FROM organization WHERE id = ${org}`)).toBe(1);
    } finally {
      await runtime.pool.end();
    }
  });

  it('idempotency keys: only COMPLETED rows beyond the 90-day horizon go; in-progress, fresh, and future-expiring rows stay', async () => {
    const insert = async (status: string, ageDays: number, expiresAt: string | null, tag: string) =>
      sql`INSERT INTO idempotency_key (id, principal_ref, endpoint_scope, idempotency_key, request_digest, response_snapshot, status, expires_at, created_at)
          VALUES (${newId()}, 'customer:x', 'probe', ${tag}, 'd', '{}'::jsonb, ${status},
                  ${expiresAt === null ? null : sql.raw(expiresAt)}, now() - make_interval(days => ${ageDays}))`.execute(testDb.db);
    await insert('completed', 120, null, 'old-1');
    await insert('completed', 100, null, 'old-2');
    await insert('completed', 95, `now() - interval '1 day'`, 'old-expired');
    await insert('in_progress', 120, null, 'old-in-progress');
    await insert('completed', 120, `now() + interval '30 days'`, 'old-future');
    await insert('completed', 10, null, 'fresh');
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'retention.idempotency-keys');
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 3 });
      const remaining = await sql<{ idempotency_key: string }>`
        SELECT idempotency_key FROM idempotency_key ORDER BY idempotency_key`.execute(testDb.db);
      expect(remaining.rows.map((r) => r.idempotency_key)).toEqual(['fresh', 'old-future', 'old-in-progress']);
    } finally {
      await runtime.pool.end();
    }
  });

  it('published outbox rows beyond the horizon go WITH their inbox dedup rows; unpublished, quarantined, and fresh published rows stay', async () => {
    const insertOutbox = async (tag: string, published: string | null, quarantined: string | null, occurredDaysAgo: number): Promise<string> => {
      const id = newId();
      await sql`INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload, occurred_at, published_at, quarantined_at, last_outcome_code)
                VALUES (${id}, 'probe', ${tag}, 1, 'probe.event', '{}'::jsonb, now() - make_interval(days => ${occurredDaysAgo}),
                        ${published === null ? null : sql.raw(published)}, ${quarantined === null ? null : sql.raw(quarantined)},
                        ${quarantined === null ? (published === null ? null : 'delivered') : 'quarantined:Error'})`.execute(testDb.db);
      await sql`INSERT INTO inbox_event (consumer, event_id) VALUES ('search-projection', ${id})`.execute(testDb.db);
      await sql`INSERT INTO inbox_event (consumer, event_id) VALUES ('notifications', ${id})`.execute(testDb.db);
      return id;
    };
    const oldPublished = await insertOutbox('old-published', `now() - interval '45 days'`, null, 46);
    const oldPublished2 = await insertOutbox('old-published-2', `now() - interval '31 days'`, null, 32);
    const freshPublished = await insertOutbox('fresh-published', `now() - interval '2 days'`, null, 3);
    const unpublished = await insertOutbox('unpublished', null, null, 60);
    const quarantined = await insertOutbox('quarantined', null, `now() - interval '50 days'`, 60);
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'retention.outbox-published');
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 2 });
      const remaining = await sql<{ aggregate_id: string }>`
        SELECT aggregate_id FROM outbox_event WHERE aggregate_type = 'probe' ORDER BY aggregate_id`.execute(testDb.db);
      expect(remaining.rows.map((r) => r.aggregate_id)).toEqual(['fresh-published', 'quarantined', 'unpublished']);
      const inbox = await sql<{ event_id: string; n: string }>`
        SELECT event_id, count(*) AS n FROM inbox_event WHERE event_id = ANY(${sql.val([oldPublished, oldPublished2, freshPublished, unpublished, quarantined])}::uuid[])
        GROUP BY event_id ORDER BY event_id`.execute(testDb.db);
      const byEvent = new Map(inbox.rows.map((r) => [r.event_id, Number(r.n)]));
      expect(byEvent.get(oldPublished)).toBeUndefined();
      expect(byEvent.get(oldPublished2)).toBeUndefined();
      expect(byEvent.get(freshPublished)).toBe(2);
      expect(byEvent.get(unpublished)).toBe(2);
      expect(byEvent.get(quarantined)).toBe(2);
    } finally {
      await runtime.pool.end();
    }
  });

  it('job runs: finished rows beyond the horizon go; the latest run of every job and any running row stay', async () => {
    const insertRun = async (job: string, outcome: string, daysAgo: number) =>
      sql`INSERT INTO job_run (id, job_name, runtime_role, run_id, started_at, finished_at, outcome, error_code)
          VALUES (${newId()}, ${job}, 'worker', ${newId()}, now() - make_interval(days => ${daysAgo}),
                  ${outcome === 'running' ? null : sql.raw(`now() - make_interval(days => ${daysAgo}) + interval '1 second'`)},
                  ${outcome}, ${outcome === 'failed' ? 'Error' : null})`.execute(testDb.db);
    await insertRun('probe.history', 'succeeded', 60);
    await insertRun('probe.history', 'failed', 50);
    await insertRun('probe.history', 'succeeded', 40); // latest of this job — kept
    await insertRun('probe.stuck', 'running', 45); // never pruned while running
    await insertRun('probe.recent', 'succeeded', 1);
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'retention.job-runs');
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 2 });
      const remaining = await sql<{ job_name: string; outcome: string }>`
        SELECT job_name, outcome FROM job_run WHERE job_name LIKE 'probe.%' ORDER BY job_name, started_at`.execute(testDb.db);
      expect(remaining.rows).toEqual([
        { job_name: 'probe.history', outcome: 'succeeded' },
        { job_name: 'probe.recent', outcome: 'succeeded' },
        { job_name: 'probe.stuck', outcome: 'running' },
      ]);
    } finally {
      await runtime.pool.end();
    }
  });

  it('retention.all runs every engineering-scoped retention job under its own lock with its own run row — and nothing policy-gated exists', async () => {
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'retention.all');
      expect(result.exitCode).toBe(0);
      expect(result.outcomes.map((o) => [o.job, o.outcome])).toEqual([
        ['retention.rate-limit-windows', 'ran'],
        ['retention.redemption-lookup-attempts', 'ran'],
        ['retention.idempotency-keys', 'ran'],
        ['retention.outbox-published', 'ran'],
        ['retention.job-runs', 'ran'],
      ]);
      const names = listMaintenanceJobs().map((job) => job.name).join(' ');
      for (const forbidden of ['audit', 'evidence', 'session', 'mfa', 'booking', 'ledger', 'payment', 'attendance', 'entitlement', 'user', 'account']) {
        expect(names).not.toContain(forbidden);
      }
    } finally {
      await runtime.pool.end();
    }
  });
});

describe('interruption, crash, and concurrency', () => {
  it('a stop request is honored at the batch boundary: the current batch commits, the run records stoppedEarly, and a re-run finishes the remainder', async () => {
    await seedRateLimitWindows(6, 0, 'stop');
    const ref: { runtime?: MaintenanceRuntime } = {};
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (chunk.toString('utf8').includes('retention batch')) ref.runtime?.requestStop();
        callback();
      },
    });
    const runtime = await compose({ batchSize: 2 }, { logDestination: stream });
    ref.runtime = runtime;
    try {
      const result = await runMaintenance(runtime, 'retention.rate-limit-windows');
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 2 });
      const facts = await sql<{ facts: Record<string, unknown> }>`
        SELECT facts FROM job_run WHERE job_name = 'retention.rate-limit-windows' ORDER BY started_at DESC LIMIT 1`.execute(testDb.db);
      expect(facts.rows[0]?.facts).toMatchObject({ batches: 1, stoppedEarly: true, exhausted: false });
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'stopold%'`)).toBe(4);
    } finally {
      await runtime.pool.end();
    }
    const resume = await compose();
    try {
      expect((await runMaintenance(resume, 'retention.rate-limit-windows')).outcomes[0]).toMatchObject({ outcome: 'ran', items: 4 });
    } finally {
      await resume.pool.end();
    }
  });

  it('process death mid-invocation (after batches committed, before bookkeeping): nothing is lost, the run is abandoned by the next invocation, which resumes', async () => {
    await seedRateLimitWindows(4, 0, 'crash');
    const runtime = await compose({ batchSize: 2, maxBatches: 1 }, {
      failpoint: (point, client) => {
        if (point === 'afterRunBeforeBookkeeping') {
          client.release(true);
          throw new SimulatedProcessDeath('maintenance-died');
        }
      },
    });
    try {
      const died = await runMaintenance(runtime, 'retention.rate-limit-windows');
      expect(died.outcomes[0]?.outcome).toBe('died');
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'crashold%'`)).toBe(2);
      expect(await count(sql`SELECT count(*) AS n FROM job_run WHERE job_name = 'retention.rate-limit-windows' AND outcome = 'running'`)).toBe(1);
    } finally {
      await runtime.pool.end();
    }
    const resume = await compose({ batchSize: 10 });
    try {
      const result = await runMaintenance(resume, 'retention.rate-limit-windows');
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 2 });
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'crashold%'`)).toBe(0);
      expect(await count(sql`SELECT count(*) AS n FROM job_run WHERE job_name = 'retention.rate-limit-windows' AND outcome = 'running'`)).toBe(0);
      expect(await count(sql`SELECT count(*) AS n FROM job_run WHERE job_name = 'retention.rate-limit-windows' AND outcome = 'abandoned' AND error_code = 'processDied'`)).toBe(1);
    } finally {
      await resume.pool.end();
    }
  });

  it('death before any batch (lock held, nothing run): zero deletions, and the next invocation runs clean', async () => {
    await seedRateLimitWindows(2, 0, 'early');
    const runtime = await compose({}, {
      failpoint: (point, client) => {
        if (point === 'afterLockBeforeRun') {
          client.release(true);
          throw new SimulatedProcessDeath('maintenance-died-early');
        }
      },
    });
    try {
      expect((await runMaintenance(runtime, 'retention.rate-limit-windows')).outcomes[0]?.outcome).toBe('died');
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'earlyold%'`)).toBe(2);
    } finally {
      await runtime.pool.end();
    }
    const resume = await compose();
    try {
      expect((await runMaintenance(resume, 'retention.rate-limit-windows')).outcomes[0]).toMatchObject({ outcome: 'ran', items: 2 });
    } finally {
      await resume.pool.end();
    }
  });

  it('a concurrent invocation of the same job is skipped (lock held) with exit 0 and deletes nothing', async () => {
    await seedRateLimitWindows(3, 0, 'held');
    const holder = new Client(clientOptionsFor(testDb.config.database));
    await holder.connect();
    const runtime = await compose();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 42))`, [lockKeyFor('retention.rate-limit-windows')]);
      const result = await runMaintenance(runtime, 'retention.rate-limit-windows');
      expect(result.exitCode).toBe(0);
      expect(result.outcomes[0]?.outcome).toBe('lockHeld');
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'heldold%'`)).toBe(3);
    } finally {
      await holder.end();
      await runtime.pool.end();
    }
  });

  it('two invocations racing the same job never double-delete: the doomed set goes exactly once, fresh rows stay, and runs never overlap', async () => {
    // Start from a clean beyond-horizon set so the doomed count is exact.
    await sql`DELETE FROM rate_limit_window WHERE window_start < now() - interval '7 days'`.execute(testDb.db);
    await seedRateLimitWindows(60, 3, 'race');
    const a = await compose({ batchSize: 5 });
    const b = await compose({ batchSize: 5 });
    try {
      const [ra, rb] = await Promise.all([
        runMaintenance(a, 'retention.rate-limit-windows'),
        runMaintenance(b, 'retention.rate-limit-windows'),
      ]);
      const outcomes = [ra.outcomes[0]?.outcome, rb.outcomes[0]?.outcome];
      expect(outcomes).toContain('ran');
      const deleted = ra.outcomes.concat(rb.outcomes).reduce((sum, o) => sum + (o.outcome === 'ran' ? o.items : 0), 0);
      expect(deleted).toBe(60);
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'raceold%'`)).toBe(0);
      expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'racenew%'`)).toBe(3);
      const overlaps = await count(sql`
        SELECT count(*) AS n FROM job_run x JOIN job_run y ON x.id < y.id
        WHERE x.job_name = 'retention.rate-limit-windows' AND y.job_name = x.job_name
          AND x.outcome <> 'abandoned' AND y.outcome <> 'abandoned'
          AND x.started_at < coalesce(y.finished_at, now()) AND y.started_at < coalesce(x.finished_at, now())`);
      expect(overlaps).toBe(0);
    } finally {
      await a.pool.end();
      await b.pool.end();
    }
  });
});

describe('repair commands', () => {
  it('rebuild-search recomputes the derived projection from live truth under the maintenance login', async () => {
    await sql`UPDATE organization_public_profile SET published = true WHERE organization_id = ${fixture.org.orgId}`.execute(testDb.db);
    await sql`INSERT INTO program_branch (program_id, branch_id, organization_id, active)
              VALUES (${fixture.programId}, ${fixture.org.branchIds[0]}, ${fixture.org.orgId}, true) ON CONFLICT DO NOTHING`.execute(testDb.db);
    await publishProgram(fixture); // fixture-level publish: no projection refresh ran — the document is absent
    expect(await count(sql`SELECT count(*) AS n FROM program_search_document WHERE program_id = ${fixture.programId}`)).toBe(0);
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'repair.rebuild-search');
      expect(result.outcomes[0]?.outcome).toBe('ran');
      expect(await count(sql`SELECT count(*) AS n FROM program_search_document WHERE program_id = ${fixture.programId}`)).toBe(1);
    } finally {
      await runtime.pool.end();
    }
  });

  it('unquarantine returns exactly the named quarantined row to the claimable set; a non-quarantined id changes nothing', async () => {
    const quarantined = newId();
    const healthy = newId();
    await sql`INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload, publish_attempts, quarantined_at, last_outcome_code)
              VALUES (${quarantined}, 'probe', 'uq-1', 1, 'probe.event', '{}'::jsonb, 8, now(), 'quarantined:Error')`.execute(testDb.db);
    await sql`INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload)
              VALUES (${healthy}, 'probe', 'uq-2', 1, 'probe.event', '{}'::jsonb)`.execute(testDb.db);
    const runtime = await compose();
    try {
      const result = await runMaintenance(runtime, 'repair.unquarantine-outbox', { eventId: quarantined });
      expect(result.outcomes[0]).toMatchObject({ outcome: 'ran', items: 1 });
      const row = await sql<{ quarantined_at: Date | null; next_attempt_at: Date | null; publish_attempts: number; last_outcome_code: string }>`
        SELECT quarantined_at, next_attempt_at, publish_attempts, last_outcome_code FROM outbox_event WHERE id = ${quarantined}`.execute(testDb.db);
      expect(row.rows[0]).toEqual({ quarantined_at: null, next_attempt_at: null, publish_attempts: 0, last_outcome_code: 'unquarantined' });
      const noop = await runMaintenance(runtime, 'repair.unquarantine-outbox', { eventId: healthy });
      expect(noop.outcomes[0]).toMatchObject({ outcome: 'ran', items: 0 });
    } finally {
      await runtime.pool.end();
    }
  });
});

describe('privilege matrix on the EXACT runtime connections (docs/37 §28/§38)', () => {
  let apiPool: Pool;
  let workerPool: Pool;
  let maintenancePool: Pool;

  beforeAll(() => {
    apiPool = poolFor('himma_api', apiPassword);
    workerPool = poolFor('himma_worker', workerPassword);
    maintenancePool = poolFor('himma_maintenance_runner', maintenancePassword);
  });

  afterAll(async () => {
    await apiPool.end();
    await workerPool.end();
    await maintenancePool.end();
  });

  it('himma_api: no maintenance DELETE, no retention function, no SET ROLE, no DDL — while ordinary DML works', async () => {
    const who = await apiPool.query('SELECT current_user AS u');
    expect(who.rows[0].u).toBe('himma_api');
    await expect(apiPool.query(`SELECT maintenance_prune_rate_limit_windows(interval '7 days', 10)`)).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query(`SELECT maintenance_unquarantine_outbox(gen_random_uuid())`)).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('DELETE FROM rate_limit_window')).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('DELETE FROM job_run')).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('SET ROLE himma_maintenance')).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('SET ROLE himma_maintenance_runner')).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('CREATE TABLE w63_rogue (id int)')).rejects.toMatchObject({ code: '42501' });
    expect((await apiPool.query('SELECT count(*) FROM program')).rowCount).toBe(1);
  });

  it('himma_worker: records job runs, never deletes them, cannot execute retention functions or assume maintenance', async () => {
    const inserted = await workerPool.query(
      `INSERT INTO job_run (id, job_name, runtime_role, run_id, outcome) VALUES (gen_random_uuid(), 'probe.grant', 'worker', gen_random_uuid(), 'running') RETURNING id`,
    );
    const id = (inserted.rows[0] as { id: string }).id;
    await workerPool.query(`UPDATE job_run SET outcome = 'succeeded', finished_at = now(), items = 1 WHERE id = $1`, [id]);
    await expect(workerPool.query(`UPDATE job_run SET job_name = 'x' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('DELETE FROM job_run')).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query(`SELECT maintenance_prune_published_outbox(interval '30 days', 10)`)).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SET ROLE himma_maintenance')).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('DELETE FROM outbox_event')).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('CREATE TABLE w63_rogue2 (id int)')).rejects.toMatchObject({ code: '42501' });
  });

  it('himma_maintenance_runner: exactly the bounded functions + enumerated reads/projection writes; no direct DELETE, no application DML, no DDL, no schema ownership, no himma_app', async () => {
    const who = await maintenancePool.query('SELECT current_user AS u');
    expect(who.rows[0].u).toBe('himma_maintenance_runner');
    // Positive: the bounded functions run (nothing beyond horizon here → 0).
    const pruned = await maintenancePool.query(`SELECT maintenance_prune_rate_limit_windows(interval '7 days', 10) AS n`);
    expect(Number(pruned.rows[0].n)).toBe(0);
    // Negative: no DIRECT delete anywhere — the predicate lives in the function.
    for (const table of ['rate_limit_window', 'redemption_lookup_attempt', 'idempotency_key', 'outbox_event', 'inbox_event', 'job_run', 'audit_event', 'booking']) {
      await expect(maintenancePool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    // No application DML / no authoritative reads.
    await expect(maintenancePool.query(`INSERT INTO audit_event (id, actor_type, action, entity_type, entity_id) VALUES (gen_random_uuid(), 'system', 'x', 'y', 'z')`)).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query('SELECT count(*) FROM booking')).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query('SELECT count(*) FROM payment_intent')).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query('SELECT count(*) FROM app_user')).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query(`UPDATE program SET updated_at = now()`)).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query(`UPDATE outbox_event SET payload = '{}'`)).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query('UPDATE rate_limit_window SET hits = 0')).rejects.toMatchObject({ code: '42501' });
    // No DDL, no ownership, no app role.
    await expect(maintenancePool.query('CREATE TABLE w63_rogue3 (id int)')).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query('DROP TABLE rate_limit_window')).rejects.toBeTruthy();
    await expect(maintenancePool.query('SET ROLE himma_app')).rejects.toMatchObject({ code: '42501' });
    await expect(maintenancePool.query('SET ROLE himma_api')).rejects.toMatchObject({ code: '42501' });
    const owners = await maintenancePool.query(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`);
    for (const row of owners.rows as { tableowner: string }[]) {
      expect(row.tableowner).not.toBe('himma_maintenance_runner');
      expect(row.tableowner).not.toBe('himma_maintenance');
    }
    // Enumerated reads + projection writes work (rebuild-search authority).
    expect((await maintenancePool.query('SELECT count(*) FROM program')).rowCount).toBe(1);
    expect((await maintenancePool.query('SELECT count(*) FROM program_search_document')).rowCount).toBe(1);
    // Bookkeeping works for its own runs.
    const run = await maintenancePool.query(
      `INSERT INTO job_run (id, job_name, runtime_role, run_id, outcome) VALUES (gen_random_uuid(), 'probe.maint', 'maintenance', gen_random_uuid(), 'running') RETURNING id`,
    );
    await maintenancePool.query(`UPDATE job_run SET outcome = 'succeeded', finished_at = now() WHERE id = $1`, [(run.rows[0] as { id: string }).id]);
  });
});
