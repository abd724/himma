/**
 * Schema convention tests: fils/currency domains, UTC sessions, opaque ids,
 * updated_at + version triggers, CAS semantics, and append-only enforcement
 * including the himma_app role denials (docs/24 §6; slice-1 acceptance).
 */
import { sql } from 'kysely';

import { newId, isId } from '../src/db/ids';
import { isDbError } from '../src/db/errors';
import { withTransaction } from '../src/db/transaction';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  // Scratch table exercising the shared domains and convention triggers
  // without polluting the committed schema.
  await sql`
    CREATE TABLE convention_probe (
      id         uuid PRIMARY KEY,
      amount     money_fils NOT NULL,
      currency   currency_code NOT NULL,
      note       text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version    integer NOT NULL DEFAULT 1
    )`.execute(testDb.db);
  await sql`
    CREATE TRIGGER trg_probe_updated_at BEFORE UPDATE ON convention_probe
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.execute(testDb.db);
  await sql`
    CREATE TRIGGER trg_probe_version BEFORE UPDATE ON convention_probe
      FOR EACH ROW EXECUTE FUNCTION bump_row_version()`.execute(testDb.db);
});

afterAll(async () => {
  await testDb.drop();
});

describe('opaque identifiers', () => {
  it('generates valid, distinct UUIDv7 values', () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(isId(a)).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('UTC timestamp handling', () => {
  it('every pooled session runs in UTC', async () => {
    const result = await sql<{ TimeZone: string }>`SHOW TimeZone`.execute(testDb.db);
    expect(result.rows[0]?.TimeZone).toBe('UTC');
  });
});

describe('money conventions', () => {
  it('rejects negative fils amounts', async () => {
    await expect(
      sql`INSERT INTO convention_probe (id, amount, currency)
          VALUES (${newId()}, -1, 'AED')`.execute(testDb.db),
    ).rejects.toThrow(/ck_money_fils_non_negative/);
  });

  it('rejects non-AED currency at launch', async () => {
    await expect(
      sql`INSERT INTO convention_probe (id, amount, currency)
          VALUES (${newId()}, 100, 'USD')`.execute(testDb.db),
    ).rejects.toThrow(/ck_currency_code_aed_only/);
  });

  it('accepts valid fils + AED', async () => {
    await sql`INSERT INTO convention_probe (id, amount, currency)
              VALUES (${newId()}, 8500, 'AED')`.execute(testDb.db);
  });
});

describe('optimistic-version and updated_at conventions', () => {
  it('version bumps and updated_at refreshes automatically on UPDATE', async () => {
    const id = newId();
    await sql`INSERT INTO convention_probe (id, amount, currency, updated_at)
              VALUES (${id}, 1, 'AED', now() - interval '1 hour')`.execute(testDb.db);
    await sql`UPDATE convention_probe SET note = 'edited' WHERE id = ${id}`.execute(testDb.db);
    const row = await sql<{
      version: number;
      lag_seconds: number;
    }>`SELECT version, EXTRACT(EPOCH FROM (now() - updated_at)) AS lag_seconds
       FROM convention_probe WHERE id = ${id}`.execute(testDb.db);
    expect(row.rows[0]?.version).toBe(2);
    expect(Number(row.rows[0]?.lag_seconds)).toBeLessThan(60);
  });

  it('CAS writes: WHERE version = expected wins once and only once', async () => {
    const id = newId();
    await sql`INSERT INTO convention_probe (id, amount, currency)
              VALUES (${id}, 1, 'AED')`.execute(testDb.db);
    const first = await sql`UPDATE convention_probe SET note = 'a'
                            WHERE id = ${id} AND version = 1`.execute(testDb.db);
    const second = await sql`UPDATE convention_probe SET note = 'b'
                             WHERE id = ${id} AND version = 1`.execute(testDb.db);
    expect(first.numAffectedRows).toBe(1n);
    expect(second.numAffectedRows).toBe(0n);
  });

  it('a trigger prevents version from being silently overwritten by the app', async () => {
    const id = newId();
    await sql`INSERT INTO convention_probe (id, amount, currency)
              VALUES (${id}, 1, 'AED')`.execute(testDb.db);
    // Even an UPDATE that tries to set version explicitly is overridden.
    await sql`UPDATE convention_probe SET note = 'x', version = 99
              WHERE id = ${id}`.execute(testDb.db);
    const row = await sql<{ version: number }>`
      SELECT version FROM convention_probe WHERE id = ${id}`.execute(testDb.db);
    expect(row.rows[0]?.version).toBe(2);
  });
});

describe('append-only enforcement (docs/24 §6.8)', () => {
  it('audit_event rejects UPDATE and DELETE even for the table owner', async () => {
    const id = newId();
    await sql`INSERT INTO audit_event (id, actor_type, action, entity_type, entity_id)
              VALUES (${id}, 'system', 'test.write', 'probe', 'p1')`.execute(testDb.db);
    await expect(
      sql`UPDATE audit_event SET action = 'tampered' WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM audit_event WHERE id = ${id}`.execute(testDb.db),
    ).rejects.toThrow(/append-only/);
  });

  it('the himma_app role cannot UPDATE or DELETE append-only tables', async () => {
    // Each denial aborts its transaction, so probe every grant separately.
    const forbiddenStatements = [
      sql`UPDATE audit_event SET action = 'x'`,
      sql`DELETE FROM audit_event`,
      sql`DELETE FROM outbox_event`,
      sql`DELETE FROM inbox_event`,
      sql`UPDATE outbox_event SET payload = '{}'`, // non-granted column
    ];
    for (const statement of forbiddenStatements) {
      let caught: unknown;
      try {
        await withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await statement.execute(trx);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(
        isDbError(caught, 'insufficientPrivilege') || isDbError(caught, 'raisedException'),
      ).toBe(true);
    }
  });

  it('the himma_app role CAN update outbox publishing bookkeeping columns', async () => {
    const eventId = newId();
    await sql`INSERT INTO outbox_event (id, aggregate_type, aggregate_id, sequence_no, event_type, payload)
              VALUES (${eventId}, 'probe', 'p1', 999, 'probe.created', '{}')`.execute(testDb.db);
    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      await sql`UPDATE outbox_event
                SET published_at = now(), publish_attempts = publish_attempts + 1
                WHERE id = ${eventId}`.execute(trx);
    });
    const row = await sql<{ published: boolean }>`
      SELECT published_at IS NOT NULL AS published FROM outbox_event WHERE id = ${eventId}
    `.execute(testDb.db);
    expect(row.rows[0]?.published).toBe(true);
  });
});
