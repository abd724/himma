/**
 * Revert the most recent migration: `npm run db:down` (development/test ONLY).
 * Guards: forbidden in production (docs/25 §9) and requires explicit
 * confirmation via DB_DOWN_CONFIRM=1 — a reviewed down section is still a
 * destructive operation.
 */
import { runMigrationsDown } from '../src/db/migrations';
import { cliConfig, fail } from './cli-env';

async function main(): Promise<void> {
  if (process.env.DB_DOWN_CONFIRM !== '1') {
    throw new Error(
      'Refusing to run a down migration without DB_DOWN_CONFIRM=1 (explicit confirmation required).',
    );
  }
  const config = cliConfig();
  await runMigrationsDown(config);
  console.log(`Reverted 1 migration on "${config.database.database}".`);
}

main().catch(fail);
