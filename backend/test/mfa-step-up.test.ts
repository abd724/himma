/**
 * B2-6B — TOTP step-up (docs/26 §3.10) on real PostgreSQL with the fake MFA
 * provider. Provider verification happens outside PostgreSQL; success
 * transactionally passes the B2-6A challenge and creates one session-bound
 * step_up_grant; provider verification alone never grants business
 * permissions, and a revoked session makes every grant useless.
 */
import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import { parseMfaConfig } from '../src/modules/identity/services/mfa-config';
import type { MfaServiceDeps } from '../src/modules/identity/services/mfa-enrollment';
import {
  beginStepUpChallenge,
  completeStepUpWithTotp,
  resolveStepUpAssurance,
} from '../src/modules/identity/services/mfa-step-up';
import { FakeMfaProvider } from '../src/modules/identity/providers/fake/fake-mfa-provider';
import { sweepDatabaseForValues } from './helpers/db-sweep';
import { createIdentity, createSession, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let fake: FakeMfaProvider;
let deps: MfaServiceDeps;

const ATTEMPT_CAP = 3;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
});

beforeEach(() => {
  fake = new FakeMfaProvider();
  deps = {
    db: testDb.db,
    mfaProvider: fake,
    mfaConfig: parseMfaConfig('test', {
      HIMMA_MFA_CHALLENGE_ATTEMPT_CAP: String(ATTEMPT_CAP),
      HIMMA_MFA_STEP_UP_TTL_SECONDS: '600',
    }),
  };
});

afterAll(async () => {
  await testDb.drop();
});

interface Fixture {
  user: string;
  sessionId: string;
}

async function makeFixture(): Promise<Fixture> {
  const user = await createUser(testDb.db);
  await sql`
    INSERT INTO mfa_method (id, user_id, kind, state, confirmed_at)
    VALUES (gen_random_uuid(), ${user}, 'totp', 'active', now())`.execute(testDb.db);
  const identity = await createIdentity(testDb.db, user);
  const session = await createSession(testDb.db, user, identity);
  return { user, sessionId: session.id };
}

async function startChallenge(fixture: Fixture): Promise<string> {
  const started = await beginStepUpChallenge(deps, {
    userId: fixture.user,
    sessionId: fixture.sessionId,
  });
  if (started.kind !== 'challengeStarted') throw new Error(started.kind);
  return started.challengeId;
}

