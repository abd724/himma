/**
 * B2-6B — TOTP enrollment services (docs/26 §5.8, §13 B2-6, A1.1) on real
 * PostgreSQL with the deterministic fake MFA provider. Cognito is invoked
 * OUTSIDE PostgreSQL transactions; activation happens transactionally only
 * after provider verification succeeds; the shared secret exists only as an
 * ephemeral in-memory service result and never touches any table, audit
 * payload, or outbox payload.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { parseMfaConfig } from '../src/modules/identity/services/mfa-config';
import {
  beginTotpEnrollment,
  completeTotpEnrollment,
  type MfaServiceDeps,
} from '../src/modules/identity/services/mfa-enrollment';
import { FakeMfaProvider } from '../src/modules/identity/providers/fake/fake-mfa-provider';
import { sweepDatabaseForValues } from './helpers/db-sweep';
import { createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let fake: FakeMfaProvider;
let deps: MfaServiceDeps;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

beforeEach(() => {
  fake = new FakeMfaProvider();
  deps = { db: testDb.db, mfaProvider: fake, mfaConfig: parseMfaConfig('test', {}) };
});

afterAll(async () => {
  await testDb.drop();
});

async function methodRow(methodId: string) {
  const row = await sql<{
    state: string;
    confirmed_at: Date | null;
    user_id: string;
  }>`SELECT state, confirmed_at, user_id FROM mfa_method WHERE id = ${methodId}`.execute(
    testDb.db,
  );
  return row.rows[0];
}

async function mirrorOf(userId: string): Promise<boolean> {
  const row = await sql<{ mfa_enrolled: boolean }>`
    SELECT mfa_enrolled FROM app_user WHERE id = ${userId}`.execute(testDb.db);
  return row.rows[0]?.mfa_enrolled === true;
}

async function enroll(userId: string, token: string): Promise<string> {
  const started = await beginTotpEnrollment(deps, { userId, providerAccessToken: token });
  if (started.kind !== 'enrollmentStarted') throw new Error(started.kind);
  const completed = await completeTotpEnrollment(deps, {
    userId,
    methodId: started.methodId,
    code: fake.validCodeFor(token),
    providerAccessToken: token,
  });
  if (completed.kind !== 'mfaEnrolled') throw new Error(completed.kind);
  return started.methodId;
}

describe('begin TOTP enrollment', () => {
  it('creates a pending method only, returning the ephemeral material without persisting it', async () => {
    const user = await createUser(testDb.db);
    const result = await beginTotpEnrollment(deps, {
      userId: user,
      providerAccessToken: 'begin-token-1',
    });
    expect(result.kind).toBe('enrollmentStarted');
    if (result.kind !== 'enrollmentStarted') return;
    expect(result.material.sharedSecret.length).toBeGreaterThan(0);

    const row = await methodRow(result.methodId);
    expect(row?.state).toBe('pending');
    expect(await mirrorOf(user)).toBe(false);

    // The secret and the provider access token exist NOWHERE in the database.
    expect(
      await sweepDatabaseForValues(testDb.db, [result.material.sharedSecret, 'begin-token-1']),
    ).toEqual([]);
  });

  it('refuses ineligible users and creates nothing on provider failure', async () => {
    const locked = await createUser(testDb.db);
    await sql`UPDATE app_user SET status = 'locked', locked_reason = 'test'
              WHERE id = ${locked}`.execute(testDb.db);
    expect(
      (await beginTotpEnrollment(deps, { userId: locked, providerAccessToken: 't' })).kind,
    ).toBe('notEligible');

    const user = await createUser(testDb.db);
    fake.setUnavailable(true);
    expect(
      (await beginTotpEnrollment(deps, { userId: user, providerAccessToken: 't2' })).kind,
    ).toBe('providerUnavailable');
    const rows = await sql<{ n: string }>`
      SELECT count(*) AS n FROM mfa_method WHERE user_id = ${user}`.execute(testDb.db);
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it('re-beginning supersedes the stale pending enrollment instead of failing', async () => {
    const user = await createUser(testDb.db);
    const first = await beginTotpEnrollment(deps, { userId: user, providerAccessToken: 'a' });
    if (first.kind !== 'enrollmentStarted') throw new Error(first.kind);
    const second = await beginTotpEnrollment(deps, { userId: user, providerAccessToken: 'b' });
    expect(second.kind).toBe('enrollmentStarted');
    if (second.kind !== 'enrollmentStarted') return;
    expect((await methodRow(first.methodId))?.state).toBe('superseded');
    expect((await methodRow(second.methodId))?.state).toBe('pending');
  });
});

describe('complete TOTP enrollment', () => {
  it('activates only after provider verification succeeds, and the database maintains the mirror', async () => {
    const user = await createUser(testDb.db);
    const methodId = await enroll(user, 'complete-token');
    const row = await methodRow(methodId);
    expect(row?.state).toBe('active');
    expect(row?.confirmed_at).toBeInstanceOf(Date);
    expect(await mirrorOf(user)).toBe(true);

    const audit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'auth.mfa_enrolled' AND entity_id = ${methodId}`.execute(testDb.db);
    expect(Number(audit.rows[0]?.n)).toBe(1);
    const outbox = await sql<{ payload: unknown }>`
      SELECT payload FROM outbox_event
      WHERE event_type = 'mfa.enrolled' AND aggregate_id = ${user}`.execute(testDb.db);
    expect(outbox.rows).toHaveLength(1);
  });

  it('failed provider verification never activates MFA', async () => {
    const user = await createUser(testDb.db);
    const started = await beginTotpEnrollment(deps, { userId: user, providerAccessToken: 'f' });
    if (started.kind !== 'enrollmentStarted') throw new Error(started.kind);
    const failed = await completeTotpEnrollment(deps, {
      userId: user,
      methodId: started.methodId,
      code: 'wrong-code',
      providerAccessToken: 'f',
    });
    expect(failed.kind).toBe('invalidCode');
    expect((await methodRow(started.methodId))?.state).toBe('pending');
    expect(await mirrorOf(user)).toBe(false);
    const enrolledEvents = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'mfa.enrolled' AND aggregate_id = ${user}`.execute(testDb.db);
    expect(Number(enrolledEvents.rows[0]?.n)).toBe(0);
    const failureAudit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action = 'auth.mfa_enrollment_failed' AND entity_id = ${started.methodId}`.execute(
      testDb.db,
    );
    expect(Number(failureAudit.rows[0]?.n)).toBe(1);
  });

  it('an expired pending enrollment cannot activate even with stale valid provider material', async () => {
    const user = await createUser(testDb.db);
    // The enrollment window is immutable after insert (B2-6A), so an
    // already-expired pending enrollment is inserted directly.
    const methodId = newId();
    await sql`
      INSERT INTO mfa_method (id, user_id, kind, state, enrollment_expires_at)
      VALUES (${methodId}, ${user}, 'totp', 'pending', now() - interval '1 minute')`.execute(
      testDb.db,
    );
    const result = await completeTotpEnrollment(deps, {
      userId: user,
      methodId,
      code: fake.validCodeFor('e'),
      providerAccessToken: 'e',
    });
    expect(result.kind).toBe('enrollmentInvalid');
    expect((await methodRow(methodId))?.state).toBe('pending');
    expect(await mirrorOf(user)).toBe(false);
  });

  it("refuses another user's enrollment and unknown methods with one normalized outcome", async () => {
    const owner = await createUser(testDb.db);
    const stranger = await createUser(testDb.db);
    const started = await beginTotpEnrollment(deps, { userId: owner, providerAccessToken: 'o' });
    if (started.kind !== 'enrollmentStarted') throw new Error(started.kind);
    expect(
      (
        await completeTotpEnrollment(deps, {
          userId: stranger,
          methodId: started.methodId,
          code: fake.validCodeFor('o'),
          providerAccessToken: 'o',
        })
      ).kind,
    ).toBe('enrollmentInvalid');
  });

  it('replacement enrollment supersedes the previous active method atomically', async () => {
    const user = await createUser(testDb.db);
    const firstMethod = await enroll(user, 'first');
    const started = await beginTotpEnrollment(deps, { userId: user, providerAccessToken: 'second' });
    if (started.kind !== 'enrollmentStarted') throw new Error(started.kind);
    const completed = await completeTotpEnrollment(deps, {
      userId: user,
      methodId: started.methodId,
      code: fake.validCodeFor('second'),
      providerAccessToken: 'second',
    });
    expect(completed.kind).toBe('mfaEnrolled');
    if (completed.kind !== 'mfaEnrolled') return;
    expect(completed.supersededMethodId).toBe(firstMethod);
    expect((await methodRow(firstMethod))?.state).toBe('superseded');
    expect((await methodRow(started.methodId))?.state).toBe('active');
    expect(await mirrorOf(user)).toBe(true);
    const active = await sql<{ n: string }>`
      SELECT count(*) AS n FROM mfa_method
      WHERE user_id = ${user} AND state = 'active'`.execute(testDb.db);
    expect(Number(active.rows[0]?.n)).toBe(1);
    const superseded = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'mfa.method_superseded' AND aggregate_id = ${user}`.execute(testDb.db);
    expect(Number(superseded.rows[0]?.n)).toBe(1);
  });

  it('secret hygiene: no shared secret, provider token, or OTP code anywhere in the database', async () => {
    const user = await createUser(testDb.db);
    const started = await beginTotpEnrollment(deps, {
      userId: user,
      providerAccessToken: 'hygiene-token',
    });
    if (started.kind !== 'enrollmentStarted') throw new Error(started.kind);
    const code = fake.validCodeFor('hygiene-token');
    await completeTotpEnrollment(deps, {
      userId: user,
      methodId: started.methodId,
      code,
      providerAccessToken: 'hygiene-token',
    });
    expect(
      await sweepDatabaseForValues(testDb.db, [
        started.material.sharedSecret,
        'hygiene-token',
        code,
      ]),
    ).toEqual([]);
  });
});
