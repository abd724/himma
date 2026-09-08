/**
 * Shared CLI bootstrap: loads `.env` for development convenience (config
 * itself never reads dotenv — docs/25 §5) and resolves the typed config.
 * Every script fails closed: any thrown error exits non-zero.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config/env';
import type { BackendConfig } from '../src/config/env';
import type { config as DotenvConfig } from 'dotenv';

export function cliConfig(): BackendConfig {
  const envFile = path.resolve(__dirname, '..', '.env');
  if (process.env.NODE_ENV !== 'production' && existsSync(envFile)) {
    // Development convenience only. `dotenv` is a devDependency and is NOT in
    // the production image (which ships no .env either), so it is required
    // lazily here rather than imported at module load — the migration,
    // verify and provisioning invocations must resolve from production
    // dependencies alone (W6-4A container certification).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config: loadDotenv } = require('dotenv') as { config: typeof DotenvConfig };
    loadDotenv({ path: envFile });
  }
  return loadConfig();
}

export function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
