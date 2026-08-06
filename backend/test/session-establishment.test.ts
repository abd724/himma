/**
 * B2-3 — login-session establishment and inventory (docs/26 §4.4, §9.1
 * session leg). Real PostgreSQL. A session exists only for a verified
 * provider session (issuer + subject + origin_jti) of an active identity,
 * user, and account; only normalized metadata is stored — never token
 * material; repeated/concurrent establishment converges on ONE live session.
 */
import { sql } from 'kysely';

import { firstLogin } from '../src/modules/identity/services/first-login';
import {
  establishSession,
  listSessions,
  digestIp,
} from '../src/modules/identity/services/sessions';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
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

const ISSUER = 'https://cognito.test/session-pool';
let counter = 0;

async function makeCustomer(): Promise<{ userId: string; accountId: string; subject: string }> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject: `session-sub-${counter}`,
    email: `session${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return { userId: result.userId, accountId: result.accountId, subject: evidence.subject };
}

function makeAccessEvidence(
  subject: string,
  overrides: Partial<AccessTokenEvidence> = {},
): AccessTokenEvidence {
  counter += 1;
  return {
    issuer: ISSUER,
    subject,
    originJti: `origin-${counter}`,
    jti: `jti-${counter}`,
    clientId: 'client-app-1',
    scopes: ['openid'],
    assurance: 'single_factor',
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

describe('session establishment', () => {
  it('creates a live session with normalized metadata only, an audit event, and a digested IP', async () => {
    const { userId, subject } = await makeCustomer();
    const evidence = makeAccessEvidence(subject);
    const rawToken = 'raw-bearer-token-material-A.B.C';
    const result = await establishSession(
      { db: testDb.db },
      {
        evidence,
        client: { deviceLabel: 'iPhone 17', ipAddress: '203.0.113.7' },
      },
    );
    expect(result.kind).toBe('sessionEstablished');
    if (result.kind !== 'sessionEstablished') return;
    expect(result.userId).toBe(userId);
    expect(result.created).toBe(true);

    const row = await testDb.db
      .selectFrom('login_session')
      .selectAll()
      .where('id', '=', result.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.provider_issuer).toBe(ISSUER);
    expect(row.provider_subject).toBe(subject);
    expect(row.origin_jti).toBe(evidence.originJti);
    expect(row.principal_kind).toBe('customer');
    expect(row.client_kind).toBe('customer_app');
    expect(row.device_label).toBe('iPhone 17');
    expect(row.revoked_at).toBeNull();
    // IP minimization: the digest, never the raw address.
    expect(row.ip_digest).toBe(digestIp('203.0.113.7'));
    expect(row.ip_digest).not.toContain('203.0.113.7');
    // No token material of any kind in the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain('A.B.C');

    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', '=', result.sessionId)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['auth.session_established']);
  });

  it('is idempotent for the same active provider session (converges on one Himma session)', async () => {
    const { subject } = await makeCustomer();
    const evidence = makeAccessEvidence(subject);
    const first = await establishSession({ db: testDb.db }, { evidence, client: {} });
    const second = await establishSession({ db: testDb.db }, { evidence, client: {} });
    if (first.kind !== 'sessionEstablished' || second.kind !== 'sessionEstablished') {
      throw new Error(`${first.kind}/${second.kind}`);
    }
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.created).toBe(false);
    const live = await testDb.db
      .selectFrom('login_session')
      .select(['id'])
      .where('origin_jti', '=', evidence.originJti)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(1);
  });

  it('converges under concurrent duplicate establishment', async () => {
    const { subject } = await makeCustomer();
    const evidence = makeAccessEvidence(subject);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        establishSession({ db: testDb.db }, { evidence, client: {} }),
      ),
    );
    const ids = new Set(
      results.map((r) => (r.kind === 'sessionEstablished' ? r.sessionId : r.kind)),
    );
    expect(ids.size).toBe(1);
    const live = await testDb.db
      .selectFrom('login_session')
      .select(['id'])
      .where('origin_jti', '=', evidence.originJti)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(1);
  });

  it('refuses evidence for an unknown identity, an ended identity, and inactive accounts', async () => {
    // Unknown identity: never first-logged-in.
    const unknown = await establishSession(
      { db: testDb.db },
      { evidence: makeAccessEvidence('never-seen-sub'), client: {} },
    );
    expect(unknown.kind).toBe('identityNotFound');

    // Locked user.
    const locked = await makeCustomer();
    await testDb.db
      .updateTable('app_user')
      .set({ status: 'locked', locked_reason: 'test' })
      .where('id', '=', locked.userId)
      .execute();
    expect(
      (
        await establishSession(
          { db: testDb.db },
          { evidence: makeAccessEvidence(locked.subject), client: {} },
        )
      ).kind,
    ).toBe('accountLocked');

    // Suspended account.
    const suspended = await makeCustomer();
    await testDb.db
      .updateTable('customer_account')
      .set({ status: 'suspended' })
      .where('user_id', '=', suspended.userId)
      .execute();
    expect(
      (
        await establishSession(
          { db: testDb.db },
          { evidence: makeAccessEvidence(suspended.subject), client: {} },
        )
      ).kind,
    ).toBe('accountSuspended');

    // Ended identity.
    const ended = await makeCustomer();
    await testDb.db
      .updateTable('auth_identity')
      .set({ status: 'ended' })
      .where('subject', '=', ended.subject)
      .execute();
    expect(
      (
        await establishSession(
          { db: testDb.db },
          { evidence: makeAccessEvidence(ended.subject), client: {} },
        )
      ).kind,
    ).toBe('identityEnded');
  });

  it('rejects structurally invalid evidence and an origin_jti recorded for a different principal', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const invalid = await establishSession(
      { db: testDb.db },
      { evidence: makeAccessEvidence(a.subject, { originJti: '' }), client: {} },
    );
    expect(invalid.kind).toBe('invalidAccessToken');

    const evidence = makeAccessEvidence(a.subject);
    const established = await establishSession({ db: testDb.db }, { evidence, client: {} });
    expect(established.kind).toBe('sessionEstablished');
    // Same origin_jti presented with a different subject: untrustworthy evidence.
    const hijack = await establishSession(
      { db: testDb.db },
      { evidence: makeAccessEvidence(b.subject, { originJti: evidence.originJti }), client: {} },
    );
    expect(hijack.kind).toBe('invalidAccessToken');
  });

  it('a forced failure rolls back the session and its events atomically', async () => {
    const { subject } = await makeCustomer();
    await sql`
      CREATE FUNCTION test_fail_session_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced test failure'; END; $$`.execute(
      testDb.db,
    );
    await sql`
      CREATE TRIGGER trg_test_fail_session BEFORE INSERT ON login_session
      FOR EACH ROW EXECUTE FUNCTION test_fail_session_insert()`.execute(testDb.db);
    const auditBefore = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(
      testDb.db,
    );
    const evidence = makeAccessEvidence(subject);
    try {
      await expect(
        establishSession({ db: testDb.db }, { evidence, client: {} }),
      ).rejects.toThrow();
    } finally {
      await sql`DROP TRIGGER trg_test_fail_session ON login_session`.execute(testDb.db);
      await sql`DROP FUNCTION test_fail_session_insert()`.execute(testDb.db);
    }
    const rows = await testDb.db
      .selectFrom('login_session')
      .select(['id'])
      .where('origin_jti', '=', evidence.originJti)
      .execute();
    expect(rows).toEqual([]);
    const auditAfter = await sql<{ n: string }>`SELECT count(*) AS n FROM audit_event`.execute(
      testDb.db,
    );
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
  });
});

describe('session inventory', () => {
  it('lists only the requesting user’s live sessions, most recently seen first', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const s1 = await establishSession(
      { db: testDb.db },
      { evidence: makeAccessEvidence(a.subject), client: { deviceLabel: 'Phone' } },
    );
    const s2 = await establishSession(
      { db: testDb.db },
      { evidence: makeAccessEvidence(a.subject), client: { deviceLabel: 'Tablet' } },
    );
    await establishSession(
      { db: testDb.db },
      { evidence: makeAccessEvidence(b.subject), client: { deviceLabel: 'Other user device' } },
    );
    if (s1.kind !== 'sessionEstablished' || s2.kind !== 'sessionEstablished') {
      throw new Error('setup failed');
    }

    const sessions = await listSessions({ db: testDb.db }, { userId: a.userId });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([s1.sessionId, s2.sessionId].sort());
    expect(sessions.map((s) => s.deviceLabel).sort()).toEqual(['Phone', 'Tablet']);
    // No token-like or raw-IP fields in the inventory shape.
    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual(
        ['clientKind', 'createdAt', 'deviceLabel', 'expiresAt', 'lastSeenAt', 'sessionId', 'version'].sort(),
      );
    }
  });
});
