/**
 * PostgreSQL connection pool (docs/25 §6).
 *
 * - Every session runs in UTC (docs/24 §6.13); Asia/Dubai is presentation.
 * - In the test environment the safety guards are re-asserted here, so even a
 *   mis-built config cannot open a pool against an unsafe target.
 */
import { Pool } from 'pg';

import type { BackendConfig } from '../config/env';
import { poolOptionsFor } from './connection-options';
import { assertSafeTestDatabase } from './safety';

/**
 * W6-4A: transport security (TLS verify-full when configured — mandatory in
 * production for every non-loopback host) and the bounded pool policy (max,
 * connect/idle timeouts, optional statement_timeout) come from the typed
 * config through the single `poolOptionsFor` helper.
 */
export function createPool(config: BackendConfig): Pool {
  if (config.nodeEnv === 'test') {
    assertSafeTestDatabase(config.database);
  }
  return new Pool(poolOptionsFor(config.database));
}
