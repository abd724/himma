/**
 * W6-2 — the production WORKER runtime on the W6-1 foundations (docs/37
 * §4/§5/§8/§15): config → canonical pool → `himma_worker` identity
 * assertion → migration-head check → handler composition → durable loops
 * → bounded graceful shutdown.
 *
 * One backend artifact, explicit role: this module composes the same
 * certified domain services the API composes — it invokes authority and
 * holds none (docs/37 §5). Loops:
 *   outbox   — the SKIP LOCKED dispatcher (docs/37 §10) with the registered
 *              search-projection handler; continuous with an idle poll;
 *   payment  — the certified W5 passes on cadence (docs/37 §12/§13), only
 *              when a payment provider composes (absent or TEST; the
 *              deterministic provider cannot compose in production and no
 *              LIVE mode exists — docs/37 §33).
 *
 * Fail-closed startup (docs/37 §15): a credential that is not
 * `himma_worker`, or a database whose applied migration head differs from
 * the head this build ships, refuses to start — a worker has no readiness
 * probe to withhold traffic behind, so it must not run at all. Cognito and
 * object storage are NOT worker dependencies and are never composed here.
 *
 * Correlation (docs/37 §23, W6-2 owner correction): every loop pass runs
 * under a fresh run id in the SEPARATE background OPERATION context — it
 * reaches structured log lines (`runId`, `loop`, event ids, counts) and
 * NOTHING else. `audit_event.request_id` is request-origin correlation:
 * audit rows written by the certified services during a pass are NULL
 * there. No HTTP request id is ever manufactured for background work.
 */
import { createServer, type Server } from 'node:http';

import { sql } from 'kysely';
import type { Pool } from 'pg';
import pino from 'pino';

import { assertRuntimeDbIdentity, ProductionRuntimeError } from '../app/production-runtime';
import type { RuntimeConfig } from '../config/runtime';
import { createDb, type Db } from '../db/kysely';
import { expectedMigrationHead } from '../db/migrations';
import { createPool } from '../db/pool';
import { resolvePaymentProvider } from '../modules/payment/provider-composition';
import { buildLoggerOptions } from '../observability/logging';
import { newCorrelationId, runWithOperationContext } from '../observability/request-context';
import { dispatchOutboxBatch, failureCode, type OutboxHandler } from './outbox-dispatcher';
import { runPaymentPass } from './payment-processing';
import { createSearchProjectionHandler } from './search-projection-handler';

export interface WorkerLoopSpec {
  name: string;
  /** Idle wait between passes. A pass that did full-batch work re-runs at once. */
  intervalMs: number;
  /** Returns true when the pass did a full batch and should run again immediately. */
  run: (runId: string) => Promise<boolean>;
}

export interface WorkerRuntime {
  pool: Pool;
  db: Db;
  log: pino.Logger;
  loops: WorkerLoopSpec[];
  /** Present only when a payment provider composed (absent or TEST). */
  paymentAvailable: boolean;
  requiredMigrationHead: string;
  start: () => void;
  /** Stop claiming new work; resolves when in-flight passes settle. */
  stop: () => Promise<void>;
  statusServer?: Server;
}

async function assertMigrationHead(db: Db, required: string): Promise<void> {
  const head = await sql<{ name: string }>`
    SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1`.execute(db);
  const applied = head.rows[0]?.name;
  if (applied !== required) {
    throw new ProductionRuntimeError(
      `migration head mismatch: this build requires "${required}" but the database is at "${applied ?? 'none'}" — refusing to start the worker (run the migration job first; docs/37 §15/§27).`,
    );
  }
}

/**
 * Composes the worker. Handlers are registered explicitly here — the
 * dispatcher never discovers consumers dynamically.
 */
