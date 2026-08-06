/**
 * Regenerate Kysely database types from the LIVE migrated schema:
 * `npm run db:codegen` (owner ruling 4 — no handwritten second schema model).
 * Output: src/db/generated/db.ts (committed; regenerated, never hand-edited).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { databaseUrl } from '../src/db/migrations';
import { cliConfig, fail } from './cli-env';

function main(): void {
  const config = cliConfig();
  if (config.nodeEnv === 'production') {
    throw new Error('db:codegen never runs against production.');
  }
  const outFile = path.resolve(__dirname, '..', 'src', 'db', 'generated', 'db.ts');
  const bin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'kysely-codegen');
  execFileSync(
    bin,
    [
      '--dialect',
      'postgres',
      '--url',
      databaseUrl(config.database),
      '--out-file',
      outFile,
      '--exclude-pattern',
      '*.(pgmigrations|migration_checksum)',
    ],
    { stdio: 'inherit' },
  );
  console.log(`Generated ${outFile} from "${config.database.database}".`);
}

try {
  main();
} catch (error) {
  fail(error);
}
