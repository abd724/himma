/**
 * Shared CLI bootstrap: loads `.env` for development convenience (config
 * itself never reads dotenv — docs/25 §5) and resolves the typed config.
 * Every script fails closed: any thrown error exits non-zero.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { loadConfig } from '../src/config/env';
import type { BackendConfig } from '../src/config/env';

export function cliConfig(): BackendConfig {
  const envFile = path.resolve(__dirname, '..', '.env');
  if (process.env.NODE_ENV !== 'production' && existsSync(envFile)) {
    loadDotenv({ path: envFile });
  }
  return loadConfig();
}

export function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
