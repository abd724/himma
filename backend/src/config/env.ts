/**
 * Typed backend configuration (docs/25 §5).
 *
 * Rules:
 * - Development, test, and production configuration are fully separated.
 * - Production NEVER falls back to defaults: it requires an explicit
 *   DATABASE_URL (delivered by the managed secret store, docs/23 §10.3) and
 *   fails closed without it.
 * - Test configuration is subject to the §safety guards: localhost only and
 *   a mandatory `himma_test` database-name prefix.
 * - This module never loads dotenv; CLI entry points load `.env` explicitly
 *   for development convenience.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { assertSafeTestDatabase } from '../db/safety';

export type NodeEnv = 'development' | 'test' | 'production';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  /**
   * W6-4A transport security (docs/38 §2.6/§10). Absent = plain TCP, which
   * `loadConfig` permits ONLY outside production or — the certification-
   * harness exception — for a LOOPBACK host under an explicit
   * `DATABASE_SSL_MODE=disable`. Production against any non-loopback host
   * (every RDS endpoint) REQUIRES `verify-full` with a CA bundle.
   */
  ssl?: DatabaseSslConfig;
  /** W6-4A explicit bounded pool policy; absent = the documented defaults. */
  pool?: DatabasePoolConfig;
}

export type DatabaseSslConfig =
  | { mode: 'disable' }
  | {
      /** TLS + server certificate chain AND hostname verification (libpq `verify-full`). */
      mode: 'verify-full';
      /** Path the CA bundle was read from (for diagnostics; never a secret). */
      caFile: string;
      /** PEM CA bundle (e.g. the AWS RDS global bundle baked into the image). */
      ca: string;
    };

export interface DatabasePoolConfig {
  /** Max clients per process (`pg` `max`). */
  max: number;
  /** `connectionTimeoutMillis` — a stuck connect fails, never hangs. */
  connectionTimeoutMs: number;
  /** `idleTimeoutMillis` — idle clients are released back to the server. */
  idleTimeoutMs: number;
  /** Session `statement_timeout` (ms); absent = server default (no limit). */
  statementTimeoutMs?: number;
}

export const DEFAULT_POOL_CONFIG: Readonly<DatabasePoolConfig> = {
  max: 10,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
};

const SSL_MODES = ['disable', 'verify-full'] as const;

/** Loopback = the local certification harness (docs/37 §36); never an RDS endpoint. */
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

function parseSslConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: NodeEnv,
  host: string,
  readFile: (path: string) => string,
): DatabaseSslConfig | undefined {
  const rawMode = env.DATABASE_SSL_MODE?.trim();
  const caFile = env.DATABASE_SSL_CA_FILE?.trim();
  if (rawMode !== undefined && rawMode !== '' && !(SSL_MODES as readonly string[]).includes(rawMode)) {
    throw new ConfigError(
      `DATABASE_SSL_MODE must be one of ${SSL_MODES.join(', ')} — received "${rawMode}" (certificate verification is never relaxed: there is no "require" or "no-verify" mode)`,
    );
  }
  const mode = rawMode === undefined || rawMode === '' ? undefined : (rawMode as 'disable' | 'verify-full');
  if (nodeEnv === 'production') {
    if (mode === undefined) {
      throw new ConfigError(
        'DATABASE_SSL_MODE is required in production (verify-full for every managed/RDS endpoint; disable is accepted ONLY for a loopback certification-harness database)',
      );
    }
    if (mode === 'disable' && !isLoopbackHost(host)) {
      throw new ConfigError(
        `DATABASE_SSL_MODE=disable is refused in production for the non-loopback database host "${host}" — TLS with certificate verification is mandatory (DATABASE_SSL_MODE=verify-full + DATABASE_SSL_CA_FILE)`,
      );
    }
  }
  if (mode === undefined || mode === 'disable') {
    if (caFile !== undefined && caFile !== '' && mode === 'disable') {
      throw new ConfigError('DATABASE_SSL_CA_FILE is set but DATABASE_SSL_MODE=disable — remove one of them');
    }
    return mode === undefined ? undefined : { mode: 'disable' };
  }
  if (caFile === undefined || caFile === '') {
    throw new ConfigError('DATABASE_SSL_MODE=verify-full requires DATABASE_SSL_CA_FILE (the CA bundle path, e.g. the AWS RDS global bundle)');
  }
  let ca: string;
  try {
    ca = readFile(caFile);
  } catch {
    throw new ConfigError(`DATABASE_SSL_CA_FILE cannot be read (${caFile})`);
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
    throw new ConfigError(`DATABASE_SSL_CA_FILE does not contain a PEM certificate bundle (${caFile})`);
  }
  return { mode: 'verify-full', caFile, ca };
}

