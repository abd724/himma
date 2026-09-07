/**
 * W6-3 — the multi-instance-safe scheduler tick (docs/37 §20/§25/§26;
 * docs/36 OP-01/OP-07).
 *
 * A job is a NAME + a CADENCE + a call into an already-certified idempotent
 * service. The scheduler decides only WHEN an existing operation runs; it
 * never becomes new authority (docs/37 §5).
 *
 * One job attempt (`runJobExclusively`):
 *   1. DUE?   — from `job_run.started_at` on the DATABASE clock: due when no
 *              run exists or `now() - started_at >= interval`. Wall-clock
 *              seconds of the process never matter; a delayed, duplicated, or
 *              missed tick simply re-evaluates.
 *   2. LOCK   — `pg_try_advisory_lock(hashtextextended('w6:job:<name>', 42))`
 *              on a DEDICATED session (a pool client held for the attempt).
 *              Not acquired = another replica is running it = skip, and that
 *              is success, not failure. The lock dies with the session: a
 *              crashed holder leaves nothing to repair.
 *   3. RE-CHECK due-ness UNDER the lock (a rival may have just finished),
 *              then mark any `running` row of this job `abandoned` — under the
 *              lock nobody else can be running it, so such a row can only be
 *              a dead process's.
 *   4. RECORD  a `running` row (committed BEFORE the service runs — a crash
 *              anywhere later is visible, never silent).
 *   5. RUN     the service inside the background OPERATION context (run id →
 *              structured logs ONLY; `audit_event.request_id` stays NULL for
 *              background work — the W6-2 owner invariant).
 *   6. RECORD  the outcome (succeeded/failed + bounded code + items + facts +
 *              duration). If THIS step is what fails, the row stays `running`
 *              and step 3 of the next holder marks it abandoned; the service's
 *              committed effects are idempotent by certification, so a re-run
 *              is harmless.
 *   7. UNLOCK  and return the client (destroyed, never returned, if the unlock
 *              itself fails — a session must never re-enter the pool holding
 *              a lock).
 *
 * Failure isolation: each job's attempt is independent; one failing job
 * never blocks another. Alerting (docs/37 §26): consecutive failures ≥ N
 * and "no successful run within M× interval" raise deduplicated operational
 * alerts through the generic seam.
 */
import type { Pool, PoolClient } from 'pg';
import type pino from 'pino';

import { newId } from '../db/ids';
import type { AlertEmitter } from '../observability/alerts';
import { newCorrelationId, runWithOperationContext } from '../observability/request-context';
import { failureCode } from './outbox-dispatcher';

export type JobFacts = Record<string, unknown>;

export interface JobRunResult {
  /** Bounded count of items the pass acted on (examined/expired/deleted…). */
  items: number;
  /** Bounded machine facts persisted with the run (never payloads/secrets). */
  facts?: JobFacts;
}

export interface JobRunContext {
  runId: string;
  /** Facts of the most recent SUCCESSFUL run of this job (durable, cross-replica). */
  previousFacts: JobFacts | undefined;
  /** True once shutdown began — long passes should stop at their next safe boundary. */
  isStopping: () => boolean;
}

export interface ScheduledJobSpec {
  /** Bounded name (`^[a-z][a-z0-9.-]*$`, ≤ 64) — also the advisory-lock key. */
  name: string;
  /** Cadence (engineering policy; docs/37 §13). */
  intervalMs: number;
  run(context: JobRunContext): Promise<JobRunResult>;
}

export type SchedulerFailpoint = 'afterLockBeforeRun' | 'afterRunBeforeBookkeeping';

/**
 * TEST-ONLY: thrown by a failpoint to emulate the process dying at that
 * point. The failpoint MUST destroy the client (`client.release(true)`)
 * before throwing — the session and its advisory lock are then gone, as
 * after a real crash.
 */
export class SimulatedProcessDeath extends Error {}

export interface JobExecutionDeps {
  pool: Pool;
  log: pino.Logger;
  runtimeRole: 'worker' | 'maintenance';
  alerts: AlertEmitter;
  isStopping?: () => boolean;
  /** TEST-ONLY crash injection; never present in production wiring. */
  failpoint?: (point: SchedulerFailpoint, client: PoolClient) => void;
  /** Consecutive failed runs that raise the failing-job alert (default 3). */
  failureAlertThreshold?: number;
  /** Missed-run alert when no success within this many intervals (default 3). */
  missedRunMultiplier?: number;
}

export type JobAttemptOutcome =
  | { job: string; outcome: 'ran'; runId: string; items: number; durationMs: number }
  | { job: string; outcome: 'failed'; runId: string; errorCode: string; durationMs: number }
  | { job: string; outcome: 'lockHeld' }
  | { job: string; outcome: 'notDue' }
  | { job: string; outcome: 'stopping' }
  | { job: string; outcome: 'died'; runId: string };

const JOB_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

export function lockKeyFor(jobName: string): string {
  return `w6:job:${jobName}`;
}

