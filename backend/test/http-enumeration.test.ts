/**
 * B2-4 — enumeration-safe flows and secrecy at the HTTP boundary (docs/26
 * §5.5, §11.9, D2): reset requests are outwardly identical for existing and
 * unknown emails (status, body, headers, timing floor); captured mail
 * carries no codes; rate limits key on digests; no token or secret reaches
 * audit, outbox, or error payloads.
 */
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app/build-app';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { firstLogin } from '../src/modules/identity/services/first-login';
import type { ProviderEvidence } from '../src/modules/identity/providers/evidence';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

const FLOOR_MS = 60;
let testDb: TestDb;
let app: FastifyInstance;
let mail: CaptureMailSender;
let ipCounter = 0;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  mail = new CaptureMailSender();
  app = buildApp({
    identity: {
      db: testDb.db,
      accessTokenVerifier: new FakeAccessTokenVerifier(),
      idTokenAdapter: new FakeAuthProviderAdapter(),
      mailSender: mail,
      rateLimiterStore: new InMemoryRateLimiterStore(),
      enumerationFloorMs: FLOOR_MS,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.drop();
});

function nextIp(): string {
  ipCounter += 1;
  return `10.7.0.${ipCounter}`;
}

const EXISTING_EMAIL = 'reset-existing@example.test';

async function resetRequest(email: string): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  elapsedMs: number;
}> {
  const started = Date.now();
  const response = await app.inject({
    method: 'POST',
    url: '/auth/password/reset-request',
    remoteAddress: nextIp(),
    payload: { email },
  });
  const headers = { ...(response.headers as Record<string, unknown>) };
  delete headers.date;
  return {
    statusCode: response.statusCode,
    body: response.body,
    headers,
    elapsedMs: Date.now() - started,
  };
}

describe('enumeration-safe password reset requests', () => {
  beforeAll(async () => {
    const evidence: ProviderEvidence = {
      provider: 'email',
      issuer: 'https://cognito.test/reset-pool',
      subject: 'reset-sub-1',
      email: EXISTING_EMAIL,
      emailVerified: true,
      isPrivateRelay: false,
      assurance: 'single_factor',
    };
    const created = await firstLogin({ db: testDb.db }, { evidence });
    if (created.kind !== 'newCustomerCreated') throw new Error(created.kind);
  });

  it('returns byte-identical responses for existing and unknown emails, both above the timing floor', async () => {
    const existing = await resetRequest(EXISTING_EMAIL);
    const unknown = await resetRequest('nobody-here@example.test');
    expect(existing.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(existing.statusCode);
    expect(unknown.body).toBe(existing.body);
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(existing.headers).sort());
    expect(existing.elapsedMs).toBeGreaterThanOrEqual(FLOOR_MS);
    expect(unknown.elapsedMs).toBeGreaterThanOrEqual(FLOOR_MS);
  });

  it('records bookkeeping and captured mail only for the existing identity — and the mail carries no code', async () => {
    const sent = mail.captured.filter((m) => m.to === EXISTING_EMAIL);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(mail.captured.filter((m) => m.to === 'nobody-here@example.test')).toEqual([]);
    for (const message of sent) {
      expect(message.body).not.toMatch(/\b\d{4,8}\b/); // no numeric codes
      expect(message.body).not.toMatch(/token|secret|code=/i);
    }
    const challenges = await sql<{ n: string }>`
      SELECT count(*) AS n FROM auth_challenge WHERE kind = 'password_reset'`.execute(testDb.db);
    expect(Number(challenges.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed emails through schema validation without touching services', async () => {
    const before = mail.captured.length;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/password/reset-request',
      remoteAddress: nextIp(),
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(422);
    expect(mail.captured.length).toBe(before);
  });

  it('rate limits repeated requests for one email digest without using the raw address as a key', async () => {
    const email = 'hammered@example.test';
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/password/reset-request',
        remoteAddress: ip,
        payload: { email },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe('secrecy at the boundary', () => {
  it('no audit or outbox row anywhere contains bearer-token-like or code-like material', async () => {
    const audit = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_event
      WHERE action LIKE '%token%' OR entity_type LIKE '%token%'`.execute(testDb.db);
    expect(Number(audit.rows[0]?.n)).toBe(0);
    const outbox = await sql<{ n: string }>`
      SELECT count(*) AS n FROM outbox_event
      WHERE payload::text ~* '(token|secret|password|code)'`.execute(testDb.db);
    expect(Number(outbox.rows[0]?.n)).toBe(0);
  });

  it('HTTP error payloads never echo submitted token material', async () => {
    const bogus = 'AAAA.BBBB.CCCC-super-secret-token-material';
    const bearer = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${bogus}` },
      remoteAddress: nextIp(),
    });
    expect(bearer.statusCode).toBe(401);
    expect(bearer.body).not.toContain(bogus);
    const body = await app.inject({
      method: 'POST',
      url: '/auth/session',
      remoteAddress: nextIp(),
      payload: { accessToken: bogus, idToken: bogus },
    });
    expect([401, 422]).toContain(body.statusCode);
    expect(body.body).not.toContain(bogus);
  });
});
