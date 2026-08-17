/**
 * Browser session-continuity channel (docs/26 §4.7(9)/§14.E — W2-12A
 * correction): the HttpOnly auth-path refresh cookie, double-submit CSRF,
 * server-mediated `POST /auth/refresh` under the §9.4 Himma liveness
 * transaction, and the final logout architecture. Real PostgreSQL + real
 * Fastify injection; ONLY the external provider boundary is the
 * deterministic fake set (verifier / id adapter / token refresher).
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';

import { buildApp } from '../src/app/build-app';
import { newId } from '../src/db/ids';
import {
  parseAuthCookieConfig,
  AuthCookieConfigError,
} from '../src/modules/identity/http/auth-session-cookies';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import type { AccessTokenEvidence } from '../src/modules/identity/providers/access-token';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { FakeTokenRefresher } from '../src/modules/identity/providers/fake/fake-token-refresher';
import { parseStaffInvitationConfig } from '../src/modules/provider/staff-invitation-config';
import { createIdentity, createUser } from './helpers/identity-fixtures';
import { addMembership, createProviderOrg } from './helpers/provider-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const ISSUER = 'https://cognito.test/session-continuity-pool';
const PORTAL_ORIGIN = 'https://portal.himma.test';
const EVIL_ORIGIN = 'https://evil.example';

let testDb: TestDb;
let app: FastifyInstance;
let verifier: FakeAccessTokenVerifier;
let refresher: FakeTokenRefresher;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  verifier = new FakeAccessTokenVerifier();
  refresher = new FakeTokenRefresher();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: verifier,
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: new CaptureMailSender(),
      rateLimiterStore: new InMemoryRateLimiterStore(),
      staffInvitationConfig: parseStaffInvitationConfig('test', {}),
      // This suite establishes many sessions from one inject IP; keep the
      // rule ACTIVE but roomy (the production default stays 10/min).
      rateLimits: { sessionEstablishment: { limit: 1000, windowMs: 60_000 } },
      sessionContinuity: {
        cookieConfig: parseAuthCookieConfig('test', {
          PORTAL_ALLOWED_ORIGINS: PORTAL_ORIGIN,
        }),
        tokenRefresher: refresher,
      },
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

let counter = 0;

function evidenceFor(subject: string, originJti: string): AccessTokenEvidence {
  return {
    issuer: ISSUER,
    subject,
    originJti,
    scopes: [],
    assurance: 'mfa',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    authTime: new Date(),
  };
}

interface Session {
  userId: string;
  subject: string;
  originJti: string;
  accessToken: string;
  refreshTokenValue: string;
  cookies: Map<string, string>;
  csrfToken: string;
}

function setCookiesOf(headers: Record<string, unknown>): string[] {
  const raw = headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

function absorbCookies(jar: Map<string, string>, setCookies: string[]): void {
  for (const cookie of setCookies) {
    const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
    const separator = (pair ?? '').indexOf('=');
    if (pair === undefined || separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
    if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) {
      jar.delete(name);
    } else if (value !== '') {
      jar.set(name, value);
    }
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Establishes a REAL Himma session with the cookie channel engaged. */
async function establishSession(
  options: { memberships?: 'none' | 'owner'; scopes?: string[] } = {},
): Promise<Session & { orgId?: string }> {
  counter += 1;
  const subject = `cont-sub-${counter}`;
  const originJti = `cont-origin-${counter}`;
  const userId = await createUser(testDb.db);
  await createIdentity(testDb.db, userId, { issuer: ISSUER, subject });
  let orgId: string | undefined;
  if (options.memberships === 'owner') {
    const org = await createProviderOrg(testDb.db, {});
    orgId = org.orgId;
    await addMembership(testDb.db, userId, org.orgId, 'owner');
  }
  const accessToken = verifier.issueToken({
    ...evidenceFor(subject, originJti),
    scopes: options.scopes ?? [],
  });
  const refreshTokenValue = `provider-refresh-${counter}`;
  refresher.register(refreshTokenValue, () => ({
    accessToken: verifier.issueToken(evidenceFor(subject, originJti)),
  }));

  const response = await app.inject({
    method: 'POST',
    url: '/auth/session',
    headers: { origin: PORTAL_ORIGIN },
    payload: { accessToken, refreshToken: refreshTokenValue },
  });
  expect(response.statusCode).toBe(200);
  const cookies = new Map<string, string>();
  absorbCookies(cookies, setCookiesOf(response.headers as Record<string, unknown>));
  const body = response.json() as { csrfToken?: string };
  if (typeof body.csrfToken !== 'string') throw new Error('csrfToken missing');
  return {
    userId,
    subject,
    originJti,
    accessToken,
    refreshTokenValue,
    cookies,
    csrfToken: body.csrfToken,
    ...(orgId !== undefined ? { orgId } : {}),
  };
}

