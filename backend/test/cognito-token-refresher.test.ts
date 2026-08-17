/**
 * Concrete Cognito ProviderTokenRefresher + session revoker + production
 * composition (W2-12A final correction). The AWS boundary is an injected
 * fetch stub (the repository's established provider test boundary — no
 * pool exists and none is contacted); everything above it is the real
 * production code path, and the §10 compatibility test runs the REAL
 * `/auth/refresh` route on real PostgreSQL over the concrete adapter.
 */
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import {
  parseAuthCookieConfig,
} from '../src/modules/identity/http/auth-session-cookies';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import {
  CognitoConfigError,
  parseCognitoConfig,
  refreshClientIdOf,
  type CognitoAdapterConfig,
} from '../src/modules/identity/providers/cognito/config';
import { CognitoSessionRevoker } from '../src/modules/identity/providers/cognito/cognito-session-revoker';
import {
  CognitoRefreshHttpClient,
  CognitoTokenRefresher,
  createCognitoTokenRefresher,
  type RefreshFetchLike,
} from '../src/modules/identity/providers/cognito/cognito-token-refresher';
import { createCognitoSessionContinuity } from '../src/modules/identity/providers/cognito/session-continuity-composition';
import { AuthCookieConfigError } from '../src/modules/identity/http/auth-session-cookies';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { FakeTokenRefresher } from '../src/modules/identity/providers/fake/fake-token-refresher';
import type { ProviderTokenRefresher } from '../src/modules/identity/providers/refresh';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { createIdentity, createUser } from './helpers/identity-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito-idp.me-central-1.amazonaws.com/me-central-1_TestPool';
const CLIENT_ID = 'portal-public-client';
const CONFIG: CognitoAdapterConfig = { issuer: ISSUER, clientIds: [CLIENT_ID] };
const REFRESH_TOKEN = 'cognito-refresh-token-material-1';

interface RecordedCall {
  url: string;
  target: string;
  body: Record<string, unknown>;
}

function stubFetch(
  respond: (call: RecordedCall) => { status: number; body: unknown } | 'network',
): { calls: RecordedCall[]; fetchImpl: RefreshFetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: RefreshFetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      target: init.headers['x-amz-target'] ?? '',
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    calls.push(call);
    const result = respond(call);
    if (result === 'network') throw new TypeError('socket hang up');
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  };
  return { calls, fetchImpl };
}

const authResult = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    AuthenticationResult: {
      AccessToken: 'refreshed-access-token',
      IdToken: 'refreshed-id-token',
      ...overrides,
    },
  },
});

