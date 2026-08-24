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
import os from 'node:os';

import { assertSafeTestDatabase } from '../db/safety';

export type NodeEnv = 'development' | 'test' | 'production';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  if (nodeEnv === 'production') {
    // Fail closed: no defaults, no PG* fallback assembly in production.
    if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') {
      throw new ConfigError(
        'Production requires an explicit DATABASE_URL from the secret store; refusing to assemble a connection from defaults.',
      );
    }
    const production: BackendConfig = {
      nodeEnv,
      database: parseDatabaseUrl(env.DATABASE_URL),
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

  const config: BackendConfig = { nodeEnv, database };
  const stripe = stripeConfigFrom(env);
  if (stripe !== undefined) {
    config.stripe = stripe;
  }
  return config;
}
