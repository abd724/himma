/**
 * B2-2 — first-login identity resolution service (docs/26 §3, §9.1).
 *
 * Real PostgreSQL throughout. Proves: atomic creation of User + AuthIdentity
 * + CustomerAccount + self participant, audit/outbox in the same
 * transaction, rollback on failure, idempotency, convergence under
 * concurrency, issuer+subject (never email) matching, verified-email
 * ownership without merges, and typed account-state outcomes.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { firstLogin } from '../src/modules/identity/services/first-login';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { createIdentity, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

let evidenceCounter = 0;
function withoutEmail(evidence: ProviderEvidence): ProviderEvidence {
  const rest = { ...evidence };
  delete rest.email;
  return rest;
}
function makeEvidence(overrides: Partial<ProviderEvidence> = {}): ProviderEvidence {
  evidenceCounter += 1;
  return {
    provider: 'google',
    issuer: 'https://accounts.google.com',
    subject: `first-login-sub-${evidenceCounter}`,
    email: `person${evidenceCounter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
    ...overrides,
  };
}

async function countRows(
  table: 'app_user' | 'auth_identity' | 'customer_account' | 'participant',
  column: string,
  value: string,
): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM ${sql.table(table)}
    WHERE ${sql.ref(column)} = ${value}`.execute(testDb.db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('first login — creation', () => {
  it('creates exactly one User, AuthIdentity, CustomerAccount, and self participant, atomically typed', async () => {
    const evidence = makeEvidence({ displayName: 'Amal' });
    const result = await firstLogin({ db: testDb.db }, { evidence });
    expect(result.kind).toBe('newCustomerCreated');
    if (result.kind !== 'newCustomerCreated') return;

    expect(await countRows('auth_identity', 'user_id', result.userId)).toBe(1);
    expect(await countRows('customer_account', 'user_id', result.userId)).toBe(1);
    expect(await countRows('participant', 'account_id', result.accountId)).toBe(1);

    const participant = await testDb.db
      .selectFrom('participant')
      .select(['kind', 'first_name'])
      .where('account_id', '=', result.accountId)
      .executeTakeFirstOrThrow();
    expect(participant.kind).toBe('self');
    expect(participant.first_name).toBe('Me');

    const account = await testDb.db
      .selectFrom('customer_account')
      .select(['display_name', 'contact_email'])
      .where('id', '=', result.accountId)
      .executeTakeFirstOrThrow();
    expect(account.display_name).toBe('Amal');
    expect(account.contact_email).toBe(evidence.email);
  });

  it('writes audit and outbox events in the creation transaction', async () => {
    const result = await firstLogin({ db: testDb.db }, { evidence: makeEvidence() });
    if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);

    const audits = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', 'in', [result.userId, result.accountId])
      .execute();
    expect(audits.map((a) => a.action).sort()).toEqual([
      'auth.account_created',
      'auth.user_created',
    ]);

    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type', 'payload'])
      .where('aggregate_id', 'in', [result.userId, result.accountId])
      .execute();
    expect(outbox.map((o) => o.event_type).sort()).toEqual(['account.created', 'user.created']);
  });

  it('a forced failure rolls back every created record and event', async () => {
    await sql`
      CREATE FUNCTION test_fail_participant_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced test failure'; END; $$`.execute(
      testDb.db,
    );
    await sql`
      CREATE TRIGGER trg_test_fail_participant BEFORE INSERT ON participant
      FOR EACH ROW EXECUTE FUNCTION test_fail_participant_insert()`.execute(testDb.db);
    const evidence = makeEvidence();
    const auditBefore = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(
      testDb.db,
    );
    try {
      await expect(firstLogin({ db: testDb.db }, { evidence })).rejects.toThrow();
    } finally {
      await sql`DROP TRIGGER trg_test_fail_participant ON participant`.execute(testDb.db);
      await sql`DROP FUNCTION test_fail_participant_insert()`.execute(testDb.db);
    }
    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('subject', '=', evidence.subject)
      .execute();
    expect(identities).toEqual([]);
    const auditAfter = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(
      testDb.db,
    );
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
  });
});

describe('first login — resolution and idempotency', () => {
  it('a repeat first login resolves the same canonical user without creating anything', async () => {
    const evidence = makeEvidence();
    const created = await firstLogin({ db: testDb.db }, { evidence });
    if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
    const repeat = await firstLogin({ db: testDb.db }, { evidence });
    expect(repeat.kind).toBe('identityResolved');
    if (repeat.kind !== 'identityResolved') return;
    expect(repeat.userId).toBe(created.userId);
    expect(repeat.accountId).toBe(created.accountId);
    expect(await countRows('auth_identity', 'user_id', created.userId)).toBe(1);
    expect(await countRows('customer_account', 'user_id', created.userId)).toBe(1);
  });

  it('concurrent identical first logins converge on one canonical user and account', async () => {
    const evidence = makeEvidence();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => firstLogin({ db: testDb.db }, { evidence })),
    );
    const kinds = results.map((r) => r.kind);
    for (const kind of kinds) {
      expect(['newCustomerCreated', 'identityResolved']).toContain(kind);
    }
    const userIds = new Set(
      results.map((r) => (r.kind === 'newCustomerCreated' || r.kind === 'identityResolved' ? r.userId : 'other')),
    );
    expect(userIds.size).toBe(1);
    const [userId] = userIds;
    expect(await countRows('auth_identity', 'user_id', userId as string)).toBe(1);
    expect(await countRows('customer_account', 'user_id', userId as string)).toBe(1);
  });

  it('matches by issuer + subject, never by email: a changed email attribute still resolves the same user', async () => {
    const evidence = makeEvidence();
    const created = await firstLogin({ db: testDb.db }, { evidence });
    if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
    const changedEmail = await firstLogin(
      { db: testDb.db },
      { evidence: { ...evidence, email: `changed-${evidenceCounter}@example.test`, emailVerified: false } },
    );
    expect(changedEmail.kind).toBe('identityResolved');
    if (changedEmail.kind === 'identityResolved') {
      expect(changedEmail.userId).toBe(created.userId);
    }
  });

  it('unverified duplicate email claims stay independent users (no merge, no conflict)', async () => {
    const sharedEmail = `shared-unverified-${newId()}@example.test`;
    const a = await firstLogin(
      { db: testDb.db },
      { evidence: makeEvidence({ email: sharedEmail, emailVerified: false }) },
    );
    const b = await firstLogin(
      { db: testDb.db },
      { evidence: makeEvidence({ email: sharedEmail, emailVerified: false }) },
    );
    if (a.kind !== 'newCustomerCreated' || b.kind !== 'newCustomerCreated') {
      throw new Error(`${a.kind}/${b.kind}`);
    }
    expect(a.userId).not.toBe(b.userId);
  });

  it('creates the missing customer account and self participant when an existing user first signs in as a customer', async () => {
    // A user provisioned outside the customer flow (fixture): identity, no account.
    const userId = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, userId, { provider: 'google' });
    const result = await firstLogin(
      { db: testDb.db },
      {
        evidence: withoutEmail(
          makeEvidence({
            issuer: identity.issuer,
            subject: identity.subject,
            emailVerified: false,
          }),
        ),
      },
    );
    expect(result.kind).toBe('identityResolved');
    if (result.kind !== 'identityResolved') return;
    expect(result.userId).toBe(userId);
    expect(await countRows('customer_account', 'user_id', userId)).toBe(1);
    expect(await countRows('participant', 'account_id', result.accountId)).toBe(1);
  });
});

describe('first login — display names are never inferred from email addresses', () => {
  async function createdAccountName(evidence: ProviderEvidence): Promise<string> {
    const result = await firstLogin({ db: testDb.db }, { evidence });
    if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
    const account = await testDb.db
      .selectFrom('customer_account')
      .select(['display_name'])
      .where('id', '=', result.accountId)
      .executeTakeFirstOrThrow();
    return account.display_name;
  }

  it('retains a valid provider-supplied display name', async () => {
    expect(await createdAccountName(makeEvidence({ displayName: 'Noor Haddad' }))).toBe(
      'Noor Haddad',
    );
  });

  it('uses the neutral placeholder when the provider supplies no name — never the email local part', async () => {
    const evidence = makeEvidence();
    const name = await createdAccountName(evidence);
    expect(name).toBe('Customer');
    expect(name).not.toBe(evidence.email?.split('@')[0]);
  });

  it('treats Apple private-relay addresses identically: the relay local part is never a name', async () => {
    const name = await createdAccountName(
      makeEvidence({
        provider: 'apple',
        issuer: 'https://appleid.apple.com',
        email: 'xk4q2n9@privaterelay.appleid.com',
        emailVerified: true,
        isPrivateRelay: true,
      }),
    );
    expect(name).toBe('Customer');
  });

  it('uses the neutral placeholder for blank or oversized provider names', async () => {
    expect(await createdAccountName(makeEvidence({ displayName: '   ' }))).toBe('Customer');
    expect(await createdAccountName(makeEvidence({ displayName: 'x'.repeat(600) }))).toBe(
      'Customer',
    );
  });

  it('a repeat first login never rewrites the stored display name', async () => {
    const evidence = makeEvidence({ displayName: 'Original Name' });
    const created = await firstLogin({ db: testDb.db }, { evidence });
    if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
    const repeat = await firstLogin(
      { db: testDb.db },
      { evidence: { ...evidence, displayName: 'Different Name' } },
    );
    expect(repeat.kind).toBe('identityResolved');
    const account = await testDb.db
      .selectFrom('customer_account')
      .select(['display_name'])
      .where('id', '=', created.accountId)
      .executeTakeFirstOrThrow();
    expect(account.display_name).toBe('Original Name');
  });
});

describe('first login — verified-email ownership (no merges, ever)', () => {
  it('refuses a new user claiming an email another user actively verified, without creating anything', async () => {
    const email = `owned-${newId()}@example.test`;
    const owner = await firstLogin(
      { db: testDb.db },
      { evidence: makeEvidence({ email, emailVerified: true }) },
    );
    if (owner.kind !== 'newCustomerCreated') throw new Error(owner.kind);

    const claim = makeEvidence({ email: email.toUpperCase(), emailVerified: true });
    const result = await firstLogin({ db: testDb.db }, { evidence: claim });
    expect(result.kind).toBe('verifiedEmailConflict');
    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('subject', '=', claim.subject)
      .execute();
    expect(identities).toEqual([]);
  });

  it('admits exactly one owner under concurrent cross-user claims; the loser gets the typed conflict', async () => {
    const email = `contested-${newId()}@example.test`;
    const results = await Promise.all([
      firstLogin({ db: testDb.db }, { evidence: makeEvidence({ email, emailVerified: true }) }),
      firstLogin({ db: testDb.db }, { evidence: makeEvidence({ email, emailVerified: true }) }),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['newCustomerCreated', 'verifiedEmailConflict']);
  });
});

describe('first login — account state and evidence validation', () => {
  it('returns typed outcomes for locked and deleted users and suspended accounts', async () => {
    const cases = [
      { userStatus: 'locked', lockedReason: 'test', expected: 'accountLocked' },
      { userStatus: 'deleted', lockedReason: null, expected: 'accountDeleted' },
    ] as const;
    for (const testCase of cases) {
      const evidence = makeEvidence();
      const created = await firstLogin({ db: testDb.db }, { evidence });
      if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
      await testDb.db
        .updateTable('app_user')
        .set({ status: testCase.userStatus, locked_reason: testCase.lockedReason })
        .where('id', '=', created.userId)
        .execute();
      const result = await firstLogin({ db: testDb.db }, { evidence });
      expect(result.kind).toBe(testCase.expected);
    }

    const evidence = makeEvidence();
    const created = await firstLogin({ db: testDb.db }, { evidence });
    if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
    await testDb.db
      .updateTable('customer_account')
      .set({ status: 'suspended' })
      .where('id', '=', created.accountId)
      .execute();
    const suspended = await firstLogin({ db: testDb.db }, { evidence });
    expect(suspended.kind).toBe('accountSuspended');
  });

  it('rejects malformed or incomplete evidence without touching the database', async () => {
    const before = await sql<{ n: string }>`SELECT count(*) AS n FROM app_user`.execute(testDb.db);
    for (const bad of [
      { ...makeEvidence(), issuer: '' },
      { ...makeEvidence(), subject: '   ' },
      { ...withoutEmail(makeEvidence()), emailVerified: true },
    ]) {
      const result = await firstLogin({ db: testDb.db }, { evidence: bad as ProviderEvidence });
      expect(result.kind).toBe('invalidProviderEvidence');
    }
    const after = await sql<{ n: string }>`SELECT count(*) AS n FROM app_user`.execute(testDb.db);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});
