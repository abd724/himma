/**
 * W6-3 — the bounded MAINTENANCE runtime mode (docs/37 §4/§18/§19/§28):
 * `npm run start:maintenance -- <job>` — the same backend artifact, invoked
 * as a SHORT-LIVED process under its OWN credential (`himma_maintenance_
 * runner`, the sole member of the `himma_maintenance` privilege role).
 *
 * Lifecycle: production config → canonical pool → exact maintenance-runner
 * identity assertion → migration-head compatibility → resolve the
 * ALLOW-LISTED job → execute bounded batches under the job's advisory lock
 * with `job_run` bookkeeping → close pool → exit. Fail-closed on a wrong DB
 * identity, an unknown job, invalid production config, a migration-head
 * mismatch, or missing maintenance authority (PostgreSQL refuses the call).
 *
 * Nothing runs merely because the process starts: exactly one explicitly
 * named job (or the explicit `retention.all` composite) executes per
 * invocation. Destructive authority lives ONLY in the database's bounded
 * SECURITY DEFINER functions (migration 0023) — this module holds no
 * DELETE statement of its own, and the API/worker logins cannot execute
 * those functions.
 *
 * Retention here is ENGINEERING-scoped storage hygiene (docs/37 §18). It is
 * NOT product/customer/legal deletion: no audit, identity, evidence,
 * booking, ledger, payment, attendance, or entitlement rows are touched
 * (those policies are open docs/36 gates SE-05/VE-05 and get their own
 * bounded jobs when ruled).
 */
import { sql } from 'kysely';
import type { Pool } from 'pg';
import pino from 'pino';

import { assertRuntimeDbIdentity, ProductionRuntimeError } from '../app/production-runtime';
import type { RuntimeConfig } from '../config/runtime';
import { createDb, type Db } from '../db/kysely';
import { expectedMigrationHead } from '../db/migrations';
import { createPool } from '../db/pool';
import { rebuildAllSearchDocuments } from '../modules/catalogue/services/search-projection';
import { createAlertEmitter, type AlertEmitter } from '../observability/alerts';
import { buildLoggerOptions } from '../observability/logging';
import {
  runJobExclusively,
  type JobAttemptOutcome,
  type JobRunContext,
  type JobRunResult,
  type SchedulerFailpoint,
} from '../worker/scheduler';
import type { PoolClient } from 'pg';

export class MaintenanceUsageError extends Error {}

export interface MaintenanceArgs {
  /** `repair.unquarantine-outbox --event-id=<uuid>` */
  eventId?: string;
}

export type MaintenanceJobKind = 'retention' | 'repair';

export interface MaintenanceJobDefinition {
  name: string;
  kind: MaintenanceJobKind;
  description: string;
  /** Usage validation BEFORE any lock/bookkeeping (throws MaintenanceUsageError). */
  validate?(args: MaintenanceArgs): void;
  run(runtime: MaintenanceRuntime, context: JobRunContext, args: MaintenanceArgs): Promise<JobRunResult>;
}

