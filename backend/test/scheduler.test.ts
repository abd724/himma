/**
 * W6-3 — the scheduler tick on real PostgreSQL under the EXACT worker login
 * (docs/37 §20/§26/§38): due-ness on the database clock, advisory-lock
 * exclusion across two instances, crash injection at both boundaries
 * (lock acquired → death before the service; service done → death before
 * bookkeeping), failure isolation with bounded codes, consecutive-failure
 * and missed-run alerts with dedup/all-clear, duplicate-tick convergence,
 * stop semantics, and the correlation invariant (`audit_event.request_id`
 * stays NULL for background work; the run id reaches logs only).
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { sql } from 'kysely';
import { Client, Pool } from 'pg';
import pino from 'pino';

import { appendAuditEvent } from '../src/db/audit';
import { clientOptionsFor } from '../src/db/connection-options';
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import { createAlertEmitter } from '../src/observability/alerts';
import { buildLoggerOptions } from '../src/observability/logging';
import {
  lockKeyFor,
  runJobExclusively,
  runSchedulerTick,
  SimulatedProcessDeath,
  type JobExecutionDeps,
  type ScheduledJobSpec,
} from '../src/worker/scheduler';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

const SECRET = 'w63-scheduler-secret-DO-NOT-LOG-77aa';

let testDb: TestDb;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;
let workerPool: Pool;
let secondPool: Pool;
let lines: string[];
let log: pino.Logger;

function workerPoolFor(): Pool {
  return new Pool({
    host: testDb.config.database.host,
    port: testDb.config.database.port,
    database: testDb.config.database.database,
    user: 'himma_worker',
    password: workerPassword,
    options: '-c TimeZone=UTC',
    max: 4,
  });
}

function captured(): { stream: Writable; lines: string[] } {
  const out: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      out.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, lines: out };
}

function depsFor(pool: Pool, extra: Partial<JobExecutionDeps> = {}): JobExecutionDeps {
  return {
    pool,
    log,
    runtimeRole: 'worker',
    alerts: createAlertEmitter(log, { suppressMs: 60_000 }),
    ...extra,
  };
}

const counts = new Map<string, number>();
function bump(name: string): number {
  const next = (counts.get(name) ?? 0) + 1;
  counts.set(name, next);
  return next;
}

function probe(name: string, intervalMs: number, body?: () => Promise<void>): ScheduledJobSpec {
  return {
    name,
    intervalMs,
    run: async () => {
      const n = bump(name);
      if (body !== undefined) await body();
      return { items: n, facts: { n } };
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runsOf(job: string): Promise<Array<{ outcome: string; error_code: string | null; runtime_role: string; items: number; run_id: string }>> {
  const rows = await sql<{ outcome: string; error_code: string | null; runtime_role: string; items: number; run_id: string }>`
    SELECT outcome, error_code, runtime_role, items, run_id FROM job_run WHERE job_name = ${job} ORDER BY started_at, id
  `.execute(testDb.db);
  return rows.rows;
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword },
  });
  workerPool = workerPoolFor();
  secondPool = workerPoolFor();
  const cap = captured();
  lines = cap.lines;
  log = pino(buildLoggerOptions({ role: 'worker', level: 'debug' }) as pino.LoggerOptions, cap.stream);
});

afterAll(async () => {
  await workerPool.end();
  await secondPool.end();
  await testDb.drop();
});

describe('due-ness on the database clock', () => {
  it('first tick runs every job once as himma_worker; an immediate re-tick is not due; after the interval it runs again', async () => {
    const jobs = [probe('probe.a', 400), probe('probe.b', 400)];
    const first = await runSchedulerTick(depsFor(workerPool), jobs);
    expect(first.outcomes.map((o) => o.outcome)).toEqual(['ran', 'ran']);
    const second = await runSchedulerTick(depsFor(workerPool), jobs);
    expect(second.outcomes.map((o) => o.outcome)).toEqual(['notDue', 'notDue']);
    await sleep(450);
    const third = await runSchedulerTick(depsFor(workerPool), jobs);
    expect(third.outcomes.map((o) => o.outcome)).toEqual(['ran', 'ran']);
    const rows = await runsOf('probe.a');
    expect(rows.map((r) => r.outcome)).toEqual(['succeeded', 'succeeded']);
    expect(rows.every((r) => r.runtime_role === 'worker')).toBe(true);
    expect(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.run_id))).toBe(true);
    expect(rows.map((r) => r.items)).toEqual([1, 2]);
    const detail = await sql<{ facts: { n: number }; duration_ms: number | null; finished: boolean }>`
      SELECT facts, duration_ms, finished_at IS NOT NULL AS finished FROM job_run WHERE job_name = 'probe.a' ORDER BY started_at DESC LIMIT 1
    `.execute(testDb.db);
    expect(detail.rows[0]?.facts).toEqual({ n: 2 });
    expect(detail.rows[0]?.duration_ms).not.toBeNull();
    expect(detail.rows[0]?.finished).toBe(true);
  });

  it('the run id reaches structured logs only — an audit row written by a job has request_id NULL', async () => {
    const job: ScheduledJobSpec = {
      name: 'probe.audit',
      intervalMs: 60_000,
      run: async () => {
        await appendAuditEvent(testDb.db, {
          actorType: 'system',
          action: 'w63.scheduled_effect',
          entityType: 'job',
          entityId: 'probe.audit',
        });
        return { items: 1 };
      },
    };
    const tick = await runSchedulerTick(depsFor(workerPool), [job]);
    expect(tick.outcomes[0]?.outcome).toBe('ran');
    const audit = await sql<{ request_id: string | null }>`
      SELECT request_id FROM audit_event WHERE action = 'w63.scheduled_effect'`.execute(testDb.db);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.request_id).toBeNull();
    const run = (await runsOf('probe.audit'))[0];
    expect(lines.join('')).toContain(`"runId":"${run?.run_id}"`);
    // The run id is bookkeeping in job_run — never the audit column.
    const leaked = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event WHERE request_id::text = ${run?.run_id ?? ''}`.execute(testDb.db);
    expect(Number(leaked.rows[0]?.n)).toBe(0);
  });
});

describe('distributed exclusion (two instances, two pools)', () => {
  it('two instances waking together: exactly one runs, the other sees the lock held; one job_run row; one effect', async () => {
    const job = probe('probe.race', 60_000, () => sleep(400));
    // Both instances attempt without the due pre-check, so the LOCK alone
    // decides (the pre-check is a cheap optimization, not the exclusion).
    const [a, b] = await Promise.all([
      runJobExclusively(depsFor(workerPool), job, { checkDue: false }),
      runJobExclusively(depsFor(secondPool), job, { checkDue: false }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['lockHeld', 'ran']);
    expect(counts.get('probe.race')).toBe(1);
    expect((await runsOf('probe.race')).map((r) => r.outcome)).toEqual(['succeeded']);
  });

  it('duplicate ticks on one instance converge to one run', async () => {
    const job = probe('probe.dup', 60_000, () => sleep(250));
    const [t1, t2] = await Promise.all([
      runSchedulerTick(depsFor(workerPool), [job]),
      runSchedulerTick(depsFor(workerPool), [job]),
    ]);
    // The loser is excluded either by the lock or by the winner's freshly
    // recorded run (double-walled, docs/37 §20) — never by luck.
    const outcomes = [t1.outcomes[0]?.outcome, t2.outcomes[0]?.outcome].sort();
    expect(outcomes).toContain('ran');
    expect(outcomes.filter((o) => o === 'lockHeld' || o === 'notDue')).toHaveLength(1);
    expect(counts.get('probe.dup')).toBe(1);
    expect((await runsOf('probe.dup')).map((r) => r.outcome)).toEqual(['succeeded']);
  });
});

describe('crash injection (docs/37 §38)', () => {
  it('lock acquired → process dies before the service: nothing executes, the lock evaporates, the orphaned run is abandoned by the next holder which runs clean', async () => {
    const job = probe('probe.die-early', 300);
    const died = await runJobExclusively(
      depsFor(workerPool, {
        failpoint: (point, client) => {
          if (point === 'afterLockBeforeRun') {
            client.release(true); // the session (and its advisory lock) is gone
            throw new SimulatedProcessDeath('die-early');
          }
        },
      }),
      job,
    );
    expect(died.outcome).toBe('died');
    expect(counts.get('probe.die-early')).toBeUndefined();
    expect((await runsOf('probe.die-early')).map((r) => r.outcome)).toEqual(['running']);
    // The lock is free again (nothing to repair).
    const probeClient = new Client(clientOptionsFor(testDb.config.database));
    await probeClient.connect();
    try {
      const free = await probeClient.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 42)) AS ok`,
        [lockKeyFor('probe.die-early')],
      );
      expect(free.rows[0]?.ok).toBe(true);
      await probeClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 42))`, [lockKeyFor('probe.die-early')]);
    } finally {
      await probeClient.end();
    }
    await sleep(350);
    const next = await runSchedulerTick(depsFor(secondPool), [job]);
    expect(next.outcomes[0]?.outcome).toBe('ran');
    const rows = await runsOf('probe.die-early');
    expect(rows.map((r) => [r.outcome, r.error_code])).toEqual([
      ['abandoned', 'processDied'],
      ['succeeded', null],
    ]);
    expect(counts.get('probe.die-early')).toBe(1);
    expect(lines.join('')).toContain('abandoned run(s) of a dead process recorded');
  });

  it('service succeeds → bookkeeping fails (connection lost): the effect committed once, the run is orphaned then abandoned, and the re-run is harmless', async () => {
    const job = probe('probe.die-late', 300);
    const died = await runJobExclusively(
      depsFor(workerPool, {
        failpoint: (point, client) => {
          if (point === 'afterRunBeforeBookkeeping') {
            client.release(true);
            throw new SimulatedProcessDeath('die-late');
          }
        },
      }),
      job,
    );
    expect(died.outcome).toBe('died');
    expect(counts.get('probe.die-late')).toBe(1);
    expect((await runsOf('probe.die-late')).map((r) => r.outcome)).toEqual(['running']);
    await sleep(350);
    const next = await runSchedulerTick(depsFor(workerPool), [job]);
    expect(next.outcomes[0]?.outcome).toBe('ran');
    expect((await runsOf('probe.die-late')).map((r) => r.outcome)).toEqual(['abandoned', 'succeeded']);
    // Idempotent services make the re-run harmless; the probe simply counts it.
    expect(counts.get('probe.die-late')).toBe(2);
  });
});

describe('failure isolation and alerting', () => {
  it('a throwing job is recorded failed with a bounded code (never its message); unrelated jobs progress; three consecutive failures raise ONE alert; a later success clears it', async () => {
    let explode = true;
    const boom: ScheduledJobSpec = {
      name: 'probe.boom',
      intervalMs: 200,
      run: async () => {
        if (explode) throw new Error(`kaboom ${SECRET}`);
        return { items: 0 };
      },
    };
    const fine = probe('probe.fine', 200);
    const deps = depsFor(workerPool);
    for (let i = 0; i < 3; i += 1) {
      const tick = await runSchedulerTick(deps, [boom, fine]);
      expect(tick.outcomes.map((o) => o.outcome)).toEqual(['failed', 'ran']);
      await sleep(230);
    }
    const rows = await runsOf('probe.boom');
    expect(rows.map((r) => r.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(rows.every((r) => r.error_code === 'Error')).toBe(true);
    expect(counts.get('probe.fine')).toBe(3);
    const joined = lines.join('');
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain('kaboom');
    const raised = joined.split('\n').filter((line) => line.includes('"code":"scheduledJobFailingConsecutively"') && line.includes('"alert":"raised"'));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain('"alertKey":"job.failing:probe.boom"');

    explode = false;
    const recovered = await runSchedulerTick(deps, [boom, fine]);
    expect(recovered.outcomes[0]?.outcome).toBe('ran');
    expect(lines.join('')).toContain('"alert":"cleared","alertKey":"job.failing:probe.boom"');
  });

  it('missed-run alert: a hung lock holder suppresses every replica; the alert fires past 3× the interval and clears after a successful run', async () => {
    const job = probe('probe.held', 200);
    const deps = depsFor(workerPool);
    const first = await runSchedulerTick(deps, [job]);
    expect(first.outcomes[0]?.outcome).toBe('ran');
    const holder = new Client(clientOptionsFor(testDb.config.database));
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 42))`, [lockKeyFor('probe.held')]);
      await sleep(700);
      const suppressed = await runSchedulerTick(deps, [job]);
      expect(suppressed.outcomes[0]?.outcome).toBe('lockHeld');
      expect(suppressed.missedRunAlerts).toEqual(['probe.held']);
      expect(lines.join('')).toContain('"code":"scheduledJobMissed"');
      expect(lines.join('')).toContain('"alertKey":"job.missed:probe.held"');
      // Dedup: a second tick under the same condition does not re-raise.
      const again = await runSchedulerTick(deps, [job]);
      expect(again.missedRunAlerts).toEqual(['probe.held']);
      const raised = lines.join('').split('\n').filter((line) => line.includes('"alertKey":"job.missed:probe.held"') && line.includes('"alert":"raised"'));
      expect(raised).toHaveLength(1);
    } finally {
      await holder.end(); // releases the hung lock
    }
    const recovered = await runSchedulerTick(deps, [job]);
    expect(recovered.outcomes[0]?.outcome).toBe('ran');
    expect(recovered.missedRunAlerts).toEqual([]);
    expect(lines.join('')).toContain('"alert":"cleared","alertKey":"job.missed:probe.held"');
  });

  it('a stopping instance starts no new job and records nothing', async () => {
    const job = probe('probe.stop', 60_000);
    const tick = await runSchedulerTick(depsFor(workerPool, { isStopping: () => true }), [job]);
    expect(tick.outcomes[0]?.outcome).toBe('stopping');
    expect(await runsOf('probe.stop')).toEqual([]);
    expect(counts.get('probe.stop')).toBeUndefined();
  });

  it('an invalid job name is refused before touching the database', async () => {
    await expect(runJobExclusively(depsFor(workerPool), probe('Bad Name', 1_000))).rejects.toThrow(/invalid scheduled job name/);
  });
});
