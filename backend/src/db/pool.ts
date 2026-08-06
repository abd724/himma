/**
 * PostgreSQL connection pool (docs/25 §6).
 *
 * - Every session runs in UTC (docs/24 §6.13); Asia/Dubai is presentation.
 * - In the test environment the safety guards are re-asserted here, so even a
 *   mis-built config cannot open a pool against an unsafe target.
 */
import { Pool } from 'pg';

import type { BackendConfig } from '../config/env';
import { assertSafeTestDatabase } from './safety';

export function createPool(config: BackendConfig): Pool {
  if (config.nodeEnv === 'test') {
    assertSafeTestDatabase(config.database);
  }
  return new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    ...(config.database.password !== undefined
      ? { password: config.database.password }
      : {}),
    options: '-c TimeZone=UTC',
  });
}