interface DueRow {
  latest_outcome: string | null;
  due: boolean | null;
}

async function isDue(client: PoolClient, jobName: string, intervalMs: number): Promise<boolean> {
  const result = await client.query<DueRow>(
    `SELECT outcome AS latest_outcome,
            (now() - started_at) >= make_interval(secs => $2) AS due
     FROM job_run WHERE job_name = $1
     ORDER BY started_at DESC LIMIT 1`,
    [jobName, intervalMs / 1_000],
  );
  const row = result.rows[0];
  if (row === undefined) return true;
  return row.due === true;
}

/** Facts of the latest succeeded run (for cross-replica state such as alert keys). */
async function previousFactsOf(client: PoolClient, jobName: string): Promise<JobFacts | undefined> {
  const result = await client.query<{ facts: JobFacts }>(
    `SELECT facts FROM job_run WHERE job_name = $1 AND outcome = 'succeeded'
     ORDER BY started_at DESC LIMIT 1`,
    [jobName],
  );
  return result.rows[0]?.facts;
}

async function consecutiveFailures(client: PoolClient, jobName: string, upTo: number): Promise<number> {
  const result = await client.query<{ outcome: string }>(
    `SELECT outcome FROM job_run WHERE job_name = $1 AND outcome <> 'running'
     ORDER BY started_at DESC LIMIT $2`,
    [jobName, upTo],
  );
  let count = 0;
  for (const row of result.rows) {
    if (row.outcome !== 'failed') break;
    count += 1;
  }
  return count;
}

/**
 * One exclusive attempt of one job. `dueIntervalMs` undefined = explicit
 * invocation (maintenance): run whenever the lock is free.
 */
export async function runJobExclusively(
  deps: JobExecutionDeps,
  job: ScheduledJobSpec,
  options: { checkDue: boolean } = { checkDue: true },
): Promise<JobAttemptOutcome> {
  if (!JOB_NAME_PATTERN.test(job.name)) {
    throw new Error(`invalid scheduled job name "${job.name}"`);
  }
  if (deps.isStopping?.() === true) return { job: job.name, outcome: 'stopping' };

  const client = await deps.pool.connect();
  // True once the client left our hands (released, or destroyed by a
  // simulated process death) — the finally block must then touch nothing.
  let clientDestroyed = false;
  let locked = false;
  try {
    if (options.checkDue && !(await isDue(client, job.name, job.intervalMs))) {
      client.release();
      clientDestroyed = true;
      return { job: job.name, outcome: 'notDue' };
    }
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 42)) AS acquired`,
      [lockKeyFor(job.name)],
    );
    locked = lock.rows[0]?.acquired === true;
    if (!locked) {
      client.release();
      clientDestroyed = true;
      deps.log.debug({ job: job.name }, 'scheduler lock held by another instance — skipped');
      return { job: job.name, outcome: 'lockHeld' };
    }
    // Under the lock: re-check (a rival may have just run), then any
    // `running` row can only belong to a dead process.
    if (options.checkDue && !(await isDue(client, job.name, job.intervalMs))) {
      return { job: job.name, outcome: 'notDue' };
    }
    const abandoned = await client.query(
      `UPDATE job_run
       SET outcome = 'abandoned', finished_at = now(), error_code = 'processDied',
           duration_ms = LEAST(2147483647, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint)::integer
       WHERE job_name = $1 AND outcome = 'running'`,
      [job.name],
    );
    if ((abandoned.rowCount ?? 0) > 0) {
      deps.log.warn({ job: job.name, abandonedRuns: abandoned.rowCount }, 'abandoned run(s) of a dead process recorded');
    }

    const runId = newCorrelationId();
    const rowId = newId();
    await client.query(
      `INSERT INTO job_run (id, job_name, runtime_role, run_id, outcome)
       VALUES ($1, $2, $3, $4, 'running')`,
      [rowId, job.name, deps.runtimeRole, runId],
    );
    const previousFacts = await previousFactsOf(client, job.name);
    deps.failpoint?.('afterLockBeforeRun', client);

    const startedAt = Date.now();
    let result: JobRunResult | undefined;
    let failure: unknown;
    try {
      result = await runWithOperationContext({ runId, operation: job.name }, () =>
        job.run({ runId, previousFacts, isStopping: () => deps.isStopping?.() === true }),
      );
    } catch (error) {
      failure = error;
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    deps.failpoint?.('afterRunBeforeBookkeeping', client);

    if (failure === undefined && result !== undefined) {
      await client.query(
        `UPDATE job_run
         SET outcome = 'succeeded', finished_at = now(), items = $2, facts = $3::jsonb, duration_ms = $4
         WHERE id = $1`,
        [rowId, Math.max(0, Math.trunc(result.items)), JSON.stringify(result.facts ?? {}), durationMs],
      );
      deps.log.info(
        { job: job.name, runId, outcome: 'succeeded', items: result.items, durationMs, lockAcquired: true },
        'scheduled job run',
      );
      deps.alerts.clear(`job.failing:${job.name}`);
      return { job: job.name, outcome: 'ran', runId, items: result.items, durationMs };
    }
    const errorCode = failureCode(failure);
    await client.query(
      `UPDATE job_run
       SET outcome = 'failed', finished_at = now(), error_code = $2, duration_ms = $3
       WHERE id = $1`,
      [rowId, errorCode, durationMs],
    );
    deps.log.error(
      { job: job.name, runId, outcome: 'failed', errorCode, durationMs, lockAcquired: true },
      'scheduled job run failed',
    );
    const threshold = deps.failureAlertThreshold ?? 3;
    const failures = await consecutiveFailures(client, job.name, threshold);
    if (failures >= threshold) {
      deps.alerts.raise({
        key: `job.failing:${job.name}`,
        severity: 'critical',
        code: 'scheduledJobFailingConsecutively',
        facts: { job: job.name, consecutiveFailures: failures, errorCode },
      });
    }
    return { job: job.name, outcome: 'failed', runId, errorCode, durationMs };
  } catch (error) {
    if (error instanceof SimulatedProcessDeath) {
      // The emulated dead process: the failpoint destroyed the session (and
      // with it the advisory lock); nothing else is attempted — exactly what
      // a real crash leaves behind.
      clientDestroyed = true;
      return { job: job.name, outcome: 'died', runId: '' };
    }
    deps.log.error({ job: job.name, errorCode: failureCode(error) }, 'scheduler attempt failed');
    throw error;
  } finally {
    if (!clientDestroyed) {
      if (locked) {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 42))`, [lockKeyFor(job.name)]);
          client.release();
        } catch {
          // Never return a session to the pool while it might still hold the lock.
          client.release(true);
        }
      } else {
        client.release();
      }
      clientDestroyed = true;
    }
  }
}

