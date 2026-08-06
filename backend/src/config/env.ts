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

export interface BackendConfig {
  nodeEnv: NodeEnv;
  database: DatabaseConfig;
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
    return { nodeEnv, database: parseDatabaseUrl(env.DATABASE_URL) };
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

  return { nodeEnv, database };
}
