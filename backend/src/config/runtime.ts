/**
 * W6-1 — the production runtime configuration contract (docs/37 §6).
 * W6-3 adds the scheduler and maintenance operational policy (bounded,
 * engineering-defaulted; never a correctness input).
 *
 * Builds on the certified `loadConfig` (env.ts) and adds the runtime-role
 * layer: role, listener, logging, payment mode, checkout URLs, evidence
 * object storage. FAIL-CLOSED in production: every missing/invalid
 * mandatory value refuses startup naming the variable; there is NO
 * fallback to localhost public origins, fixture storage, dev identity,
 * deterministic payments, or in-memory security stores (those refusals
 * live in composition — this module refuses the CONFIG side).
 *
 * Secrets never appear in code or errors: messages name variables, never
 * values.
 */
import type { S3EvidenceStoreConfig } from '../modules/provider/storage/s3-evidence-store';
import type { LogLevel } from '../observability/logging';
import { parseLogLevel } from '../observability/logging';
import type { BackendConfig } from './env';
import { ConfigError, loadConfig } from './env';

export type RuntimeRole = 'api' | 'worker' | 'maintenance' | 'migrate';

const RUNTIME_ROLES: readonly RuntimeRole[] = ['api', 'worker', 'maintenance', 'migrate'];

/**
 * The DB login each runtime role must present (docs/37 §28). Verified at
 * startup against `SELECT current_user` — a mispasted credential refuses
 * to boot (docs/37 §6). The maintenance login arrives with W6-3.
 */
export const EXPECTED_DB_LOGIN: Readonly<Record<Exclude<RuntimeRole, 'migrate'>, string>> = {
  api: 'himma_api',
  worker: 'himma_worker',
  maintenance: 'himma_maintenance_runner',
};

export type PaymentsMode = 'disabled' | 'test';

export interface RuntimeConfig extends BackendConfig {
  role: RuntimeRole;
  host: string;
  port: number;
  logLevel: LogLevel;
  /** Bounded graceful-shutdown drain budget (docs/37 §8). */
  shutdownDrainMs: number;
  /**
   * Explicit payment composition mode (docs/37 §33): `disabled` (default)
   * composes NO provider; `test` allows the Stripe TEST driver ONLY (the
   * driver still refuses non-TEST keys structurally). There is no `live`
   * value — live enablement is the future PA-06 slice, not configuration.
   */
  paymentsMode: PaymentsMode;
  /** Server-authored hosted-checkout navigation targets (W5-5). */
  checkoutUrls?: { successUrl: string; cancelUrl: string };
  /** W3-4 private evidence object storage; absent = fail-closed 404 surface. */
  evidenceStorage?: S3EvidenceStoreConfig;
  /**
   * W6-2 worker operational policy (docs/37 §13/§22 — engineering-owned,
   * bounded env overrides with defaults). Only consumed by RUNTIME_ROLE=worker.
   */
  worker: {
    /** Idle poll interval of the outbox dispatcher loop. */
    outboxPollMs: number;
    /** Rows claimed per dispatcher pass (FOR UPDATE SKIP LOCKED batch). */
    outboxBatchSize: number;
    /** Attempt ceiling before a row is durably quarantined. */
    outboxMaxAttempts: number;
    /** Cadence of the certified payment passes (pending events + trusted results). */
    paymentPollMs: number;
    /** Optional minimal liveness listener port (absent = none). */
    statusPort?: number;
  };
  /**
   * W6-3 worker-hosted scheduler policy (docs/37 §13/§20 — engineering-owned).
   * Cadences are per-job engineering defaults (scheduled-jobs.ts); the
   * tick only decides how often DUE-ness is evaluated on the DATABASE clock.
   */
  scheduler: {
    /** How often the worker evaluates due jobs (never a correctness input). */
    tickMs: number;
    /** Job names switched off for this deployment (operational choice). */
    disabledJobs: string[];
    /** Per-job cadence overrides in ms (`SCHEDULER_INTERVALS=name=ms,…`). */
    intervalOverridesMs: Record<string, number>;
  };
  /**
   * W6-3 maintenance-mode policy (docs/37 §18/§19 — engineering-scoped
   * retention horizons and batch bounds; floors are ALSO enforced inside the
   * database functions, so a shorter value cannot delete more).
   */
  maintenance: {
    batchSize: number;
    maxBatches: number;
    retentionDays: {
      rateLimitWindows: number;
      redemptionLookupAttempts: number;
      idempotencyKeys: number;
      publishedOutbox: number;
      jobRuns: number;
    };
  };
}