function refreshRequest(
  session: Session,
  overrides: {
    csrfHeader?: string | null;
    origin?: string | null;
  } = {},
) {
  const headers: Record<string, string> = { cookie: cookieHeader(session.cookies) };
  const origin = overrides.origin === undefined ? PORTAL_ORIGIN : overrides.origin;
  if (origin !== null) headers.origin = origin;
  const csrf = overrides.csrfHeader === undefined ? session.csrfToken : overrides.csrfHeader;
  if (csrf !== null) headers['x-csrf-token'] = csrf;
  return app.inject({ method: 'POST', url: '/auth/refresh', headers, payload: {} });
}

describe('cookie channel establishment (docs/26 §4.7(9) attributes, exact)', () => {
  it('session establishment sets the exact HttpOnly refresh + readable CSRF cookies and never echoes the refresh token', async () => {
    counter += 1;
    const subject = `attr-sub-${counter}`;
    const userId = await createUser(testDb.db);
    await createIdentity(testDb.db, userId, { issuer: ISSUER, subject });
    const accessToken = verifier.issueToken(evidenceFor(subject, `attr-origin-${counter}`));
    const refreshTokenValue = `attr-refresh-${counter}`;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin: PORTAL_ORIGIN },
      payload: { accessToken, refreshToken: refreshTokenValue },
    });
    expect(response.statusCode).toBe(200);
    const setCookies = setCookiesOf(response.headers as Record<string, unknown>);
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]).toBe(
      `himma_refresh=${refreshTokenValue}; Path=/auth; SameSite=Strict; Max-Age=2592000; HttpOnly; Secure`,
    );
    expect(setCookies[1]).toMatch(
      /^himma_csrf=[A-Za-z0-9\-_]+; Path=\/auth; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
    // The refresh token appears in NO response body — cookie channel only.
    expect(response.body).not.toContain(refreshTokenValue);
    const body = response.json() as { csrfToken: string };
    // The CSRF value is random channel binding, never credential material.
    expect(body.csrfToken).not.toBe(refreshTokenValue);
    expect(body.csrfToken).not.toBe(accessToken);
  });

  it('a session establishment from a disallowed origin cannot engage the cookie channel', async () => {
    counter += 1;
    const subject = `evil-sub-${counter}`;
    const userId = await createUser(testDb.db);
    await createIdentity(testDb.db, userId, { issuer: ISSUER, subject });
    const accessToken = verifier.issueToken(evidenceFor(subject, `evil-origin-${counter}`));
    const response = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin: EVIL_ORIGIN },
      payload: { accessToken, refreshToken: 'evil-refresh' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('csrfRejected');
    expect(setCookiesOf(response.headers as Record<string, unknown>)).toHaveLength(0);
  });

  it('production configuration REFUSES insecure cookies (no dev shortcut leaks into production)', () => {
    expect(() =>
      parseAuthCookieConfig('production', { AUTH_COOKIE_SECURE: 'false' }),
    ).toThrow(AuthCookieConfigError);
    expect(() =>
      parseAuthCookieConfig('production', {
        PORTAL_ALLOWED_ORIGINS: 'http://portal.himma.test',
      }),
    ).toThrow(AuthCookieConfigError);
  });
});

