/**
 * Create the next numbered migration file: `npm run db:new -- <short-name>`.
 * Naming convention (docs/25 §9): NNNN_snake_case_description.sql, ordinal,
 * zero-padded, lexically ordered.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultMigrationsDir, listMigrationFiles } from '../src/db/migrations';
import { fail } from './cli-env';

function main(): void {
  const rawName = process.argv[2];
  if (rawName === undefined || !/^[a-z][a-z0-9_]*$/.test(rawName)) {
    throw new Error('Usage: npm run db:new -- <snake_case_name>');
  }
  const dir = defaultMigrationsDir();
  const existing = listMigrationFiles(dir);
  const last = existing[existing.length - 1];
  const lastOrdinal = last === undefined ? 0 : Number(last.filename.slice(0, 4));
  const ordinal = String(lastOrdinal + 1).padStart(4, '0');
  const filename = `${ordinal}_${rawName}.sql`;
  const template = `-- ${ordinal}_${rawName} — <one-line purpose>.
-- Authority: docs/24 §<...>; docs/25 §9. Runs in one transaction.
-- If this migration is IRREVERSIBLE, replace the Down section body with:
--   SELECT 1/0; -- IRREVERSIBLE: <justification>
-- and record the justification in the migration review.

-- Up Migration


-- Down Migration
-- Reviewed rollback (development/test only — docs/25 §9).

`;
  writeFileSync(path.join(dir, filename), template, { flag: 'wx' });
  console.log(`Created migrations/${filename}`);
}

try {
  main();
} catch (error) {
  fail(error);
}