const JOB_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

function parseJobNameList(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const names = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  for (const job of names) {
    if (!JOB_NAME_PATTERN.test(job)) {
      throw new ConfigError(`${name} contains an invalid job name "${job}"`);
    }
  }
  return [...new Set(names)];
}

function parseIntervalOverrides(raw: string | undefined): Record<string, number> {
  const overrides: Record<string, number> = {};
  if (raw === undefined || raw.trim() === '') return overrides;
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const [job, value, ...rest] = entry.split('=');
    if (job === undefined || value === undefined || rest.length > 0 || !JOB_NAME_PATTERN.test(job.trim())) {
      throw new ConfigError(`SCHEDULER_INTERVALS entries must be "<job>=<ms>" — received "${entry}"`);
    }
    overrides[job.trim()] = parseBoundedInt(
      `SCHEDULER_INTERVALS[${job.trim()}]`,
      value.trim(),
      0,
      1_000,
      7 * 24 * 3_600_000,
    );
  }
  return overrides;
}

export const DEFAULT_SCHEDULER_POLICY: Readonly<RuntimeConfig['scheduler']> = {
  tickMs: 5_000,
  disabledJobs: [],
  intervalOverridesMs: {},
};

function parseSchedulerPolicy(env: NodeJS.ProcessEnv): RuntimeConfig['scheduler'] {
  return {
    tickMs: parseBoundedInt('SCHEDULER_TICK_MS', env.SCHEDULER_TICK_MS, DEFAULT_SCHEDULER_POLICY.tickMs, 250, 60_000),
    disabledJobs: parseJobNameList('SCHEDULER_DISABLED_JOBS', env.SCHEDULER_DISABLED_JOBS),
    intervalOverridesMs: parseIntervalOverrides(env.SCHEDULER_INTERVALS),
  };
}

/**
 * Engineering-scoped retention horizons (docs/37 §18). The database
 * functions refuse anything below their floors (1 d / 1 d / 30 d / 7 d / 7 d)
 * regardless of what configuration says.
 */
export const DEFAULT_MAINTENANCE_POLICY: Readonly<RuntimeConfig['maintenance']> = {
  batchSize: 1_000,
  maxBatches: 100,
  retentionDays: {
    rateLimitWindows: 7,
    redemptionLookupAttempts: 7,
    idempotencyKeys: 90,
    publishedOutbox: 30,
    jobRuns: 30,
  },
};

function parseMaintenancePolicy(env: NodeJS.ProcessEnv): RuntimeConfig['maintenance'] {
  const d = DEFAULT_MAINTENANCE_POLICY;
  return {
    batchSize: parseBoundedInt('MAINTENANCE_BATCH', env.MAINTENANCE_BATCH, d.batchSize, 1, 10_000),
    maxBatches: parseBoundedInt('MAINTENANCE_MAX_BATCHES', env.MAINTENANCE_MAX_BATCHES, d.maxBatches, 1, 100_000),
    retentionDays: {
      rateLimitWindows: parseBoundedInt(
        'RETENTION_RATE_LIMIT_WINDOW_DAYS', env.RETENTION_RATE_LIMIT_WINDOW_DAYS, d.retentionDays.rateLimitWindows, 1, 3_650),
      redemptionLookupAttempts: parseBoundedInt(
        'RETENTION_REDEMPTION_LOOKUP_DAYS', env.RETENTION_REDEMPTION_LOOKUP_DAYS, d.retentionDays.redemptionLookupAttempts, 1, 3_650),
      idempotencyKeys: parseBoundedInt(
        'RETENTION_IDEMPOTENCY_KEY_DAYS', env.RETENTION_IDEMPOTENCY_KEY_DAYS, d.retentionDays.idempotencyKeys, 30, 3_650),
      publishedOutbox: parseBoundedInt(
        'RETENTION_OUTBOX_PUBLISHED_DAYS', env.RETENTION_OUTBOX_PUBLISHED_DAYS, d.retentionDays.publishedOutbox, 7, 3_650),
      jobRuns: parseBoundedInt('RETENTION_JOB_RUN_DAYS', env.RETENTION_JOB_RUN_DAYS, d.retentionDays.jobRuns, 7, 3_650),
    },
  };
}

function parseBoundedInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in ${min}–${max} — received "${raw}"`);
  }
  return value;
}

function parseWorkerPolicy(env: NodeJS.ProcessEnv): RuntimeConfig['worker'] {
  const policy: RuntimeConfig['worker'] = {
    outboxPollMs: parseBoundedInt('WORKER_OUTBOX_POLL_MS', env.WORKER_OUTBOX_POLL_MS, 2_000, 100, 60_000),
    outboxBatchSize: parseBoundedInt('WORKER_OUTBOX_BATCH', env.WORKER_OUTBOX_BATCH, 100, 1, 1_000),
    outboxMaxAttempts: parseBoundedInt('WORKER_OUTBOX_MAX_ATTEMPTS', env.WORKER_OUTBOX_MAX_ATTEMPTS, 8, 1, 100),
    paymentPollMs: parseBoundedInt('WORKER_PAYMENT_POLL_MS', env.WORKER_PAYMENT_POLL_MS, 30_000, 1_000, 600_000),
  };
  if ((env.WORKER_STATUS_PORT ?? '') !== '') {
    policy.statusPort = parseBoundedInt('WORKER_STATUS_PORT', env.WORKER_STATUS_PORT, 0, 0, 65_535);
  }
  return policy;
}

function parseRole(raw: string | undefined): RuntimeRole {
  if (raw === undefined || raw === '') {
    throw new ConfigError('RUNTIME_ROLE is required (api | worker | maintenance | migrate)');
  }
  if (!(RUNTIME_ROLES as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `RUNTIME_ROLE must be one of ${RUNTIME_ROLES.join(', ')} — received "${raw}"`,
    );
  }
  return raw as RuntimeRole;
}

function parseListenPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new ConfigError('PORT is required for the production listener');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be a TCP port (0–65535) — received "${raw}"`);
  }
  return port;
}

function parseHost(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    // Explicit by design (docs/37 §2): containers need 0.0.0.0, VMs may
    // bind narrower — a silent default surprises one of them.
    throw new ConfigError('HOST is required for the production listener (an explicit bind address)');
  }
  return raw;
}

function parsePaymentsMode(raw: string | undefined): PaymentsMode {
  if (raw === undefined || raw === '') return 'disabled';
  if (raw === 'disabled' || raw === 'test') return raw;
  throw new ConfigError(
    `PAYMENTS_MODE must be "disabled" or "test" — received "${raw}". There is no "live" value: live enablement is a future owner-approved change (docs/36 PA-06), not configuration.`,
  );
}

const LOCAL_HOST_PATTERN = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i;

/** Public origins (checkout returns) must be real https origins in production. */
function assertPublicHttpsUrl(name: string, raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`${name} must be an https URL in production`);
  }
  if (LOCAL_HOST_PATTERN.test(parsed.hostname)) {
    throw new ConfigError(`${name} must not point at a local address in production`);
  }
}

function parseCheckoutUrls(
  env: NodeJS.ProcessEnv,
  production: boolean,
): { successUrl: string; cancelUrl: string } | undefined {
  const successUrl = env.PAYMENT_CHECKOUT_SUCCESS_URL;
  const cancelUrl = env.PAYMENT_CHECKOUT_CANCEL_URL;
  const anySet = (successUrl ?? '') !== '' || (cancelUrl ?? '') !== '';
  if (!anySet) return undefined;
  if ((successUrl ?? '') === '' || (cancelUrl ?? '') === '') {
    throw new ConfigError(
      'PAYMENT_CHECKOUT_SUCCESS_URL and PAYMENT_CHECKOUT_CANCEL_URL must both be set (or neither)',
    );
  }
  if (production) {
    assertPublicHttpsUrl('PAYMENT_CHECKOUT_SUCCESS_URL', successUrl as string);
    assertPublicHttpsUrl('PAYMENT_CHECKOUT_CANCEL_URL', cancelUrl as string);
  }
  return { successUrl: successUrl as string, cancelUrl: cancelUrl as string };
}

const EVIDENCE_VARS = [
  'EVIDENCE_S3_ENDPOINT',
  'EVIDENCE_S3_REGION',
  'EVIDENCE_S3_BUCKET',
  'EVIDENCE_S3_ACCESS_KEY_ID',
  'EVIDENCE_S3_SECRET_ACCESS_KEY',
] as const;