describe('GET /auth/csrf (reload bootstrap entry)', () => {
  it('re-issues the double-submit value to an allowlisted origin holding the refresh cookie', async () => {
    const session = await establishSession();
    const response = await app.inject({
      method: 'GET',
      url: '/auth/csrf',
      headers: { cookie: cookieHeader(session.cookies), origin: PORTAL_ORIGIN },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { csrfToken: string };
    expect(body.csrfToken.length).toBeGreaterThan(20);
  });

  it('without the refresh cookie it is semantically signed out; from a foreign origin it is refused', async () => {
    const bare = await app.inject({
      method: 'GET',
      url: '/auth/csrf',
      headers: { origin: PORTAL_ORIGIN },
    });
    expect(bare.statusCode).toBe(401);
    expect((bare.json() as { code: string }).code).toBe('sessionExpired');

    const session = await establishSession();
    const foreign = await app.inject({
      method: 'GET',
      url: '/auth/csrf',
      headers: { cookie: cookieHeader(session.cookies), origin: EVIL_ORIGIN },
    });
    expect(foreign.statusCode).toBe(403);
    expect((foreign.json() as { code: string }).code).toBe('csrfRejected');
  });
});

describe('POST /auth/refresh — CSRF and origin enforcement', () => {
  it('a valid same-origin request with the double-submit header refreshes to a USABLE access token', async () => {
    const session = await establishSession({ memberships: 'owner' });
    const response = await refreshRequest(session);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accessToken: string;
      csrfToken: string;
      assurance: string;
    };
    expect(body.assurance).toBe('mfa');
    expect(body.csrfToken).not.toBe(session.csrfToken); // rotated
    // The refreshed access token works as a bearer against the real API.
    const me = await app.inject({
      method: 'GET',
      url: '/provider/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const memberships = (me.json() as { memberships: { organizationId: string }[] })
      .memberships;
    expect(memberships).toHaveLength(1);
  });

  it('missing CSRF header is refused', async () => {
    const session = await establishSession();
    const response = await refreshRequest(session, { csrfHeader: null });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('csrfRejected');
  });

  it('an INCORRECT CSRF header is refused', async () => {
    const session = await establishSession();
    const response = await refreshRequest(session, { csrfHeader: 'not-the-right-value' });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('csrfRejected');
  });

  it('a cross-origin request cannot refresh even with the correct header value', async () => {
    const session = await establishSession();
    const response = await refreshRequest(session, { origin: EVIL_ORIGIN });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { code: string }).code).toBe('csrfRejected');
  });

  it('without the refresh cookie the channel is semantically signed out', async () => {
    const session = await establishSession();
    session.cookies.delete('himma_refresh');
    const response = await refreshRequest(session);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('sessionExpired');
  });
});

describe('Himma LoginSession stays authoritative over a valid provider refresh token (§9.4)', () => {
  it('a REVOKED login_session cannot refresh — the channel is cleared, no loop fuel remains', async () => {
    const session = await establishSession();
    await sql`UPDATE login_session SET revoked_at = now(), revoke_reason = 'forced'
              WHERE provider_subject = ${session.subject}`.execute(testDb.db);
    const response = await refreshRequest(session);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('sessionExpired');
    const cleared = setCookiesOf(response.headers as Record<string, unknown>);
    expect(cleared.some((cookie) => cookie.startsWith('himma_refresh=;'))).toBe(true);
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('an EXPIRED login_session cannot refresh', async () => {
    const session = await establishSession();
    await sql`UPDATE login_session SET expires_at = now() - interval '1 minute'
              WHERE provider_subject = ${session.subject}`.execute(testDb.db);
    const response = await refreshRequest(session);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { code: string }).code).toBe('sessionExpired');
  });

  it('provider-side refresh invalidation (revocation/rotation reuse) clears the channel; provider OUTAGE does not', async () => {
    const session = await establishSession();
    refresher.invalidate(session.refreshTokenValue);
    const dead = await refreshRequest(session);
    expect(dead.statusCode).toBe(401);
    expect((dead.json() as { code: string }).code).toBe('sessionExpired');
    expect(
      setCookiesOf(dead.headers as Record<string, unknown>).some((cookie) =>
        cookie.startsWith('himma_refresh=;'),
      ),
    ).toBe(true);

    const outage = await establishSession();
    refresher.setUnavailable(true);
    try {
      const response = await refreshRequest(outage);
      expect(response.statusCode).toBe(503);
      const body = response.json() as { code: string; message: string };
      expect(body.code).toBe('providerUnavailable');
      // Raw provider errors never leak; the channel survives the outage.
      expect(body.message).not.toMatch(/cognito|exception|stack/i);
      expect(setCookiesOf(response.headers as Record<string, unknown>)).toHaveLength(0);
    } finally {
      refresher.setUnavailable(false);
    }
  });

  it('rotation: when the provider rotates the refresh token, the cookie rotates with it', async () => {
    counter += 1;
    const subject = `rot-sub-${counter}`;
    const originJti = `rot-origin-${counter}`;
    const userId = await createUser(testDb.db);
    await createIdentity(testDb.db, userId, { issuer: ISSUER, subject });
    const accessToken = verifier.issueToken(evidenceFor(subject, originJti));
    const first = `rot-refresh-a-${counter}`;
    const second = `rot-refresh-b-${counter}`;
    refresher.register(first, () => ({
      accessToken: verifier.issueToken(evidenceFor(subject, originJti)),
      refreshToken: second,
    }));
    refresher.register(second, () => ({
      accessToken: verifier.issueToken(evidenceFor(subject, originJti)),
    }));

    const establish = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { origin: PORTAL_ORIGIN },
      payload: { accessToken, refreshToken: first },
    });
    const cookies = new Map<string, string>();
    absorbCookies(cookies, setCookiesOf(establish.headers as Record<string, unknown>));
    const csrfToken = (establish.json() as { csrfToken: string }).csrfToken;

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: {
        cookie: cookieHeader(cookies),
        origin: PORTAL_ORIGIN,
        'x-csrf-token': csrfToken,
      },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const rotated = setCookiesOf(refreshed.headers as Record<string, unknown>);
    expect(rotated.some((cookie) => cookie.startsWith(`himma_refresh=${second};`))).toBe(true);
    expect(refreshed.body).not.toContain(second); // never in JSON
  });
});

