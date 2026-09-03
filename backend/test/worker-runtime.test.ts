/**
 * W6-2 — the in-process worker runtime on real PostgreSQL (docs/37 §4/§8/
 * §15/§23): fail-closed composition (identity, migration head, role),
 * loop supervision (outbox convergence through the real supervisor, failure
 * isolation, correlation into audit rows), bounded graceful shutdown, and
 * runtime log redaction — plus the `himma_worker` negative privilege
 * boundary re-asserted on its exact connection.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { sql } from 'kysely';
import { Pool } from 'pg';

import { ProductionRuntimeError } from '../src/app/production-runtime';
import type { RuntimeConfig } from '../src/config/runtime';
import { appendAuditEvent } from '../src/db/audit';
import { withTransaction } from '../src/db/transaction';
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import { appendOutboxEvent, markInboxProcessed } from '../src/outbox/outbox';
import type { OutboxHandler } from '../src/worker/outbox-dispatcher';
import { composeWorkerRuntime, createWorkerShutdown } from '../src/worker/worker-runtime';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;
const SECRET = 'w6-worker-secret-DO-NOT-LOG-9f2a';

function workerConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    nodeEnv: 'production',
    database: {
      host: testDb.config.database.host,
      port: testDb.config.database.port,
      database: testDb.config.database.database,
      user: 'himma_worker',
      password: workerPassword,
    },
    role: 'worker',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    shutdownDrainMs: 5_000,
    paymentsMode: 'disabled',
    worker: { outboxPollMs: 100, outboxBatchSize: 50, outboxMaxAttempts: 3, paymentPollMs: 30_000 },
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

async function emitProbe(eventType: string, payload: Record<string, unknown> = {}): Promise<string> {
  return withTransaction(testDb.db, async (trx) => {
    const appended = await appendOutboxEvent(trx, {
      aggregateType: 'probe',
      aggregateId: 'runtime',
      eventType,
      payload,
    });
    return appended.id;
  });
}

const probeHandler: OutboxHandler = {
  consumer: 'w6-runtime-probe',
  matches: (event) => event.aggregateType === 'probe',
  handle: async (db, event) =>
    withTransaction(db, async (trx) => {
      if (event.eventType === 'probe.explode') throw new Error(`boom ${SECRET}`);
      const first = await markInboxProcessed(trx, 'w6-runtime-probe', event.id);
      if (!first) return 'duplicate' as const;
      // The certified audit helper — its ambient correlation seam records the worker RUN id.
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'w6.runtime_effect',
        entityType: 'outbox_event',
        entityId: event.id,
      });
      return 'processed' as const;
    }),
};

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword },
  });
});

afterAll(async () => {
  await testDb.drop();
});

describe('fail-closed composition (docs/37 §15)', () => {
  it('refuses a non-worker role, a mispasted credential, and a database behind the required migration head', async () => {
    await expect(composeWorkerRuntime(workerConfig({ role: 'api' }))).rejects.toThrow(ProductionRuntimeError);
    await expect(
      composeWorkerRuntime(workerConfig({ database: { ...testDb.config.database, user: 'himma_api', password: apiPassword } })),
    ).rejects.toThrow(/himma_worker/);
    await sql`INSERT INTO pgmigrations (name, run_on) VALUES ('9999_future_migration', now())`.execute(testDb.db);
    try {
      await expect(composeWorkerRuntime(workerConfig())).rejects.toThrow(/migration head mismatch/);
    } finally {
      await sql`DELETE FROM pgmigrations WHERE name = '9999_future_migration'`.execute(testDb.db);
    }
  });

  it('composes as himma_worker with the outbox loop; the payment loop is explicitly unavailable without TEST configuration', async () => {
    const { stream, lines } = captured();
    const runtime = await composeWorkerRuntime(workerConfig(), { logDestination: stream });
    try {
      expect(runtime.loops.map((loop) => loop.name)).toEqual(['outbox']);
      expect(runtime.paymentAvailable).toBe(false);
      expect(runtime.requiredMigrationHead).toBe('0022_outbox_delivery_state');
      expect(lines.join('')).toContain('payment processing unavailable');
      const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(runtime.db);
      expect(who.rows[0]?.u).toBe('himma_worker');
    } finally {
      await runtime.pool.end();
    }
  });
});

describe('supervised loops, correlation, redaction, shutdown', () => {
  it('drains the outbox continuously, isolates a poisoned event, carries a run id into audit rows, and never logs secrets', async () => {
    const good = await emitProbe('probe.created', { note: SECRET });
    const bad = await emitProbe('probe.explode', { note: SECRET });
    const { stream, lines } = captured();
    const runtime = await composeWorkerRuntime(
      workerConfig({ worker: { outboxPollMs: 100, outboxBatchSize: 50, outboxMaxAttempts: 2, paymentPollMs: 30_000 } }),
      { handlers: [probeHandler], logDestination: stream },
    );
    runtime.start();
    try {
      await waitFor(async () => {
        const row = await sql<{ published: boolean }>`
          SELECT published_at IS NOT NULL AS published FROM outbox_event WHERE id = ${good}`.execute(testDb.db);
        return row.rows[0]?.published === true;
      });
      const effect = await sql<{ request_id: string | null }>`
        SELECT request_id FROM audit_event WHERE action = 'w6.runtime_effect' AND entity_id = ${good}`.execute(testDb.db);
      expect(effect.rows).toHaveLength(1);
      // Background work carries a RUN id (canonical format) — never a fake HTTP request id.
      expect(effect.rows[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);
      const poisoned = await sql<{ attempts: number; code: string | null; published: boolean }>`
        SELECT publish_attempts AS attempts, last_outcome_code AS code, published_at IS NOT NULL AS published
        FROM outbox_event WHERE id = ${bad}`.execute(testDb.db);
      expect(poisoned.rows[0]?.published).toBe(false);
      expect(poisoned.rows[0]?.attempts).toBeGreaterThanOrEqual(1);
      expect(poisoned.rows[0]?.code).toMatch(/^failed:Error|^quarantined:Error/);
    } finally {
      const controller = createWorkerShutdown(runtime, {
        drainMs: 5_000,
        exit: ((code: number) => {
          throw new Error(`unexpected force exit ${code}`);
        }) as (code: number) => never,
      });
      await controller.shutdown();
    }
    // Graceful shutdown closed the pool; loops stopped claiming.
    await expect(runtime.pool.query('SELECT 1')).rejects.toThrow();
    const joined = lines.join('');
    expect(joined).toContain('"role":"worker"');
    expect(joined).toContain('"loop":"outbox"');
    expect(joined).toMatch(/"runId":"[0-9a-f-]{36}"/);
    // Never-log: payload contents and handler error messages never reach the log.
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain('boom');
  });

  it('the exact himma_worker connection stays non-destructive: no DDL, no maintenance DELETE, no maintenance role', async () => {
    const pool = new Pool({
      host: testDb.config.database.host,
      port: testDb.config.database.port,
      database: testDb.config.database.database,
      user: 'himma_worker',
      password: workerPassword,
    });
    try {
      await expect(pool.query('CREATE TABLE w6_worker_rogue (id int)')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('DELETE FROM outbox_event')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('DELETE FROM rate_limit_window')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SET ROLE himma_maintenance')).rejects.toBeTruthy();
      // The relay bookkeeping columns ARE updatable (0022 column grant); payload is not.
      const inserted = await pool.query(
        `INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload)
         VALUES (gen_random_uuid(), 'w6grant', 'g1', 1, 'w6.grant', '{}'::jsonb) RETURNING id`,
      );
      const id = (inserted.rows[0] as { id: string }).id;
      await pool.query(
        `UPDATE outbox_event SET next_attempt_at = now(), last_outcome_code = 'failed:probe', quarantined_at = NULL WHERE id = $1`,
        [id],
      );
      await expect(pool.query(`UPDATE outbox_event SET payload = '{}' WHERE id = $1`, [id])).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await pool.end();
    }
  });
});
