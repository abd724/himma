/**
 * W6-1 — the production runtime configuration contract (docs/37 §6):
 * fail-closed, variable-naming refusals, no silent fallback.
 */
import { ConfigError } from '../src/config/env';
import { EXPECTED_DB_LOGIN, loadRuntimeConfig } from '../src/config/runtime';

const PROD_BASE = {
  NODE_ENV: 'production',
  RUNTIME_ROLE: 'api',
  DATABASE_URL: 'postgres://himma_api:pw@db.internal:5432/himma',
  HOST: '0.0.0.0',
  PORT: '8080',
};

describe('W6-1 production configuration contract', () => {
  it('a complete production api config parses with explicit values only', () => {
    const config = loadRuntimeConfig({ ...PROD_BASE });
    expect(config.nodeEnv).toBe('production');
    expect(config.role).toBe('api');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.paymentsMode).toBe('disabled');
    expect(config.logLevel).toBe('info');
    expect(config.database.host).toBe('db.internal');
  });

  it('every missing mandatory production value refuses startup naming the variable', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, RUNTIME_ROLE: undefined })).toThrow(
      /RUNTIME_ROLE/,
    );
    expect(() => loadRuntimeConfig({ ...PROD_BASE, HOST: undefined })).toThrow(/HOST/);
    expect(() => loadRuntimeConfig({ ...PROD_BASE, PORT: undefined })).toThrow(/PORT/);
    expect(() => loadRuntimeConfig({ ...PROD_BASE, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('unknown runtime roles are refused — never defaulted', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, RUNTIME_ROLE: 'everything' })).toThrow(
      ConfigError,
    );
  });

  it('payment mode is explicit: unknown values (including "live") are refused, and test mode requires a key', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'live' })).toThrow(
      /PAYMENTS_MODE/,
    );
    expect(() => loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'test' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    const test = loadRuntimeConfig({
      ...PROD_BASE,
      PAYMENTS_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_fictional',
    });
    expect(test.paymentsMode).toBe('test');
  });

  it('public checkout return URLs must be https and never local in production', () => {
    expect(() =>
      loadRuntimeConfig({
        ...PROD_BASE,
        PAYMENT_CHECKOUT_SUCCESS_URL: 'http://himma.app/return',
        PAYMENT_CHECKOUT_CANCEL_URL: 'https://himma.app/cancel',
      }),
    ).toThrow(/https/);
    expect(() =>
      loadRuntimeConfig({
        ...PROD_BASE,
        PAYMENT_CHECKOUT_SUCCESS_URL: 'https://localhost/return',
        PAYMENT_CHECKOUT_CANCEL_URL: 'https://himma.app/cancel',
      }),
    ).toThrow(/local/);
    expect(() =>
      loadRuntimeConfig({
        ...PROD_BASE,
        PAYMENT_CHECKOUT_SUCCESS_URL: 'https://himma.app/return',
      }),
    ).toThrow(/both/);
    const ok = loadRuntimeConfig({
      ...PROD_BASE,
      PAYMENT_CHECKOUT_SUCCESS_URL: 'https://himma.app/return',
      PAYMENT_CHECKOUT_CANCEL_URL: 'https://himma.app/cancel',
    });
    expect(ok.checkoutUrls?.successUrl).toBe('https://himma.app/return');
  });

  it('partial evidence object-storage configuration is refused (all or none)', () => {
    expect(() =>
      loadRuntimeConfig({ ...PROD_BASE, EVIDENCE_S3_BUCKET: 'himma-evidence' }),
    ).toThrow(/EVIDENCE_S3/);
    const full = loadRuntimeConfig({
      ...PROD_BASE,
      EVIDENCE_S3_ENDPOINT: 'https://s3.me-south-1.amazonaws.com',
      EVIDENCE_S3_REGION: 'me-south-1',
      EVIDENCE_S3_BUCKET: 'himma-evidence',
      EVIDENCE_S3_ACCESS_KEY_ID: 'AKIAFICTIONAL',
      EVIDENCE_S3_SECRET_ACCESS_KEY: 'fictional-secret',
    });
    expect(full.evidenceStorage?.bucket).toBe('himma-evidence');
  });

  it('the expected DB login per runtime role is pinned (docs/37 §28)', () => {
    expect(EXPECTED_DB_LOGIN).toEqual({
      api: 'himma_api',
      worker: 'himma_worker',
      maintenance: 'himma_maintenance_runner',
    });
  });

  it('bad log levels and drain budgets refuse with the variable name', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => loadRuntimeConfig({ ...PROD_BASE, SHUTDOWN_DRAIN_MS: '-1' })).toThrow(
      /SHUTDOWN_DRAIN_MS/,
    );
  });
});
