/**
 * Apply pending migrations: `npm run db:migrate`.
 * Enforces applied-migration immutability (checksums) and order; production
 * requires an explicit DATABASE_URL and fails closed on any error.
 */
import { runMigrationsUp } from '../src/db/migrations';
import { cliConfig, fail } from './cli-env';

async function main(): Promise<void> {
  const config = cliConfig();
  const result = await runMigrationsUp(config);
  if (result.applied.length === 0) {
    console.log(`Database "${config.database.database}" is up to date — nothing to apply.`);
  } else {
    console.log(`Applied ${result.applied.length} migration(s) to "${config.database.database}":`);
    for (const name of result.applied) console.log(`  - ${name}`);
  }
}

main().catch(fail);
