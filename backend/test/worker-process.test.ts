/**
 * W6-2 — REAL spawned production worker processes on one PostgreSQL
 * database (docs/37 §36/§38; owner items 3/13/14): two `start:worker`
 * replicas boot as himma_worker under NODE_ENV=production with the genuine
 * composition, share the outbox safely (every event exactly once), survive
 * a SIGKILL of one replica mid-backlog, resume after restart, shut down
 * cleanly on SIGTERM, and refuse a mispasted credential / stale schema.
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

jest.setTimeout(180_000);

const BACKEND = path.resolve(__dirname, '..');
const TSX = path.join(BACKEND, 'node_modules', '.bin', 'tsx');

let testDb: TestDb;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;

interface WorkerProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exit: Promise<number | null>;
}

function databaseUrlFor(user: string, password: string): string {
  const db = testDb.config.database;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${db.host}:${db.port}/${db.database}`;
}

function spawnWorker(env: Record<string, string>): WorkerProcess {
  const child = spawn(TSX, ['scripts/start-worker.ts'], {
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

function startWorker(extra: Record<string, string> = {}): WorkerProcess {
  return spawnWorker({
    NODE_ENV: 'production',
    RUNTIME_ROLE: 'worker',
    DATABASE_URL: databaseUrlFor('himma_worker', workerPassword),
    LOG_LEVEL: 'info',
    WORKER_OUTBOX_POLL_MS: '150',
    WORKER_OUTBOX_BATCH: '10',
    ...extra,
  });
}

async function waitRunning(proc: WorkerProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.stdout.join('').includes('himma worker running')) return;
    if (proc.child.exitCode !== null) {
      throw new Error(`worker exited early: ${proc.stderr.join('')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`worker did not report running:\n${proc.stdout.join('')}\n${proc.stderr.join('')}`);
}

let orgId: string;
let programId: string;

async function emitBatch(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(
      await withTransaction(testDb.db, async (trx) => {
        const appended = await appendOutboxEvent(trx, {
          aggregateType: 'organization',
          aggregateId: orgId,
          eventType: 'organization.profile_updated',
          payload: { organizationId: orgId },
        });
        return appended.id;
      }),
    );
  }
  return ids;
}

async function unpublishedCount(): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM outbox_event WHERE published_at IS NULL AND quarantined_at IS NULL
  `.execute(testDb.db);
  return Number(rows.rows[0]?.n);
}

async function waitDrained(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await unpublishedCount()) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`outbox did not drain: ${await unpublishedCount()} left`);
}

async function assertExactlyOnce(ids: string[]): Promise<void> {
  const inbox = await sql<{ n: string }>`
    SELECT count(*) AS n FROM inbox_event WHERE consumer = 'search-projection'
      AND event_id = ANY(${sql.val(ids)}::uuid[])`.execute(testDb.db);
  expect(Number(inbox.rows[0]?.n)).toBe(ids.length);
  const published = await sql<{ n: string; quarantined: string }>`
    SELECT count(*) FILTER (WHERE published_at IS NOT NULL AND last_outcome_code = 'delivered') AS n,
           count(*) FILTER (WHERE quarantined_at IS NOT NULL) AS quarantined
    FROM outbox_event WHERE id = ANY(${sql.val(ids)}::uuid[])`.execute(testDb.db);
  expect(Number(published.rows[0]?.n)).toBe(ids.length);
  expect(Number(published.rows[0]?.quarantined)).toBe(0);
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword },
  });
  const f = await createBookingFixture(testDb.db);
  orgId = f.org.orgId;
  programId = f.programId;
  await sql`UPDATE organization_public_profile SET published = true WHERE organization_id = ${orgId}`.execute(testDb.db);
  await sql`INSERT INTO program_branch (program_id, branch_id, organization_id, active)
            VALUES (${programId}, ${f.org.branchIds[0]}, ${orgId}, true) ON CONFLICT DO NOTHING`.execute(testDb.db);
  await publishProgram(f);
});

afterAll(async () => {
  await testDb.drop();
});

describe('two production worker processes on one database', () => {
  let a: WorkerProcess;
  let b: WorkerProcess;

  afterAll(async () => {
    for (const proc of [a, b]) {
      if (proc !== undefined && proc.child.exitCode === null) {
        proc.child.kill('SIGKILL');
        await proc.exit;
      }
    }
  });

  it('both boot as himma_worker, share the backlog safely, and every event lands exactly once', async () => {
    const ids = await emitBatch(60);
    a = startWorker();
    b = startWorker();
    await waitRunning(a);
    await waitRunning(b);
    const identities = await sql<{ n: string }>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'himma_worker'
        AND datname = ${testDb.config.database.database}`.execute(testDb.db);
    expect(Number(identities.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    await waitDrained();
    await assertExactlyOnce(ids);
    const document = await sql<{ active: boolean }>`
      SELECT active FROM program_search_document WHERE program_id = ${programId}`.execute(testDb.db);
    expect(document.rows[0]?.active).toBe(true);
    for (const proc of [a, b]) {
      const joined = proc.stdout.join('');
      expect(joined).toContain('"role":"worker"');
      expect(joined).toContain('himma worker running');
      expect(joined).not.toContain(workerPassword);
    }
  });

  it('SIGKILL of one replica mid-backlog corrupts nothing — the survivor converges the rest exactly once', async () => {
    const ids = await emitBatch(80);
    await new Promise((resolve) => setTimeout(resolve, 120));
    a.child.kill('SIGKILL');
    await a.exit;
    await waitDrained();
    await assertExactlyOnce(ids);
  });

  it('a restarted replica resumes eligible unfinished and due-retry work', async () => {
    b.child.kill('SIGTERM');
    expect(await b.exit).toBe(0);
    // Work appended while NO worker runs, plus a row whose retry is already due.
    const ids = await emitBatch(15);
    await sql`UPDATE outbox_event SET publish_attempts = 1, next_attempt_at = now() - interval '5 seconds',
              last_outcome_code = 'failed:probe' WHERE id = ${ids[0]}`.execute(testDb.db);
    expect(await unpublishedCount()).toBe(15);
    a = startWorker();
    await waitRunning(a);
    await waitDrained();
    await assertExactlyOnce(ids);
    const retried = await sql<{ attempts: number }>`
      SELECT publish_attempts AS attempts FROM outbox_event WHERE id = ${ids[0]}`.execute(testDb.db);
    expect(retried.rows[0]?.attempts).toBe(2);
  });

  it('SIGTERM shuts the surviving replica down cleanly (exit 0)', async () => {
    a.child.kill('SIGTERM');
    expect(await a.exit).toBe(0);
    expect(a.stdout.join('')).toContain('shutdown signal received');
  });
});

describe('startup refusals (docs/37 §15)', () => {
  it('the API credential under RUNTIME_ROLE=worker refuses startup with a bounded message', async () => {
    const proc = startWorker({ DATABASE_URL: databaseUrlFor('himma_api', apiPassword) });
    expect(await proc.exit).toBe(1);
    const err = proc.stderr.join('');
    expect(err).toContain('startup refused');
    expect(err).toContain('himma_worker');
    expect(err).not.toContain(apiPassword);
  });

  it('a database behind the required migration head refuses startup (the migration job runs first, never the worker)', async () => {
    await sql`INSERT INTO pgmigrations (name, run_on) VALUES ('9999_future_migration', now())`.execute(testDb.db);
    try {
      const proc = startWorker();
      expect(await proc.exit).toBe(1);
      expect(proc.stderr.join('')).toContain('migration head mismatch');
    } finally {
      await sql`DELETE FROM pgmigrations WHERE name = '9999_future_migration'`.execute(testDb.db);
    }
  });
});
