/**
 * W6-4A — the ONE place a PostgreSQL client/pool option object is derived
 * from the typed `DatabaseConfig` (docs/38 §2.6/§10).
 *
 * Transport security: `ssl.mode === 'verify-full'` → TLS with the configured
 * CA bundle, `rejectUnauthorized: true` (chain verification) and node's
 * default `checkServerIdentity` (hostname verification) — the libpq
 * `verify-full` posture; there is deliberately no option that disables
 * verification. `disable`/absent → plain TCP (legal only where `loadConfig`
 * allowed it: outside production, or the loopback certification harness).
 *
 * Every connection path (pool, migration runner, role provisioning) uses
 * this helper so no path can drift to a weaker posture.
 */
import type { ClientConfig, PoolConfig } from 'pg';

import type { DatabaseConfig, DatabasePoolConfig } from '../config/env';
import { DEFAULT_POOL_CONFIG } from '../config/env';

/** Session start-up parameters: UTC always (docs/24 §6.13) + bounded statement timeout when configured. */
export function sessionOptions(pool: DatabasePoolConfig | undefined): string {
  const parts = ['-c TimeZone=UTC'];
  if (pool?.statementTimeoutMs !== undefined) {
    parts.push(`-c statement_timeout=${Math.trunc(pool.statementTimeoutMs)}`);
  }
  return parts.join(' ');
}

/** Options for a single `pg.Client` (migration job, role provisioning) — TLS posture, no pool policy. */
export function clientOptionsFor(db: DatabaseConfig): ClientConfig {
  const options: ClientConfig = {
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    ...(db.password !== undefined ? { password: db.password } : {}),
    options: '-c TimeZone=UTC',
  };
  if (db.ssl?.mode === 'verify-full') {
    options.ssl = { ca: db.ssl.ca, rejectUnauthorized: true };
  }
  return options;
}

/** Options for the canonical runtime pool — TLS posture + the bounded pool policy. */
export function poolOptionsFor(db: DatabaseConfig): PoolConfig {
  const pool = db.pool ?? DEFAULT_POOL_CONFIG;
  const options: PoolConfig = {
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    ...(db.password !== undefined ? { password: db.password } : {}),
    max: pool.max,
    connectionTimeoutMillis: pool.connectionTimeoutMs,
    idleTimeoutMillis: pool.idleTimeoutMs,
    options: sessionOptions(pool),
  };
  if (db.ssl?.mode === 'verify-full') {
    options.ssl = { ca: db.ssl.ca, rejectUnauthorized: true };
  }
  return options;
}