function parseEvidenceStorage(env: NodeJS.ProcessEnv): S3EvidenceStoreConfig | undefined {
  const present = EVIDENCE_VARS.filter((name) => (env[name] ?? '') !== '');
  if (present.length === 0) return undefined;
  if (present.length !== EVIDENCE_VARS.length) {
    const missing = EVIDENCE_VARS.filter((name) => (env[name] ?? '') === '');
    throw new ConfigError(
      `Evidence object-storage configuration is partial — missing: ${missing.join(', ')} (set all of ${EVIDENCE_VARS.join(', ')} or none)`,
    );
  }
  const config: S3EvidenceStoreConfig = {
    endpoint: env.EVIDENCE_S3_ENDPOINT as string,
    region: env.EVIDENCE_S3_REGION as string,
    bucket: env.EVIDENCE_S3_BUCKET as string,
    accessKeyId: env.EVIDENCE_S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.EVIDENCE_S3_SECRET_ACCESS_KEY as string,
  };
  if ((env.EVIDENCE_S3_KEY_PREFIX ?? '') !== '') {
    config.keyPrefix = env.EVIDENCE_S3_KEY_PREFIX as string;
  }
  return config;
}

function parseDrainMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 15_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 300_000) {
    throw new ConfigError(`SHUTDOWN_DRAIN_MS must be 0–300000 — received "${raw}"`);
  }
  return value;
}

/**
 * The full runtime contract. Production validates everything fail-closed;
 * development/test keep their certified ergonomics (the dev server does not
 * use this module).
 */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  io: { readFile?: (path: string) => string } = {},
): RuntimeConfig {
  const base = loadConfig(env, io);
  const production = base.nodeEnv === 'production';
  const role = parseRole(env.RUNTIME_ROLE);
  // The HTTP listener is the API's; the worker exposes at most an optional
  // liveness port (WORKER_STATUS_PORT) — so HOST/PORT are mandatory only
  // for RUNTIME_ROLE=api in production (docs/37 §6).
  const listenerRequired = production && role === 'api';
  const config: RuntimeConfig = {
    ...base,
    role,
    host: listenerRequired ? parseHost(env.HOST) : (env.HOST ?? '127.0.0.1'),
    port: listenerRequired ? parseListenPort(env.PORT) : Number(env.PORT ?? 0),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    shutdownDrainMs: parseDrainMs(env.SHUTDOWN_DRAIN_MS),
    paymentsMode: parsePaymentsMode(env.PAYMENTS_MODE),
    worker: parseWorkerPolicy(env),
    scheduler: parseSchedulerPolicy(env),
    maintenance: parseMaintenancePolicy(env),
  };
  // W6-4A: bounded statement_timeout per runtime role when not configured
  // explicitly (operational policy; the migration job never gets one).
  if (config.database.pool !== undefined && config.database.pool.statementTimeoutMs === undefined) {
    const roleDefault = { api: 15_000, worker: 60_000, maintenance: 300_000, migrate: undefined }[role];
    if (roleDefault !== undefined) config.database.pool.statementTimeoutMs = roleDefault;
  }
  const checkoutUrls = parseCheckoutUrls(env, production);
  if (checkoutUrls !== undefined) config.checkoutUrls = checkoutUrls;
  const evidenceStorage = parseEvidenceStorage(env);
  if (evidenceStorage !== undefined) config.evidenceStorage = evidenceStorage;
  if (config.paymentsMode === 'test' && config.stripe === undefined) {
    throw new ConfigError('PAYMENTS_MODE=test requires STRIPE_SECRET_KEY (a TEST-mode key)');
  }
  // W6-4A container certification: a production process never STARTS with a
  // non-TEST-mode Stripe secret in its environment. Composition already
  // refuses such a key (it never reaches a driver — docs/37 §33 "a key alone
  // is never a mode"); the runtime contract refuses the process outright
  // rather than starting silently without payment capability. Live enablement
  // is the future reviewed PA-06 change, never configuration.
  if (production && config.stripe !== undefined && !isStripeTestModeSecret(config.stripe.secretKey)) {
    throw new ConfigError(
      'STRIPE_SECRET_KEY must be a Stripe TEST-mode key (sk_test_/rk_test_) — a live-mode key is refused at startup; live enablement is the future PA-06 slice, not configuration',
    );
  }
  return config;
}

/** Same prefix rule as the payment driver (kept dependency-free for config). */
function isStripeTestModeSecret(secretKey: string): boolean {
  return secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');
}
