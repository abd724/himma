/**
 * B2-1 correction — finance-role approver qualifications (owner directive
 * 2026-08-06, guarantee 2): activating any finance-capable role requires
 * distinct requesting and approving users who BOTH hold currently active,
 * unexpired access_admin assignments, enforced in PostgreSQL under
 * concurrency, with the docs/26 §7.5/§9.9 bootstrap preserved and no
 * bypass for finance-capable grants.
 *
 * Test order matters: the negative bootstrap cases run before the fixture
 * bootstrap because the seal is a permanent singleton per database.
 */
import { sql } from 'kysely';
import { Client } from 'pg';

import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
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

function expectRaised(caught: unknown, pattern: RegExp): void {
  expect((caught as { code?: string }).code).toBe('P0001');
  expect(String((caught as { message?: string }).message)).toMatch(pattern);
}

async function insertActiveAssignment(options: {
  userId: string;
  role: 'operations' | 'support' | 'finance' | 'access_admin' | 'auditor';
  requestedBy: string;
  approvedBy?: string;
  expiresAt?: Date;
}): Promise<string> {
  const id = newId();
  await testDb.db
    .insertInto('admin_role_assignment')
    .values({
      id,
      user_id: options.userId,
      role: options.role,
      state: 'active',
      requested_by: options.requestedBy,
      approved_by: options.approvedBy ?? null,
      expires_at: options.expiresAt ?? null,
    })
    .execute();
  return id;
}

// Established by the "bootstrap transaction succeeds" test below and reused
// by every later test as the two qualified Access Administrators.
let adminA: string;
let adminB: string;

describe('bootstrap model (docs/26 §7.5, §9.9) — preserved without a bypass', () => {
  it('a cross-witnessed access_admin pair WITHOUT the seal transaction is rejected', async () => {
    const u1 = await createUser(testDb.db);
    const u2 = await createUser(testDb.db);
    const caught = await expectDbFailure(
      withTransaction(testDb.db, (trx) =>
        trx
          .insertInto('admin_role_assignment')
          .values([
            {
              id: newId(),
              user_id: u1,
              role: 'access_admin',
              state: 'active',
              requested_by: u2,
              approved_by: u1,
            },
            {
              id: newId(),
              user_id: u2,
              role: 'access_admin',
              state: 'active',
              requested_by: u1,
              approved_by: u2,
            },
          ])
          .execute(),
      ),
    );
    expectRaised(caught, /access_admin/);
    const rows = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(rows.n)).toBe(0);
  });

  it('the bootstrap transaction cannot create a finance role', async () => {
    const u1 = await createUser(testDb.db);
    const u2 = await createUser(testDb.db);
    const caught = await expectDbFailure(
      withTransaction(testDb.db, async (trx) => {
        await sql`INSERT INTO bootstrap_seal (manifest_digest, executed_by)
                  VALUES ('rogue-digest', 'rogue')`.execute(trx);
        await trx
          .insertInto('admin_role_assignment')
          .values([
            {
              id: newId(),
              user_id: u1,
              role: 'finance',
              state: 'active',
              requested_by: u2,
              approved_by: u1,
            },
            {
              id: newId(),
              user_id: u2,
              role: 'finance',
              state: 'active',
              requested_by: u1,
              approved_by: u2,
            },
          ])
          .execute();
      }),
    );
    expectRaised(caught, /access_admin/);
    // The failed attempt consumed nothing: no seal, no assignments.
    const seal = await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(
      testDb.db,
    );
    expect(Number(seal.rows[0]?.n)).toBe(0);
  });

  it('the approved bootstrap shape (seal + two cross-witnessed access_admins, one transaction) succeeds', async () => {
    const admins = await bootstrapAccessAdmins(testDb.db);
    adminA = admins.adminA;
    adminB = admins.adminB;
    const active = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['user_id', 'role', 'state'])
      .where('state', '=', 'active')
      .execute();
    expect(active).toHaveLength(2);
    expect(active.every((r) => r.role === 'access_admin')).toBe(true);
  });
});

