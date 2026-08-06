/**
 * B2-1 admin-role and bootstrap-seal schema tests: dual control, D4
 * exclusivity (including under concurrency), state-machine guards, and the
 * permanent one-shot bootstrap seal (docs/26 §7, §8.7, Amendment A1.3–4).
 */
import { sql } from 'kysely';

import { isDbError } from '../src/db/errors';
import { newId } from '../src/db/ids';
import { withTransaction } from '../src/db/transaction';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
// Bootstrapped Access Administrators — the qualified requester/approver pair
// required for every finance-capable activation (0003 correction).
let qualifiedA: string;
let qualifiedB: string;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  ({ adminA: qualifiedA, adminB: qualifiedB } = await bootstrapAccessAdmins(testDb.db));
});

afterAll(async () => {
  await testDb.drop();
});

type Role = 'operations' | 'support' | 'finance' | 'access_admin' | 'auditor';
type State = 'requested' | 'active' | 'denied' | 'revoked' | 'expired';

async function insertAssignment(options: {
  userId: string;
  role: Role;
  state: State;
  requestedBy: string;
  approvedBy?: string;
}): Promise<string> {
  const id = newId();
  await testDb.db
    .insertInto('admin_role_assignment')
    .values({
      id,
      user_id: options.userId,
      role: options.role,
      state: options.state,
      requested_by: options.requestedBy,
      approved_by: options.approvedBy ?? null,
    })
    .execute();
  return id;
}

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

describe('dual control', () => {
  it('the requester can never be recorded as the approver', async () => {
    const target = await createUser(testDb.db);
    const admin = await createUser(testDb.db);
    const caught = await expectDbFailure(
      insertAssignment({
        userId: target,
        role: 'finance',
        state: 'active',
        requestedBy: admin,
        approvedBy: admin,
      }),
    );
    expect((caught as { constraint?: string }).constraint).toBe(
      'ck_admin_role_assignment_dual_control',
    );
  });

  it('finance-capable roles cannot be active without a recorded approver', async () => {
    const target = await createUser(testDb.db);
    const admin = await createUser(testDb.db);
    for (const role of ['finance', 'access_admin'] as const) {
      const caught = await expectDbFailure(
        insertAssignment({ userId: target, role, state: 'active', requestedBy: admin }),
      );
      expect((caught as { constraint?: string }).constraint).toBe(
        'ck_admin_role_assignment_finance_approved',
      );
    }
  });

  it('a non-finance role activates with a single distinct grantor', async () => {
    const target = await createUser(testDb.db);
    const admin = await createUser(testDb.db);
    await insertAssignment({
      userId: target,
      role: 'operations',
      state: 'active',
      requestedBy: admin,
    });
  });

  it('concurrent approvals cannot produce a self-approved or double-active grant', async () => {
    const target = await createUser(testDb.db);
    const requestId = await insertAssignment({
      userId: target,
      role: 'finance',
      state: 'requested',
      requestedBy: qualifiedA,
    });
    // Two approvers race on the same request; version CAS admits exactly one.
    const attempts = await Promise.allSettled(
      [qualifiedB, qualifiedB].map((approver) =>
        withTransaction(testDb.db, async (trx) => {
          const result = await trx
            .updateTable('admin_role_assignment')
            .set({ state: 'active', approved_by: approver })
            .where('id', '=', requestId)
            .where('state', '=', 'requested')
            .where('version', '=', 1)
            .executeTakeFirst();
          if (result.numUpdatedRows !== 1n) throw new Error('lost the race');
          return approver;
        }),
      ),
    );
    const winners = attempts.filter((a) => a.status === 'fulfilled');
    expect(winners.length).toBe(1);
    const row = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state', 'approved_by', 'version'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('active');
    expect(row.approved_by).toBe(qualifiedB);
    expect(row.version).toBe(2);
  });
});

describe('state-machine guard', () => {
  it('rejects invalid transitions and accepts valid ones', async () => {
    const target = await createUser(testDb.db);
    const adminA = await createUser(testDb.db);
    const adminB = await createUser(testDb.db);

    const id = await insertAssignment({
      userId: target,
      role: 'support',
      state: 'requested',
      requestedBy: adminA,
    });

    // requested → revoked is illegal.
    let caught = await expectDbFailure(
      testDb.db
        .updateTable('admin_role_assignment')
        .set({ state: 'revoked' })
        .where('id', '=', id)
        .execute(),
    );
    expect(isDbError(caught, 'raisedException') || (caught as { code?: string }).code === 'P0001').toBe(true);

    // requested → active is legal.
    await testDb.db
      .updateTable('admin_role_assignment')
      .set({ state: 'active', approved_by: adminB })
      .where('id', '=', id)
      .execute();

    // active → denied is illegal.
    caught = await expectDbFailure(
      testDb.db
        .updateTable('admin_role_assignment')
        .set({ state: 'denied' })
        .where('id', '=', id)
        .execute(),
    );
    expect(isDbError(caught, 'raisedException') || (caught as { code?: string }).code === 'P0001').toBe(true);

    // active → revoked is legal and terminal.
    await testDb.db
      .updateTable('admin_role_assignment')
      .set({ state: 'revoked' })
      .where('id', '=', id)
      .execute();
    caught = await expectDbFailure(
      testDb.db
        .updateTable('admin_role_assignment')
        .set({ state: 'active' })
        .where('id', '=', id)
        .execute(),
    );
    expect(caught).toBeDefined();
  });

  it('enforces one active assignment per (user, role)', async () => {
    const target = await createUser(testDb.db);
    const admin = await createUser(testDb.db);
    await insertAssignment({
      userId: target,
      role: 'support',
      state: 'active',
      requestedBy: admin,
    });
    await expectDbFailure(
      insertAssignment({
        userId: target,
        role: 'support',
        state: 'active',
        requestedBy: admin,
      }),
    );
  });
});

