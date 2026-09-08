/**
 * W6-1 — the production runtime configuration contract (docs/37 §6):
 * fail-closed, variable-naming refusals, no silent fallback.
 */
import { ConfigError } from '../src/config/env';
import { EXPECTED_DB_LOGIN, loadRuntimeConfig } from '../src/config/runtime';

// W6-4A: production configs carry the TLS contract; the CA bundle is read
// through an injected reader (no file system in this unit suite).
const TLS = { DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/etc/himma/certs/rds-global-bundle.pem' };
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const IO = { readFile: () => PEM };
const PROD_BASE = {
  NODE_ENV: 'production',
  RUNTIME_ROLE: 'api',
  DATABASE_URL: 'postgres://himma_api:pw@db.internal:5432/himma',
  HOST: '0.0.0.0',
  PORT: '8080',
  ...TLS,
};

describe('W6-1 production configuration contract', () => {
  it('a complete production api config parses with explicit values only', () => {
    const config = loadRuntimeConfig({ ...PROD_BASE }, IO);
    expect(config.nodeEnv).toBe('production');
    expect(config.role).toBe('api');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.paymentsMode).toBe('disabled');
    expect(config.logLevel).toBe('info');
    expect(config.database.host).toBe('db.internal');
  });

  it('every missing mandatory production value refuses startup naming the variable', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, RUNTIME_ROLE: undefined }, IO)).toThrow(
      /RUNTIME_ROLE/,
    );
    expect(() => loadRuntimeConfig({ ...PROD_BASE, HOST: undefined }, IO)).toThrow(/HOST/);
    expect(() => loadRuntimeConfig({ ...PROD_BASE, PORT: undefined }, IO)).toThrow(/PORT/);
    expect(() => loadRuntimeConfig({ ...PROD_BASE, DATABASE_URL: undefined }, IO)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('unknown runtime roles are refused — never defaulted', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, RUNTIME_ROLE: 'everything' }, IO)).toThrow(
      ConfigError,
    );
  });

  it('payment mode is explicit: unknown values (including "live") are refused, and test mode requires a key', () => {
    expect(() => loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'live' }, IO)).toThrow(
      /PAYMENTS_MODE/,
    );
    expect(() => loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'test' }, IO)).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    const test = loadRuntimeConfig({
      ...PROD_BASE,
      PAYMENTS_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_fictional',
    }, IO);
    expect(test.paymentsMode).toBe('test');
  });

  it('a production process never starts with a non-TEST-mode Stripe secret — in test mode or disabled mode (W6-4A container certification)', () => {
    for (const key of ['sk_live_fictional', 'rk_live_fictional', 'whatever']) {
      expect(() =>
        loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'test', STRIPE_SECRET_KEY: key }, IO),
      ).toThrow(/TEST-mode key .* live-mode key is refused/);
      expect(() =>
        loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'disabled', STRIPE_SECRET_KEY: key }, IO),
      ).toThrow(/TEST-mode key .* live-mode key is refused/);
    }
    // The message names the variable, never the value.
    let thrown: unknown;
    try {
      loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'test', STRIPE_SECRET_KEY: 'sk_live_fictional' }, IO);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('STRIPE_SECRET_KEY');
    expect((thrown as Error).message).not.toContain('fictional');
    // TEST-mode restricted keys are accepted like secret keys.
    expect(
      loadRuntimeConfig({ ...PROD_BASE, PAYMENTS_MODE: 'test', STRIPE_SECRET_KEY: 'rk_test_fictional' }, IO)
        .paymentsMode,
    ).toBe('test');
  });

  it('public checkout return URLs must be https and never local in production', () => {
    expect(() =>
      loadRuntimeConfig({
        ...PROD_BASE,
        PAYMENT_CHECKOUT_SUCCESS_URL: 'http://himma.app/return',
        PAYMENT_CHECKOUT_CANCEL_URL: 'https://himma.app/cancel',
      }, IO),
    ).toThrow(/https/);
    expect(() =>
      loadRuntimeConfig({
        ...PROD_BASE,
        PAYMENT_CHECKOUT_SUCCESS_URL: 'https://localhost/return',
        PAYMENT_CHECKOUT_CANCEL_URL: 'https://himma.app/cancel',
      }, IO),
    ).toThrow(/local/);
    expect(() =>
      loadRuntimeConfig({
        ...PROD_BASE,
        PAYMENT_CHECKOUT_SUCCESS_URL: 'https://himma.app/return',
      }, IO),
    ).toThrow(/both/);
    const ok = loadRuntimeConfig({
      ...PROD_BASE,
      PAYMENT_CHECKOUT_SUCCESS_URL: 'https://himma.app/return',
      PAYMENT_CHECKOUT_CANCEL_URL: 'https://himma.app/cancel',
    }, IO);
    expect(ok.checkoutUrls?.successUrl).toBe('https://himma.app/return');
  });

  it('partial evidence object-storage configuration is refused (all or none)', () => {
    expect(() =>
      loadRuntimeConfig({ ...PROD_BASE, EVIDENCE_S3_BUCKET: 'himma-evidence' }, IO),
    ).toThrow(/EVIDENCE_S3/);
    const full = loadRuntimeConfig({
      ...PROD_BASE,
      EVIDENCE_S3_ENDPOINT: 'https://s3.me-south-1.amazonaws.com',
      EVIDENCE_S3_REGION: 'me-south-1',
      EVIDENCE_S3_BUCKET: 'himma-evidence',
      EVIDENCE_S3_ACCESS_KEY_ID: 'AKIAFICTIONAL',
      EVIDENCE_S3_SECRET_ACCESS_KEY: 'fictional-secret',
    }, IO);
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
    expect(() => loadRuntimeConfig({ ...PROD_BASE, LOG_LEVEL: 'verbose' }, IO)).toThrow(/LOG_LEVEL/);
    expect(() => loadRuntimeConfig({ ...PROD_BASE, SHUTDOWN_DRAIN_MS: '-1' }, IO)).toThrow(
      /SHUTDOWN_DRAIN_MS/,
    );
  });
});