export interface MaintenanceRuntime {
  pool: Pool;
  db: Db;
  log: pino.Logger;
  alerts: AlertEmitter;
  config: RuntimeConfig;
  requiredMigrationHead: string;
  /** Set by the signal handler; batch loops stop at their next boundary. */
  stopRequested: () => boolean;
  requestStop: () => void;
  /** TEST-ONLY crash injection; never present in production wiring. */
  failpoint?: (point: SchedulerFailpoint, client: PoolClient) => void;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Bounded retention loop — one database function call per batch (one
// transaction each); stops when a batch comes back short (exhausted), at the
// batch ceiling, or at a stop request. An interruption between batches
// loses nothing; the next invocation resumes from live truth.
// ---------------------------------------------------------------------------

type PruneFunction =
  | 'maintenance_prune_rate_limit_windows'
  | 'maintenance_prune_redemption_lookup_attempts'
  | 'maintenance_prune_idempotency_keys'
  | 'maintenance_prune_published_outbox'
  | 'maintenance_prune_job_runs';

async function pruneInBatches(
  runtime: MaintenanceRuntime,
  context: JobRunContext,
  fn: PruneFunction,
  horizonDays: number,
): Promise<JobRunResult> {
  const { batchSize, maxBatches } = runtime.config.maintenance;
  let batches = 0;
  let deleted = 0;
  let exhausted = false;
  let stoppedEarly = false;
  while (batches < maxBatches) {
    if (batches > 0 && (runtime.stopRequested() || context.isStopping())) {
      stoppedEarly = true;
      break;
    }
    batches += 1;
    const result = await sql<{ n: number }>`
      SELECT ${sql.raw(fn)}(make_interval(days => ${horizonDays}), ${batchSize}) AS n
    `.execute(runtime.db);
    const n = Number(result.rows[0]?.n ?? 0);
    deleted += n;
    runtime.log.info({ job: fn, runId: context.runId, batch: batches, deleted: n }, 'retention batch');
    if (n < batchSize) {
      exhausted = true;
      break;
    }
  }
  return {
    items: deleted,
    facts: { batches, deleted, horizonDays, batchSize, exhausted, stoppedEarly },
  };
}

const RETENTION_JOBS: MaintenanceJobDefinition[] = [
  {
    name: 'retention.rate-limit-windows',
    kind: 'retention',
    description: 'delete superseded rate_limit_window rows older than RETENTION_RATE_LIMIT_WINDOW_DAYS (floor 1 d)',
    run: (runtime, context) =>
      pruneInBatches(runtime, context, 'maintenance_prune_rate_limit_windows', runtime.config.maintenance.retentionDays.rateLimitWindows),
  },
  {
    name: 'retention.redemption-lookup-attempts',
    kind: 'retention',
    description: 'delete redemption_lookup_attempt windows older than RETENTION_REDEMPTION_LOOKUP_DAYS (floor 1 d)',
    run: (runtime, context) =>
      pruneInBatches(
        runtime,
        context,
        'maintenance_prune_redemption_lookup_attempts',
        runtime.config.maintenance.retentionDays.redemptionLookupAttempts,
      ),
  },
  {
    name: 'retention.idempotency-keys',
    kind: 'retention',
    description: 'delete COMPLETED idempotency_key rows older than RETENTION_IDEMPOTENCY_KEY_DAYS (floor 30 d)',
    run: (runtime, context) =>
      pruneInBatches(runtime, context, 'maintenance_prune_idempotency_keys', runtime.config.maintenance.retentionDays.idempotencyKeys),
  },
  {
    name: 'retention.outbox-published',
    kind: 'retention',
    description: 'delete PUBLISHED outbox_event rows (+ their inbox_event dedup rows) older than RETENTION_OUTBOX_PUBLISHED_DAYS (floor 7 d); unpublished/quarantined rows are never touched',
    run: (runtime, context) =>
      pruneInBatches(runtime, context, 'maintenance_prune_published_outbox', runtime.config.maintenance.retentionDays.publishedOutbox),
  },
  {
    name: 'retention.job-runs',
    kind: 'retention',
    description: 'delete FINISHED job_run rows older than RETENTION_JOB_RUN_DAYS (floor 7 d); the latest run of every job is kept',
    run: (runtime, context) =>
      pruneInBatches(runtime, context, 'maintenance_prune_job_runs', runtime.config.maintenance.retentionDays.jobRuns),
  },
];

const REPAIR_JOBS: MaintenanceJobDefinition[] = [
  {
    name: 'repair.rebuild-search',
    kind: 'repair',
    description: 'recompute every program search document from live catalogue truth (rebuildAllSearchDocuments; never scheduled)',
    run: async (runtime) => {
      const summary = await rebuildAllSearchDocuments({ db: runtime.db });
      return { items: summary.refreshed, facts: { refreshed: summary.refreshed } };
    },
  },
  {
    name: 'repair.unquarantine-outbox',
    kind: 'repair',
    description: 'return ONE quarantined outbox row to the claimable set (--event-id=<uuid>) after the cause is fixed',
    validate: (args) => {
      if (args.eventId === undefined || !UUID_PATTERN.test(args.eventId)) {
        throw new MaintenanceUsageError('repair.unquarantine-outbox requires --event-id=<uuid>');
      }
    },
    run: async (runtime, _context, args) => {
      const result = await sql<{ n: number }>`
        SELECT maintenance_unquarantine_outbox(${args.eventId as string}::uuid) AS n
      `.execute(runtime.db);
      const n = Number(result.rows[0]?.n ?? 0);
      return { items: n, facts: { eventId: args.eventId, unquarantined: n } };
    },
  },
];

/** The explicit composite: every engineering-scoped retention job, in order. */
export const RETENTION_ALL = 'retention.all';

/** The complete allow-list — nothing outside it can be invoked. */
export function listMaintenanceJobs(): readonly MaintenanceJobDefinition[] {
  return [...RETENTION_JOBS, ...REPAIR_JOBS];
}

export function resolveMaintenanceJobs(name: string): MaintenanceJobDefinition[] {
  if (name === RETENTION_ALL) return [...RETENTION_JOBS];
  const job = listMaintenanceJobs().find((candidate) => candidate.name === name);
  if (job === undefined) {
    const known = [RETENTION_ALL, ...listMaintenanceJobs().map((candidate) => candidate.name)].join(', ');
    throw new MaintenanceUsageError(`unknown maintenance job "${name}" — allow-listed jobs: ${known}`);
  }
  return [job];
}

async function assertMigrationHead(db: Db, required: string): Promise<void> {
  const head = await sql<{ name: string }>`
    SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1`.execute(db);
  const applied = head.rows[0]?.name;
  if (applied !== required) {
    throw new ProductionRuntimeError(
      `migration head mismatch: this build requires "${required}" but the database is at "${applied ?? 'none'}" — refusing to run maintenance (run the migration job first; docs/37 §27).`,
    );
  }
}

export async function composeMaintenanceRuntime(
  config: RuntimeConfig,
  options: { logDestination?: pino.DestinationStream; failpoint?: MaintenanceRuntime['failpoint'] } = {},
): Promise<MaintenanceRuntime> {
  if (config.role !== 'maintenance') {
    throw new ProductionRuntimeError(
      `composeMaintenanceRuntime serves RUNTIME_ROLE=maintenance only — received "${config.role}".`,
    );
  }
  const loggerOptions = buildLoggerOptions({ role: 'maintenance', level: config.logLevel }) as pino.LoggerOptions;
  const log =
    options.logDestination !== undefined ? pino(loggerOptions, options.logDestination) : pino(loggerOptions);
  const pool = createPool(config);
  const db = createDb(pool);
  const requiredMigrationHead = expectedMigrationHead();
  try {
    await assertRuntimeDbIdentity(db, 'maintenance');
    await assertMigrationHead(db, requiredMigrationHead);
  } catch (error) {
    await pool.end();
    throw error;
  }
  let stop = false;
  const runtime: MaintenanceRuntime = {
    pool,
    db,
    log,
    alerts: createAlertEmitter(log),
    config,
    requiredMigrationHead,
    stopRequested: () => stop,
    requestStop: () => {
      stop = true;
    },
    ...(options.failpoint !== undefined ? { failpoint: options.failpoint } : {}),
  };
  return runtime;
}

export interface MaintenanceInvocationResult {
  outcomes: JobAttemptOutcome[];
  /** 0 = every job ran or was skipped because another invocation held its lock; 1 = a job failed. */
  exitCode: 0 | 1;
}

/**
 * Executes the named job (or the retention composite) — each job under its
 * own advisory lock with `job_run` bookkeeping (`runtime_role = maintenance`).
 * A concurrent invocation of the same job skips (lock held) rather than
 * running twice; that is success, not failure.
 */
export async function runMaintenance(
  runtime: MaintenanceRuntime,
  jobName: string,
  args: MaintenanceArgs = {},
): Promise<MaintenanceInvocationResult> {
  const jobs = resolveMaintenanceJobs(jobName);
  for (const job of jobs) job.validate?.(args);
  const outcomes: JobAttemptOutcome[] = [];
  let exitCode: 0 | 1 = 0;
  for (const job of jobs) {
    if (runtime.stopRequested()) {
      outcomes.push({ job: job.name, outcome: 'stopping' });
      continue;
    }
    const outcome = await runJobExclusively(
      {
        pool: runtime.pool,
        log: runtime.log,
        runtimeRole: 'maintenance',
        alerts: runtime.alerts,
        isStopping: runtime.stopRequested,
        ...(runtime.failpoint !== undefined ? { failpoint: runtime.failpoint } : {}),
      },
      {
        name: job.name,
        intervalMs: 0,
        run: (context) => job.run(runtime, context, args),
      },
      { checkDue: false },
    );
    outcomes.push(outcome);
    if (outcome.outcome === 'failed') exitCode = 1;
    if (outcome.outcome === 'lockHeld') {
      runtime.log.warn({ job: job.name }, 'another maintenance invocation holds this job — skipped');
    }
  }
  return { outcomes, exitCode };
}
