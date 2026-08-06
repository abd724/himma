/**
 * B2-3 — per-request session liveness (docs/26 §4.7). Provider-independent:
 * receives already-verified access-token evidence, resolves the Himma
 * session-of-record, gates on session/identity/user/account state, and
 * returns a framework-neutral principal context. Business roles never come
 * from provider claims — the principal carries none.
 */
import { firstLogin } from '../src/modules/identity/services/first-login';
import { establishSession } from '../src/modules/identity/services/sessions';
import { checkSessionLiveness } from '../src/modules/identity/services/session-liveness';
import { logoutSession } from '../src/modules/identity/services/session-revocation';
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

const ISSUER = 'https://cognito.test/liveness-pool';
let counter = 0;

interface Customer {
  userId: string;
  accountId: string;
  subject: string;
}

async function makeCustomer(): Promise<Customer> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject: `liveness-sub-${counter}`,
    email: `liveness${counter}@example.test`,
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
    originJti: `liveness-origin-${counter}`,
    scopes: ['openid'],
    assurance: 'single_factor',
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

async function establishedSession(customer: Customer): Promise<{
  evidence: AccessTokenEvidence;
  sessionId: string;
}> {
  const evidence = makeAccessEvidence(customer.subject);
  const result = await establishSession({ db: testDb.db }, { evidence, client: {} });
  if (result.kind !== 'sessionEstablished') throw new Error(result.kind);
  return { evidence, sessionId: result.sessionId };
}

describe('session liveness', () => {
  it('authenticates an active session with a framework-neutral, role-free principal', async () => {
    const customer = await makeCustomer();
    const { evidence, sessionId } = await establishedSession(customer);
    const result = await checkSessionLiveness({ db: testDb.db }, { evidence });
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') return;
    expect(result.principal).toMatchObject({
      principalKind: 'customer',
      userId: customer.userId,
      accountId: customer.accountId,
      sessionId,
      assurance: 'single_factor',
    });
    // No business roles, ever, from provider claims.
    expect(JSON.stringify(result.principal)).not.toContain('role');
    expect(JSON.stringify(result.principal)).not.toContain('admin');
  });

  it('rejects evidence with no registered session (not-found-shaped)', async () => {
    const customer = await makeCustomer();
    const result = await checkSessionLiveness(
      { db: testDb.db },
      { evidence: makeAccessEvidence(customer.subject) },
    );
    expect(result.kind).toBe('sessionNotRegistered');
  });

  it('rejects a session registered under different provider identifiers (not-found-shaped)', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const { evidence } = await establishedSession(a);
    const result = await checkSessionLiveness(
      { db: testDb.db },
      { evidence: { ...evidence, subject: b.subject } },
    );
    expect(result.kind).toBe('sessionNotRegistered');
  });

  it('rejects revoked and expired sessions with distinct typed outcomes', async () => {
    const customer = await makeCustomer();
    const revoked = await establishedSession(customer);
    const logout = await logoutSession(
      { db: testDb.db },
      { userId: customer.userId },
      { sessionId: revoked.sessionId },
    );
    expect(logout.kind).toBe('loggedOut');
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: revoked.evidence })).kind,
    ).toBe('sessionRevoked');

    const expired = await establishedSession(customer);
    await testDb.db
      .updateTable('login_session')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', expired.sessionId)
      .execute();
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: expired.evidence })).kind,
    ).toBe('sessionExpired');
  });

  it('rejects locked, suspended, and deleted account states and ended identities', async () => {
    const locked = await makeCustomer();
    const lockedSession = await establishedSession(locked);
    await testDb.db
      .updateTable('app_user')
      .set({ status: 'locked', locked_reason: 'test' })
      .where('id', '=', locked.userId)
      .execute();
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: lockedSession.evidence })).kind,
    ).toBe('accountLocked');

    const suspended = await makeCustomer();
    const suspendedSession = await establishedSession(suspended);
    await testDb.db
      .updateTable('customer_account')
      .set({ status: 'suspended' })
      .where('user_id', '=', suspended.userId)
      .execute();
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: suspendedSession.evidence }))
        .kind,
    ).toBe('accountSuspended');

    const deleted = await makeCustomer();
    const deletedSession = await establishedSession(deleted);
    await testDb.db
      .updateTable('app_user')
      .set({ status: 'deleted' })
      .where('id', '=', deleted.userId)
      .execute();
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: deletedSession.evidence })).kind,
    ).toBe('accountDeleted');

    const ended = await makeCustomer();
    const endedSession = await establishedSession(ended);
    await testDb.db
      .updateTable('auth_identity')
      .set({ status: 'ended' })
      .where('subject', '=', ended.subject)
      .execute();
    expect(
      (await checkSessionLiveness({ db: testDb.db }, { evidence: endedSession.evidence })).kind,
    ).toBe('identityEnded');
  });

  it('rejects structurally invalid evidence without touching session state', async () => {
    const customer = await makeCustomer();
    const { evidence } = await establishedSession(customer);
    const result = await checkSessionLiveness(
      { db: testDb.db },
      { evidence: { ...evidence, originJti: '' } },
    );
    expect(result.kind).toBe('invalidAccessToken');
  });

  it('by default reads without mutating the session row', async () => {
    const customer = await makeCustomer();
    const { evidence, sessionId } = await establishedSession(customer);
    const before = await testDb.db
      .selectFrom('login_session')
      .select(['version', 'last_seen_at'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    await checkSessionLiveness({ db: testDb.db }, { evidence });
    const after = await testDb.db
      .selectFrom('login_session')
      .select(['version', 'last_seen_at'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('never authorizes a request after a revocation has committed — including under concurrency', async () => {
    const customer = await makeCustomer();
    const { evidence, sessionId } = await establishedSession(customer);

    // Concurrent revocation + liveness storm: whatever interleaving occurs,
    // every liveness check STARTED after the revocation commit must deny.
    const revocation = logoutSession(
      { db: testDb.db },
      { userId: customer.userId },
      { sessionId },
    );
    const during = Promise.all(
      Array.from({ length: 4 }, () => checkSessionLiveness({ db: testDb.db }, { evidence })),
    );
    await Promise.all([revocation, during]);

    // The documented rule: after the revocation commits, liveness is denied.
    const after = await checkSessionLiveness({ db: testDb.db }, { evidence });
    expect(after.kind).toBe('sessionRevoked');
    const repeat = await checkSessionLiveness({ db: testDb.db }, { evidence });
    expect(repeat.kind).toBe('sessionRevoked');
  });
});
