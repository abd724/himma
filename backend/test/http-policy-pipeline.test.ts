/**
 * B2-4 — route-policy registry, structural deny-by-default, and the bearer
 * authentication pipeline (docs/26 §6, §11.2, §11.10).
 *
 * Fastify injection over real PostgreSQL with the deterministic fake
 * access-token verifier. Cognito ID tokens are never API bearer tokens;
 * groups/custom claims never affect the principal.
 */
import { buildApp } from '../src/app/build-app';
import { FakeMfaProvider } from '../src/modules/identity/providers/fake/fake-mfa-provider';
import { parseMfaConfig } from '../src/modules/identity/services/mfa-config';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import type { FastifyInstance } from 'fastify';

import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { InMemoryRateLimiterStore, createRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { firstLogin } from '../src/modules/identity/services/first-login';
import { establishSession } from '../src/modules/identity/services/sessions';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/http-pool';
let testDb: TestDb;
let app: FastifyInstance;
let accessVerifier: FakeAccessTokenVerifier;
let idAdapter: FakeAuthProviderAdapter;
let counter = 0;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  accessVerifier = new FakeAccessTokenVerifier();
  idAdapter = new FakeAuthProviderAdapter();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: accessVerifier,
      idTokenAdapter: idAdapter,
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      // B2-6C: the canonical inventory snapshot covers the MFA surface too.
      mfaProvider: new FakeMfaProvider(),
      mfaConfig: parseMfaConfig('test', {}),
      // S3-3: and the provider-private management surface.
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

async function makeCustomer(): Promise<{ userId: string; subject: string }> {
  counter += 1;
  const evidence: ProviderEvidence = {
    provider: 'google',
    issuer: ISSUER,
    subject: `http-sub-${counter}`,
    email: `http${counter}@example.test`,
    emailVerified: true,
    isPrivateRelay: false,
    assurance: 'single_factor',
  };
  const result = await firstLogin({ db: testDb.db }, { evidence });
  if (result.kind !== 'newCustomerCreated') throw new Error(result.kind);
  return { userId: result.userId, subject: evidence.subject };
}

function accessEvidence(subject: string, overrides: Partial<AccessTokenEvidence> = {}): AccessTokenEvidence {
  counter += 1;
  return {
    issuer: ISSUER,
    subject,
    originJti: `http-origin-${counter}`,
    scopes: ['openid'],
    assurance: 'single_factor',
    expiresAt: new Date(Date.now() + 3_600_000),
    authTime: new Date(),
    ...overrides,
  };
}

async function makeAuthenticated(): Promise<{ token: string; userId: string; subject: string }> {
  const customer = await makeCustomer();
  const evidence = accessEvidence(customer.subject);
  const established = await establishSession({ db: testDb.db }, { evidence, client: {} });
  if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
  return { token: accessVerifier.issueToken(evidence), ...customer };
}

describe('route-policy registry and structural deny-by-default', () => {
  it('every registered route carries an explicit policy (inventory snapshot)', () => {
    const inventory = app.routePolicyInventory
      .map((r) => `${r.method} ${r.url} → ${r.policy}`)
      .sort();
    expect(inventory).toMatchSnapshot();
    expect(inventory.length).toBeGreaterThan(0);
    for (const line of inventory) {
      expect(line).toMatch(
        /→ (public|unauthenticatedAuthFlow|authenticatedCustomer|stepUpRequired|admin|adminStepUp|provider|providerStepUp)$/,
      );
    }
  });

  it('registering a route without a policy declaration fails immediately, before the app can start', async () => {
    const rogue = buildApp({});
    expect(() => rogue.get('/rogue-unprotected', async () => ({ ok: true }))).toThrow(
      /authPolicy/,
    );
    await rogue.close();
  });

  it('the health route is explicitly public and needs no authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/internal/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    const declared = app.routePolicyInventory.find((r) => r.url === '/internal/health');
    expect(declared?.policy).toBe('public');
  });
});