async function grantsForSession(sessionId: string): Promise<number> {
  const rows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM step_up_grant WHERE login_session_id = ${sessionId}`.execute(
    testDb.db,
  );
  return Number(rows.rows[0]?.n);
}

describe('beginning a step-up challenge', () => {
  it('creates a pending session-bound challenge for an enrolled user on a live session', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const row = await sql<{ purpose: string; state: string; login_session_id: string }>`
      SELECT purpose, state, login_session_id FROM mfa_challenge
      WHERE id = ${challengeId}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({
      purpose: 'step_up',
      state: 'pending',
      login_session_id: fixture.sessionId,
    });
  });

  it('refuses users without an active method and sessions that are not live', async () => {
    const noMfa = await createUser(testDb.db);
    const identity = await createIdentity(testDb.db, noMfa);
    const session = await createSession(testDb.db, noMfa, identity);
    expect(
      (await beginStepUpChallenge(deps, { userId: noMfa, sessionId: session.id })).kind,
    ).toBe('notEligible');

    const fixture = await makeFixture();
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'test'
              WHERE id = ${fixture.sessionId}`.execute(testDb.db);
    expect(
      (await beginStepUpChallenge(deps, { userId: fixture.user, sessionId: fixture.sessionId }))
        .kind,
    ).toBe('sessionNotLive');
  });
});

describe('completing step-up with TOTP', () => {
  it('successful provider verification passes the challenge and creates exactly one bounded grant', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const result = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId,
      code: fake.validCodeFor('step-token'),
      providerAccessToken: 'step-token',
    });
    expect(result.kind).toBe('stepUpCompleted');
    if (result.kind !== 'stepUpCompleted') return;

    const challenge = await sql<{ state: string; passed_at: Date | null }>`
      SELECT state, passed_at FROM mfa_challenge WHERE id = ${challengeId}`.execute(testDb.db);
    expect(challenge.rows[0]?.state).toBe('passed');
    expect(challenge.rows[0]?.passed_at).toBeInstanceOf(Date);

    const grant = await sql<{
      user_id: string;
      login_session_id: string;
      method: string;
      window_seconds: number;
    }>`SELECT user_id, login_session_id, method,
              EXTRACT(EPOCH FROM (expires_at - granted_at)) AS window_seconds
       FROM step_up_grant WHERE id = ${result.grantId}`.execute(testDb.db);
    expect(grant.rows[0]?.user_id).toBe(fixture.user);
    expect(grant.rows[0]?.login_session_id).toBe(fixture.sessionId);
    expect(grant.rows[0]?.method).toBe('totp');
    expect(Number(grant.rows[0]?.window_seconds)).toBe(600);

    const assurance = await resolveStepUpAssurance(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
    });
    expect(assurance.assured).toBe(true);

    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'mfa.step_up_completed' AND aggregate_id = ${fixture.user}`.execute(
      testDb.db,
    );
    expect(Number(outbox.rows[0]?.n)).toBe(1);
  });

  it('failed provider verification produces no grant and increments attempts monotonically', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const failed = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId,
      code: 'wrong',
      providerAccessToken: 't',
    });
    expect(failed.kind).toBe('invalidCode');
    const row = await sql<{ state: string; attempt_count: number }>`
      SELECT state, attempt_count FROM mfa_challenge WHERE id = ${challengeId}`.execute(testDb.db);
    expect(row.rows[0]).toEqual({ state: 'pending', attempt_count: 1 });
    expect(await grantsForSession(fixture.sessionId)).toBe(0);
  });

  it('too many failed attempts finalize the challenge with a normalized outcome', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const attempt = () =>
      completeStepUpWithTotp(deps, {
        userId: fixture.user,
        sessionId: fixture.sessionId,
        challengeId,
        code: 'wrong',
        providerAccessToken: 't',
      });
    for (let i = 1; i < ATTEMPT_CAP; i += 1) {
      expect((await attempt()).kind).toBe('invalidCode');
    }
    expect((await attempt()).kind).toBe('tooManyAttempts');
    const row = await sql<{ state: string }>`
      SELECT state FROM mfa_challenge WHERE id = ${challengeId}`.execute(testDb.db);
    expect(row.rows[0]?.state).toBe('failed');
    // Even a now-valid code cannot reuse the finalized challenge.
    const after = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId,
      code: fake.validCodeFor('t'),
      providerAccessToken: 't',
    });
    expect(after.kind).toBe('challengeInvalid');
    expect(await grantsForSession(fixture.sessionId)).toBe(0);
  });

  it('expired and already-used challenges cannot produce a grant', async () => {
    const fixture = await makeFixture();
    // expires_at is immutable after insert (B2-6A), so an already-expired
    // pending challenge is inserted directly.
    const expired = newId();
    await sql`
      INSERT INTO mfa_challenge (id, user_id, login_session_id, purpose, state, expires_at)
      VALUES (${expired}, ${fixture.user}, ${fixture.sessionId}, 'step_up', 'pending',
              now() - interval '1 minute')`.execute(testDb.db);
    const expiredResult = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId: expired,
      code: fake.validCodeFor('t'),
      providerAccessToken: 't',
    });
    expect(expiredResult.kind).toBe('challengeExpired');
    expect(await grantsForSession(fixture.sessionId)).toBe(0);

    const used = await startChallenge(fixture);
    const first = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId: used,
      code: fake.validCodeFor('t'),
      providerAccessToken: 't',
    });
    expect(first.kind).toBe('stepUpCompleted');
    const replay = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId: used,
      code: fake.validCodeFor('t'),
      providerAccessToken: 't',
    });
    expect(replay.kind).toBe('challengeInvalid');
    expect(await grantsForSession(fixture.sessionId)).toBe(1);
  });

  it('concurrent replay of one successful challenge creates exactly one usable grant', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const complete = () =>
      completeStepUpWithTotp(deps, {
        userId: fixture.user,
        sessionId: fixture.sessionId,
        challengeId,
        code: fake.validCodeFor('t'),
        providerAccessToken: 't',
      });
    const results = await Promise.all([complete(), complete()]);
    expect(results.map((r) => r.kind).sort()).toEqual(['challengeInvalid', 'stepUpCompleted']);
    expect(await grantsForSession(fixture.sessionId)).toBe(1);
  });

  it("a challenge cannot be completed by another user or against another session", async () => {
    const fixture = await makeFixture();
    const other = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const wrongUser = await completeStepUpWithTotp(deps, {
      userId: other.user,
      sessionId: other.sessionId,
      challengeId,
      code: fake.validCodeFor('t'),
      providerAccessToken: 't',
    });
    expect(wrongUser.kind).toBe('challengeInvalid');
  });

  it('a revoked session refuses completion and makes existing grants useless', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const completed = await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId,
      code: fake.validCodeFor('t'),
      providerAccessToken: 't',
    });
    expect(completed.kind).toBe('stepUpCompleted');
    expect(
      (await resolveStepUpAssurance(deps, { userId: fixture.user, sessionId: fixture.sessionId }))
        .assured,
    ).toBe(true);

    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'test'
              WHERE id = ${fixture.sessionId}`.execute(testDb.db);
    expect(
      (await resolveStepUpAssurance(deps, { userId: fixture.user, sessionId: fixture.sessionId }))
        .assured,
    ).toBe(false);

    // And a fresh completion attempt on the revoked session is refused.
    const second = await startChallenge(fixture).catch((e) => (e as Error).message);
    expect(second).toBe('sessionNotLive');
  });

  it('secret hygiene: OTP codes and provider tokens never reach the database', async () => {
    const fixture = await makeFixture();
    const challengeId = await startChallenge(fixture);
    const code = fake.validCodeFor('hygiene-step-token');
    await completeStepUpWithTotp(deps, {
      userId: fixture.user,
      sessionId: fixture.sessionId,
      challengeId,
      code,
      providerAccessToken: 'hygiene-step-token',
    });
    expect(await sweepDatabaseForValues(testDb.db, [code, 'hygiene-step-token'])).toEqual([]);
  });
});