describe('CognitoRefreshHttpClient — the exact REFRESH_TOKEN_AUTH operation', () => {
  it('invokes InitiateAuth/REFRESH_TOKEN_AUTH on the pool endpoint with the designated app client, sending the refresh token ONLY to Cognito', async () => {
    const { calls, fetchImpl } = stubFetch(() => authResult());
    const refresher = createCognitoTokenRefresher(CONFIG, { fetchImpl });
    const result = await refresher.refreshTokens({ refreshToken: REFRESH_TOKEN });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://cognito-idp.me-central-1.amazonaws.com/');
    expect(calls[0]?.target).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(calls[0]?.body).toEqual({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN },
    });
    expect(result).toEqual({
      ok: true,
      tokens: { accessToken: 'refreshed-access-token', idToken: 'refreshed-id-token' },
    });
  });

  it('maps the optional tokens exactly: absent ID token stays absent, and NO refresh token is ever fabricated', async () => {
    const bare = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch(() => authResult({ IdToken: undefined })).fetchImpl,
    });
    const result = await bare.refreshTokens({ refreshToken: REFRESH_TOKEN });
    expect(result).toEqual({ ok: true, tokens: { accessToken: 'refreshed-access-token' } });
    if (result.ok) {
      expect('refreshToken' in result.tokens).toBe(false); // never fabricated
      expect('idToken' in result.tokens).toBe(false);
    }
  });

  it('passes through a provider-ROTATED refresh token only when Cognito actually returns one', async () => {
    const rotated = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch(() => authResult({ RefreshToken: 'rotated-refresh' })).fetchImpl,
    });
    const result = await rotated.refreshTokens({ refreshToken: REFRESH_TOKEN });
    expect(result).toEqual({
      ok: true,
      tokens: {
        accessToken: 'refreshed-access-token',
        idToken: 'refreshed-id-token',
        refreshToken: 'rotated-refresh',
      },
    });
  });

  it.each([
    'NotAuthorizedException', // revoked/expired/reused credential, disabled user
    'UserNotFoundException', // deleted identity
    'PasswordResetRequiredException',
  ])('%s maps to the session-invalid semantic class', async (type) => {
    const refresher = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch(() => ({
        status: 400,
        body: { __type: type, message: 'refused with provider internals' },
      })).fetchImpl,
    });
    await expect(refresher.refreshTokens({ refreshToken: REFRESH_TOKEN })).resolves.toEqual({
      ok: false,
      reason: 'invalidRefreshToken',
    });
  });

  it('a transient outage (network / 5xx / unknown provider error) stays DISTINCT from credential invalidation', async () => {
    const network = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch(() => 'network').fetchImpl,
    });
    await expect(network.refreshTokens({ refreshToken: REFRESH_TOKEN })).resolves.toEqual({
      ok: false,
      reason: 'providerUnavailable',
    });
    const serverError = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch(() => ({ status: 500, body: { __type: 'InternalErrorException' } }))
        .fetchImpl,
    });
    await expect(serverError.refreshTokens({ refreshToken: REFRESH_TOKEN })).resolves.toEqual({
      ok: false,
      reason: 'providerUnavailable',
    });
    const throttled = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch(() => ({ status: 400, body: { __type: 'TooManyRequestsException' } }))
        .fetchImpl,
    });
    await expect(throttled.refreshTokens({ refreshToken: REFRESH_TOKEN })).resolves.toEqual({
      ok: false,
      reason: 'providerUnavailable',
    });
  });

  it('raw AWS error payloads and token material never escape the adapter boundary', async () => {
    const client = new CognitoRefreshHttpClient(CONFIG, {
      fetchImpl: stubFetch(() => ({
        status: 400,
        body: {
          __type: 'com.amazon.coral#NotAuthorizedException',
          message: 'Refresh Token has been revoked (request id abc-123)',
        },
      })).fetchImpl,
    });
    await expect(client.initiateRefreshAuth({ refreshToken: REFRESH_TOKEN })).rejects.toMatchObject(
      {
        name: 'NotAuthorizedException',
        message: 'Cognito refresh refused.', // fixed safe phrase, no AWS internals
      },
    );
    try {
      await client.initiateRefreshAuth({ refreshToken: REFRESH_TOKEN });
    } catch (error) {
      expect(JSON.stringify({ ...(error as Error) })).not.toContain(REFRESH_TOKEN);
      expect(String(error)).not.toMatch(/request id|abc-123|coral/i);
    }
  });

  it('the concrete adapter satisfies the same semantic port contract as the deterministic fake', async () => {
    const fake = new FakeTokenRefresher();
    fake.register(REFRESH_TOKEN, () => ({ accessToken: 'fake-access' }));
    const concrete = createCognitoTokenRefresher(CONFIG, {
      fetchImpl: stubFetch((call) => {
        const params = call.body.AuthParameters as { REFRESH_TOKEN?: string };
        return params.REFRESH_TOKEN === REFRESH_TOKEN
          ? authResult({ IdToken: undefined, AccessToken: 'real-access' })
          : { status: 400, body: { __type: 'NotAuthorizedException' } };
      }).fetchImpl,
    });
    for (const [refresher, expected] of [
      [fake, 'fake-access'],
      [concrete, 'real-access'],
    ] as const satisfies readonly (readonly [ProviderTokenRefresher, string])[]) {
      const good = await refresher.refreshTokens({ refreshToken: REFRESH_TOKEN });
      expect(good).toMatchObject({ ok: true, tokens: { accessToken: expected } });
      const bad = await refresher.refreshTokens({ refreshToken: 'unknown-token' });
      expect(bad).toEqual({ ok: false, reason: 'invalidRefreshToken' });
    }
  });
});

