/**
 * Verify schema state: `npm run db:verify`.
 * Fails (exit 1) on pending migrations, order drift, checksum drift, unknown
 * applied rows, or missing foundation objects.
 */
import { verifyMigrations } from '../src/db/migrations';
import { cliConfig, fail } from './cli-env';

async function main(): Promise<void> {
  const config = cliConfig();
  const report = await verifyMigrations(config);
  console.log(
    `Database "${config.database.database}": ${report.appliedCount} migration(s) applied, ${report.pending.length} pending.`,
  );
  for (const name of report.pending) console.log(`  pending: ${name}`);
  for (const problem of report.problems) console.log(`  problem: ${problem}`);
  if (!report.ok) {
    throw new Error('Schema verification FAILED.');
  }
  console.log('Schema verification passed.');
}

main().catch(fail);