describe('W6-3 scheduler and maintenance policy (bounded, engineering-defaulted)', () => {
  const WORKER = { NODE_ENV: 'production', RUNTIME_ROLE: 'worker', DATABASE_URL: 'postgres://himma_worker:pw@db.internal:5432/himma', ...TLS };

  it('defaults compose without any variable set', () => {
    const config = loadRuntimeConfig({ ...WORKER }, IO);
    expect(config.scheduler).toEqual({ tickMs: 5_000, disabledJobs: [], intervalOverridesMs: {} });
    expect(config.maintenance).toEqual({
      batchSize: 1_000,
      maxBatches: 100,
      retentionDays: { rateLimitWindows: 7, redemptionLookupAttempts: 7, idempotencyKeys: 90, publishedOutbox: 30, jobRuns: 30 },
    });
  });

  it('parses overrides and refuses malformed or out-of-bound values naming the variable', () => {
    const config = loadRuntimeConfig({
      ...WORKER,
      SCHEDULER_TICK_MS: '1000',
      SCHEDULER_DISABLED_JOBS: 'booking.hold-sweep, identity.role-expiry',
      SCHEDULER_INTERVALS: 'payment.checkout-sweep=30000,payment.stuck-state=60000',
      MAINTENANCE_BATCH: '250',
      RETENTION_IDEMPOTENCY_KEY_DAYS: '120',
    }, IO);
    expect(config.scheduler.tickMs).toBe(1_000);
    expect(config.scheduler.disabledJobs).toEqual(['booking.hold-sweep', 'identity.role-expiry']);
    expect(config.scheduler.intervalOverridesMs).toEqual({ 'payment.checkout-sweep': 30_000, 'payment.stuck-state': 60_000 });
    expect(config.maintenance.batchSize).toBe(250);
    expect(config.maintenance.retentionDays.idempotencyKeys).toBe(120);

    expect(() => loadRuntimeConfig({ ...WORKER, SCHEDULER_TICK_MS: '10' }, IO)).toThrow(/SCHEDULER_TICK_MS/);
    expect(() => loadRuntimeConfig({ ...WORKER, SCHEDULER_DISABLED_JOBS: 'DROP TABLE' }, IO)).toThrow(/SCHEDULER_DISABLED_JOBS/);
    expect(() => loadRuntimeConfig({ ...WORKER, SCHEDULER_INTERVALS: 'payment.checkout-sweep=1' }, IO)).toThrow(/SCHEDULER_INTERVALS/);
    expect(() => loadRuntimeConfig({ ...WORKER, SCHEDULER_INTERVALS: 'nonsense' }, IO)).toThrow(/SCHEDULER_INTERVALS/);
    // Retention horizons cannot be configured below their engineering floors.
    expect(() => loadRuntimeConfig({ ...WORKER, RETENTION_IDEMPOTENCY_KEY_DAYS: '5' }, IO)).toThrow(/RETENTION_IDEMPOTENCY_KEY_DAYS/);
    expect(() => loadRuntimeConfig({ ...WORKER, RETENTION_OUTBOX_PUBLISHED_DAYS: '1' }, IO)).toThrow(/RETENTION_OUTBOX_PUBLISHED_DAYS/);
    expect(() => loadRuntimeConfig({ ...WORKER, MAINTENANCE_BATCH: '0' }, IO)).toThrow(/MAINTENANCE_BATCH/);
  });

  it('the maintenance role pins its own login', () => {
    expect(EXPECTED_DB_LOGIN.maintenance).toBe('himma_maintenance_runner');
    const config = loadRuntimeConfig({ NODE_ENV: 'production', RUNTIME_ROLE: 'maintenance', DATABASE_URL: 'postgres://himma_maintenance_runner:pw@db.internal:5432/himma', ...TLS }, IO);
    expect(config.role).toBe('maintenance');
  });
});