export interface SchedulerTickSummary {
  outcomes: JobAttemptOutcome[];
  missedRunAlerts: string[];
}

interface MissedRow {
  has_runs: boolean;
  missed: boolean | null;
}

/**
 * Missed-run detection (docs/37 §26): a job with run history but no
 * successful run within `multiplier × interval` — e.g. a hung lock holder
 * suppressing every replica — raises a deduplicated alert; a later success
 * clears it.
 */
async function checkMissedRun(
  deps: JobExecutionDeps,
  job: ScheduledJobSpec,
): Promise<'missed' | 'ok'> {
  const multiplier = deps.missedRunMultiplier ?? 3;
  const windowSeconds = (job.intervalMs * multiplier) / 1_000;
  const result = await deps.pool.query<MissedRow>(
    `SELECT EXISTS (SELECT 1 FROM job_run WHERE job_name = $1) AS has_runs,
            CASE
              WHEN (SELECT max(started_at) FROM job_run WHERE job_name = $1 AND outcome = 'succeeded') IS NULL
                THEN (now() - (SELECT min(started_at) FROM job_run WHERE job_name = $1)) >= make_interval(secs => $2)
              ELSE (now() - (SELECT max(started_at) FROM job_run WHERE job_name = $1 AND outcome = 'succeeded'))
                     >= make_interval(secs => $2)
            END AS missed`,
    [job.name, windowSeconds],
  );
  const row = result.rows[0];
  const key = `job.missed:${job.name}`;
  if (row?.has_runs === true && row.missed === true) {
    deps.alerts.raise({
      key,
      severity: 'critical',
      code: 'scheduledJobMissed',
      facts: { job: job.name, intervalMs: job.intervalMs, multiplier },
    });
    return 'missed';
  }
  deps.alerts.clear(key);
  return 'ok';
}

/** One scheduler tick: attempt every job independently, then missed-run checks. */
export async function runSchedulerTick(
  deps: JobExecutionDeps,
  jobs: readonly ScheduledJobSpec[],
): Promise<SchedulerTickSummary> {
  const outcomes: JobAttemptOutcome[] = [];
  const missedRunAlerts: string[] = [];
  for (const job of jobs) {
    if (deps.isStopping?.() === true) {
      outcomes.push({ job: job.name, outcome: 'stopping' });
      continue;
    }
    try {
      outcomes.push(await runJobExclusively(deps, job));
    } catch (error) {
      // A transient PostgreSQL failure on the bookkeeping connection: the
      // job is retried on a later tick; unrelated jobs continue below.
      outcomes.push({ job: job.name, outcome: 'failed', runId: '', errorCode: failureCode(error), durationMs: 0 });
    }
  }
  for (const job of jobs) {
    if (deps.isStopping?.() === true) break;
    try {
      if ((await checkMissedRun(deps, job)) === 'missed') missedRunAlerts.push(job.name);
    } catch (error) {
      deps.log.warn({ job: job.name, errorCode: failureCode(error) }, 'missed-run check unavailable');
    }
  }
  return { outcomes, missedRunAlerts };
}
