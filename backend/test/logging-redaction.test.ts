/**
 * W6-1 — structured logging + NEVER-LOG discipline (docs/37 §24; owner
 * items 18–20): runtime proofs with deliberately secret-shaped values —
 * never a source grep. The production logger options are exercised through
 * a real buildApp with a captured pino destination.
 */
import { Writable } from 'node:stream';

import { buildApp } from '../src/app/build-app';
import { buildLoggerOptions, parseLogLevel, safeLogPath } from '../src/observability/logging';
import { CaptureMailSender } from '../src/modules/identity/mail/mail-sender';
import { InMemoryRateLimiterStore } from '../src/modules/identity/http/rate-limiter';
import { FakeAccessTokenVerifier } from '../src/modules/identity/providers/fake/fake-access-token-verifier';
import { FakeAuthProviderAdapter } from '../src/modules/identity/providers/fake/fake-adapter';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(60_000);

const BEARER_SECRET = 'w6-secret-bearer-token-DO-NOT-LOG-abc123';
const COOKIE_SECRET = 'himma_refresh=w6-secret-refresh-cookie-DO-NOT-LOG';
const CSRF_SECRET = 'w6-secret-csrf-DO-NOT-LOG';
const REDEMPTION_CODE = '86754321';
const BODY_SECRET = 'w6-body-secret-DO-NOT-LOG';

describe('W6-1 structured production logging', () => {
  let testDb: TestDb;
  const lines: string[] = [];

  beforeAll(async () => {
    testDb = await createMigratedTestDb();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  async function buildCapturedApp() {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const options = buildLoggerOptions({ role: 'api', level: 'info' }) as Record<string, unknown>;
    const app = buildApp({
      logger: { ...options, stream } as never,
      identity: {
        db: testDb.db,
        accessTokenVerifier: new FakeAccessTokenVerifier(),
        idTokenAdapter: new FakeAuthProviderAdapter(),
        mailSender: new CaptureMailSender(),
        rateLimiterStore: new InMemoryRateLimiterStore(),
      },
    });
    await app.ready();
    return app;
  }

  it('request logs are bounded metadata with the runtime role and canonical id — secret-shaped material never appears', async () => {
    const app = await buildCapturedApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/me?redemptionCode=${REDEMPTION_CODE}&secret=${BODY_SECRET}`,
        headers: {
          authorization: `Bearer ${BEARER_SECRET}`,
          cookie: COOKIE_SECRET,
          'x-csrf-token': CSRF_SECRET,
        },
      });
      expect(response.statusCode).toBe(401);
      await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { accessToken: BEARER_SECRET, refreshToken: `rt-${BODY_SECRET}` },
      });
    } finally {
      await app.close();
    }
    const joined = lines.join('');
    expect(lines.length).toBeGreaterThan(0);
    // Never-log locks (owner item 19): deliberately secret-shaped values.
    expect(joined).not.toContain(BEARER_SECRET);
    expect(joined).not.toContain(COOKIE_SECRET);
    expect(joined).not.toContain(CSRF_SECRET);
    expect(joined).not.toContain(REDEMPTION_CODE);
    expect(joined).not.toContain(BODY_SECRET);
    // Query strings are stripped from logged paths (owner item 20).
    expect(joined).not.toContain('redemptionCode=');
    expect(joined).toContain('"path":"/me"');
    // Structured fields: role tag + canonical request correlation.
    expect(joined).toContain('"role":"api"');
    expect(joined).toMatch(/"reqId":"[0-9a-f-]{36}"/);
  });

  it('logger primitives are bounded: safe path truncation and fail-closed level parsing', () => {
    expect(safeLogPath('/customer/bookings?bookingId=b-1&code=999')).toBe('/customer/bookings');
    expect(safeLogPath(`/x/${'y'.repeat(500)}`)).toHaveLength(200);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(() => parseLogLevel('chatty')).toThrow(/LOG_LEVEL/);
  });
});
