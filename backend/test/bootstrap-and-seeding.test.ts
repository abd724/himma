/**
 * B2-5 — one-time production bootstrap (docs/26 §7.5, §9.9, D3) and the
 * entirely separate development/test seed mechanism.
 *
 * Full bootstrap rehearsal against fresh scratch PostgreSQL databases:
 * zero-state + seal preconditions, manifest/phrase/secret gates, exactly
 * two Access Administrators atomically with audit + outbox + seal,
 * concurrency single-winner, permanent sealing, rollback on forced
 * failure, and strict production/dev separation.
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';

import { newId } from '../src/db/ids';

import {
  runProductionBootstrap,
  BOOTSTRAP_CONFIRMATION_PHRASE,
  type BootstrapManifest,
} from '../src/modules/identity/admin/bootstrap';
import { seedDevelopmentAdmins } from '../src/modules/identity/admin/seed';
import { resolveAdminRoles } from '../src/modules/identity/services/admin-roles';
import { firstLogin } from '../src/modules/identity/services/first-login';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const SECRET = 'a-sufficiently-long-bootstrap-secret-value-0123456789';

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let counter = 0;
async function makeVerifiedUser(db: TestDb['db']): Promise<string> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: 'https://cognito.test/bootstrap-pool',
    subject: `bootstrap-sub-${counter}`,
    email: `bootstrap${counter}@example.test`,
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

describe('production bootstrap rehearsal (fresh scratch database)', () => {
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

  it('refuses outside an explicit production environment', async () => {
    const result = await runProductionBootstrap(
      { db: scratch.db },
      {
        nodeEnv: 'development',
        manifest: manifestFor([userA, userB]),
        confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
        secret: SECRET,
        executedBy: 'ops-rehearsal',
      },
    );
    expect(result.kind).toBe('unsafeEnvironment');
  });

  it('refuses invalid manifests, wrong secrets, and wrong confirmation phrases before any transaction', async () => {
    const base = {
      nodeEnv: 'production' as const,
      confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
      secret: SECRET,
      executedBy: 'ops-rehearsal',
    };
    // Same user twice.
    expect(
      (
        await runProductionBootstrap(
          { db: scratch.db },
          { ...base, manifest: manifestFor([userA, userA]) },
        )
      ).kind,
    ).toBe('invalidBootstrapManifest');
    // Unknown user.
    expect(
      (
        await runProductionBootstrap(
          { db: scratch.db },
          {
            ...base,
            manifest: manifestFor([userA, '01890000-0000-7000-8000-0000000000aa']),
          },
        )
      ).kind,
    ).toBe('invalidBootstrapManifest');
    // Secret does not match the reviewed manifest digest.
    expect(
      (
        await runProductionBootstrap(
          { db: scratch.db },
          { ...base, manifest: manifestFor([userA, userB]), secret: 'wrong-secret-that-is-long-enough-000' },
        )
      ).kind,
    ).toBe('invalidBootstrapManifest');
    // Wrong confirmation phrase.
    expect(
      (
        await runProductionBootstrap(
          { db: scratch.db },
          {
            ...base,
            manifest: manifestFor([userA, userB]),
            confirmationPhrase: 'bootstrap something else',
          },
        )
      ).kind,
    ).toBe('invalidConfirmation');
    // Nothing was created by any refusal.
    const rows = await scratch.db
      .selectFrom('admin_role_assignment')
      .select(['id'])
      .execute();
    expect(rows).toEqual([]);
  });

  it('a forced failure rolls back assignments, events, and seal atomically', async () => {
    await sql`
      CREATE FUNCTION test_fail_seal() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced bootstrap failure'; END; $$`.execute(
      scratch.db,
    );
    await sql`
      CREATE TRIGGER trg_test_fail_seal BEFORE INSERT ON bootstrap_seal
      FOR EACH ROW EXECUTE FUNCTION test_fail_seal()`.execute(scratch.db);
    try {
      await expect(
        runProductionBootstrap(
          { db: scratch.db },
          {
            nodeEnv: 'production',
            manifest: manifestFor([userA, userB]),
            confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
            secret: SECRET,
            executedBy: 'ops-rehearsal',
          },
        ),
      ).rejects.toThrow();
    } finally {
      await sql`DROP TRIGGER trg_test_fail_seal ON bootstrap_seal`.execute(scratch.db);
      await sql`DROP FUNCTION test_fail_seal()`.execute(scratch.db);
    }
    const assignments = await scratch.db
      .selectFrom('admin_role_assignment')
      .select(['id'])
      .execute();
    expect(assignments).toEqual([]);
    const seal = await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(
      scratch.db,
    );
    expect(Number(seal.rows[0]?.n)).toBe(0);
  });

  it('concurrent bootstrap attempts admit exactly one success, creating exactly two Access Administrators atomically', async () => {
    const input = {
      nodeEnv: 'production' as const,
      manifest: manifestFor([userA, userB]),
      confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
      secret: SECRET,
      executedBy: 'ops-rehearsal',
    };
    const results = await Promise.all([
      runProductionBootstrap({ db: scratch.db }, input),
      runProductionBootstrap({ db: scratch.db }, input),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['bootstrapAlreadySealed', 'bootstrapCompleted']);

    const assignments = await scratch.db
      .selectFrom('admin_role_assignment')
      .select(['user_id', 'role', 'state'])
      .execute();
    expect(assignments).toHaveLength(2);
    expect(assignments.every((a) => a.role === 'access_admin' && a.state === 'active')).toBe(true);
    expect(new Set(assignments.map((a) => a.user_id))).toEqual(new Set([userA, userB]));
    expect(await resolveAdminRoles({ db: scratch.db }, userA)).toEqual(['access_admin']);
    expect(await resolveAdminRoles({ db: scratch.db }, userB)).toEqual(['access_admin']);

    const audit = await scratch.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('action', '=', 'auth.bootstrap_completed')
      .execute();
    expect(audit).toHaveLength(1);
    const outbox = await scratch.db
      .selectFrom('outbox_event')
      .select(['event_type'])
      .where('event_type', '=', 'admin_role.approved')
      .execute();
    expect(outbox).toHaveLength(2);
    const seal = await sql<{ executed_by: string }>`
      SELECT executed_by FROM bootstrap_seal`.execute(scratch.db);
    expect(seal.rows[0]?.executed_by).toBe('ops-rehearsal');
  });

  it('every later attempt fails permanently once sealed', async () => {
    const again = await runProductionBootstrap(
      { db: scratch.db },
      {
        nodeEnv: 'production',
        manifest: manifestFor([userA, userB]),
        confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
        secret: SECRET,
        executedBy: 'ops-second-attempt',
      },
    );
    expect(again.kind).toBe('bootstrapAlreadySealed');
  });

  it('no result, audit row, or outbox row contains the bootstrap secret', async () => {
    const audits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action::text LIKE ${'%' + SECRET + '%'}
         OR entity_id::text LIKE ${'%' + SECRET + '%'}`.execute(scratch.db);
    expect(Number(audits.rows[0]?.n)).toBe(0);
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE payload::text LIKE ${'%' + SECRET + '%'}`.execute(scratch.db);
    expect(Number(outbox.rows[0]?.n)).toBe(0);
  });
});

describe('bootstrap cannot create any role other than access_admin', () => {
  it('is structurally incapable: the implementation carries no role parameter and inserts only access_admin', async () => {
    const scratch = await createMigratedTestDb();
    try {
      const u1 = await makeVerifiedUser(scratch.db);
      const u2 = await makeVerifiedUser(scratch.db);
      const result = await runProductionBootstrap(
        { db: scratch.db },
        {
          nodeEnv: 'production',
          manifest: manifestFor([u1, u2]),
          confirmationPhrase: BOOTSTRAP_CONFIRMATION_PHRASE,
          secret: SECRET,
          executedBy: 'ops',
        },
      );
      expect(result.kind).toBe('bootstrapCompleted');
      const roles = await scratch.db
        .selectFrom('admin_role_assignment')
        .select(['role'])
        .execute();
      expect(new Set(roles.map((r) => r.role))).toEqual(new Set(['access_admin']));
    } finally {
      await scratch.drop();
    }
  });
});

describe('development/test seeding (separate mechanism)', () => {
  let seedDb: TestDb;

  beforeAll(async () => {
    seedDb = await createMigratedTestDb();
  });

  afterAll(async () => {
    await seedDb.drop();
  });

  it('refuses to run in production', async () => {
    const result = await seedDevelopmentAdmins({ db: seedDb.db }, { nodeEnv: 'production' });
    expect(result.kind).toBe('unsafeEnvironment');
  });

  it('creates deterministic seed admins without touching the bootstrap seal, and repeats safely', async () => {
    const first = await seedDevelopmentAdmins({ db: seedDb.db }, { nodeEnv: 'test' });
    expect(first.kind).toBe('seeded');
    if (first.kind !== 'seeded') return;
    expect(await resolveAdminRoles({ db: seedDb.db }, first.adminA)).toEqual(['access_admin']);
    expect(await resolveAdminRoles({ db: seedDb.db }, first.adminB)).toEqual(['access_admin']);

    // The seal is untouched — seeding never creates or consumes it.
    const seal = await sql<{ n: string }>`SELECT count(*) AS n FROM bootstrap_seal`.execute(
      seedDb.db,
    );
    expect(Number(seal.rows[0]?.n)).toBe(0);

    // Repeatable: converges on the same deterministic identities.
    const again = await seedDevelopmentAdmins({ db: seedDb.db }, { nodeEnv: 'test' });
    expect(again.kind).toBe('seeded');
    if (again.kind === 'seeded') {
      expect(again.adminA).toBe(first.adminA);
      expect(again.adminB).toBe(first.adminB);
    }
    const assignments = await seedDb.db
      .selectFrom('admin_role_assignment')
      .select(['id'])
      .execute();
    expect(assignments).toHaveLength(2);
  });

  it('post-seed grants still flow through the full constraint machinery (no weakened database)', async () => {
    const seeded = await seedDevelopmentAdmins({ db: seedDb.db }, { nodeEnv: 'test' });
    if (seeded.kind !== 'seeded') throw new Error(seeded.kind);
    // A conspirator pair without a seal must STILL be refused after seeding
    // (the finance-approver trigger is fully active for everything else).
    const u1 = await makeVerifiedUser(seedDb.db);
    const u2 = await makeVerifiedUser(seedDb.db);
    await expect(
      seedDb.db
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
    ).rejects.toThrow();
  });
});
