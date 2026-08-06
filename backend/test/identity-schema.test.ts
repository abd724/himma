/**
 * B2-1 identity schema tests: identity uniqueness, no-silent-merge email
 * rules, account/participant invariants, session ownership, structural
 * absence of secret-bearing columns, role grants, and atomic audit/outbox
 * with identity mutations (docs/26 §8, Amendment A1).
 */
import { sql } from 'kysely';

import { appendAuditEvent } from '../src/db/audit';
import { isDbError } from '../src/db/errors';
import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { appendOutboxEvent } from '../src/outbox/outbox';
import {
  createAccount,
  createIdentity,
  createSelfParticipant,
  createSession,
  createUser,
  TEST_ISSUER,
} from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

async function expectDbFailure(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  return caught;
}

describe('auth identity uniqueness (issuer + subject, never email)', () => {
  it('rejects a second identity with the same issuer and subject, even for another user', async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, userA);
    await expectDbFailure(
      createIdentity(testDb.db, userB, {
        issuer: identity.issuer,
        subject: identity.subject,
      }),
    );
  });

  it('allows the same subject under a different issuer (normalized issuer matters)', async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, userA, { subject: 'shared-sub' });
    await createIdentity(testDb.db, userB, {
      issuer: `${TEST_ISSUER}-other`,
      subject: identity.subject,
    });
  });
});

describe('duplicate emails never merge users', () => {
  it('permits the same unverified email on identities of two distinct users', async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    await createIdentity(testDb.db, userA, { email: 'dup@example.test' });
    await createIdentity(testDb.db, userB, { email: 'dup@example.test' });
    const users = await testDb.db
      .selectFrom('app_user')
      .select(sql<string>`count(*)`.as('n'))
      .where('id', 'in', [userA, userB])
      .executeTakeFirstOrThrow();
    expect(Number(users.n)).toBe(2); // both users still exist — nothing merged
  });

  it('rejects a second ACTIVE VERIFIED identity with the same email (case-insensitive), instead of merging', async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    await createIdentity(testDb.db, userA, {
      email: 'Verified@Example.test',
      emailVerified: true,
    });
    await expectDbFailure(
      createIdentity(testDb.db, userB, {
        email: 'verified@example.test',
        emailVerified: true,
      }),
    );
  });

  it('represents Apple private-relay addresses without special-case merging', async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    await createIdentity(testDb.db, userA, {
      provider: 'apple',
      email: 'abc123@privaterelay.appleid.com',
      emailVerified: true,
      isPrivateRelay: true,
    });
    await createIdentity(testDb.db, userB, {
      provider: 'apple',
      email: 'xyz789@privaterelay.appleid.com',
      emailVerified: true,
      isPrivateRelay: true,
    });
    const relays = await testDb.db
      .selectFrom('auth_identity')
      .select(sql<string>`count(*)`.as('n'))
      .where('is_private_relay', '=', true)
      .executeTakeFirstOrThrow();
    expect(Number(relays.n)).toBe(2);
  });
});

