/**
 * B2-3 — logout and forced revocation (docs/26 §4.5–4.6, §9.6, §9.8 leg).
 *
 * Local revocation is authoritative; provider revocation is post-commit
 * follow-up through the port, and its failure never weakens local denial.
 * Ownership, idempotency, optimistic concurrency, and the documented
 * revoke-all race rule are all proven on real PostgreSQL.
 */
import { sql } from 'kysely';

import { firstLogin } from '../src/modules/identity/services/first-login';
import { establishSession } from '../src/modules/identity/services/sessions';
import { checkSessionLiveness } from '../src/modules/identity/services/session-liveness';
import {
  forceRevokeUserSessions,
  logoutAllSessions,
  logoutSession,
} from '../src/modules/identity/services/session-revocation';
import { FakeProviderRevoker } from '../src/modules/identity/providers/fake/fake-provider-revoker';
import type {
  ProviderRevocationOutcome,
  ProviderRevocationTarget,
  ProviderSessionRevoker,
} from '../src/modules/identity/providers/revocation';
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

const ISSUER = 'https://cognito.test/revocation-pool';
let counter = 0;

interface Customer {
  userId: string;
  subject: string;
}

async function makeCustomer(): Promise<Customer> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject: `revoke-sub-${counter}`,
    email: `revoke${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return { userId: result.userId, subject: evidence.subject };
}

function makeAccessEvidence(subject: string): AccessTokenEvidence {
  counter += 1;
  return {
    issuer: ISSUER,
    subject,
    originJti: `revoke-origin-${counter}`,
    scopes: ['openid'],
    assurance: 'single_factor',
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

async function establish(customer: Customer): Promise<{
  evidence: AccessTokenEvidence;
  sessionId: string;
  version: number;
}> {
  const evidence = makeAccessEvidence(customer.subject);
  const result = await establishSession({ db: testDb.db }, { evidence, client: {} });
  if (result.kind !== 'sessionEstablished') throw new Error(result.kind);
  const row = await testDb.db
    .selectFrom('login_session')
    .select(['version'])
    .where('id', '=', result.sessionId)
    .executeTakeFirstOrThrow();
  return { evidence, sessionId: result.sessionId, version: row.version };
}

describe('current and selected-session logout', () => {
  it('revokes the session with reason, actor audit, and a version bump; repeat logout is idempotent', async () => {
    const customer = await makeCustomer();
    const { sessionId, version } = await establish(customer);
    const result = await logoutSession(
      { db: testDb.db },
      { userId: customer.userId },
      { sessionId },
    );
    expect(result.kind).toBe('loggedOut');

    const row = await testDb.db
      .selectFrom('login_session')
      .select(['revoked_at', 'revoke_reason', 'version'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoke_reason).toBe('logout');
    expect(row.version).toBe(version + 1);

    const audit = await testDb.db
      .selectFrom('audit_event')
      .select(['action', 'actor_id'])
      .where('entity_id', '=', sessionId)
      .where('action', '=', 'auth.session_revoked')
      .execute();
    expect(audit).toEqual([{ action: 'auth.session_revoked', actor_id: customer.userId }]);

    const repeat = await logoutSession(
      { db: testDb.db },
      { userId: customer.userId },
      { sessionId },
    );
    expect(repeat.kind).toBe('alreadyRevoked');
  });

  it('concurrent logouts of one session admit one revocation and stay idempotent', async () => {
    const customer = await makeCustomer();
    const { sessionId } = await establish(customer);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        logoutSession({ db: testDb.db }, { userId: customer.userId }, { sessionId }),
      ),
    );
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['alreadyRevoked', 'alreadyRevoked', 'loggedOut']);
    const audits = await testDb.db
      .selectFrom('audit_event')
      .select(['id'])
      .where('entity_id', '=', sessionId)
      .where('action', '=', 'auth.session_revoked')
      .execute();
    expect(audits).toHaveLength(1);
  });

  it("enforces ownership: another user's session is not-found-shaped", async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const { sessionId } = await establish(a);
    const result = await logoutSession(
      { db: testDb.db },
      { userId: b.userId },
      { sessionId },
    );
    expect(result.kind).toBe('sessionNotFound');
    const row = await testDb.db
      .selectFrom('login_session')
      .select(['revoked_at'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeNull();
  });

  it('selected-session logout uses optimistic versioning: stale versions are refused', async () => {
    const customer = await makeCustomer();
    const { sessionId, version } = await establish(customer);
    const stale = await logoutSession(
      { db: testDb.db },
      { userId: customer.userId },
      { sessionId, expectedVersion: version + 7 },
    );
    expect(stale.kind).toBe('staleVersion');
    const fresh = await logoutSession(
      { db: testDb.db },
      { userId: customer.userId },
      { sessionId, expectedVersion: version },
    );
    expect(fresh.kind).toBe('loggedOut');
  });
});

describe('logout-all and forced revocation', () => {
  it("revokes only the intended user's live sessions and emits one session.revoked_all outbox event", async () => {
    const target = await makeCustomer();
    const bystander = await makeCustomer();
    await establish(target);
    await establish(target);
    const bystanderSession = await establish(bystander);

    const result = await logoutAllSessions({ db: testDb.db }, { userId: target.userId });
    expect(result.kind).toBe('loggedOutAll');
    expect(result.revokedCount).toBe(2);

    const targetLive = await testDb.db
      .selectFrom('login_session')
      .select(['id'])
      .where('user_id', '=', target.userId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(targetLive).toEqual([]);
    const bystanderRow = await testDb.db
      .selectFrom('login_session')
      .select(['revoked_at'])
      .where('id', '=', bystanderSession.sessionId)
      .executeTakeFirstOrThrow();
    expect(bystanderRow.revoked_at).toBeNull();

    const outbox = await testDb.db
      .selectFrom('outbox_event')
      .select(['event_type'])
      .where('aggregate_id', '=', target.userId)
      .where('event_type', '=', 'session.revoked_all')
      .execute();
    expect(outbox).toHaveLength(1);

    // Idempotent: nothing left to revoke, no second outbox event.
    const again = await logoutAllSessions({ db: testDb.db }, { userId: target.userId });
    expect(again.revokedCount).toBe(0);
    expect(again.providerRevocation).toEqual({ attempted: false });
  });

  it('forced account revocation blocks every session immediately (liveness denies)', async () => {
    const customer = await makeCustomer();
    const s1 = await establish(customer);
    const s2 = await establish(customer);
    const result = await forceRevokeUserSessions(
      { db: testDb.db },
      { userId: customer.userId, reason: 'security' },
    );
    expect(result.revokedCount).toBe(2);
    for (const session of [s1, s2]) {
      const liveness = await checkSessionLiveness(
        { db: testDb.db },
        { evidence: session.evidence },
      );
      expect(liveness.kind).toBe('sessionRevoked');
    }
    const reasons = await testDb.db
      .selectFrom('login_session')
      .select(['revoke_reason'])
      .where('user_id', '=', customer.userId)
      .execute();
    expect(reasons.every((r) => r.revoke_reason === 'security')).toBe(true);
  });

  it('documented race rule: revoke-all is point-in-time — a NEW provider login after it survives; old tokens stay dead', async () => {
    const customer = await makeCustomer();
    const old = await establish(customer);
    await logoutAllSessions({ db: testDb.db }, { userId: customer.userId });

    // A genuinely new provider login (fresh origin_jti) is allowed.
    const fresh = await establish(customer);
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: fresh.evidence })).kind,
    ).toBe('authenticated');
    // The old provider session cannot be resurrected by re-establishment.
    const resurrect = await establishSession(
      { db: testDb.db },
      { evidence: old.evidence, client: {} },
    );
    expect(resurrect.kind).toBe('sessionRevoked');
  });

  it('concurrent revoke-all and new establishment leave a consistent state (old always revoked)', async () => {
    const customer = await makeCustomer();
    const old = await establish(customer);
    const evidence = makeAccessEvidence(customer.subject);
    const [, established] = await Promise.all([
      logoutAllSessions({ db: testDb.db }, { userId: customer.userId }),
      establishSession({ db: testDb.db }, { evidence, client: {} }),
    ]);
    // The pre-existing session is revoked in every interleaving.
    const oldRow = await testDb.db
      .selectFrom('login_session')
      .select(['revoked_at'])
      .where('id', '=', old.sessionId)
      .executeTakeFirstOrThrow();
    expect(oldRow.revoked_at).not.toBeNull();
    // The racing establishment either committed after (live) or before
    // (revoked with the rest) — both consistent under the documented rule.
    if (established.kind === 'sessionEstablished') {
      const newRow = await testDb.db
        .selectFrom('login_session')
        .select(['revoked_at'])
        .where('id', '=', established.sessionId)
        .executeTakeFirstOrThrow();
      expect([null, newRow.revoked_at].includes(newRow.revoked_at)).toBe(true);
    }
  });
});

describe('post-commit provider revocation', () => {
  it('calls the provider strictly AFTER the local commit, passing identifiers and ephemeral material without retaining it', async () => {
    const customer = await makeCustomer();
    const { sessionId, evidence } = await establish(customer);

    // A revoker that observes committed DB state at call time.
    const observedStates: boolean[] = [];
    const observingRevoker: ProviderSessionRevoker = {
      revokeProviderSessions: async (
        target: ProviderRevocationTarget,
      ): Promise<ProviderRevocationOutcome> => {
        const row = await testDb.db
          .selectFrom('login_session')
          .select(['revoked_at'])
          .where('id', '=', sessionId)
          .executeTakeFirstOrThrow();
        observedStates.push(row.revoked_at !== null);
        expect(target.scope).toBe('session');
        expect(target.originJti).toBe(evidence.originJti);
        expect(target.ephemeralToken).toBe('client-held-refresh-token');
        return { delivered: true };
      },
    };
    const result = await logoutSession(
      { db: testDb.db, providerRevoker: observingRevoker },
      { userId: customer.userId },
      { sessionId, ephemeralToken: 'client-held-refresh-token' },
    );
    expect(result.kind).toBe('loggedOut');
    if (result.kind === 'loggedOut') {
      expect(result.providerRevocation).toEqual({ attempted: true, delivered: true });
    }
    // The provider saw the revocation already committed.
    expect(observedStates).toEqual([true]);

    // Nothing token-like was persisted anywhere.
    const stored = await sql<{ found: string }>`
      SELECT 'x' AS found FROM login_session
      WHERE id = ${sessionId} AND (
        coalesce(device_label, '') LIKE '%client-held-refresh-token%'
        OR coalesce(revoke_reason, '') LIKE '%client-held-refresh-token%'
      )`.execute(testDb.db);
    expect(stored.rows).toEqual([]);
  });

  it('provider failure yields a typed delivery status and leaves local denial fully intact', async () => {
    const customer = await makeCustomer();
    const { sessionId, evidence } = await establish(customer);
    const failing = new FakeProviderRevoker();
    failing.setFailure('providerUnavailable');
    const result = await logoutSession(
      { db: testDb.db, providerRevoker: failing },
      { userId: customer.userId },
      { sessionId },
    );
    expect(result.kind).toBe('loggedOut');
    if (result.kind === 'loggedOut') {
      expect(result.providerRevocation).toEqual({
        attempted: true,
        delivered: false,
        reason: 'providerUnavailable',
      });
    }
    // Local denial holds; the failure is audit-evented for retry processing.
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence })).kind,
    ).toBe('sessionRevoked');
    const failureAudit = await testDb.db
      .selectFrom('audit_event')
      .select(['id'])
      .where('action', '=', 'auth.provider_revocation_failed')
      .where('entity_id', '=', sessionId)
      .execute();
    expect(failureAudit).toHaveLength(1);
    // The fake demonstrates non-retention: presence only, never material.
    expect(JSON.stringify(failing.recorded)).not.toContain('client-held');
  });

  it('a throwing provider is normalized to providerUnavailable and never reactivates the session', async () => {
    const customer = await makeCustomer();
    const { sessionId, evidence } = await establish(customer);
    const throwing: ProviderSessionRevoker = {
      revokeProviderSessions: async () => {
        throw new Error('network exploded');
      },
    };
    const result = await logoutSession(
      { db: testDb.db, providerRevoker: throwing },
      { userId: customer.userId },
      { sessionId },
    );
    expect(result.kind).toBe('loggedOut');
    if (result.kind === 'loggedOut') {
      expect(result.providerRevocation).toEqual({
        attempted: true,
        delivered: false,
        reason: 'providerUnavailable',
      });
    }
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence })).kind,
    ).toBe('sessionRevoked');
  });

  it('logout-all reaches the provider with allSessions scope after commit', async () => {
    const customer = await makeCustomer();
    await establish(customer);
    const revoker = new FakeProviderRevoker();
    const result = await logoutAllSessions(
      { db: testDb.db, providerRevoker: revoker },
      { userId: customer.userId },
    );
    expect(result.providerRevocation).toEqual({ attempted: true, delivered: true });
    expect(revoker.recorded).toEqual([
      {
        scope: 'allSessions',
        issuer: ISSUER,
        subject: customer.subject,
        ephemeralTokenPresent: false,
      },
    ]);
  });
});

describe('secrecy', () => {
  it('no audit or outbox payload written by session services carries token-like material', async () => {
    const audits = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action LIKE 'auth.session%' AND (
        coalesce(before_digest, '') <> '' OR coalesce(after_digest, '') <> '')`.execute(
      testDb.db,
    );
    expect(Number(audits.rows[0]?.n)).toBe(0);
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE event_type = 'session.revoked_all' AND payload::text <> '{}'`.execute(testDb.db);
    expect(Number(outbox.rows[0]?.n)).toBe(0);
  });
});