describe('D4 role exclusivity', () => {
  it('access_admin and finance are mutually exclusive', async () => {
    const target = await createUser(testDb.db);
    await insertAssignment({
      userId: target,
      role: 'access_admin',
      state: 'active',
      requestedBy: qualifiedA,
      approvedBy: qualifiedB,
    });
    const caught = await expectDbFailure(
      insertAssignment({
        userId: target,
        role: 'finance',
        state: 'active',
        requestedBy: qualifiedA,
        approvedBy: qualifiedB,
      }),
    );
    expect(isDbError(caught, 'raisedException') || (caught as { code?: string }).code === 'P0001').toBe(true);
  });

  it('auditor excludes every mutating platform role, both directions', async () => {
    // auditor first, then a mutating role.
    const target1 = await createUser(testDb.db);
    await insertAssignment({
      userId: target1,
      role: 'auditor',
      state: 'active',
      requestedBy: qualifiedA,
    });
    await expectDbFailure(
      insertAssignment({
        userId: target1,
        role: 'operations',
        state: 'active',
        requestedBy: qualifiedA,
      }),
    );

    // mutating role first, then auditor.
    const target2 = await createUser(testDb.db);
    await insertAssignment({
      userId: target2,
      role: 'finance',
      state: 'active',
      requestedBy: qualifiedA,
      approvedBy: qualifiedB,
    });
    await expectDbFailure(
      insertAssignment({
        userId: target2,
        role: 'auditor',
        state: 'active',
        requestedBy: qualifiedA,
      }),
    );
  });

  it('holds under concurrent activation of conflicting roles', async () => {
    const target = await createUser(testDb.db);
    const outcomes = await Promise.allSettled([
      withTransaction(testDb.db, (trx) =>
        trx
          .insertInto('admin_role_assignment')
          .values({
            id: newId(),
            user_id: target,
            role: 'access_admin',
            state: 'active',
            requested_by: qualifiedA,
            approved_by: qualifiedB,
          })
          .execute(),
      ),
      withTransaction(testDb.db, (trx) =>
        trx
          .insertInto('admin_role_assignment')
          .values({
            id: newId(),
            user_id: target,
            role: 'finance',
            state: 'active',
            requested_by: qualifiedA,
            approved_by: qualifiedB,
          })
          .execute(),
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBe(1);
    const active = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['role'])
      .where('user_id', '=', target)
      .where('state', '=', 'active')
      .execute();
    expect(active.length).toBe(1);
  });

  it('has no universal super-admin role value', async () => {
    const target = await createUser(testDb.db);
    const admin = await createUser(testDb.db);
    await expectDbFailure(
      testDb.db
        .insertInto('admin_role_assignment')
        .values({
          id: newId(),
          user_id: target,
          role: 'super_admin',
          state: 'requested',
          requested_by: admin,
        })
        .execute(),
    );
  });
});

describe('bootstrap seal', () => {
  it('admits exactly one row, forever (the beforeAll bootstrap wrote it)', async () => {
    const existing = await sql<{ n: string }>`
      SELECT count(*) AS n FROM bootstrap_seal`.execute(testDb.db);
    expect(Number(existing.rows[0]?.n)).toBe(1);
    const dup = await expectDbFailure(
      sql`INSERT INTO bootstrap_seal (manifest_digest, executed_by)
          VALUES ('digest-2', 'ops-ticket-2')`.execute(testDb.db),
    );
    expect((dup as { code?: string }).code).toBe('23505');
  });

  it('can never be updated or deleted, even by the table owner', async () => {
    await expectDbFailure(
      sql`UPDATE bootstrap_seal SET manifest_digest = 'tampered'`.execute(testDb.db),
    );
    await expectDbFailure(sql`DELETE FROM bootstrap_seal`.execute(testDb.db));
    const row = await sql<{ manifest_digest: string }>`
      SELECT manifest_digest FROM bootstrap_seal`.execute(testDb.db);
    expect(row.rows[0]?.manifest_digest).toBe('test-manifest-digest');
  });
});