describe('customer account and self participant invariants', () => {
  it('allows exactly one customer account per user', async () => {
    const user = await createUser(testDb.db);
    await createAccount(testDb.db, user);
    const caught = await expectDbFailure(createAccount(testDb.db, user));
    expect((caught as { code?: string }).code ?? '').toBe('23505');
  });

  it('allows exactly one self participant per account', async () => {
    const user = await createUser(testDb.db);
    const account = await createAccount(testDb.db, user);
    await createSelfParticipant(testDb.db, account);
    await expectDbFailure(createSelfParticipant(testDb.db, account));
  });

  it('rejects participants for a nonexistent account (ownership FK)', async () => {
    await expectDbFailure(
      testDb.db
        .insertInto('participant')
        .values({ id: newId(), account_id: newId(), kind: 'self', first_name: 'X' })
        .execute(),
    );
  });

  it('structurally prevents child logins: no participant reference exists on auth tables and participants carry no credentials', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('auth_identity', 'login_session', 'participant')
    `.execute(testDb.db);
    const names = columns.rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(names).not.toContain('auth_identity.participant_id');
    expect(names).not.toContain('login_session.participant_id');
    // Participants have no user/login linkage at all — they are never principals.
    expect(names.filter((n) => n.startsWith('participant.'))).toEqual(
      expect.not.arrayContaining(['participant.user_id']),
    );
  });
});

describe('login session ownership and uniqueness', () => {
  it("rejects a session claiming another user's provider identity (composite FK)", async () => {
    const userA = await createUser(testDb.db);
    const userB = await createUser(testDb.db);
    const identityA = await createIdentity(testDb.db, userA);
    const caught = await expectDbFailure(createSession(testDb.db, userB, identityA));
    expect((caught as { code?: string }).code ?? '').toBe('23503');
  });

  it('rejects a session without any provider identity', async () => {
    const user = await createUser(testDb.db);
    await expectDbFailure(
      createSession(testDb.db, user, { issuer: TEST_ISSUER, subject: 'no-such-sub' }),
    );
  });

  it('enforces one LIVE session per origin_jti and frees the key on revocation', async () => {
    const user = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity, 'jti-unique-1');
    await expectDbFailure(createSession(testDb.db, user, identity, 'jti-unique-1'));

    await testDb.db
      .updateTable('login_session')
      .set({ revoked_at: new Date(), revoke_reason: 'logout' })
      .where('id', '=', session.id)
      .execute();
    await createSession(testDb.db, user, identity, 'jti-unique-1');
  });

  it('optimistic-version CAS works on sessions (revoke exactly once)', async () => {
    const user = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, user);
    const session = await createSession(testDb.db, user, identity);
    const first = await testDb.db
      .updateTable('login_session')
      .set({ revoked_at: new Date(), revoke_reason: 'logout' })
      .where('id', '=', session.id)
      .where('version', '=', 1)
      .executeTakeFirst();
    const second = await testDb.db
      .updateTable('login_session')
      .set({ revoke_reason: 'other' })
      .where('id', '=', session.id)
      .where('version', '=', 1)
      .executeTakeFirst();
    expect(first.numUpdatedRows).toBe(1n);
    expect(second.numUpdatedRows).toBe(0n);
  });
});

describe('structural absence of secret-bearing columns (Amendment A1.1)', () => {
  it('no public table carries password/secret/token/totp/recovery/credential columns', async () => {
    const columns = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
    `.execute(testDb.db);
    const offenders = columns.rows.filter((r) =>
      /(password|secret|token|totp|recovery|credential)/i.test(r.column_name),
    );
    expect(offenders).toEqual([]);
  });

  it('no refresh-token table exists', async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `.execute(testDb.db);
    const names = tables.rows.map((r) => r.table_name);
    expect(names.filter((n) => /refresh|token/i.test(n))).toEqual([]);
  });
});

describe('application role permissions on identity tables', () => {
  it('himma_app can read/insert/update identity tables but never delete, and can only read the bootstrap seal', async () => {
    const user = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, user);
    await createSession(testDb.db, user, identity);

    // Allowed: insert + update as the app role.
    await withTransaction(testDb.db, async (trx) => {
      await sql`SET LOCAL ROLE himma_app`.execute(trx);
      const id = newId();
      await trx.insertInto('app_user').values({ id }).execute();
      await trx
        .updateTable('app_user')
        .set({ last_login_at: new Date() })
        .where('id', '=', id)
        .execute();
    });

    // Denied: deletes and bootstrap-seal writes.
    const denied = [
      sql`DELETE FROM app_user`,
      sql`DELETE FROM auth_identity`,
      sql`DELETE FROM login_session`,
      sql`DELETE FROM admin_role_assignment`,
      sql`INSERT INTO bootstrap_seal (manifest_digest, executed_by) VALUES ('x', 'x')`,
    ];
    for (const statement of denied) {
      let caught: unknown;
      try {
        await withTransaction(testDb.db, async (trx) => {
          await sql`SET LOCAL ROLE himma_app`.execute(trx);
          await statement.execute(trx);
        });
      } catch (error) {
        caught = error;
      }
      expect(isDbError(caught, 'insufficientPrivilege')).toBe(true);
    }
  });
});

describe('audit/outbox atomicity with identity mutations', () => {
  it('user creation + audit + outbox commit or roll back as one unit', async () => {
    const before = await testDb.db
      .selectFrom('audit_event')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();

    await expectDbFailure(
      withTransaction(testDb.db, async (trx) => {
        const id = newId();
        await trx.insertInto('app_user').values({ id }).execute();
        await appendAuditEvent(trx, {
          actorType: 'system',
          action: 'auth.user_created',
          entityType: 'app_user',
          entityId: id,
        });
        await appendOutboxEvent(trx, {
          aggregateType: 'app_user',
          aggregateId: id,
          eventType: 'user.created',
          payload: {},
        });
        throw new Error('forced rollback');
      }),
    );
    const afterRollback = await testDb.db
      .selectFrom('audit_event')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(afterRollback.n).toBe(before.n);

    const userId = await withTransaction(testDb.db, async (trx) => {
      const id = newId();
      await trx.insertInto('app_user').values({ id }).execute();
      await appendAuditEvent(trx, {
        actorType: 'system',
        action: 'auth.user_created',
        entityType: 'app_user',
        entityId: id,
      });
      await appendOutboxEvent(trx, {
        aggregateType: 'app_user',
        aggregateId: id,
        eventType: 'user.created',
        payload: {},
      });
      return id;
    });
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type'])
      .where('aggregate_id', '=', userId)
      .execute();
    expect(outbox.map((r) => r.event_type)).toEqual(['user.created']);
  });
});