describe('configuration (fail-closed, nothing hardcoded)', () => {
  it('a single accepted app client is the default refresh client; several REQUIRE the explicit designation', () => {
    expect(refreshClientIdOf({ issuer: ISSUER, clientIds: ['only-one'] })).toBe('only-one');
    expect(() => refreshClientIdOf({ issuer: ISSUER, clientIds: ['a', 'b'] })).toThrow(
      CognitoConfigError,
    );
    expect(
      refreshClientIdOf({ issuer: ISSUER, clientIds: ['a', 'b'], refreshClientId: 'b' }),
    ).toBe('b');
  });

  it('COGNITO_REFRESH_CLIENT_ID must be an accepted client id', () => {
    expect(() =>
      parseCognitoConfig({
        COGNITO_ISSUER: ISSUER,
        COGNITO_CLIENT_IDS: 'a,b',
        COGNITO_REFRESH_CLIENT_ID: 'stranger',
      }),
    ).toThrow(CognitoConfigError);
    expect(
      parseCognitoConfig({
        COGNITO_ISSUER: ISSUER,
        COGNITO_CLIENT_IDS: 'a,b',
        COGNITO_REFRESH_CLIENT_ID: 'b',
      })?.refreshClientId,
    ).toBe('b');
  });

  it('production composition selects the CONCRETE providers and fails closed on every configuration gap', () => {
    const complete = createCognitoSessionContinuity('production', {
      COGNITO_ISSUER: ISSUER,
      COGNITO_CLIENT_IDS: CLIENT_ID,
      PORTAL_ALLOWED_ORIGINS: 'https://portal.himma.ae',
    });
    expect(complete).toBeDefined();
    expect(complete?.sessionContinuity.tokenRefresher).toBeInstanceOf(CognitoTokenRefresher);
    expect(complete?.providerRevoker).toBeInstanceOf(CognitoSessionRevoker);
    expect(complete?.sessionContinuity.cookieConfig.secure).toBe(true);

    // No Cognito configuration → the channel simply does not exist.
    expect(createCognitoSessionContinuity('production', {})).toBeUndefined();

    // Ambiguous refresh client → startup refusal.
    expect(() =>
      createCognitoSessionContinuity('production', {
        COGNITO_ISSUER: ISSUER,
        COGNITO_CLIENT_IDS: 'a,b',
        PORTAL_ALLOWED_ORIGINS: 'https://portal.himma.ae',
      }),
    ).toThrow(CognitoConfigError);

    // A production channel with no declared portal origin → refusal.
    expect(() =>
      createCognitoSessionContinuity('production', {
        COGNITO_ISSUER: ISSUER,
        COGNITO_CLIENT_IDS: CLIENT_ID,
      }),
    ).toThrow(AuthCookieConfigError);

    // Insecure production cookies → refusal (carried rule).
    expect(() =>
      createCognitoSessionContinuity('production', {
        COGNITO_ISSUER: ISSUER,
        COGNITO_CLIENT_IDS: CLIENT_ID,
        PORTAL_ALLOWED_ORIGINS: 'https://portal.himma.ae',
        AUTH_COOKIE_SECURE: 'false',
      }),
    ).toThrow(AuthCookieConfigError);
  });
});

