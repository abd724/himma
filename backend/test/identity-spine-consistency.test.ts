/**
 * B2-3 correction task — identity-spine consistency proof (owner directive
 * 2026-08-06).
 *
 * Proves structurally and end-to-end that the subject persisted by B2-2
 * first login is the SAME stable subject carried by Cognito API access
 * tokens: both Cognito adapters verify the token's `iss` against the
 * configured pool issuer and emit (pool issuer, Cognito user `sub`) — the
 * external Apple/Google subject appears only inside the `identities` claim
 * and is used solely as provenance, never as the identity key. Sessions
 * are tied to that canonical identity by the login_session composite FK.
 *
 * These tests run the REAL Cognito ID-token adapter and access-token
 * verifier over locally generated JWKS (no AWS), through the real
 * first-login/session services on real PostgreSQL.
 */
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import type { JWK, JWTPayload } from 'jose';

import { CognitoAuthProviderAdapter } from '../src/modules/identity/providers/cognito/cognito-adapter';
import { CognitoAccessTokenVerifier } from '../src/modules/identity/providers/cognito/cognito-access-token-verifier';
import type { CognitoAdapterConfig } from '../src/modules/identity/providers/cognito/config';
import { firstLogin } from '../src/modules/identity/services/first-login';
import { linkIdentity } from '../src/modules/identity/services/link-identity';
import { establishSession } from '../src/modules/identity/services/sessions';
import { checkSessionLiveness } from '../src/modules/identity/services/session-liveness';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const POOL_ISSUER = 'https://cognito-idp.test-region-1.amazonaws.com/spine_pool_fixture';
const CLIENT_ID = 'client-app-1';
const CONFIG: CognitoAdapterConfig = { issuer: POOL_ISSUER, clientIds: [CLIENT_ID] };

let testDb: TestDb;
let idAdapter: CognitoAuthProviderAdapter;
let accessVerifier: CognitoAccessTokenVerifier;
let signIdToken: (payload: JWTPayload) => Promise<string>;
let signAccessToken: (payload: JWTPayload) => Promise<string>;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const getKey = createLocalJWKSet({ keys: [jwk] });
  idAdapter = new CognitoAuthProviderAdapter(CONFIG, { getKey });
  accessVerifier = new CognitoAccessTokenVerifier(CONFIG, { getKey });
  signIdToken = (payload) =>
    new SignJWT({ token_use: 'id', ...payload })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(POOL_ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  signAccessToken = (payload) =>
    new SignJWT({ token_use: 'access', client_id: CLIENT_ID, scope: 'openid', ...payload })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(POOL_ISSUER)
      .setIssuedAt()
      .setExpirationTime('30m')
      .sign(privateKey);
});

afterAll(async () => {
  await testDb.drop();
});

let counter = 0;

/** Full flow: Cognito ID-token first login, then access-token session. */
async function loginThenEstablish(idClaims: JWTPayload): Promise<{
  cognitoSub: string;
  userId: string;
  identityId: string;
  sessionUserId: string;
  sessionId: string;
  originJti: string;
}> {
  const cognitoSub = String(idClaims.sub);
  const idResult = await idAdapter.validateToken(await signIdToken(idClaims));
  if (!idResult.ok) throw new Error(`id token rejected: ${idResult.reason}`);
  const login = await firstLogin({ db: testDb.db }, { evidence: idResult.evidence });
  if (login.kind !== 'newCustomerCreated' && login.kind !== 'identityResolved') {
    throw new Error(login.kind);
  }

  counter += 1;
  const originJti = `spine-origin-${counter}`;
  const accessResult = await accessVerifier.verifyAccessToken(
    await signAccessToken({ sub: cognitoSub, origin_jti: originJti, jti: `jti-${counter}` }),
  );
  if (!accessResult.ok) throw new Error(`access token rejected: ${accessResult.reason}`);
  const session = await establishSession(
    { db: testDb.db },
    { evidence: accessResult.evidence, client: {} },
  );
  if (session.kind !== 'sessionEstablished') throw new Error(session.kind);
  return {
    cognitoSub,
    userId: login.userId,
    identityId: login.identityId,
    sessionUserId: session.userId,
    sessionId: session.sessionId,
    originJti,
  };
}

