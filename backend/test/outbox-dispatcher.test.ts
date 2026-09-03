/**
 * W6-2 — the transactional-outbox relay on real PostgreSQL (docs/37
 * §10/§21/§22): durable claim/ack, unhandled diagnosability, inbox-backed
 * exactly-once effects under duplicate delivery, server-side backoff and
 * quarantine, failure isolation, crash injection between handler commit
 * and acknowledgement, and two dispatchers racing one queue.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { appendOutboxEvent, markInboxProcessed } from '../src/outbox/outbox';
import {
  dispatchOutboxBatch,
  failureCode,
  type OutboxEventRow,
  type OutboxHandler,
} from '../src/worker/outbox-dispatcher';
import { createRacePool } from './helpers/race-harness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

let testDb: TestDb;
const CONSUMER = 'w6-probe-consumer';

async function emit(aggregateId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<string> {
  return withTransaction(testDb.db, async (trx) => {
    const appended = await appendOutboxEvent(trx, {
      aggregateType: 'probe',
      aggregateId,
      eventType,
      payload,
    });
    return appended.id;
  });
}

/** A certified-shape consumer: inbox dedup + ONE effect (an audit row) per event. */
function probeHandler(options: { failFor?: (event: OutboxEventRow) => Error | undefined } = {}): OutboxHandler {
  return {
    consumer: CONSUMER,
    matches: (event) => event.aggregateType === 'probe' && event.eventType.startsWith('probe.'),
    handle: async (db, event) =>
      withTransaction(db, async (trx) => {
        const failure = options.failFor?.(event);
        if (failure !== undefined) throw failure;
        const first = await markInboxProcessed(trx, CONSUMER, event.id);
        if (!first) return 'duplicate' as const;
        await sql`INSERT INTO audit_event (id, actor_type, action, entity_type, entity_id)
                  VALUES (${newId()}, 'system', 'w6.probe_effect', 'outbox_event', ${event.id})`.execute(trx);
        return 'processed' as const;
      }),
  };
}