describe('CognitoSessionRevoker — the production logout follow-up', () => {
  it('revokes the session refresh-token chain via RevokeToken for the designated public client', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ status: 200, body: {} }));
    const revoker = new CognitoSessionRevoker(CONFIG, { fetchImpl });
    await expect(
      revoker.revokeProviderSessions({
        scope: 'session',
        issuer: ISSUER,
        subject: 'sub-1',
        originJti: 'origin-1',
        ephemeralToken: REFRESH_TOKEN,
      }),
    ).resolves.toEqual({ delivered: true });
    expect(calls[0]?.target).toBe('AWSCognitoIdentityProviderService.RevokeToken');
    expect(calls[0]?.body).toEqual({ ClientId: CLIENT_ID, Token: REFRESH_TOKEN });
  });

  it('is HONEST about public-client capability limits and provider outages', async () => {
    const { calls, fetchImpl } = stubFetch(() => 'network');
    const revoker = new CognitoSessionRevoker(CONFIG, { fetchImpl });
    // Global sign-out needs admin credentials the architecture does not
    // hold — typed notSupported, no call attempted, Himma denial stands.
    await expect(
      revoker.revokeProviderSessions({ scope: 'allSessions', issuer: ISSUER, subject: 's' }),
    ).resolves.toEqual({ delivered: false, reason: 'notSupported' });
    await expect(
      revoker.revokeProviderSessions({ scope: 'session', issuer: ISSUER, subject: 's' }),
    ).resolves.toEqual({ delivered: false, reason: 'notSupported' });
    expect(calls).toHaveLength(0);
    await expect(
      revoker.revokeProviderSessions({
        scope: 'session',
        issuer: ISSUER,
        subject: 's',
        ephemeralToken: REFRESH_TOKEN,
      }),
    ).resolves.toEqual({ delivered: false, reason: 'providerUnavailable' });
  });
});

describe('§10 route compatibility — the REAL /auth/refresh over the CONCRETE adapter (real PostgreSQL)', () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  let verifier: FakeAccessTokenVerifier;

  const PORTAL_ORIGIN = 'https://portal.himma.test';
  const SUBJECT = 'concrete-route-sub';
  const ORIGIN_JTI = 'concrete-route-origin';

  const evidence = (): AccessTokenEvidence => ({
    issuer: ISSUER,
    subject: SUBJECT,
    originJti: ORIGIN_JTI,
    scopes: [],
    assurance: 'mfa',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    authTime: new Date(),
  });

  beforeAll(async () => {
    testDb = await createMigratedTestDb();
    verifier = new FakeAccessTokenVerifier();
    // The CONCRETE refresher/HTTP client with only the wire stubbed: a
    // valid REFRESH_TOKEN_AUTH body yields a fresh verifier-minted access
    // token for the SAME provider session (origin_jti stable, like Cognito).
    const { fetchImpl } = stubFetch((call) => {
      const params = call.body.AuthParameters as { REFRESH_TOKEN?: string };
      if (call.body.ClientId !== CLIENT_ID || params.REFRESH_TOKEN !== REFRESH_TOKEN) {
        return { status: 400, body: { __type: 'NotAuthorizedException' } };
      }
      return authResult({ AccessToken: verifier.issueToken(evidence()), IdToken: undefined });
    });
    app = buildApp({
      identity: {
        db: testDb.db,
        accessTokenVerifier: verifier,
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
        staffInvitationConfig: parseStaffInvitationConfig('test', {}),
        sessionContinuity: {
          cookieConfig: parseAuthCookieConfig('test', {
            PORTAL_ALLOWED_ORIGINS: PORTAL_ORIGIN,
          }),
          tokenRefresher: createCognitoTokenRefresher(CONFIG, { fetchImpl }),
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  it('a concrete-adapter refresh runs the full route: verification → liveness/CAS → CSRF rotation → usable response', async () => {
    const userId = await createUser(testDb.db);
    await createIdentity(testDb.db, userId, { issuer: ISSUER, subject: SUBJECT });
    const established = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin: PORTAL_ORIGIN },
      payload: {
        accessToken: verifier.issueToken(evidence()),
        refreshToken: REFRESH_TOKEN,
      },
    });
    expect(established.statusCode).toBe(200);
    const csrfToken = (established.json() as { csrfToken: string }).csrfToken;
    const setCookies = established.headers['set-cookie'] as string[];
    const cookie = setCookies
      .map((entry) => entry.split(';')[0])
      .filter((entry) => entry !== undefined)
      .join('; ');

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { origin: PORTAL_ORIGIN, cookie, 'x-csrf-token': csrfToken },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const body = refreshed.json() as {
      accessToken: string;
      csrfToken: string;
      assurance: string;
    };
    expect(body.assurance).toBe('mfa');
    expect(body.csrfToken).not.toBe(csrfToken); // rotated
    // The refreshed bearer works against the authenticated API surface
    // (provider-access bootstrap continues from here).
    const me = await app.inject({
      method: 'GET',
      url: '/provider/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ memberships: [] });
  });
});