describe('canonical Cognito identity keying', () => {
  it('a Cognito ID-token first login persists the pool issuer + Cognito sub — not the external provider subject', async () => {
    const flow = await loginThenEstablish({
      sub: 'cognito-sub-apple-1',
      email: 'apple-user@privaterelay.appleid.com',
      email_verified: true,
      identities: [{ providerName: 'SignInWithApple', userId: 'apple-external-subject-001' }],
    });
    const identity = await testDb.db
      .selectFrom('auth_identity')
      .select(['issuer', 'subject', 'provider', 'is_private_relay'])
      .where('id', '=', flow.identityId)
      .executeTakeFirstOrThrow();
    expect(identity.issuer).toBe(POOL_ISSUER);
    expect(identity.subject).toBe('cognito-sub-apple-1');
    expect(identity.provider).toBe('apple'); // provenance only, never the key
    expect(identity.is_private_relay).toBe(true);
    // The external Apple subject appears nowhere as an identity key.
    const externalRows = await testDb.db
      .selectFrom('auth_identity')
      .select(['id'])
      .where('subject', '=', 'apple-external-subject-001')
      .execute();
    expect(externalRows).toEqual([]);
  });

  it('ID-token evidence and access-token evidence carry the identical (issuer, subject) key for one user', async () => {
    const idResult = await idAdapter.validateToken(
      await signIdToken({ sub: 'cognito-sub-key-parity', email: 'parity@example.test', email_verified: true }),
    );
    const accessResult = await accessVerifier.verifyAccessToken(
      await signAccessToken({ sub: 'cognito-sub-key-parity', origin_jti: 'parity-origin' }),
    );
    if (!idResult.ok || !accessResult.ok) throw new Error('fixture tokens rejected');
    expect(accessResult.evidence.issuer).toBe(idResult.evidence.issuer);
    expect(accessResult.evidence.subject).toBe(idResult.evidence.subject);
  });
});

describe('every login flow reaches access-token sessions through the canonical identity', () => {
  it.each([
    [
      'Apple-federated',
      {
        sub: 'cognito-sub-flow-apple',
        email: 'xk9@privaterelay.appleid.com',
        email_verified: true,
        identities: [{ providerName: 'SignInWithApple', userId: 'apple-ext-9' }],
      },
    ],
    [
      'Google-federated',
      {
        sub: 'cognito-sub-flow-google',
        email: 'google-user@example.test',
        email_verified: true,
        identities: [{ providerName: 'Google', userId: 'google-ext-9' }],
      },
    ],
    [
      'email/password',
      { sub: 'cognito-sub-flow-email', email: 'native@example.test', email_verified: true },
    ],
  ])('%s login then access-token establishment resolves one user', async (_label, claims) => {
    const flow = await loginThenEstablish(claims);
    expect(flow.sessionUserId).toBe(flow.userId);

    // The session row is FK-tied to the canonical Cognito identity.
    const session = await testDb.db
      .selectFrom('login_session')
      .select(['provider_issuer', 'provider_subject', 'user_id'])
      .where('id', '=', flow.sessionId)
      .executeTakeFirstOrThrow();
    expect(session.provider_issuer).toBe(POOL_ISSUER);
    expect(session.provider_subject).toBe(flow.cognitoSub);
    expect(session.user_id).toBe(flow.userId);

    // And liveness authenticates the same canonical user.
    const accessResult = await accessVerifier.verifyAccessToken(
      await signAccessToken({ sub: flow.cognitoSub, origin_jti: flow.originJti }),
    );
    if (!accessResult.ok) throw new Error('access token rejected');
    const liveness = await checkSessionLiveness(
      { db: testDb.db },
      { evidence: accessResult.evidence },
    );
    expect(liveness.kind).toBe('authenticated');
    if (liveness.kind === 'authenticated') {
      expect(liveness.principal.userId).toBe(flow.userId);
    }
  });
});

