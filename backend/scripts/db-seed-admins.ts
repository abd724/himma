/**
 * Development/test admin seeding: `npm run db:seed-admins`.
 *
 * The SEPARATE deterministic mechanism (docs/26 D3): refuses production,
 * never creates or consumes the bootstrap seal, never calls the production
 * bootstrap implementation, and is safely repeatable. Slice-1 test-database
 * safety guards apply through the shared config/pool path.
 */
import { createDb } from '../src/db/kysely';
import { createPool } from '../src/db/pool';
import { seedDevelopmentAdmins } from '../src/modules/identity/admin/seed';
import { cliConfig, fail } from './cli-env';

async function main(): Promise<void> {
  const config = cliConfig();
  const pool = createPool(config);
  const db = createDb(pool);
  try {
    const result = await seedDevelopmentAdmins({ db }, { nodeEnv: config.nodeEnv });
    if (result.kind === 'seeded') {
      console.log(`Seed access administrators ready in "${config.database.database}":`);
      console.log(`  - ${result.adminA}`);
      console.log(`  - ${result.adminB}`);
      return;
    }
    throw new Error(`Seeding refused: ${result.kind}`);
  } finally {
    await db.destroy();
  }
}

main().catch(fail);