/**
 * W6-4A (infrastructure-required, docs/38 §10): a managed secret store hands
 * a task the PASSWORD as its own value (the RDS-managed master secret, the
 * per-role runtime secrets) — passwords are not guaranteed URL-safe, so the
 * URL may omit it and `DATABASE_PASSWORD` supplies it. Never both.
 */
function applyPasswordEnv(database: DatabaseConfig, env: NodeJS.ProcessEnv): void {
  const password = env.DATABASE_PASSWORD;
  if (password === undefined || password === '') return;
  if (database.password !== undefined) {
    throw new ConfigError('DATABASE_URL carries a password AND DATABASE_PASSWORD is set — supply exactly one');
  }
  database.password = password;
}

function parseBoundedIntEnv(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer in ${min}–${max} — received "${raw}"`);
  }
  return value;
}

/** Bounded pool policy from the environment (operational policy, docs/37 §32). */
export function parsePoolConfig(env: NodeJS.ProcessEnv): DatabasePoolConfig {
  const pool: DatabasePoolConfig = {
    max: parseBoundedIntEnv('DB_POOL_MAX', env.DB_POOL_MAX, DEFAULT_POOL_CONFIG.max, 1, 200),
    connectionTimeoutMs: parseBoundedIntEnv(
      'DB_CONNECT_TIMEOUT_MS', env.DB_CONNECT_TIMEOUT_MS, DEFAULT_POOL_CONFIG.connectionTimeoutMs, 500, 60_000),
    idleTimeoutMs: parseBoundedIntEnv('DB_IDLE_TIMEOUT_MS', env.DB_IDLE_TIMEOUT_MS, DEFAULT_POOL_CONFIG.idleTimeoutMs, 1_000, 600_000),
  };
  const statement = env.DB_STATEMENT_TIMEOUT_MS;
  if (statement !== undefined && statement.trim() !== '') {
    pool.statementTimeoutMs = parseBoundedIntEnv('DB_STATEMENT_TIMEOUT_MS', statement, 0, 1_000, 3_600_000);
  }
  return pool;
}

/**
 * Stripe configuration (W5-2; D-W5-1/D-W5-6). Credentials arrive ONLY
 * through this boundary (dev: `.env`; production: the managed secret
 * store) — never PostgreSQL rows, never code. In W5-2 the platform holds
 * SANDBOX capability only: the driver refuses non-test keys structurally
 * (see stripe-driver.ts) and production composition remains unconfigured
 * by construction until the D-W5-3 VAT posture + docs/23 §19 lift arrive
 * as their own reviewed change.
 */
export interface StripeConfig {
  secretKey: string;
  /**
   * Endpoint-specific webhook signing secret (W5-3). Test/sandbox and
   * eventual live endpoint secrets are DISTINCT configurations; absent →
   * the webhook trust boundary rejects everything (fail-closed).
   */
  webhookSecret?: string;
  /**
   * Rotation support: during a secret rollover the RETIRING secret stays
   * accepted alongside the current one, then is removed. No broader
   * secret-management framework exists (docs/33 §7.3).
   */
  webhookSecretRetiring?: string;
}

function stripeConfigFrom(env: NodeJS.ProcessEnv): StripeConfig | undefined {
  if (env.STRIPE_SECRET_KEY === undefined || env.STRIPE_SECRET_KEY === '') return undefined;
  const stripe: StripeConfig = { secretKey: env.STRIPE_SECRET_KEY };
  if (env.STRIPE_WEBHOOK_SECRET !== undefined && env.STRIPE_WEBHOOK_SECRET !== '') {
    stripe.webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  }
  if (
    env.STRIPE_WEBHOOK_SECRET_RETIRING !== undefined &&
    env.STRIPE_WEBHOOK_SECRET_RETIRING !== ''
  ) {
    stripe.webhookSecretRetiring = env.STRIPE_WEBHOOK_SECRET_RETIRING;
  }
  return stripe;
}

export interface BackendConfig {
  nodeEnv: NodeEnv;
  database: DatabaseConfig;
  stripe?: StripeConfig;
}

export class ConfigError extends Error {}

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

function parseNodeEnv(raw: string | undefined): NodeEnv {
  const value = raw ?? 'development';
  if (!(NODE_ENVS as readonly string[]).includes(value)) {
    throw new ConfigError(
      `NODE_ENV must be one of ${NODE_ENVS.join(', ')} — received "${value}"`,
    );
  }
  return value as NodeEnv;
}

export function parseDatabaseUrl(url: string): DatabaseConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConfigError('DATABASE_URL must use the postgres:// scheme');
  }
  // Transport security is configured through the typed DATABASE_SSL_* contract
  // only — a libpq-style query parameter would silently mean something else.
  if (parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl') || parsed.searchParams.has('sslrootcert')) {
    throw new ConfigError('DATABASE_URL must not carry sslmode/ssl/sslrootcert — use DATABASE_SSL_MODE and DATABASE_SSL_CA_FILE');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (database.length === 0) {
    throw new ConfigError('DATABASE_URL must name a database');
  }
  const config: DatabaseConfig = {
    host: parsed.hostname,
    port: parsed.port === '' ? 5432 : Number(parsed.port),
    database,
    user: decodeURIComponent(parsed.username),
  };
  if (parsed.password !== '') {
    config.password = decodeURIComponent(parsed.password);
  }
  return config;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 5432;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PGPORT must be a valid TCP port — received "${raw}"`);
  }
  return port;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  io: { readFile?: (path: string) => string } = {},
): BackendConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  if (nodeEnv === 'production') {
    // Fail closed: no defaults, no PG* fallback assembly in production.
    if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') {
      throw new ConfigError(
        'Production requires an explicit DATABASE_URL from the secret store; refusing to assemble a connection from defaults.',
      );
    }
    const database = parseDatabaseUrl(env.DATABASE_URL);
    applyPasswordEnv(database, env);
    const ssl = parseSslConfig(env, nodeEnv, database.host, readFile);
    if (ssl !== undefined) database.ssl = ssl;
    database.pool = parsePoolConfig(env);
    const production: BackendConfig = {
      nodeEnv,
      database,
    };
    const productionStripe = stripeConfigFrom(env);
    if (productionStripe !== undefined) {
      production.stripe = productionStripe;
    }
    return production;
  }

  const database: DatabaseConfig = {
    host: env.PGHOST ?? 'localhost',
    port: parsePort(env.PGPORT),
    database:
      env.PGDATABASE ?? (nodeEnv === 'test' ? 'himma_test' : 'himma_backend_dev'),
    user: env.PGUSER ?? os.userInfo().username,
  };
  if (env.PGPASSWORD !== undefined && env.PGPASSWORD !== '') {
    database.password = env.PGPASSWORD;
  }

  if (nodeEnv === 'test') {
    assertSafeTestDatabase(database);
  }
  // Development/test: TLS is opt-in (a TLS-enabled local server), the pool
  // policy is the same bounded contract.
  const ssl = parseSslConfig(env, nodeEnv, database.host, readFile);
  if (ssl !== undefined) database.ssl = ssl;
  database.pool = parsePoolConfig(env);

  const config: BackendConfig = { nodeEnv, database };
  const stripe = stripeConfigFrom(env);
  if (stripe !== undefined) {
    config.stripe = stripe;
  }
  return config;
}
