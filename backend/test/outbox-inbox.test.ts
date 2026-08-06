/**
 * Outbox/inbox foundation: per-aggregate ordering (including under
 * concurrency), consumer deduplication, and the idempotency-key uniqueness
 * required by the docs/24 slice-1 concurrency tests.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { isDbError, translateDbError } from '../src/db/errors';
import { withTransaction } from '../src/db/transaction';
import { appendOutboxEvent, markInboxProcessed } from '../src/outbox/outbox';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

describe('transactional outbox', () => {
  it('assigns strictly increasing per-aggregate sequence numbers', async () => {
    const results: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const appended = await withTransaction(testDb.db, (trx) =>
        appendOutboxEvent(trx, {
          aggregateType: 'booking',
          aggregateId: 'b-1',
          eventType: 'booking.probe',
          payload: { i },
        }),
      );
      results.push(appended.sequenceNo);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it('keeps sequences independent across aggregates', async () => {
    const a = await withTransaction(testDb.db, (trx) =>
      appendOutboxEvent(trx, {
        aggregateType: 'booking',
        aggregateId: 'b-2',
        eventType: 'booking.probe',
        payload: {},
      }),
    );
    expect(a.sequenceNo).toBe(1);
  });

  it('serializes concurrent appends to one aggregate without gaps or collisions', async () => {
    const CONCURRENCY = 8;
    const appended = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        withTransaction(testDb.db, (trx) =>
          appendOutboxEvent(trx, {
            aggregateType: 'booking',
            aggregateId: 'b-concurrent',
            eventType: 'booking.probe',
            payload: { i },
          }),
        ),
      ),
    );
    const sequences = appended.map((r) => r.sequenceNo).sort((x, y) => x - y);
    expect(sequences).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
  });

  it('rejects duplicate (aggregate, sequence) pairs at the database layer', async () => {
    let caught: unknown;
    try {
      await sql`INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload)
                VALUES (${newId()}, 'booking', 'b-1', 1, 'booking.probe', '{}')`.execute(
        testDb.db,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });
});

describe('consumer inbox deduplication', () => {
  it('returns true on first processing and false on duplicates', async () => {
    const eventId = newId();
    expect(await markInboxProcessed(testDb.db, 'notifications', eventId)).toBe(true);
    expect(await markInboxProcessed(testDb.db, 'notifications', eventId)).toBe(false);
  });

  it('tracks processing per consumer', async () => {
    const eventId = newId();
    expect(await markInboxProcessed(testDb.db, 'consumer-a', eventId)).toBe(true);
    expect(await markInboxProcessed(testDb.db, 'consumer-b', eventId)).toBe(true);
    expect(await markInboxProcessed(testDb.db, 'consumer-a', eventId)).toBe(false);
  });

  it('yields exactly one winner under concurrent duplicate delivery', async () => {
    const eventId = newId();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        markInboxProcessed(testDb.db, 'concurrent-consumer', eventId),
      ),
    );
    expect(results.filter((r) => r).length).toBe(1);
  });
});

describe('idempotency keys (docs/24 §6.6)', () => {
  it('concurrent identical inserts produce exactly one stored key', async () => {
    const values = {
      principal_ref: 'account:a-1',
      endpoint_scope: 'POST /bookings',
      idempotency_key: 'idem-123',
    };
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, async () => {
        try {
          await testDb.db
            .insertInto('idempotency_key')
            .values({ id: newId(), ...values })
            .execute();
          return 'inserted' as const;
        } catch (error) {
          const translated = translateDbError(error);
          return isDbError(translated, 'uniqueViolation')
            ? ('duplicate' as const)
            : ('unexpected' as const);
        }
      }),
    );
    expect(outcomes.filter((o) => o === 'inserted').length).toBe(1);
    expect(outcomes.filter((o) => o === 'unexpected').length).toBe(0);
  });
});
