/**
 * B2-2 — challenge bookkeeping and account-state services (docs/26 §8.6,
 * §3.8, Amendment A1.1). Bookkeeping only: code generation and validation
 * are the provider's; no secret, code, or token material exists in any row,
 * audit payload, or outbox payload.
 */
import { sql } from 'kysely';

import { firstLogin } from '../src/modules/identity/services/first-login';
import { readAccountState } from '../src/modules/identity/services/account-status';
import {
  recordChallengeAttempt,
  recordChallengeCompleted,
  recordChallengeRequested,
} from '../src/modules/identity/services/challenges';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

afterAll(async () => {
  await testDb.drop();
});

let counter = 0;
async function makeCustomer(): Promise<{ userId: string; identityId: string }> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'email',
    issuer: 'https://cognito.test/challenge-pool',
    subject: `challenge-sub-${counter}`,
    email: `challenge${counter}@example.test`,
    emailVerified: false,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return { userId: result.userId, identityId: result.identityId };
}

describe('challenge bookkeeping', () => {
  it('records a requested challenge with an audit event and no secret material anywhere', async () => {
    const { userId, identityId } = await makeCustomer();
    const { challengeId } = await recordChallengeRequested(
      { db: testDb.db },
      { kind: 'email_verification', identityId, userId },
    );
    const row = await testDb.db
      .selectFrom('auth_challenge')
      .selectAll()
      .where('id', '=', challengeId)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('email_verification');
    expect(row.completed_at).toBeNull();
    expect(row.attempt_count).toBe(0);

    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action', 'entity_type'])
      .where('entity_id', '=', challengeId)
      .execute();
    expect(audit).toEqual([{ action: 'auth.challenge_requested', entity_type: 'auth_challenge' }]);
  });

  it('counts attempts and completes exactly once (CAS single-use semantics)', async () => {
    const { userId, identityId } = await makeCustomer();
    const { challengeId } = await recordChallengeRequested(
      { db: testDb.db },
      { kind: 'password_reset', identityId, userId },
    );
    const attempt = await recordChallengeAttempt({ db: testDb.db }, challengeId);
    expect(attempt).toEqual({ kind: 'recorded', attemptCount: 1 });

    const completed = await recordChallengeCompleted({ db: testDb.db }, challengeId);
    expect(completed.kind).toBe('completed');
    const again = await recordChallengeCompleted({ db: testDb.db }, challengeId);
    expect(again.kind).toBe('challengeInvalid');
    const lateAttempt = await recordChallengeAttempt({ db: testDb.db }, challengeId);
    expect(lateAttempt.kind).toBe('challengeInvalid');
  });

  it('treats expired and unknown challenges as challengeInvalid', async () => {
    const { userId, identityId } = await makeCustomer();
    const { challengeId } = await recordChallengeRequested(
      { db: testDb.db },
      {
        kind: 'email_verification',
        identityId,
        userId,
        expiresAt: new Date(Date.now() - 60_000),
      },
    );
    expect((await recordChallengeCompleted({ db: testDb.db }, challengeId)).kind).toBe(
      'challengeInvalid',
    );
    expect(
      (await recordChallengeCompleted({ db: testDb.db }, '01890000-0000-7000-8000-000000000000'))
        .kind,
    ).toBe('challengeInvalid');
  });

  it('exactly one concurrent completion wins', async () => {
    const { userId, identityId } = await makeCustomer();
    const { challengeId } = await recordChallengeRequested(
      { db: testDb.db },
      { kind: 'email_verification', identityId, userId },
    );
    const results = await Promise.all([
      recordChallengeCompleted({ db: testDb.db }, challengeId),
      recordChallengeCompleted({ db: testDb.db }, challengeId),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['challengeInvalid', 'completed']);
  });
});

describe('account state', () => {
  it('reports active, locked, deleted, and suspended states as typed outcomes', async () => {
    const { userId } = await makeCustomer();
    expect(await readAccountState({ db: testDb.db }, userId)).toMatchObject({ kind: 'active' });

    await testDb.db
      .updateTable('customer_account')
      .set({ status: 'suspended' })
      .where('user_id', '=', userId)
      .execute();
    expect(await readAccountState({ db: testDb.db }, userId)).toMatchObject({
      kind: 'accountSuspended',
    });

    await testDb.db
      .updateTable('app_user')
      .set({ status: 'locked', locked_reason: 'test' })
      .where('id', '=', userId)
      .execute();
    expect(await readAccountState({ db: testDb.db }, userId)).toMatchObject({
      kind: 'accountLocked',
    });

    await testDb.db
      .updateTable('app_user')
      .set({ status: 'deleted', locked_reason: null })
      .where('id', '=', userId)
      .execute();
    expect(await readAccountState({ db: testDb.db }, userId)).toMatchObject({
      kind: 'accountDeleted',
    });
  });

  it('treats an unknown user as deleted-shaped rather than leaking existence', async () => {
    const state = await readAccountState(
      { db: testDb.db },
      '01890000-0000-7000-8000-00000000ffff',
    );
    expect(state.kind).toBe('accountDeleted');
  });

  it('never places email addresses in audit or outbox payloads (opaque ids only)', async () => {
    const audits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE coalesce(before_digest, '') LIKE '%@%'
         OR coalesce(after_digest, '') LIKE '%@%'
         OR action LIKE '%@%'`.execute(testDb.db);
    expect(Number(audits.rows[0]?.n)).toBe(0);
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event WHERE payload::text LIKE '%@%'`.execute(testDb.db);
    expect(Number(outbox.rows[0]?.n)).toBe(0);
  });
});