describe('refresh cannot mint business authority (docs/26 §5/§6)', () => {
  it('a refreshed identity with authority-suggesting scopes and NO membership stays a plain customer', async () => {
    const session = await establishSession({
      memberships: 'none',
      scopes: ['provider-admin', 'org-owner'],
    });
    const refreshed = await refreshRequest(session);
    expect(refreshed.statusCode).toBe(200);
    const accessToken = (refreshed.json() as { accessToken: string }).accessToken;
    const me = await app.inject({
      method: 'GET',
      url: '/provider/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ memberships: [] });
    const org = await app.inject({
      method: 'GET',
      url: `/provider/organizations/${newId()}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(org.statusCode).toBe(404);
  });

  it('membership stays PostgreSQL-authoritative across refresh: a revoked seat is gone on the refreshed bearer', async () => {
    const session = await establishSession({ memberships: 'owner' });
    // A standing owner keeps the org valid; revoke by re-role is not needed —
    // add a second owner then revoke the first seat.
    const other = await createUser(testDb.db);
    const orgId = (session as { orgId?: string }).orgId as string;
    await addMembership(testDb.db, other, orgId, 'owner');
    await sql`UPDATE staff_membership SET state = 'revoked', revoked_at = now()
              WHERE user_id = ${session.userId}`.execute(testDb.db);

    const refreshed = await refreshRequest(session);
    expect(refreshed.statusCode).toBe(200);
    const accessToken = (refreshed.json() as { accessToken: string }).accessToken;
    const me = await app.inject({
      method: 'GET',
      url: '/provider/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.json()).toEqual({ memberships: [] });
  });
});

describe('final logout architecture', () => {
  it('logout revokes the session-of-record, clears both cookies, and the stale cookie cannot silently re-authenticate', async () => {
    const session = await establishSession();
    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        cookie: cookieHeader(session.cookies),
        origin: PORTAL_ORIGIN,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    const cleared = setCookiesOf(logout.headers as Record<string, unknown>);
    expect(cleared.some((cookie) => cookie.startsWith('himma_refresh=;'))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith('himma_csrf=;'))).toBe(true);
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);

    const rows = await testDb.db
      .selectFrom('login_session')
      .select(['revoked_at'])
      .where('provider_subject', '=', session.subject)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();

    // A browser that somehow retained the cookie jar still cannot refresh:
    // Himma's revoked session-of-record refuses (§9.4 authority).
    const csrf = await app.inject({
      method: 'GET',
      url: '/auth/csrf',
      headers: { cookie: cookieHeader(session.cookies), origin: PORTAL_ORIGIN },
    });
    const csrfBody = csrf.json() as { csrfToken?: string };
    if (csrf.statusCode === 200 && typeof csrfBody.csrfToken === 'string') {
      absorbCookies(session.cookies, setCookiesOf(csrf.headers as Record<string, unknown>));
      session.csrfToken = csrfBody.csrfToken;
      const replay = await refreshRequest(session);
      expect(replay.statusCode).toBe(401);
      expect((replay.json() as { code: string }).code).toBe('sessionExpired');
    }
  });
});