export async function composeWorkerRuntime(
  config: RuntimeConfig,
  options: { handlers?: OutboxHandler[]; logDestination?: pino.DestinationStream } = {},
): Promise<WorkerRuntime> {
  if (config.role !== 'worker') {
    throw new ProductionRuntimeError(
      `composeWorkerRuntime serves RUNTIME_ROLE=worker only — received "${config.role}".`,
    );
  }
  const loggerOptions = buildLoggerOptions({ role: 'worker', level: config.logLevel }) as pino.LoggerOptions;
  const log =
    options.logDestination !== undefined ? pino(loggerOptions, options.logDestination) : pino(loggerOptions);

  const pool = createPool(config);
  const db = createDb(pool);
  const requiredMigrationHead = expectedMigrationHead();
  try {
    await assertRuntimeDbIdentity(db, 'worker');
    await assertMigrationHead(db, requiredMigrationHead);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const handlers = options.handlers ?? [createSearchProjectionHandler()];
  const payment = resolvePaymentProvider(config.nodeEnv, {
    ...(config.stripe !== undefined ? { stripe: config.stripe } : {}),
    paymentsMode: config.paymentsMode,
  });
  if (payment.kind === 'unconfigured') {
    log.warn({ reason: payment.reason }, 'payment processing unavailable — outbox/search loops run; payment loop disabled');
  }

  const loops: WorkerLoopSpec[] = [
    {
      name: 'outbox',
      intervalMs: config.worker.outboxPollMs,
      run: async (runId) => {
        const summary = await dispatchOutboxBatch(db, handlers, {
          batchSize: config.worker.outboxBatchSize,
          maxAttempts: config.worker.outboxMaxAttempts,
        });
        if (summary.claimed > 0) log.info({ loop: 'outbox', runId, ...summary }, 'outbox pass');
        return summary.claimed >= config.worker.outboxBatchSize;
      },
    },
  ];
  if (payment.kind === 'configured') {
    const provider = payment.provider;
    loops.push({
      name: 'payment',
      intervalMs: config.worker.paymentPollMs,
      run: async (runId) => {
        const summary = await runPaymentPass({ db, provider });
        if (summary.examinedPending > 0 || summary.examinedTrusted > 0) {
          log.info({ loop: 'payment', runId, ...summary }, 'payment pass');
        }
        return false;
      },
    });
  }

  const supervisor = createLoopSupervisor(loops, log);
  let statusServer: Server | undefined;
  const runtime: WorkerRuntime = {
    pool,
    db,
    log,
    loops,
    paymentAvailable: payment.kind === 'configured',
    requiredMigrationHead,
    start: () => {
      supervisor.start();
      if (config.worker.statusPort !== undefined) {
        statusServer = createServer((request, response) => {
          if (request.url === '/internal/live') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"status":"ok"}');
            return;
          }
          response.writeHead(404);
          response.end();
        });
        statusServer.listen(config.worker.statusPort, config.host);
        runtime.statusServer = statusServer;
      }
    },
    stop: async () => {
      await supervisor.stop();
      if (statusServer !== undefined) {
        await new Promise<void>((resolve) => statusServer?.close(() => resolve()));
      }
    },
  };
  return runtime;
}

interface LoopSupervisor {
  start: () => void;
  stop: () => Promise<void>;
}

/** Runs each loop as its own resilient async chain; one loop's failure never touches another. */
function createLoopSupervisor(loops: WorkerLoopSpec[], log: pino.Logger): LoopSupervisor {
  let stopping = false;
  const wakers = new Set<() => void>();
  const inFlight: Promise<void>[] = [];

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakers.delete(wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      wakers.add(wake);
    });

  const runLoop = async (spec: WorkerLoopSpec): Promise<void> => {
    while (!stopping) {
      const runId = newCorrelationId();
      let again = false;
      try {
        again = await runWithOperationContext({ runId, operation: spec.name }, () => spec.run(runId));
      } catch (error) {
        log.error({ loop: spec.name, runId, errorCode: failureCode(error) }, 'loop pass failed');
      }
      if (stopping) break;
      if (!again) await sleep(spec.intervalMs);
    }
  };

  return {
    start: () => {
      for (const spec of loops) inFlight.push(runLoop(spec));
    },
    stop: async () => {
      stopping = true;
      for (const wake of [...wakers]) wake();
      await Promise.all(inFlight);
    },
  };
}

export interface WorkerShutdownController {
  shutdown: () => Promise<void>;
  forceExit: () => never;
}

/**
 * Graceful shutdown (docs/37 §8, worker): stop claiming, let the current
 * pass settle (each item is one short transaction; an uncommitted claim
 * releases with the connection), close the pool, exit 0 — or force-exit
 * non-zero past the drain budget.
 */
export function createWorkerShutdown(
  runtime: Pick<WorkerRuntime, 'stop' | 'pool' | 'log'>,
  options: { drainMs: number; exit?: (code: number) => never },
): WorkerShutdownController {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  return {
    shutdown: async () => {
      if (started) return;
      started = true;
      const budget = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), options.drainMs).unref(),
      );
      const settled = runtime.stop().then(() => 'settled' as const);
      const outcome = await Promise.race([settled, budget]);
      if (outcome === 'timeout') {
        runtime.log.error('worker drain exceeded the budget — forcing exit');
        await runtime.pool.end().catch(() => undefined);
        exit(1);
      }
      await runtime.pool.end();
    },
    forceExit: () => exit(1),
  };
}
