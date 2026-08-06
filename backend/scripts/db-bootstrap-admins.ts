/**
 * One-time production bootstrap CLI: `npm run bootstrap:admins -- --manifest <path>`.
 *
 * CLI-only by design (docs/26 §7.5 D3) — there is no HTTP path. Inputs:
 * - NODE_ENV=production and an explicit DATABASE_URL (loadConfig fails
 *   closed otherwise);
 * - --manifest <path>: the REVIEWED manifest JSON
 *   `{ "users": ["<uuid>", "<uuid>"], "secretDigest": "<sha256 hex>" }`;
 * - HIMMA_BOOTSTRAP_SECRET: the bootstrap secret via environment (or the
 *   interactive prompt on a TTY) — NEVER a command-line argument, so it
 *   cannot enter shell history;
 * - the exact confirmation phrase, typed interactively (or
 *   HIMMA_BOOTSTRAP_CONFIRMATION for non-interactive approved automation);
 * - --executed-by <ref>: safe operator/ticket reference for the seal.
 *
 * Secret lifecycle (operational, docs/26 D3): generate ≥32 chars of
 * randomness into the approved secret store at manifest review, record its
 * sha256 digest in the manifest under review, inject it as
 * HIMMA_BOOTSTRAP_SECRET for the single execution, then destroy the store
 * entry. The secret is never logged or persisted; this script prints only
 * safe identifiers and the typed result.
 */
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

import { createDb } from '../src/db/kysely';
import { createPool } from '../src/db/pool';
import {
  BOOTSTRAP_CONFIRMATION_PHRASE,
  runProductionBootstrap,
  type BootstrapManifest,
} from '../src/modules/identity/admin/bootstrap';
import { cliConfig, fail } from './cli-env';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const config = cliConfig();
  const manifestPath = argValue('--manifest');
  const executedBy = argValue('--executed-by');
  if (manifestPath === undefined || executedBy === undefined) {
    throw new Error(
      'Usage: npm run bootstrap:admins -- --manifest <path> --executed-by <ticket-ref>',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BootstrapManifest;

  const secret =
    process.env.HIMMA_BOOTSTRAP_SECRET ??
    (process.stdin.isTTY ? await promptHidden('Bootstrap secret: ') : undefined);
  if (secret === undefined || secret.length === 0) {
    throw new Error('HIMMA_BOOTSTRAP_SECRET is required (environment or interactive input).');
  }
  const confirmationPhrase =
    process.env.HIMMA_BOOTSTRAP_CONFIRMATION ??
    (process.stdin.isTTY
      ? await promptHidden(`Type the confirmation phrase ("${BOOTSTRAP_CONFIRMATION_PHRASE}"): `)
      : undefined);
  if (confirmationPhrase === undefined) {
    throw new Error('The confirmation phrase is required.');
  }

  const pool = createPool(config);
  const db = createDb(pool);
  try {
    const result = await runProductionBootstrap(
      { db },
      {
        nodeEnv: config.nodeEnv,
        manifest,
        confirmationPhrase,
        secret,
        executedBy,
      },
    );
    if (result.kind === 'bootstrapCompleted') {
      console.log('Bootstrap completed.');
      console.log(`  access_admin: ${result.adminA}`);
      console.log(`  access_admin: ${result.adminB}`);
      console.log(`  manifest digest: ${result.manifestDigest}`);
      return;
    }
    throw new Error(`Bootstrap refused: ${result.kind}`);
  } finally {
    await db.destroy();
  }
}

main().catch(fail);