describe('linked external identities are additional, never required', () => {
  it('a linked external Apple identity coexists without replacing or conflicting with the canonical Cognito identity', async () => {
    const flow = await loginThenEstablish({
      sub: 'cognito-sub-linked',
      email: 'linked-spine@example.test',
      email_verified: true,
    });
    // Retain the external provider identity as an ADDITIONAL linked row.
    const linked = await linkIdentity(
      { db: testDb.db },
      { userId: flow.userId },
      {
        evidence: {
          provider: 'apple',
          issuer: 'https://appleid.apple.com',
          subject: 'apple-direct-subject-7',
          email: 'linked-spine@example.test',
          emailVerified: true,
          isPrivateRelay: false,
          assurance: 'single_factor',
        },
      },
    );
    expect(linked.kind).toBe('identityLinked');

    const identities = await testDb.db
      .selectFrom('auth_identity')
      .select(['issuer', 'subject', 'status'])
      .where('user_id', '=', flow.userId)
      .execute();
    expect(identities).toHaveLength(2);
    expect(identities.every((i) => i.status === 'active')).toBe(true);

    // Access tokens still resolve through the canonical Cognito identity —
    // the external identity is never consulted for bearer authentication.
    counter += 1;
    const accessResult = await accessVerifier.verifyAccessToken(
      await signAccessToken({ sub: flow.cognitoSub, origin_jti: `post-link-origin-${counter}` }),
    );
    if (!accessResult.ok) throw new Error('access token rejected');
    const session = await establishSession(
      { db: testDb.db },
      { evidence: accessResult.evidence, client: {} },
    );
    expect(session.kind).toBe('sessionEstablished');
    if (session.kind === 'sessionEstablished') {
      expect(session.userId).toBe(flow.userId);
      expect(session.identityId).toBe(flow.identityId); // the canonical row
    }
    // Structurally: the access verifier only ever emits the configured pool
    // issuer, so an external-issuer identity can never be the resolution key.
    expect(accessResult.evidence.issuer).toBe(POOL_ISSUER);
  });
});

describe('email remains non-authoritative across the spine', () => {
  it('two Cognito users sharing an unverified email stay separate through login and sessions', async () => {
    const a = await loginThenEstablish({
      sub: 'cognito-sub-dup-a',
      email: 'shared-spine@example.test',
      email_verified: false,
    });
    const b = await loginThenEstablish({
      sub: 'cognito-sub-dup-b',
      email: 'shared-spine@example.test',
      email_verified: false,
    });
    expect(a.userId).not.toBe(b.userId);
    expect(a.sessionUserId).toBe(a.userId);
    expect(b.sessionUserId).toBe(b.userId);
  });

  it('a second Cognito user claiming an owned verified email gets the typed conflict — never a merge', async () => {
    const owner = await loginThenEstablish({
      sub: 'cognito-sub-owner',
      email: 'owned-spine@example.test',
      email_verified: true,
    });
    const claimResult = await idAdapter.validateToken(
      await signIdToken({
        sub: 'cognito-sub-claimant',
        email: 'owned-spine@example.test',
        email_verified: true,
      }),
    );
    if (!claimResult.ok) throw new Error('fixture token rejected');
    const claim = await firstLogin({ db: testDb.db }, { evidence: claimResult.evidence });
    expect(claim.kind).toBe('verifiedEmailConflict');
    const users = await testDb.db
      .selectFrom('auth_identity')
      .select(['user_id'])
      .where('subject', 'in', ['cognito-sub-owner', 'cognito-sub-claimant'])
      .execute();
    expect(users).toHaveLength(1);
    expect(users[0]?.user_id).toBe(owner.userId);
  });
});

describe('concurrency across the spine', () => {
  it('concurrent first logins and session establishments for one Cognito user converge on one user and one live session', async () => {
    const sub = 'cognito-sub-concurrent';
    const idResult = await idAdapter.validateToken(
      await signIdToken({ sub, email: 'concurrent-spine@example.test', email_verified: true }),
    );
    if (!idResult.ok) throw new Error('fixture token rejected');
    const accessResult = await accessVerifier.verifyAccessToken(
      await signAccessToken({ sub, origin_jti: 'concurrent-spine-origin' }),
    );
    if (!accessResult.ok) throw new Error('fixture token rejected');

    const logins = await Promise.all(
      Array.from({ length: 3 }, () =>
        firstLogin({ db: testDb.db }, { evidence: idResult.evidence }),
      ),
    );
    const userIds = new Set(
      logins.map((r) =>
        r.kind === 'newCustomerCreated' || r.kind === 'identityResolved' ? r.userId : r.kind,
      ),
    );
    expect(userIds.size).toBe(1);

    const sessions = await Promise.all(
      Array.from({ length: 3 }, () =>
        establishSession({ db: testDb.db }, { evidence: accessResult.evidence, client: {} }),
      ),
    );
    const sessionIds = new Set(
      sessions.map((s) => (s.kind === 'sessionEstablished' ? s.sessionId : s.kind)),
    );
    expect(sessionIds.size).toBe(1);
    const live = await testDb.db
      .selectFrom('login_session')
      .select(['id'])
      .where('origin_jti', '=', 'concurrent-spine-origin')
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(1);
  });
});
