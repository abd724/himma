/**
 * B2-6C — MFA/step-up HTTP routes, principal assurance, administrative MFA
 * enforcement, and the production admin capability gate (docs/26 §6, §10,
 * §11; docs/23 §7). Fastify injection over real PostgreSQL with the
 * deterministic fake providers.
 *
 * Assurance semantics under test: enrollment state alone is never recent
 * step-up assurance; a Himma step_up_grant is session-bound and useless on
 * a dead session; admin surfaces need live session + active Himma role +
 * MFA enrollment + sufficiently recent MFA-verified assurance; production
 * admin activation stays fail-closed until every capability reports ready.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { FakeMfaProvider } from '../src/modules/identity/providers/fake/fake-mfa-provider';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { parseMfaConfig } from '../src/modules/identity/services/mfa-config';
import { firstLogin } from '../src/modules/identity/services/first-login';
import { establishSession } from '../src/modules/identity/services/sessions';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import { sweepDatabaseForValues } from './helpers/db-sweep';
import { bootstrapAccessAdmins } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/mfa-routes-pool';
const STEP_UP_MAX_AGE_SECONDS = 300;

let testDb: TestDb;
let app: FastifyInstance;
let accessVerifier: FakeAccessTokenVerifier;
let mfaProvider: FakeMfaProvider;
let counter = 0;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  accessVerifier = new FakeAccessTokenVerifier();
  mfaProvider = new FakeMfaProvider();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: accessVerifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      stepUpMaxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
      mfaProvider,
      mfaConfig: parseMfaConfig('test', {
        HIMMA_MFA_RECOVERY_CODE_COUNT: '4',
        HIMMA_MFA_CHALLENGE_ATTEMPT_CAP: '3',
      }),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

interface Actor {
  userId: string;
  subject: string;
  sessionId: string;
  bearer: string;
}

async function makeActor(options: {
  assurance?: 'single_factor' | 'mfa';
  authTimeAgeSeconds?: number;
}): Promise<Actor> {
  counter += 1;
  const subject = `mfa-routes-sub-${counter}`;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject,
    email: `mfaroutes${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const created = await firstLogin({ db: testDb.db }, { evidence });
  if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
  const access: AccessTokenEvidence = {
    issuer: ISSUER,
    subject,
    originJti: `mfa-routes-origin-${counter}`,
    scopes: ['openid'],
    assurance: options.assurance ?? 'single_factor',
    expiresAt: new Date(Date.now() + 3_600_000),
    authTime: new Date(Date.now() - (options.authTimeAgeSeconds ?? 0) * 1000),
  };
  const established = await establishSession({ db: testDb.db }, { evidence: access, client: {} });
  if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
  return {
    userId: created.userId,
    subject,
    sessionId: established.sessionId,
    bearer: accessVerifier.issueToken(access),
  };
}

function authed(bearer: string) {
  return { authorization: `Bearer ${bearer}` };
}

async function enrollViaRoutes(actor: Actor): Promise<{ methodId: string; sharedSecret: string }> {
  const begin = await app.inject({
    method: 'POST',
    url: '/auth/mfa/totp/enroll',
    headers: authed(actor.bearer),
    payload: {},
  });
  if (begin.statusCode !== 200) throw new Error(begin.body);
  const { methodId, totp } = begin.json() as { methodId: string; totp: { sharedSecret: string } };
  const confirm = await app.inject({
    method: 'POST',
    url: '/auth/mfa/totp/confirm',
    headers: authed(actor.bearer),
    payload: { methodId, code: mfaProvider.validCodeFor(actor.bearer) },
  });
  if (confirm.statusCode !== 200) throw new Error(confirm.body);
  return { methodId, sharedSecret: totp.sharedSecret };
}

async function stepUpViaRoutes(actor: Actor): Promise<void> {
  const begin = await app.inject({
    method: 'POST',
    url: '/auth/step-up/totp/begin',
    headers: authed(actor.bearer),
    payload: {},
  });
  if (begin.statusCode !== 200) throw new Error(begin.body);
  const { challengeId, providerChallenge } = begin.json() as {
    challengeId: string;
    providerChallenge: string;
  };
  const complete = await app.inject({
    method: 'POST',
    url: '/auth/step-up/totp/complete',
    headers: authed(actor.bearer),
    payload: {
      challengeId,
      providerChallenge,
      code: mfaProvider.validCodeFor(actor.subject),
    },
  });
  if (complete.statusCode !== 200) throw new Error(complete.body);
}

describe('route policies and structure', () => {
  it('declares every MFA route with its explicit policy', () => {
    const policies = new Map(
      app.routePolicyInventory.map((r) => [`${r.method} ${r.url}`, r.policy]),
    );
    expect(policies.get('POST /auth/mfa/totp/enroll')).toBe('stepUpRequired');
    expect(policies.get('POST /auth/mfa/totp/confirm')).toBe('stepUpRequired');
    expect(policies.get('POST /auth/mfa/recovery-codes/regenerate')).toBe('stepUpRequired');
    expect(policies.get('POST /auth/step-up/totp/begin')).toBe('authenticatedCustomer');
    expect(policies.get('POST /auth/step-up/totp/complete')).toBe('authenticatedCustomer');
    expect(policies.get('POST /auth/step-up/recovery-code')).toBe('authenticatedCustomer');
  });

  it('rejects unauthenticated calls on every MFA route', async () => {
    // Schema-valid payloads so the auth gate (not validation) answers.
    const cases: Array<{ url: string; payload: Record<string, unknown> }> = [
      { url: '/auth/mfa/totp/enroll', payload: {} },
      { url: '/auth/mfa/totp/confirm', payload: { methodId: newId(), code: '123456' } },
      { url: '/auth/mfa/recovery-codes/regenerate', payload: {} },
      { url: '/auth/step-up/totp/begin', payload: {} },
      {
        url: '/auth/step-up/totp/complete',
        payload: { challengeId: newId(), code: '123456', providerChallenge: 's' },
      },
      { url: '/auth/step-up/recovery-code', payload: { code: 'aaaa-bbbb' } },
    ];
    for (const { url, payload } of cases) {
      const response = await app.inject({ method: 'POST', url, payload });
      expect(response.statusCode).toBe(401);
    }
  });

  it('schema-rejects malformed MFA payloads', async () => {
    const actor = await makeActor({});
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/confirm',
      headers: authed(actor.bearer),
      payload: { methodId: 'not-a-uuid', code: 42 },
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { code: string }).code).toBe('validationError');
  });
});

describe('TOTP enrollment routes', () => {
  it('begin returns ephemeral material with no-store and persists none of it', async () => {
    const actor = await makeActor({});
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/enroll',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as {
      status: string;
      methodId: string;
      totp: { sharedSecret: string };
    };
    expect(body.status).toBe('enrollmentStarted');
    expect(body.totp.sharedSecret.length).toBeGreaterThan(0);

    const method = await sql<{ state: string }>`
      SELECT state FROM mfa_method WHERE id = ${body.methodId}`.execute(testDb.db);
    expect(method.rows[0]?.state).toBe('pending');
    expect(
      await sweepDatabaseForValues(testDb.db, [body.totp.sharedSecret, actor.bearer]),
    ).toEqual([]);
  });

  it('requires recent step-up assurance to begin enrollment', async () => {
    const stale = await makeActor({ authTimeAgeSeconds: STEP_UP_MAX_AGE_SECONDS + 60 });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/enroll',
      headers: authed(stale.bearer),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('stepUpRequired');
  });

  it('confirm activates only after provider success', async () => {
    const actor = await makeActor({});
    const begin = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/enroll',
      headers: authed(actor.bearer),
      payload: {},
    });
    const { methodId } = begin.json() as { methodId: string };

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/confirm',
      headers: authed(actor.bearer),
      payload: { methodId, code: 'wrong-code' },
    });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { code: string }).code).toBe('challengeInvalid');
    const still = await sql<{ state: string; mfa_enrolled: boolean }>`
      SELECT m.state, u.mfa_enrolled FROM mfa_method m
      JOIN app_user u ON u.id = m.user_id WHERE m.id = ${methodId}`.execute(testDb.db);
    expect(still.rows[0]).toEqual({ state: 'pending', mfa_enrolled: false });

    const right = await app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/confirm',
      headers: authed(actor.bearer),
      payload: { methodId, code: mfaProvider.validCodeFor(actor.bearer) },
    });
    expect(right.statusCode).toBe(200);
    expect((right.json() as { status: string }).status).toBe('mfaEnrolled');
    const enrolled = await sql<{ mfa_enrolled: boolean }>`
      SELECT mfa_enrolled FROM app_user WHERE id = ${actor.userId}`.execute(testDb.db);
    expect(enrolled.rows[0]?.mfa_enrolled).toBe(true);
  });
});

describe('recovery-code routes', () => {
  it('regeneration needs an enrolled user, returns codes exactly once, and stores only digests', async () => {
    const bare = await makeActor({});
    const notEnrolled = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(bare.bearer),
      payload: {},
    });
    expect(notEnrolled.statusCode).toBe(403);
    expect((notEnrolled.json() as { code: string }).code).toBe('mfaRequired');

    const actor = await makeActor({});
    await enrollViaRoutes(actor);
    const first = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const body = first.json() as {
      status: string;
      batchId: string;
      codes: string[];
      presentation: string;
    };
    expect(body.status).toBe('recoveryCodesGenerated');
    expect(body.codes).toHaveLength(4);
    expect(body.presentation).toBe('one-time');
    expect(await sweepDatabaseForValues(testDb.db, body.codes)).toEqual([]);

    // Regeneration replaces the batch and returns entirely new codes.
    const second = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    const secondBody = second.json() as { batchId: string; codes: string[] };
    expect(secondBody.batchId).not.toBe(body.batchId);
    expect(secondBody.codes.some((code) => body.codes.includes(code))).toBe(false);
    const oldBatch = await sql<{ state: string }>`
      SELECT state FROM mfa_recovery_code_batch WHERE id = ${body.batchId}`.execute(testDb.db);
    expect(oldBatch.rows[0]?.state).toBe('superseded');
  });

  it('regeneration requires RECENT step-up — stale sessions are refused even when enrolled', async () => {
    const actor = await makeActor({});
    await enrollViaRoutes(actor);
    // Same user, fresh session whose provider auth is stale and ungranted.
    counter += 1;
    const access: AccessTokenEvidence = {
      issuer: ISSUER,
      subject: actor.subject,
      originJti: `stale-origin-${counter}`,
      scopes: ['openid'],
      assurance: 'single_factor',
      expiresAt: new Date(Date.now() + 3_600_000),
      authTime: new Date(Date.now() - (STEP_UP_MAX_AGE_SECONDS + 120) * 1000),
    };
    const established = await establishSession({ db: testDb.db }, { evidence: access, client: {} });
    if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
    const staleBearer = accessVerifier.issueToken(access);
    const refused = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(staleBearer),
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe('stepUpRequired');
  });
});

describe('TOTP step-up routes', () => {
  it('begin issues an ephemeral provider challenge that never reaches the database', async () => {
    const actor = await makeActor({});
    await enrollViaRoutes(actor);
    const begin = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/begin',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(begin.statusCode).toBe(200);
    expect(begin.headers['cache-control']).toBe('no-store');
    const body = begin.json() as { challengeId: string; providerChallenge: string };
    expect(body.providerChallenge.length).toBeGreaterThan(0);
    const challenge = await sql<{ state: string; login_session_id: string }>`
      SELECT state, login_session_id FROM mfa_challenge WHERE id = ${body.challengeId}`.execute(
      testDb.db,
    );
    expect(challenge.rows[0]).toEqual({ state: 'pending', login_session_id: actor.sessionId });
    expect(await sweepDatabaseForValues(testDb.db, [body.providerChallenge])).toEqual([]);
  });

  it('begin refuses users without an active method', async () => {
    const actor = await makeActor({});
    const begin = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/begin',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(begin.statusCode).toBe(403);
    expect((begin.json() as { code: string }).code).toBe('mfaRequired');
  });

  it('successful completion creates exactly one session-bound grant and unlocks step-up policies', async () => {
    const actor = await makeActor({ authTimeAgeSeconds: STEP_UP_MAX_AGE_SECONDS + 120 });
    // Enrollment needs step-up: enroll through a FRESH actor session first.
    const enrolled = await makeActor({});
    void enrolled;
    // Give the stale actor an active method directly (schema-level fixture).
    await sql`
      INSERT INTO mfa_method (id, user_id, kind, state, confirmed_at)
      VALUES (${newId()}, ${actor.userId}, 'totp', 'active', now())`.execute(testDb.db);

    // Stale session, no grant: a step-up-gated route refuses.
    const before = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect((before.json() as { code: string }).code).toBe('stepUpRequired');

    await stepUpViaRoutes(actor);
    const grants = await sql<{ n: string }>`
      SELECT count(*) AS n FROM step_up_grant WHERE login_session_id = ${actor.sessionId}`.execute(
      testDb.db,
    );
    expect(Number(grants.rows[0]?.n)).toBe(1);

    // The grant now satisfies the step-up policy on the same session.
    const after = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(after.statusCode).toBe(200);
  });

  it('invalid, replayed, and expired challenges create no grant', async () => {
    const actor = await makeActor({});
    await enrollViaRoutes(actor);

    const begin = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/begin',
      headers: authed(actor.bearer),
      payload: {},
    });
    const { challengeId, providerChallenge } = begin.json() as {
      challengeId: string;
      providerChallenge: string;
    };
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/complete',
      headers: authed(actor.bearer),
      payload: { challengeId, providerChallenge, code: 'wrong' },
    });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { code: string }).code).toBe('challengeInvalid');

    // Complete successfully, then REPLAY the same Himma challenge and the
    // same provider session: both refused, still exactly one grant.
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/complete',
      headers: authed(actor.bearer),
      payload: { challengeId, providerChallenge, code: mfaProvider.validCodeFor(actor.subject) },
    });
    expect(ok.statusCode).toBe(200);
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/complete',
      headers: authed(actor.bearer),
      payload: { challengeId, providerChallenge, code: mfaProvider.validCodeFor(actor.subject) },
    });
    expect(replay.statusCode).toBe(400);
    expect((replay.json() as { code: string }).code).toBe('challengeInvalid');

    // An expired Himma challenge (inserted pre-expired) cannot complete.
    const expired = newId();
    await sql`
      INSERT INTO mfa_challenge (id, user_id, login_session_id, purpose, state, expires_at)
      VALUES (${expired}, ${actor.userId}, ${actor.sessionId}, 'step_up', 'pending',
              now() - interval '1 minute')`.execute(testDb.db);
    const expiredResponse = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/complete',
      headers: authed(actor.bearer),
      payload: {
        challengeId: expired,
        providerChallenge,
        code: mfaProvider.validCodeFor(actor.subject),
      },
    });
    expect(expiredResponse.statusCode).toBe(400);

    const grants = await sql<{ n: string }>`
      SELECT count(*) AS n FROM step_up_grant WHERE login_session_id = ${actor.sessionId}`.execute(
      testDb.db,
    );
    expect(Number(grants.rows[0]?.n)).toBe(1);
  });

  it('too many failed attempts return the throttled outcome', async () => {
    const actor = await makeActor({});
    await enrollViaRoutes(actor);
    const begin = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/begin',
      headers: authed(actor.bearer),
      payload: {},
    });
    const { challengeId, providerChallenge } = begin.json() as {
      challengeId: string;
      providerChallenge: string;
    };
    let lastCode = '';
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/step-up/totp/complete',
        headers: authed(actor.bearer),
        payload: { challengeId, providerChallenge, code: 'wrong' },
      });
      lastCode = (response.json() as { code: string }).code;
    }
    expect(lastCode).toBe('rateLimited');
  });
});

describe('recovery-code step-up route', () => {
  async function actorWithCodes(): Promise<{ actor: Actor; codes: string[] }> {
    const actor = await makeActor({});
    await enrollViaRoutes(actor);
    const generated = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    return { actor, codes: (generated.json() as { codes: string[] }).codes };
  }

  it('consumes one code exactly once and creates the session-bound grant', async () => {
    const { actor, codes } = await actorWithCodes();
    const first = await app.inject({
      method: 'POST',
      url: '/auth/step-up/recovery-code',
      headers: authed(actor.bearer),
      payload: { code: codes[0] },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status: string }).status).toBe('stepUpCompleted');
    const grant = await sql<{ method: string }>`
      SELECT method FROM step_up_grant WHERE login_session_id = ${actor.sessionId}
      ORDER BY created_at DESC LIMIT 1`.execute(testDb.db);
    expect(grant.rows[0]?.method).toBe('recovery_code');

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/step-up/recovery-code',
      headers: authed(actor.bearer),
      payload: { code: codes[0] },
    });
    expect(reuse.statusCode).toBe(400);
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/step-up/recovery-code',
      headers: authed(actor.bearer),
      payload: { code: 'zzzz-zzzz-zzzz-zzzz-zzzz-zzzz-zzzz' },
    });
    // Consumed vs never-existed are byte-identical to the caller.
    expect(wrong.statusCode).toBe(reuse.statusCode);
    expect(wrong.body).toBe(reuse.body);
  });

  it('concurrent use of one code admits exactly one winner', async () => {
    const { actor, codes } = await actorWithCodes();
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/step-up/recovery-code',
        headers: authed(actor.bearer),
        payload: { code: codes[1] },
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
  });
});

describe('principal assurance boundaries', () => {
  it('expired or invalidated grants do not satisfy step-up policies', async () => {
    const actor = await makeActor({ authTimeAgeSeconds: STEP_UP_MAX_AGE_SECONDS + 120 });
    await sql`
      INSERT INTO mfa_method (id, user_id, kind, state, confirmed_at)
      VALUES (${newId()}, ${actor.userId}, 'totp', 'active', now())`.execute(testDb.db);

    // Expired grant (inserted with a past window).
    await sql`
      INSERT INTO step_up_grant (id, user_id, login_session_id, method, granted_at, expires_at)
      VALUES (${newId()}, ${actor.userId}, ${actor.sessionId}, 'totp',
              now() - interval '20 minutes', now() - interval '10 minutes')`.execute(testDb.db);
    const expired = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect((expired.json() as { code: string }).code).toBe('stepUpRequired');

    // Live grant satisfies; invalidating it withdraws the assurance.
    const grantId = newId();
    await sql`
      INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
      VALUES (${grantId}, ${actor.userId}, ${actor.sessionId}, 'totp',
              now() + interval '10 minutes')`.execute(testDb.db);
    const live = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(live.statusCode).toBe(200);
    await sql`UPDATE step_up_grant SET invalidated_at = now() WHERE id = ${grantId}`.execute(
      testDb.db,
    );
    const invalidated = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect((invalidated.json() as { code: string }).code).toBe('stepUpRequired');
  });

  it('a revoked session makes an existing grant useless', async () => {
    const actor = await makeActor({});
    await enrollViaRoutes(actor);
    await stepUpViaRoutes(actor);
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'test'
              WHERE id = ${actor.sessionId}`.execute(testDb.db);
    const response = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('sessionExpired');
  });
});

describe('administrative MFA enforcement', () => {
  let adminA: string;

  beforeAll(async () => {
    ({ adminA } = await bootstrapAccessAdmins(testDb.db));
  });

  async function adminBearer(options: {
    assurance: 'single_factor' | 'mfa';
    authTimeAgeSeconds?: number;
    enroll?: boolean;
  }): Promise<{ bearer: string; sessionId: string; subject: string }> {
    counter += 1;
    const subject = `admin-mfa-sub-${counter}`;
    await testDb.db
      .insertInto('auth_identity')
      .values({
        id: newId(),
        user_id: adminA,
        provider: 'google',
        issuer: ISSUER,
        subject,
        email_verified: false,
        is_private_relay: false,
      })
      .execute();
    if (options.enroll === true) {
      const existing = await sql<{ n: string }>`
        SELECT count(*) AS n FROM mfa_method WHERE user_id = ${adminA} AND state = 'active'`.execute(
        testDb.db,
      );
      if (Number(existing.rows[0]?.n) === 0) {
        await sql`
          INSERT INTO mfa_method (id, user_id, kind, state, confirmed_at)
          VALUES (${newId()}, ${adminA}, 'totp', 'active', now())`.execute(testDb.db);
      }
    }
    const access: AccessTokenEvidence = {
      issuer: ISSUER,
      subject,
      originJti: `admin-mfa-origin-${counter}`,
      scopes: ['openid'],
      assurance: options.assurance,
      expiresAt: new Date(Date.now() + 3_600_000),
      authTime: new Date(Date.now() - (options.authTimeAgeSeconds ?? 0) * 1000),
    };
    const established = await establishSession({ db: testDb.db }, { evidence: access, client: {} });
    if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
    return { bearer: accessVerifier.issueToken(access), sessionId: established.sessionId, subject };
  }

  it('an active administrator WITHOUT MFA enrollment is rejected with mfaRequired', async () => {
    // Fresh MFA-asserting token cannot compensate for missing enrollment.
    const { bearer } = await adminBearer({ assurance: 'mfa' });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(bearer),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('mfaRequired');
  });

  it('enrolled admin with an MFA-verified fresh session passes; single-factor and stale sessions are refused precisely', async () => {
    const ok = await adminBearer({ assurance: 'mfa', enroll: true });
    const pass = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(ok.bearer),
    });
    expect(pass.statusCode).toBe(200);

    // Enrolled but the session never completed an MFA factor.
    const singleFactor = await adminBearer({ assurance: 'single_factor', enroll: true });
    const noFactor = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(singleFactor.bearer),
    });
    expect((noFactor.json() as { code: string }).code).toBe('mfaRequired');

    // MFA-verified login, but too long ago and no step-up grant since.
    const stale = await adminBearer({
      assurance: 'mfa',
      authTimeAgeSeconds: STEP_UP_MAX_AGE_SECONDS + 120,
      enroll: true,
    });
    const staleResponse = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(stale.bearer),
    });
    expect((staleResponse.json() as { code: string }).code).toBe('stepUpRequired');

    // A live MFA-method grant restores recency on that stale session.
    await sql`
      INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
      VALUES (${newId()}, ${adminA}, ${stale.sessionId}, 'totp', now() + interval '5 minutes')`.execute(
      testDb.db,
    );
    const granted = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(stale.bearer),
    });
    expect(granted.statusCode).toBe(200);
  });

  it('a non-MFA-method grant (password/oidc) never satisfies admin MFA assurance', async () => {
    const stale = await adminBearer({
      assurance: 'single_factor',
      authTimeAgeSeconds: STEP_UP_MAX_AGE_SECONDS + 120,
      enroll: true,
    });
    await sql`
      INSERT INTO step_up_grant (id, user_id, login_session_id, method, expires_at)
      VALUES (${newId()}, ${adminA}, ${stale.sessionId}, 'password', now() + interval '5 minutes')`.execute(
      testDb.db,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(stale.bearer),
    });
    expect((response.json() as { code: string }).code).toBe('mfaRequired');
  });

  it('normal customers cannot use admin routes regardless of MFA state', async () => {
    const customer = await makeActor({ assurance: 'mfa' });
    await enrollViaRoutes(customer);
    await stepUpViaRoutes(customer);
    const response = await app.inject({
      method: 'GET',
      url: '/admin/role-assignments',
      headers: authed(customer.bearer),
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('forbidden');
  });
});

describe('production admin capability gate', () => {
  function productionApp(readiness?: {
    cognitoConfigured: boolean;
    mfaProviderValidated: boolean;
    realPoolSmokeVerified: boolean;
    productionConfigApproved: boolean;
  }): FastifyInstance {
    return buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: accessVerifier,
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
        nodeEnv: 'production',
        ...(readiness !== undefined ? { adminReadiness: readiness } : {}),
      },
    });
  }

  it('production admin routes stay fail-closed while capabilities are unverified', async () => {
    const closed = productionApp();
    await closed.ready();
    expect(closed.routePolicyInventory.some((r) => r.url.startsWith('/admin'))).toBe(false);
    const response = await closed.inject({ method: 'GET', url: '/admin/role-assignments' });
    expect(response.statusCode).toBe(404);
    await closed.close();

    const partial = productionApp({
      cognitoConfigured: true,
      mfaProviderValidated: true,
      realPoolSmokeVerified: false,
      productionConfigApproved: true,
    });
    await partial.ready();
    expect(partial.routePolicyInventory.some((r) => r.url.startsWith('/admin'))).toBe(false);
    await partial.close();
  });

  it('explicitly forcing admin routes in unready production refuses startup', () => {
    expect(() =>
      buildApp({
        identity: {
          db: testDb.db,
          accessTokenVerifier: accessVerifier,
          idTokenAdapter: new FakeAuthProviderAdapter(),
          mailSender: new CaptureMailSender(),
          rateLimiterStore: new InMemoryRateLimiterStore(),
          nodeEnv: 'production',
          enableAdminRoutes: true,
        },
      }),
    ).toThrow(/fail-closed|not ready|capabilit/i);
  });

  it('a fully-ready production build registers the admin surface', async () => {
    const ready = productionApp({
      cognitoConfigured: true,
      mfaProviderValidated: true,
      realPoolSmokeVerified: true,
      productionConfigApproved: true,
    });
    await ready.ready();
    expect(ready.routePolicyInventory.some((r) => r.url.startsWith('/admin'))).toBe(true);
    await ready.close();
  });
});

describe('secret hygiene across the HTTP surface', () => {
  it('no secret material from full flows exists in the database, audit, or outbox', async () => {
    const actor = await makeActor({});
    const enrolled = await enrollViaRoutes(actor);
    const generated = await app.inject({
      method: 'POST',
      url: '/auth/mfa/recovery-codes/regenerate',
      headers: authed(actor.bearer),
      payload: {},
    });
    const codes = (generated.json() as { codes: string[] }).codes;
    const begin = await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/begin',
      headers: authed(actor.bearer),
      payload: {},
    });
    const { challengeId, providerChallenge } = begin.json() as {
      challengeId: string;
      providerChallenge: string;
    };
    await app.inject({
      method: 'POST',
      url: '/auth/step-up/totp/complete',
      headers: authed(actor.bearer),
      payload: { challengeId, providerChallenge, code: mfaProvider.validCodeFor(actor.subject) },
    });
    expect(
      await sweepDatabaseForValues(testDb.db, [
        enrolled.sharedSecret,
        actor.bearer,
        providerChallenge,
        ...codes,
      ]),
    ).toEqual([]);
  });
});
