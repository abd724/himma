/**
 * Transaction helper: complete rollback on failure and typed error
 * translation at the database boundary.
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../src/db/audit';
import { isDbError } from '../src/db/errors';
import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { appendOutboxEvent } from '../src/outbox/outbox';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function auditCount(): Promise<number> {
  const r = await testDb.db
    .selectFrom('audit_event')
    .select(sql<string>`count(*)`.as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

async function outboxCount(): Promise<number> {
  const r = await testDb.db
    .selectFrom('outbox_event')
    .select(sql<string>`count(*)`.as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

describe('withTransaction', () => {
  it('rolls back ALL writes when the callback throws after several inserts', async () => {
    const auditBefore = await auditCount();
    const outboxBefore = await outboxCount();

    await expect(
      withTransaction(testDb.db, async (trx) => {
        await appendAuditEvent(trx, {
          actorType: 'system',
          action: 'probe.step1',
          entityType: 'probe',
          entityId: 'p1',
        });
        await appendOutboxEvent(trx, {
          aggregateType: 'probe',
          aggregateId: 'p1',
          eventType: 'probe.created',
          payload: { step: 1 },
        });
        throw new Error('forced failure after writes');
      }),
    ).rejects.toThrow('forced failure after writes');

    expect(await auditCount()).toBe(auditBefore);
    expect(await outboxCount()).toBe(outboxBefore);
  });

  it('commits and returns the callback value on success', async () => {
    const auditBefore = await auditCount();
    const value = await withTransaction(testDb.db, async (trx) => {
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'probe.commit',
        entityType: 'probe',
        entityId: 'p2',
      });
      return 42;
    });
    expect(value).toBe(42);
    expect(await auditCount()).toBe(auditBefore + 1);
  });

  it('translates constraint violations into typed DbError values', async () => {
    const id = newId();
    await testDb.db
      .insertInto('inbox_event')
      .values({ consumer: 'c1', event_id: id })
      .execute();
    let caught: unknown;
    try {
      await withTransaction(testDb.db, async (trx) => {
        await trx.insertInto('inbox_event').values({ consumer: 'c1', event_id: id }).execute();
      });
    } catch (error) {
      caught = error;
    }
    expect(isDbError(caught, 'uniqueViolation')).toBe(true);
  });

  it('rolls back on a mid-transaction constraint violation (partial work discarded)', async () => {
    const auditBefore = await auditCount();
    const id = newId();
    await testDb.db
      .insertInto('inbox_event')
      .values({ consumer: 'c2', event_id: id })
      .execute();
    await expect(
      withTransaction(testDb.db, async (trx) => {
        await appendAuditEvent(trx, {
          actorType: 'system',
          action: 'probe.partial',
          entityType: 'probe',
          entityId: 'p3',
        });
        // Violates pk_inbox_event → whole transaction rolls back.
        await trx.insertInto('inbox_event').values({ consumer: 'c2', event_id: id }).execute();
      }),
    ).rejects.toThrow();
    expect(await auditCount()).toBe(auditBefore);
  });
});
