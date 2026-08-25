/**
 * RI-1 — dev identity composition (D-RI-3). Real PostgreSQL + transport.
 *
 * The deterministic email/password provider is a Cognito CLIENT stand-in
 * behind the certified ports: everything Himma-side is REAL (first login
 * creates user + account + self participant in PostgreSQL; bearer auth
 * resolves genuine session liveness; logout permanently retires the
 * provider session). Proven here: the full sign-up → session → /me →
 * participants journey; wrong-password/duplicate-email/weak-password
 * refusals; refresh continuity on ONE Himma session; logout finality
 * (old bearers AND refreshed bearers of the retired provider session are
 * dead — only a fresh sign-in works); and the STRUCTURAL production
 * refusal (buildApp throws; without the composition the routes are
 * absent).
 */
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { DevPasswordIdentityProvider } from '../src/modules/identity/providers/dev/dev-password-identity';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

let testDb: TestDb;
let app: FastifyInstance;
let provider: DevPasswordIdentityProvider;
let emailSerial = 0;

const nextEmail = (): string => `dev-user-${(emailSerial += 1)}@himma.test`;

function makeApp(withDevIdentity: boolean, nodeEnv?: 'production'): FastifyInstance {
  const devProvider = withDevIdentity ? provider : new DevPasswordIdentityProvider();
  return buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: provider,
      idTokenAdapter: provider,
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
      ...(nodeEnv !== undefined ? { nodeEnv } : {}),
    },
    ...(withDevIdentity ? { devIdentity: { provider: devProvider } } : {}),
  });
}

async function post(url: string, payload: Record<string, unknown>, bearer?: string) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  });
}

async function establish(tokens: { accessToken: string; idToken: string }) {
  return post('/auth/session', {
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
  });
}

async function me(bearer: string) {
  return app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${bearer}` },
  });
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  provider = new DevPasswordIdentityProvider();
  app = makeApp(true);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

describe('structural boundaries', () => {
  it('production REFUSES the dev identity composition; without it the routes are absent', async () => {
    expect(() => makeApp(true, 'production')).toThrow(/never available in production/);
    const bare = makeApp(false);
    await bare.ready();
    try {
      expect(
        bare.routePolicyInventory.filter((route) => route.url.startsWith('/dev/')),
      ).toEqual([]);
      const response = await bare.inject({
        method: 'POST',
        url: '/dev/identity/signin',
        payload: { email: 'x@y.z', password: 'password123' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('the real email/password journey', () => {
  it('sign up → Himma session → /me shows the real account + self participant → participants API serves', async () => {
    const email = nextEmail();
    const signup = await post('/dev/identity/signup', {
      email,
      password: 'password123',
      displayName: 'Test Parent',
    });
    expect(signup.statusCode).toBe(201);
    const tokens = signup.json();

    const session = await establish(tokens);
    expect(session.statusCode).toBe(200);
    expect(session.json().status).toBe('authenticated');
    expect(session.json().accountId).toBeDefined();

    const profile = await me(tokens.accessToken as string);
    expect(profile.statusCode).toBe(200);
    expect(profile.json().account.displayName).toBe('Test Parent');
    expect(profile.json().account.contactEmail).toBe(email);
    expect(profile.json().participants).toEqual([
      expect.objectContaining({ kind: 'self' }),
    ]);

    const participants = await app.inject({
      method: 'GET',
      url: '/customer/participants',
      headers: { authorization: `Bearer ${tokens.accessToken as string}` },
    });
    expect(participants.statusCode).toBe(200);
    expect(participants.json().participants).toHaveLength(1);
  });

  it('refusals are typed and enumeration-safe: wrong password, duplicate email, weak password, invalid email', async () => {
    const email = nextEmail();
    expect(
      (await post('/dev/identity/signup', { email, password: 'password123' })).statusCode,
    ).toBe(201);
    const wrong = await post('/dev/identity/signin', { email, password: 'wrong-password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('invalidCredentials');
    // Unknown email collapses into the SAME class — no enumeration.
    const unknown = await post('/dev/identity/signin', {
      email: 'nobody@himma.test',
      password: 'password123',
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe('invalidCredentials');
    const dup = await post('/dev/identity/signup', { email, password: 'password456' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('emailTaken');
    expect(
      (await post('/dev/identity/signup', { email: nextEmail(), password: 'short' })).statusCode,
    ).toBe(422);
    expect(
      (await post('/dev/identity/signup', { email: 'not-an-email', password: 'password123' }))
        .statusCode,
    ).toBe(422);
  });

  it('refresh continues the SAME provider session and the SAME Himma session; sign-in twice = two sessions', async () => {
    const email = nextEmail();
    const signup = await post('/dev/identity/signup', { email, password: 'password123' });
    const tokens = signup.json();
    await establish(tokens);

    const refreshed = await post('/dev/identity/refresh', {
      refreshToken: tokens.refreshToken,
    });
    expect(refreshed.statusCode).toBe(200);
    const newBearer = refreshed.json().accessToken as string;
    expect(newBearer).not.toBe(tokens.accessToken);
    // The refreshed bearer works immediately (same originJti → same live
    // Himma session; no re-establishment needed).
    expect((await me(newBearer)).statusCode).toBe(200);
    const sessions = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { authorization: `Bearer ${newBearer}` },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().sessions).toHaveLength(1);

    // A second SIGN-IN is a new provider session → a second Himma session.
    const second = await post('/dev/identity/signin', { email, password: 'password123' });
    await establish(second.json());
    const after = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { authorization: `Bearer ${second.json().accessToken as string}` },
    });
    expect(after.json().sessions).toHaveLength(2);
  });

  it('logout is FINAL for the provider session: old and refreshed bearers die; only a fresh sign-in works', async () => {
    const email = nextEmail();
    const signup = await post('/dev/identity/signup', { email, password: 'password123' });
    const tokens = signup.json();
    await establish(tokens);
    expect((await me(tokens.accessToken as string)).statusCode).toBe(200);

    const logout = await post('/auth/logout', {}, tokens.accessToken as string);
    expect(logout.statusCode).toBe(200);
    expect((await me(tokens.accessToken as string)).statusCode).toBe(401);

    // Even a FRESH provider access token for the retired originJti is dead:
    // the revoked Himma session permanently retires the provider session.
    const refreshed = await post('/dev/identity/refresh', {
      refreshToken: tokens.refreshToken,
    });
    expect(refreshed.statusCode).toBe(200);
    expect((await me(refreshed.json().accessToken as string)).statusCode).toBe(401);
    const reestablish = await post('/auth/session', {
      accessToken: refreshed.json().accessToken,
    });
    expect(reestablish.statusCode).toBe(401);

    // A fresh sign-in (new provider session) works.
    const again = await post('/dev/identity/signin', { email, password: 'password123' });
    expect((await establish(again.json())).statusCode).toBe(200);
    expect((await me(again.json().accessToken as string)).statusCode).toBe(200);
  });

  it('an expired access token is refused by the verifier port', async () => {
    const expiring = new DevPasswordIdentityProvider({ accessTokenTtlSeconds: 0 });
    const issued = expiring.signUp({ email: 'ttl@himma.test', password: 'password123' });
    if (issued.kind !== 'signedUp') throw new Error(issued.kind);
    const verified = await expiring.verifyAccessToken(issued.tokens.accessToken);
    expect(verified).toEqual({ ok: false, reason: 'invalidAccessToken' });
  });
});