async function effects(eventId: string): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM audit_event WHERE action = 'w6.probe_effect' AND entity_id = ${eventId}
  `.execute(testDb.db);
  return Number(rows.rows[0]?.n);
}

async function rowState(eventId: string): Promise<{
  published: boolean;
  attempts: number;
  code: string | null;
  retryDue: boolean | null;
  quarantined: boolean;
}> {
  const rows = await sql<{
    published: boolean;
    attempts: number;
    code: string | null;
    retry_due: boolean | null;
    quarantined: boolean;
  }>`
    SELECT published_at IS NOT NULL AS published, publish_attempts AS attempts,
           last_outcome_code AS code, (next_attempt_at <= now()) AS retry_due,
           quarantined_at IS NOT NULL AS quarantined
    FROM outbox_event WHERE id = ${eventId}`.execute(testDb.db);
  const row = rows.rows[0]!;
  return {
    published: row.published,
    attempts: row.attempts,
    code: row.code,
    retryDue: row.retry_due,
    quarantined: row.quarantined,
  };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe('claim → dispatch → acknowledge', () => {
  it('delivers registered events exactly once and marks them published with a bounded outcome code', async () => {
    const ids = [await emit('a1', 'probe.created'), await emit('a1', 'probe.updated'), await emit('a2', 'probe.created')];
    const summary = await dispatchOutboxBatch(testDb.db, [probeHandler()], { batchSize: 10, maxAttempts: 3 });
    expect(summary).toMatchObject({ claimed: 3, delivered: 3, failed: 0, quarantined: 0, unhandled: 0 });
    for (const id of ids) {
      expect(await rowState(id)).toMatchObject({ published: true, attempts: 1, code: 'delivered', quarantined: false });
      expect(await effects(id)).toBe(1);
    }
    // Nothing left to claim; replaying the dispatcher is a no-op.
    const again = await dispatchOutboxBatch(testDb.db, [probeHandler()], { batchSize: 10, maxAttempts: 3 });
    expect(again.claimed).toBe(0);
  });

  it('an event type with no registered handler is published with a diagnosable code — never silently lost, never spun on', async () => {
    const id = await emit('u1', 'unregistered.kind');
    const summary = await dispatchOutboxBatch(testDb.db, [probeHandler()], { batchSize: 10, maxAttempts: 3 });
    expect(summary.unhandled).toBe(1);
    expect(await rowState(id)).toMatchObject({ published: true, code: 'unhandledEventType' });
    expect(await effects(id)).toBe(0);
  });

  it('duplicate delivery is harmless: a consumer that already recorded the event yields no second effect', async () => {
    const id = await emit('d1', 'probe.created');
    // Simulate a prior delivery whose acknowledgement was lost (inbox row exists, outbox unpublished).
    await markInboxProcessed(testDb.db, CONSUMER, id);
    const summary = await dispatchOutboxBatch(testDb.db, [probeHandler()], { batchSize: 10, maxAttempts: 3 });
    expect(summary).toMatchObject({ delivered: 1, duplicates: 1 });
    expect(await rowState(id)).toMatchObject({ published: true });
    expect(await effects(id)).toBe(0);
  });
});

describe('failures: server-side backoff, isolation, quarantine', () => {
  it('a failing event backs off durably, does not block its neighbours, and is quarantined at the ceiling', async () => {
    const poison = await emit('p1', 'probe.poison');
    const healthy = await emit('p2', 'probe.created');
    const handler = probeHandler({
      failFor: (event) => (event.eventType === 'probe.poison' ? new Error('handler exploded') : undefined),
    });
    const first = await dispatchOutboxBatch(testDb.db, [handler], {
      batchSize: 10,
      maxAttempts: 2,
      backoffSeconds: () => 3_600,
    });
    expect(first).toMatchObject({ claimed: 2, delivered: 1, failed: 1, quarantined: 0 });
    expect(await rowState(healthy)).toMatchObject({ published: true });
    expect(await rowState(poison)).toMatchObject({
      published: false,
      attempts: 1,
      code: 'failed:Error',
      retryDue: false,
      quarantined: false,
    });
    // Not due yet: the next pass leaves it alone (no hot loop).
    const idle = await dispatchOutboxBatch(testDb.db, [handler], { batchSize: 10, maxAttempts: 2 });
    expect(idle.claimed).toBe(0);
    // Make the retry due (server clock authority) → second attempt hits the ceiling → quarantined.
    await sql`UPDATE outbox_event SET next_attempt_at = now() - interval '1 second' WHERE id = ${poison}`.execute(testDb.db);
    const second = await dispatchOutboxBatch(testDb.db, [handler], { batchSize: 10, maxAttempts: 2 });
    expect(second).toMatchObject({ claimed: 1, quarantined: 1 });
    expect(await rowState(poison)).toMatchObject({
      published: false,
      attempts: 2,
      code: 'quarantined:Error',
      quarantined: true,
    });
    // Quarantined rows leave the claimable set for good (explicit operator action only).
    const after = await dispatchOutboxBatch(testDb.db, [handler], { batchSize: 10, maxAttempts: 2 });
    expect(after.claimed).toBe(0);
    expect(await effects(poison)).toBe(0);
  });

  it('failure codes are bounded machine facts, never messages', () => {
    expect(failureCode(new Error('secret-bearing message sk_test_123'))).toBe('Error');
    const coded = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    expect(failureCode(coded)).toBe('ECONNRESET');
    expect(failureCode('weird')).toBe('unknown');
    expect(failureCode(Object.assign(new Error('x'), { code: 'bad code with spaces!' }))).toBe('bad_code_with_spaces_');
  });
});

describe('crash injection and concurrency (docs/37 §38)', () => {
  it('a crash AFTER the handler committed but BEFORE acknowledgement leaves the row claimable and the effect exactly once', async () => {
    const id = await emit('c1', 'probe.created');
    await expect(
      dispatchOutboxBatch(testDb.db, [probeHandler()], {
        batchSize: 10,
        maxAttempts: 3,
        failpoint: () => {
          throw new Error('simulated process death before ack');
        },
      }),
    ).rejects.toThrow(/simulated/);
    // The claim transaction rolled back: attempts untouched, still unpublished — but the effect committed once.
    expect(await rowState(id)).toMatchObject({ published: false, attempts: 0, quarantined: false });
    expect(await effects(id)).toBe(1);
    // Recovery: redelivery is absorbed by the inbox — one effect, then acknowledged.
    const recovered = await dispatchOutboxBatch(testDb.db, [probeHandler()], { batchSize: 10, maxAttempts: 3 });
    expect(recovered).toMatchObject({ claimed: 1, delivered: 1, duplicates: 1 });
    expect(await rowState(id)).toMatchObject({ published: true });
    expect(await effects(id)).toBe(1);
  });

  it('two dispatchers on two pools racing one queue: every event delivered exactly once, no row double-owned', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i += 1) ids.push(await emit(`r${i % 5}`, 'probe.created'));
    const poolA = await createRacePool(testDb.config, 4);
    const poolB = await createRacePool(testDb.config, 4);
    try {
      const drain = async (db: typeof poolA.db) => {
        let claimed = 0;
        for (let pass = 0; pass < 20; pass += 1) {
          const summary = await dispatchOutboxBatch(db, [probeHandler()], { batchSize: 7, maxAttempts: 3 });
          claimed += summary.claimed;
          if (summary.claimed === 0) break;
        }
        return claimed;
      };
      const [claimedA, claimedB] = await Promise.all([drain(poolA.db), drain(poolB.db)]);
      expect(claimedA + claimedB).toBe(40);
    } finally {
      await poolA.destroy();
      await poolB.destroy();
    }
    for (const id of ids) {
      expect(await rowState(id)).toMatchObject({ published: true, attempts: 1 });
      expect(await effects(id)).toBe(1);
    }
    const inbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM inbox_event WHERE consumer = ${CONSUMER} AND event_id = ANY(${sql.val(ids)}::uuid[])
    `.execute(testDb.db);
    expect(Number(inbox.rows[0]?.n)).toBe(40);
  });
});