describe('bearer authentication pipeline', () => {
  it('rejects a missing or malformed Authorization header with a sanitized envelope', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: 'Bearer two tokens' },
      { authorization: `Bearer ${'x'.repeat(5000)}` },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/me', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        code: 'invalidAccessToken',
        message: expect.not.stringContaining('Bearer '),
      });
    }
  });

  it('rejects an unknown bearer token as invalidAccessToken without echoing it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer forged-token-abc123' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('forged-token-abc123');
    expect(response.json().code).toBe('invalidAccessToken');
  });

  it('an ID token presented as a bearer token is rejected (fake verifier accepts only access tokens)', async () => {
    const customer = await makeCustomer();
    // Token minted by the ID-token adapter, not the access verifier — the
    // access pipeline must not accept it.
    const idToken = idAdapter.issueToken({
      provider: 'google',
      issuer: ISSUER,
      subject: customer.subject,
      emailVerified: false,
      isPrivateRelay: false,
      assurance: 'single_factor',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${idToken}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('invalidAccessToken');
  });

  it('authenticates a valid access token with a registered live session', async () => {
    const { token, userId } = await makeAuthenticated();
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(userId);
  });

  it('rejects a token whose session is not registered as sessionExpired-shaped', async () => {
    const customer = await makeCustomer();
    const token = accessVerifier.issueToken(accessEvidence(customer.subject));
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('sessionExpired');
  });

  it('rejects revoked sessions and inactive accounts with the approved external vocabulary', async () => {
    const revoked = await makeAuthenticated();
    await testDb.db
      .updateTable('login_session')
      .set({ revoked_at: new Date(), revoke_reason: 'logout' })
      .where('user_id', '=', revoked.userId)
      .execute();
    const revokedResponse = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${revoked.token}` },
    });
    expect(revokedResponse.statusCode).toBe(401);
    expect(revokedResponse.json().code).toBe('sessionExpired'); // non-specific per §10

    // Locked, suspended, and deleted all collapse to the shared external
    // accountSuspended message (docs/26 §3.8) — internal causes stay typed.
    for (const mutate of [
      { table: 'app_user' as const, set: { status: 'locked', locked_reason: 't' } },
      { table: 'customer_account' as const, set: { status: 'suspended' } },
      { table: 'app_user' as const, set: { status: 'deleted' } },
    ]) {
      const target = await makeAuthenticated();
      await testDb.db
        .updateTable(mutate.table)
        .set(mutate.set)
        .where(mutate.table === 'app_user' ? 'id' : 'user_id', '=', target.userId)
        .execute();
      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${target.token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('accountSuspended');
    }
  });

  it('provider outage maps to a typed 503 without provider detail', async () => {
    const { token } = await makeAuthenticated();
    accessVerifier.setUnavailable(true);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe('providerUnavailable');
    } finally {
      accessVerifier.setUnavailable(false);
    }
  });

  it('scopes and provider claims never create permissions: the principal carries no roles', async () => {
    const customer = await makeCustomer();
    const evidence = accessEvidence(customer.subject, {
      scopes: ['openid', 'admin', 'cognito:groups/admins'],
    });
    const established = await establishSession({ db: testDb.db }, { evidence, client: {} });
    if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
    const token = accessVerifier.issueToken(evidence);
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().roles).toEqual([]);
  });

  it('repeated invalid bearer attempts trip the rate limiter deterministically', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: 'Bearer repeatedly-invalid-token', 'x-forwarded-for': '198.51.100.9' },
        remoteAddress: '198.51.100.9',
      });
      responses.push(response.statusCode);
    }
    expect(responses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(responses.slice(10)).toEqual([429, 429]);
    const limited = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer repeatedly-invalid-token' },
      remoteAddress: '198.51.100.9',
    });
    expect(limited.json().code).toBe('rateLimited');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('step-up-required routes refuse stale authentication with the typed stepUpRequired outcome', async () => {
    const customer = await makeCustomer();
    const staleEvidence = accessEvidence(customer.subject, {
      authTime: new Date(Date.now() - 3_600_000), // authenticated an hour ago
    });
    const established = await establishSession(
      { db: testDb.db },
      { evidence: staleEvidence, client: {} },
    );
    if (established.kind !== 'sessionEstablished') throw new Error(established.kind);
    const token = accessVerifier.issueToken(staleEvidence);
    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${established.sessionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('stepUpRequired');
  });
});

describe('rate-limiter store production posture', () => {
  it('fails closed in production until an approved distributed store exists', () => {
    expect(() => createRateLimiterStore('production')).toThrow(/production/i);
    expect(createRateLimiterStore('test')).toBeInstanceOf(InMemoryRateLimiterStore);
    expect(createRateLimiterStore('development')).toBeInstanceOf(InMemoryRateLimiterStore);
  });
});
