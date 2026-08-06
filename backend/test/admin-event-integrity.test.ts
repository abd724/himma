/**
 * B2-5 event-integrity correction — bootstrap completion and admin-role
 * expiry must each write their immutable audit event AND transactional
 * outbox event in the same PostgreSQL transaction as the state change.
 *
 * Real PostgreSQL throughout: single-winner concurrency, forced-failure
 * atomic rollback, sweep idempotence, and payload hygiene (no secrets, no
 * email addresses, safe identifiers only).
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';

import {
  runProductionBootstrap,
  BOOTSTRAP_CONFIRMATION_PHRASE,
  type BootstrapManifest,
} from '../src/modules/identity/admin/bootstrap';
import {
  processExpiredAssignments,
  requestRoleAssignment,
  resolveAdminRoles,
} from '../src/modules/identity/services/admin-roles';
import { firstLogin } from '../src/modules/identity/services/first-login';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { bootstrapAccessAdmins, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const SECRET = 'event-integrity-bootstrap-secret-value-0123456789';
const COMPLETION_EVENT = 'admin.bootstrap.completed';
const EXPIRED_EVENT = 'admin_role.expired';

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let counter = 0;
async function makeVerifiedUser(db: TestDb['db']): Promise<string> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: 'https://cognito.test/event-integrity-pool',
    subject: `event-integrity-sub-${counter}`,
    email: `eventintegrity${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return result.userId;
}

function manifestFor(users: [string, string]): BootstrapManifest {
  return { users, secretDigest: digestOf(SECRET) };
}

function bootstrapInput(users: [string, string]) {
  return {
    nodeEnv: 'production' as const,
    manifest: manifestFor(users),
    confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
    secret: SECRET,
    executedBy: 'ops-event-integrity',
  };
}

async function completionEvents(db: TestDb['db']) {
  const audit = await db
    .selectFrom('audit_event')
    .select(['id'])
    .where('action', '=', 'auth.bootstrap_completed')
    .execute();
  const outbox = await db
    .selectFrom('outbox_event')
    .select(['payload'])
    .where('event_type', '=', COMPLETION_EVENT)
    .execute();
  return { audit, outbox };
}

describe('bootstrap completion event (successful run)', () => {
  let scratch: TestDb;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    scratch = await createMigratedTestDb();
    userA = await makeVerifiedUser(scratch.db);
    userB = await makeVerifiedUser(scratch.db);
  });

  afterAll(async () => {
    await scratch.drop();
  });

  it('writes exactly one completion audit event and one completion outbox event with the seal', async () => {
    const result = await runProductionBootstrap(
      { db: scratch.db },
      bootstrapInput([userA, userB]),
    );
    expect(result.kind).toBe('bootstrapCompleted');

    const { audit, outbox } = await completionEvents(scratch.db);
    expect(audit).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('carries safe identifiers only: seal reference, assignment ids, user ids, digest, timestamp', async () => {
    const { outbox } = await completionEvents(scratch.db);
    expect(outbox).toHaveLength(1);
    const raw = outbox[0]?.payload;
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;

    const assignments = await scratch.db
      .selectFrom('admin_role_assignment')
      .select(['id', 'user_id'])
      .execute();
    expect(assignments).toHaveLength(2);

    const seal = await sql<{ manifest_digest: string; sealed_at: Date }>`
      SELECT manifest_digest, sealed_at FROM bootstrap_seal`.execute(scratch.db);
    const sealRow = seal.rows[0];
    if (sealRow === undefined) throw new Error('missing bootstrap seal');

    expect(payload['manifestDigest']).toBe(sealRow.manifest_digest);
    expect(new Set(payload['assignmentIds'] as string[])).toEqual(
      new Set(assignments.map((a) => a.id)),
    );
    expect(new Set(payload['userIds'] as string[])).toEqual(new Set([userA, userB]));
    expect(payload['sealedAt']).toBe(sealRow.sealed_at.toISOString());
    expect(payload['executedBy']).toBe('ops-event-integrity');
  });

  it('contains no bootstrap secret and no email address in either event payload', async () => {
    const total = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = ${COMPLETION_EVENT}`.execute(scratch.db);
    expect(Number(total.rows[0]?.n)).toBe(1);
    const dirtyOutbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type IN (${COMPLETION_EVENT}, ${EXPIRED_EVENT})
        AND (payload::text LIKE ${'%' + SECRET + '%'} OR payload::text LIKE '%@%')`.execute(
      scratch.db,
    );
    expect(Number(dirtyOutbox.rows[0]?.n)).toBe(0);
    const dirtyAudit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE entity_id::text LIKE ${'%' + SECRET + '%'} OR entity_id::text LIKE '%@%'`.execute(
      scratch.db,
    );
    expect(Number(dirtyAudit.rows[0]?.n)).toBe(0);
  });
});

describe('bootstrap completion event (failure and concurrency)', () => {
  let scratch: TestDb;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    scratch = await createMigratedTestDb();
    userA = await makeVerifiedUser(scratch.db);
    userB = await makeVerifiedUser(scratch.db);
  });

  afterAll(async () => {
    await scratch.drop();
  });

  it('a forced failure at the completion event rolls back assignments, seal, and every event', async () => {
    await sql`
      CREATE FUNCTION test_fail_completion() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced completion failure'; END; $$`.execute(
      scratch.db,
    );
    await sql`
      CREATE TRIGGER trg_test_fail_completion BEFORE INSERT ON outbox_event
      FOR EACH ROW WHEN (NEW.event_type = ${sql.lit(COMPLETION_EVENT)})
      EXECUTE FUNCTION test_fail_completion()`.execute(scratch.db);
    try {
      await expect(
        runProductionBootstrap({ db: scratch.db }, bootstrapInput([userA, userB])),
      ).rejects.toThrow();
    } finally {
      await sql`DROP TRIGGER trg_test_fail_completion ON outbox_event`.execute(scratch.db);
      await sql`DROP FUNCTION test_fail_completion()`.execute(scratch.db);
    }

    expect(
      await scratch.db.selectFrom('admin_role_assignment').select(['id']).execute(),
    ).toEqual([]);
    const seal = await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(
      scratch.db,
    );
    expect(Number(seal.rows[0]?.n)).toBe(0);
    // Only bootstrap-related events matter: firstLogin fixtures legitimately
    // wrote their own audit/outbox rows before the bootstrap attempt.
    expect(
      await scratch.db
        .selectFrom('audit_event')
        .select(['id'])
        .where('action', 'in', ['auth.bootstrap_completed', 'auth.admin_role_approved'])
        .execute(),
    ).toEqual([]);
    expect(
      await scratch.db
        .selectFrom('outbox_event')
        .select(['id'])
        .where('event_type', 'in', [COMPLETION_EVENT, 'admin_role.approved'])
        .execute(),
    ).toEqual([]);
  });

  it('concurrent attempts produce exactly one completion audit event and one completion outbox event', async () => {
    const results = await Promise.all([
      runProductionBootstrap({ db: scratch.db }, bootstrapInput([userA, userB])),
      runProductionBootstrap({ db: scratch.db }, bootstrapInput([userA, userB])),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      'bootstrapAlreadySealed',
      'bootstrapCompleted',
    ]);

    const { audit, outbox } = await completionEvents(scratch.db);
    expect(audit).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });
});

describe('admin-role expiry events', () => {
  let testDb: TestDb;
  let adminA: string;

  beforeAll(async () => {
    testDb = await createMigratedTestDb();
    ({ adminA } = await bootstrapAccessAdmins(testDb.db));
  });

  afterAll(async () => {
    await testDb.drop();
  });

  async function makeExpiredAssignment(): Promise<{ target: string; assignmentId: string }> {
    const target = await createUser(testDb.db);
    const activated = await requestRoleAssignment(
      { db: testDb.db },
      { userId: adminA },
      { targetUserId: target, role: 'operations', expiresAt: new Date(Date.now() + 40) },
    );
    if (activated.kind !== 'roleActivated') throw new Error(activated.kind);
    await new Promise((resolve) => setTimeout(resolve, 70));
    return { target, assignmentId: activated.assignmentId };
  }

  async function expiryEventsFor(assignmentId: string) {
    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['id'])
      .where('action', '=', 'auth.admin_role_expired')
      .where('entity_id', '=', assignmentId)
      .execute();
    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['payload', 'aggregate_id'])
      .where('event_type', '=', EXPIRED_EVENT)
      .where(sql<boolean>`payload->>'assignmentId' = ${assignmentId}`)
      .execute();
    return { audit, outbox };
  }

  it('the sweep writes the audit and outbox events atomically with the state transition', async () => {
    const { target, assignmentId } = await makeExpiredAssignment();

    // Time-expired but not yet swept: resolution already denies the role.
    expect(await resolveAdminRoles({ db: testDb.db }, target)).toEqual([]);

    // Force the outbox write to fail: the state transition must roll back too.
    await sql`
      CREATE FUNCTION test_fail_expiry() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced expiry failure'; END; $$`.execute(
      testDb.db,
    );
    await sql`
      CREATE TRIGGER trg_test_fail_expiry BEFORE INSERT ON outbox_event
      FOR EACH ROW WHEN (NEW.event_type = ${sql.lit(EXPIRED_EVENT)})
      EXECUTE FUNCTION test_fail_expiry()`.execute(testDb.db);
    try {
      await expect(processExpiredAssignments({ db: testDb.db })).rejects.toThrow();
    } finally {
      await sql`DROP TRIGGER trg_test_fail_expiry ON outbox_event`.execute(testDb.db);
      await sql`DROP FUNCTION test_fail_expiry()`.execute(testDb.db);
    }
    const afterFailure = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state'])
      .where('id', '=', assignmentId)
      .executeTakeFirstOrThrow();
    expect(afterFailure.state).toBe('active');
    expect((await expiryEventsFor(assignmentId)).outbox).toHaveLength(0);

    // The successful sweep transitions and emits both events together.
    const swept = await processExpiredAssignments({ db: testDb.db });
    expect(swept.expiredCount).toBeGreaterThanOrEqual(1);
    const afterSweep = await testDb.db
      .selectFrom('admin_role_assignment')
      .select(['state'])
      .where('id', '=', assignmentId)
      .executeTakeFirstOrThrow();
    expect(afterSweep.state).toBe('expired');

    const { audit, outbox } = await expiryEventsFor(assignmentId);
    expect(audit).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.aggregate_id).toBe(target);
    const raw = outbox[0]?.payload;
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(payload).toEqual({ assignmentId });
  });

  it('repeated sweeps are idempotent: no duplicate events for already processed assignments', async () => {
    const { assignmentId } = await makeExpiredAssignment();
    const first = await processExpiredAssignments({ db: testDb.db });
    expect(first.expiredCount).toBeGreaterThanOrEqual(1);
    const again = await processExpiredAssignments({ db: testDb.db });
    expect(again.expiredCount).toBe(0);

    const { audit, outbox } = await expiryEventsFor(assignmentId);
    expect(audit).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('concurrent expiry processors emit exactly one transition and event set per assignment', async () => {
    const made = await Promise.all([
      makeExpiredAssignment(),
      makeExpiredAssignment(),
      makeExpiredAssignment(),
    ]);

    const sweeps = await Promise.all([
      processExpiredAssignments({ db: testDb.db }),
      processExpiredAssignments({ db: testDb.db }),
    ]);
    expect(sweeps[0].expiredCount + sweeps[1].expiredCount).toBe(made.length);

    for (const { assignmentId } of made) {
      const row = await testDb.db
        .selectFrom('admin_role_assignment')
        .select(['state'])
        .where('id', '=', assignmentId)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe('expired');
      const { audit, outbox } = await expiryEventsFor(assignmentId);
      expect(audit).toHaveLength(1);
      expect(outbox).toHaveLength(1);
    }
  });

  it('expiry event payloads contain safe identifiers only — no email address material', async () => {
    const dirty = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = ${EXPIRED_EVENT} AND payload::text LIKE '%@%'`.execute(testDb.db);
    expect(Number(dirty.rows[0]?.n)).toBe(0);
    const total = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = ${EXPIRED_EVENT}`.execute(testDb.db);
    expect(Number(total.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });
});