describe('finance-capable activation requires two qualified Access Administrators', () => {
  it('activates with two valid, distinct active access_admins', async () => {
    const target = await createUser(testDb.db);
    await insertActiveAssignment({
      userId: target,
      role: 'finance',
      requestedBy: adminA,
      approvedBy: adminB,
    });
    const row = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state'])
      .where('user_id', '=', target)
      .where('role', '=', 'finance')
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('active');
  });

  it('rejects a requester who is not an Access Administrator', async () => {
    const target = await createUser(testDb.db);
    const outsider = await createUser(testDb.db);
    const caught = await expectDbFailure(
      insertActiveAssignment({
        userId: target,
        role: 'finance',
        requestedBy: outsider,
        approvedBy: adminB,
      }),
    );
    expectRaised(caught, /request/i);
  });

  it('rejects an approver who is not an Access Administrator', async () => {
    const target = await createUser(testDb.db);
    const outsider = await createUser(testDb.db);
    const caught = await expectDbFailure(
      insertActiveAssignment({
        userId: target,
        role: 'finance',
        requestedBy: adminA,
        approvedBy: outsider,
      }),
    );
    expectRaised(caught, /approv/i);
  });

  it('a merely requested or denied access_admin assignment does not qualify', async () => {
    const target = await createUser(testDb.db);
    for (const state of ['requested', 'denied'] as const) {
      const pretender = await createUser(testDb.db);
      await testDb.db
        .insertInto('admin_role_assignment')
        .values({
          id: newId(),
          user_id: pretender,
          role: 'access_admin',
          state,
          requested_by: adminA,
          ...(state === 'denied' ? { denied_by: adminB } : {}),
        })
        .execute();
      const caught = await expectDbFailure(
        insertActiveAssignment({
          userId: target,
          role: 'finance',
          requestedBy: adminA,
          approvedBy: pretender,
        }),
      );
      expectRaised(caught, /approv/i);
    }
  });

  it('a revoked access_admin assignment does not qualify', async () => {
    const target = await createUser(testDb.db);
    const former = await createUser(testDb.db);
    const assignmentId = await insertActiveAssignment({
      userId: former,
      role: 'access_admin',
      requestedBy: adminA,
      approvedBy: adminB,
    });
    await testDb.db
      .updateTable('admin_role_assignment')
      .set({ state: 'revoked', revoked_by: adminA })
      .where('id', '=', assignmentId)
      .execute();
    const caught = await expectDbFailure(
      insertActiveAssignment({
        userId: target,
        role: 'finance',
        requestedBy: adminA,
        approvedBy: former,
      }),
    );
    expectRaised(caught, /approv/i);
  });

  it('a time-expired access_admin assignment does not qualify even before the expiry sweep', async () => {
    const target = await createUser(testDb.db);
    const lapsed = await createUser(testDb.db);
    await insertActiveAssignment({
      userId: lapsed,
      role: 'access_admin',
      requestedBy: adminA,
      approvedBy: adminB,
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    const caught = await expectDbFailure(
      insertActiveAssignment({
        userId: target,
        role: 'finance',
        requestedBy: adminA,
        approvedBy: lapsed,
      }),
    );
    expectRaised(caught, /approv/i);
  });

  it('the requester can never be the approver (unchanged CHECK)', async () => {
    const target = await createUser(testDb.db);
    const caught = await expectDbFailure(
      insertActiveAssignment({
        userId: target,
        role: 'finance',
        requestedBy: adminA,
        approvedBy: adminA,
      }),
    );
    expect((caught as { constraint?: string }).constraint).toBe(
      'ck_admin_role_assignment_dual_control',
    );
  });

  it('binds the application role too: himma_app cannot activate an unqualified finance grant', async () => {
    const target = await createUser(testDb.db);
    const outsider = await createUser(testDb.db);
    const caught = await expectDbFailure(
      withTransaction(testDb.db, async (trx) => {
        await sql`SET LOCAL ROLE himma_app`.execute(trx);
        await trx
          .insertInto('admin_role_assignment')
          .values({
            id: newId(),
            user_id: target,
            role: 'finance',
            state: 'active',
            requested_by: outsider,
            approved_by: adminB,
          })
          .execute();
      }),
    );
    expectRaised(caught, /request/i);
  });

  it('cannot be bypassed by mutating an active non-finance row into a finance role', async () => {
    const target = await createUser(testDb.db);
    const id = await insertActiveAssignment({
      userId: target,
      role: 'operations',
      requestedBy: adminA,
    });
    const caught = await expectDbFailure(
      testDb.db
        .updateTable('admin_role_assignment')
        .set({ role: 'finance', approved_by: adminB })
        .where('id', '=', id)
        .execute(),
    );
    expect((caught as { code?: string }).code).toBe('P0001');
    const row = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['role'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe('operations');
  });
});

describe('concurrent approval versus Access Administrator revocation', () => {
  async function rawClient(): Promise<Client> {
    const { database } = testDb.config;
    const client = new Client({
      host: database.host,
      port: database.port,
      database: database.database,
      user: database.user,
    });
    await client.connect();
    return client;
  }

  it('an approval that commits after the approver’s concurrent revocation is rejected', async () => {
    // Third qualified admin C, granted by the bootstrap pair.
    const adminC = await createUser(testDb.db);
    const adminCAssignment = await insertActiveAssignment({
      userId: adminC,
      role: 'access_admin',
      requestedBy: adminA,
      approvedBy: adminB,
    });
    const target = await createUser(testDb.db);
    const requestId = newId();
    await testDb.db
      .insertInto('admin_role_assignment')
      .values({
        id: requestId,
        user_id: target,
        role: 'finance',
        state: 'requested',
        requested_by: adminA,
      })
      .execute();

    const revoker = await rawClient();
    const approver = await rawClient();
    try {
      // T2 revokes admin C's access_admin and holds its transaction open.
      await revoker.query('BEGIN');
      await revoker.query(
        `UPDATE admin_role_assignment SET state = 'revoked', revoked_by = $1 WHERE id = $2`,
        [adminB, adminCAssignment],
      );

      // T1 approves the finance request with C as approver and tries to
      // commit: the activation check must serialize behind the revocation.
      await approver.query('BEGIN');
      await approver.query(
        `UPDATE admin_role_assignment SET state = 'active', approved_by = $1 WHERE id = $2`,
        [adminC, requestId],
      );
      let approvalSettled = false;
      const approvalCommit = approver
        .query('COMMIT')
        .then(() => ({ committed: true }))
        .catch((error: unknown) => ({ committed: false, error }))
        .finally(() => {
          approvalSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(approvalSettled).toBe(false); // blocked on the revocation lock

      await revoker.query('COMMIT');
      const result = await approvalCommit;
      expect(result.committed).toBe(false);
    } finally {
      await revoker.end();
      await approver.end();
    }

    // Exactly one consistent outcome: revocation committed, no finance grant.
    const financeRow = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(financeRow.state).toBe('requested');
    const adminCRow = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state'])
      .where('id', '=', adminCAssignment)
      .executeTakeFirstOrThrow();
    expect(adminCRow.state).toBe('revoked');
  });
});

describe('assignment rows cannot be rewritten after the fact', () => {
  it('user_id, role, requested_by and a recorded approver are immutable', async () => {
    const target = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const id = await insertActiveAssignment({
      userId: target,
      role: 'finance',
      requestedBy: adminA,
      approvedBy: adminB,
    });
    const mutations = [
      { user_id: other },
      { role: 'support' as const },
      { requested_by: adminB },
      { approved_by: adminA },
    ];
    for (const mutation of mutations) {
      const caught = await expectDbFailure(
        testDb.db
          .updateTable('admin_role_assignment')
          .set(mutation)
          .where('id', '=', id)
          .execute(),
      );
      expect((caught as { code?: string }).code).toBe('P0001');
    }
  });
});
