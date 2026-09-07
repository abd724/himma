/**
 * W6-3 — REAL spawned production processes on one PostgreSQL database
 * (docs/37 §36/§38): two `start:worker` replicas host the scheduler as
 * `himma_worker` (ticks never overlap per job; both replicas participate or
 * skip on the lock; the W6-2 outbox loop keeps running), a SIGKILLed
 * replica leaves at most an abandoned run the survivor records, SIGTERM
 * exits 0 — and real `start:maintenance` invocations run as
 * `himma_maintenance_runner` (bounded deletion, two concurrent invocations
 * never double-delete, SIGTERM stops at a batch boundary and a re-run
 * finishes, wrong credential / unknown job refused with secrets absent).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { sql } from 'kysely';

import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import { withTransaction } from '../src/db/transaction';
import { appendOutboxEvent } from '../src/outbox/outbox';
import { createBookingFixture, publishProgram } from './helpers/booking-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(240_000);

const BACKEND = path.resolve(__dirname, '..');
const TSX = path.join(BACKEND, 'node_modules', '.bin', 'tsx');

let testDb: TestDb;
let orgId: string;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;
const maintenancePassword = `maint-${randomBytes(18).toString('base64url')}`;

interface Proc {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exit: Promise<number | null>;
}

function databaseUrlFor(user: string, password: string): string {
  const db = testDb.config.database;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${db.host}:${db.port}/${db.database}`;
}

function spawnScript(script: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(TSX, [script, ...args], {
    cwd: BACKEND,
    env: { PATH: process.env.PATH as string, HOME: process.env.HOME ?? '', ...env },
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, stdout, stderr, exit };
}

function startWorker(extra: Record<string, string> = {}): Proc {
  return spawnScript('scripts/start-worker.ts', [], {
    NODE_ENV: 'production',
    RUNTIME_ROLE: 'worker',
    DATABASE_URL: databaseUrlFor('himma_worker', workerPassword),
    LOG_LEVEL: 'info',
    WORKER_OUTBOX_POLL_MS: '150',
    WORKER_OUTBOX_BATCH: '10',
    SCHEDULER_TICK_MS: '250',
    SCHEDULER_INTERVALS: 'booking.hold-sweep=1000,payment.stuck-state=1000,identity.role-expiry=1000,provider.invitation-expiry=1000',
    ...extra,
  });
}

function startMaintenance(args: string[], extra: Record<string, string> = {}): Proc {
  return spawnScript('scripts/start-maintenance.ts', args, {
    NODE_ENV: 'production',
    RUNTIME_ROLE: 'maintenance',
    DATABASE_URL: databaseUrlFor('himma_maintenance_runner', maintenancePassword),
    LOG_LEVEL: 'info',
    ...extra,
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitRunning(proc: Proc): Promise<void> {
  await waitFor(() => {
    if (proc.child.exitCode !== null) throw new Error(`worker exited early: ${proc.stderr.join('')}`);
    return proc.stdout.join('').includes('himma worker running');
  }, 60_000, 'worker running');
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const result = await query.execute(testDb.db);
  return Number((result.rows[0] as { n: string }).n);
}

async function seedRateLimitWindows(old: number, tag: string): Promise<void> {
  await sql`INSERT INTO rate_limit_window (limiter_key, window_start, hits)
            SELECT ${tag} || g, now() - interval '10 days' - make_interval(secs => g), 1
            FROM generate_series(1, ${old}) AS g`.execute(testDb.db);
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword, himma_maintenance_runner: maintenancePassword },
  });
  const f = await createBookingFixture(testDb.db);
  orgId = f.org.orgId;
  await sql`UPDATE organization_public_profile SET published = true WHERE organization_id = ${orgId}`.execute(testDb.db);
  await publishProgram(f);
});

afterAll(async () => {
  await testDb.drop();
});

describe('two production worker processes hosting the scheduler', () => {
  let a: Proc;
  let b: Proc;
  const SCHEDULED = ['booking.hold-sweep', 'payment.stuck-state', 'identity.role-expiry', 'provider.invitation-expiry'];

  afterAll(async () => {
    for (const proc of [a, b]) {
      if (proc !== undefined && proc.child.exitCode === null) {
        proc.child.kill('SIGKILL');
        await proc.exit;
      }
    }
  });

  it('both boot as himma_worker with the scheduler, every scheduled job runs on cadence, runs of one job never overlap across replicas, and the W6-2 outbox loop still converges', async () => {
    a = startWorker();
    b = startWorker();
    await waitRunning(a);
    await waitRunning(b);
    for (const proc of [a, b]) {
      const joined = proc.stdout.join('');
      expect(joined).toContain('"scheduledJobs":[');
      expect(joined).toContain('"unavailableJobs":["payment.checkout-sweep","payment.reconciliation"]');
      expect(joined).toContain('scheduled job unavailable on this worker');
    }
    const identities = await count(sql`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'himma_worker' AND datname = ${testDb.config.database.database}`);
    expect(identities).toBeGreaterThanOrEqual(2);

    // Outbox work emitted while both replicas run (W6-2 regression).
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(
        await withTransaction(testDb.db, async (trx) => {
          const appended = await appendOutboxEvent(trx, { aggregateType: 'organization', aggregateId: orgId, eventType: 'organization.profile_updated', payload: { organizationId: orgId } });
          return appended.id;
        }),
      );
    }
    await waitFor(async () => (await count(sql`SELECT count(*) AS n FROM outbox_event WHERE id = ANY(${sql.val(ids)}::uuid[]) AND published_at IS NULL`)) === 0, 30_000, 'outbox drained');
    expect(await count(sql`SELECT count(*) AS n FROM inbox_event WHERE consumer = 'search-projection' AND event_id = ANY(${sql.val(ids)}::uuid[])`)).toBe(20);

    // Each scheduled job accumulates ≥ 3 successful runs across the two replicas.
    await waitFor(async () => {
      for (const job of SCHEDULED) {
        if ((await count(sql`SELECT count(*) AS n FROM job_run WHERE job_name = ${job} AND outcome = 'succeeded'`)) < 3) return false;
      }
      return true;
    }, 30_000, 'scheduled runs');
    const roles = await sql<{ runtime_role: string; outcome: string; n: string }>`
      SELECT runtime_role, outcome, count(*) AS n FROM job_run GROUP BY runtime_role, outcome ORDER BY runtime_role, outcome`.execute(testDb.db);
    expect(roles.rows.every((row) => row.runtime_role === 'worker')).toBe(true);
    expect(roles.rows.filter((row) => row.outcome === 'failed')).toEqual([]);
    const overlaps = await count(sql`
      SELECT count(*) AS n FROM job_run x JOIN job_run y ON x.id < y.id AND x.job_name = y.job_name
      WHERE x.outcome <> 'abandoned' AND y.outcome <> 'abandoned'
        AND x.started_at < coalesce(y.finished_at, now()) AND y.started_at < coalesce(x.finished_at, now())`);
    expect(overlaps).toBe(0);
    // Cadence honored on the database clock: consecutive runs of a job are ≥ its interval apart.
    const gaps = await sql<{ gap: number }>`
      SELECT EXTRACT(EPOCH FROM (started_at - lag(started_at) OVER (PARTITION BY job_name ORDER BY started_at))) AS gap
      FROM job_run WHERE outcome = 'succeeded'`.execute(testDb.db);
    for (const row of gaps.rows) {
      if (row.gap !== null) expect(Number(row.gap)).toBeGreaterThanOrEqual(0.95);
    }
    const stdoutAll = a.stdout.join('') + b.stdout.join('');
    expect(stdoutAll).toContain('"job":"booking.hold-sweep"');
    expect(stdoutAll).toContain('"outcome":"succeeded"');
    expect(stdoutAll).not.toContain(workerPassword);
    const audits = await count(sql`SELECT count(*) AS n FROM audit_event WHERE request_id IS NOT NULL`);
    expect(audits).toBe(0); // pure background work never writes a request id
  });

  it('SIGKILL of one replica corrupts nothing: the survivor keeps running every job and any orphaned run is recorded abandoned', async () => {
    const before = await count(sql`SELECT count(*) AS n FROM job_run WHERE outcome = 'succeeded'`);
    a.child.kill('SIGKILL');
    await a.exit;
    await waitFor(async () => (await count(sql`SELECT count(*) AS n FROM job_run WHERE outcome = 'succeeded'`)) >= before + 4, 30_000, 'survivor progress');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stale = await count(sql`SELECT count(*) AS n FROM job_run WHERE outcome = 'running' AND started_at < now() - interval '3 seconds'`);
    expect(stale).toBe(0);
    const failed = await count(sql`SELECT count(*) AS n FROM job_run WHERE outcome = 'failed'`);
    expect(failed).toBe(0);
  });

  it('SIGTERM shuts the surviving replica down cleanly (exit 0) and leaves no running row behind', async () => {
    b.child.kill('SIGTERM');
    expect(await b.exit).toBe(0);
    expect(b.stdout.join('')).toContain('shutdown signal received');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await count(sql`SELECT count(*) AS n FROM job_run WHERE outcome = 'running'`)).toBe(0);
  });
});

describe('real maintenance invocations as himma_maintenance_runner', () => {
  it('runs one allow-listed retention job under the exact maintenance identity, deletes only beyond-horizon rows, exits 0, and prints no secret', async () => {
    await seedRateLimitWindows(25, 'p-old-');
    await sql`INSERT INTO rate_limit_window (limiter_key, window_start, hits) VALUES ('p-fresh', now(), 1)`.execute(testDb.db);
    const proc = startMaintenance(['retention.rate-limit-windows'], { MAINTENANCE_BATCH: '10' });
    expect(await proc.exit).toBe(0);
    const out = proc.stdout.join('');
    expect(out).toContain('"role":"maintenance"');
    expect(out).toContain('himma maintenance finished');
    expect(out).toContain('"outcome":"ran"');
    expect(out).not.toContain(maintenancePassword);
    expect(out).not.toContain('p-old-0');
    expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'p-old-%'`)).toBe(0);
    expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key = 'p-fresh'`)).toBe(1);
    const run = await sql<{ runtime_role: string; outcome: string; items: number }>`
      SELECT runtime_role, outcome, items FROM job_run WHERE job_name = 'retention.rate-limit-windows' ORDER BY started_at DESC LIMIT 1`.execute(testDb.db);
    expect(run.rows[0]).toEqual({ runtime_role: 'maintenance', outcome: 'succeeded', items: 25 });
  });

  it('two concurrent invocations of the same job never double-delete and both exit 0', async () => {
    await seedRateLimitWindows(300, 'c-old-');
    const x = startMaintenance(['retention.rate-limit-windows'], { MAINTENANCE_BATCH: '20' });
    const y = startMaintenance(['retention.rate-limit-windows'], { MAINTENANCE_BATCH: '20' });
    expect(await x.exit).toBe(0);
    expect(await y.exit).toBe(0);
    expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 'c-old-%'`)).toBe(0);
    const items = await sql<{ items: number }>`
      SELECT items FROM job_run WHERE job_name = 'retention.rate-limit-windows' AND outcome = 'succeeded' ORDER BY started_at DESC LIMIT 2`.execute(testDb.db);
    const deleted = items.rows.reduce((sum, row) => sum + row.items, 0);
    expect(deleted).toBeLessThanOrEqual(300 + 25);
    const identities = x.stdout.join('') + y.stdout.join('');
    expect(identities).not.toContain(maintenancePassword);
  });

  it('SIGTERM mid-run stops at a batch boundary (exit 0, run recorded stoppedEarly); a re-run finishes the remainder', async () => {
    // Large enough that the invocation is still mid-run when the signal lands.
    await seedRateLimitWindows(40_000, 's-old-');
    const proc = startMaintenance(['retention.rate-limit-windows'], { MAINTENANCE_BATCH: '5', MAINTENANCE_MAX_BATCHES: '100000' });
    await waitFor(() => proc.stdout.join('').includes('retention batch'), 30_000, 'first batch');
    proc.child.kill('SIGTERM');
    expect(await proc.exit).toBe(0);
    expect(proc.stdout.join('')).toContain('stop requested');
    const run = await sql<{ facts: Record<string, unknown> }>`
      SELECT facts FROM job_run WHERE job_name = 'retention.rate-limit-windows' ORDER BY started_at DESC LIMIT 1`.execute(testDb.db);
    expect(run.rows[0]?.facts).toMatchObject({ stoppedEarly: true });
    const remaining = await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 's-old-%'`);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining % 5).toBe(0); // whole batches only — no partial deletion
    const again = startMaintenance(['retention.rate-limit-windows'], { MAINTENANCE_BATCH: '5000', MAINTENANCE_MAX_BATCHES: '100' });
    expect(await again.exit).toBe(0);
    expect(await count(sql`SELECT count(*) AS n FROM rate_limit_window WHERE limiter_key LIKE 's-old-%'`)).toBe(0);
  });

  it('refuses a mispasted credential, an unknown job, and a stale migration head — with bounded messages and no secret', async () => {
    const wrongLogin = startMaintenance(['retention.rate-limit-windows'], { DATABASE_URL: databaseUrlFor('himma_worker', workerPassword) });
    expect(await wrongLogin.exit).toBe(1);
    expect(wrongLogin.stderr.join('')).toContain('himma_maintenance_runner');
    expect(wrongLogin.stderr.join('')).not.toContain(workerPassword);

    const unknown = startMaintenance(['retention.audit-events']);
    expect(await unknown.exit).toBe(2);
    expect(unknown.stderr.join('')).toContain('usage error');
    expect(unknown.stderr.join('')).toContain('retention.all');

    const noJob = startMaintenance([]);
    expect(await noJob.exit).toBe(2);

    await sql`INSERT INTO pgmigrations (name, run_on) VALUES ('9999_future_migration', now())`.execute(testDb.db);
    try {
      const stale = startMaintenance(['retention.rate-limit-windows']);
      expect(await stale.exit).toBe(1);
      expect(stale.stderr.join('')).toContain('migration head mismatch');
    } finally {
      await sql`DELETE FROM pgmigrations WHERE name = '9999_future_migration'`.execute(testDb.db);
    }
  });
});
