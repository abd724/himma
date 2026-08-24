/**
 * Migration execution and verification (owner ruling 5; docs/25 §9).
 *
 * node-pg-migrate applies the numbered SQL files in `migrations/` — each
 * migration runs in its own transaction and a failed migration aborts the
 * run with nothing partially applied.
 *
 * On top of node-pg-migrate this module enforces the migration policy:
 * - applied migrations are IMMUTABLE: a sha256 of every applied file is
 *   recorded in `migration_checksum`; any later edit to an applied file makes
 *   both `migrate` and `verify` fail closed;
 * - order is enforced (`checkOrder`) and files must be lexically ordered;
 * - down migrations are refused in production;
 * - verification reports pending files, unknown applied rows, order drift,
 *   checksum drift, and missing foundation objects.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runner } from 'node-pg-migrate';
import { Client } from 'pg';

import type { BackendConfig, DatabaseConfig } from '../config/env';
import { assertSafeTestDatabase } from './safety';

export const MIGRATIONS_TABLE = 'pgmigrations';
export const CHECKSUM_TABLE = 'migration_checksum';

export function defaultMigrationsDir(): string {
  return path.resolve(__dirname, '..', '..', 'migrations');
}

export function databaseUrl(db: DatabaseConfig): string {
  const auth =
    db.password === undefined
      ? encodeURIComponent(db.user)
      : `${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}`;
  const host = db.host.includes(':') ? `[${db.host}]` : db.host;
  return `postgres://${auth}@${host}:${db.port}/${db.database}`;
}

export interface MigrationFile {
  /** Migration name as recorded by node-pg-migrate (filename without extension). */
  name: string;
  filename: string;
  sha256: string;
}

export function listMigrationFiles(dir: string = defaultMigrationsDir()): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((filename) => ({
    name: filename.replace(/\.sql$/, ''),
    filename,
    sha256: createHash('sha256')
      .update(readFileSync(path.join(dir, filename)))
      .digest('hex'),
  }));
}

async function connect(db: DatabaseConfig): Promise<Client> {
  const client = new Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    ...(db.password !== undefined ? { password: db.password } : {}),
  });
  await client.connect();
  return client;
}

async function ensureChecksumTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${CHECKSUM_TABLE} (
       name        text        NOT NULL,
       sha256      text        NOT NULL,
       recorded_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT pk_${CHECKSUM_TABLE} PRIMARY KEY (name)
     )`,
  );
}

async function recordedChecksums(client: Client): Promise<Map<string, string>> {
  const result = await client.query<{ name: string; sha256: string }>(
    `SELECT name, sha256 FROM ${CHECKSUM_TABLE}`,
  );
  return new Map(result.rows.map((r) => [r.name, r.sha256]));
}

async function appliedMigrations(client: Client): Promise<string[]> {
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [MIGRATIONS_TABLE],
  );
  if (exists.rowCount === 0) return [];
  const result = await client.query<{ name: string }>(
    `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`,
  );
  return result.rows.map((r) => r.name);
}

export class MigrationPolicyError extends Error {}

function assertImmutableApplied(
  files: MigrationFile[],
  recorded: Map<string, string>,
): void {
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const [name, sha] of recorded) {
    const file = byName.get(name);
    if (file === undefined) {
      throw new MigrationPolicyError(
        `Applied migration "${name}" is missing from the migrations directory. Applied migrations are immutable — restore the file; never delete or rename applied migrations.`,
      );
    }
    if (file.sha256 !== sha) {
      throw new MigrationPolicyError(
        `Applied migration "${name}" has been edited after being applied (checksum mismatch). Applied migrations are immutable — write a new migration instead.`,
      );
    }
  }
}

export interface MigrateResult {
  applied: string[];
}

export async function runMigrationsUp(
  config: BackendConfig,
  options: { dir?: string; quiet?: boolean } = {},
): Promise<MigrateResult> {
  const dir = options.dir ?? defaultMigrationsDir();
  if (config.nodeEnv === 'test') assertSafeTestDatabase(config.database);
  const files = listMigrationFiles(dir);
  const client = await connect(config.database);
  try {
    await ensureChecksumTable(client);
    assertImmutableApplied(files, await recordedChecksums(client));

    const before = await appliedMigrations(client);
    await runner({
      dbClient: client,
      dir,
      migrationsTable: MIGRATIONS_TABLE,
      direction: 'up',
      checkOrder: true,
      ...(options.quiet === true
        ? { log: () => undefined }
        : {}),
    });
    const after = await appliedMigrations(client);
    const applied = after.filter((name) => !before.includes(name));

    const byName = new Map(files.map((f) => [f.name, f]));
    for (const name of applied) {
      const file = byName.get(name);
      if (file !== undefined) {
        await client.query(
          `INSERT INTO ${CHECKSUM_TABLE} (name, sha256) VALUES ($1, $2)
           ON CONFLICT (name) DO NOTHING`,
          [name, file.sha256],
        );
      }
    }
    return { applied };
  } finally {
    await client.end();
  }
}

export async function runMigrationsDown(
  config: BackendConfig,
  options: { dir?: string; count?: number; quiet?: boolean } = {},
): Promise<void> {
  if (config.nodeEnv === 'production') {
    throw new MigrationPolicyError(
      'Down migrations are forbidden in production (docs/25 §9). Roll forward with a new migration.',
    );
  }
  if (config.nodeEnv === 'test') assertSafeTestDatabase(config.database);
  const dir = options.dir ?? defaultMigrationsDir();
  const client = await connect(config.database);
  try {
    const before = await appliedMigrations(client);
    await runner({
      dbClient: client,
      dir,
      migrationsTable: MIGRATIONS_TABLE,
      direction: 'down',
      count: options.count ?? 1,
      checkOrder: true,
      ...(options.quiet === true ? { log: () => undefined } : {}),
    });
    const after = await appliedMigrations(client);
    const reverted = before.filter((name) => !after.includes(name));
    await ensureChecksumTable(client);
    for (const name of reverted) {
      await client.query(`DELETE FROM ${CHECKSUM_TABLE} WHERE name = $1`, [name]);
    }
  } finally {
    await client.end();
  }
}

/** Schema objects whose presence `verify` asserts per applied migration. */
type SchemaCheck = {
  kind: 'domain' | 'table' | 'function' | 'constraint' | 'extension';
  name: string;
};
const SCHEMA_CHECKS: Record<string, SchemaCheck[]> = {
  '0001_foundation': [
    { kind: 'domain', name: 'money_fils' },
    { kind: 'domain', name: 'currency_code' },
    { kind: 'function', name: 'set_updated_at' },
    { kind: 'function', name: 'bump_row_version' },
    { kind: 'function', name: 'forbid_mutation' },
    { kind: 'table', name: 'audit_event' },
    { kind: 'table', name: 'outbox_event' },
    { kind: 'table', name: 'inbox_event' },
    { kind: 'table', name: 'idempotency_key' },
  ],
  '0002_identity': [
    { kind: 'table', name: 'app_user' },
    { kind: 'table', name: 'auth_identity' },
    { kind: 'table', name: 'customer_account' },
    { kind: 'table', name: 'participant' },
    { kind: 'table', name: 'login_session' },
    { kind: 'table', name: 'auth_challenge' },
    { kind: 'table', name: 'admin_role_assignment' },
    { kind: 'table', name: 'bootstrap_seal' },
    { kind: 'function', name: 'enforce_admin_role_exclusivity' },
    { kind: 'function', name: 'enforce_admin_role_transition' },
  ],
  '0003_email_ownership_and_finance_approver_controls': [
    { kind: 'extension', name: 'btree_gist' },
    { kind: 'constraint', name: 'excl_auth_identity_verified_email_owner' },
    { kind: 'function', name: 'serialize_access_admin_release' },
    { kind: 'function', name: 'enforce_admin_role_immutability' },
    { kind: 'function', name: 'enforce_finance_activation_controls' },
  ],
  '0004_mfa_and_step_up_foundation': [
    { kind: 'table', name: 'mfa_method' },
    { kind: 'table', name: 'mfa_recovery_code_batch' },
    { kind: 'table', name: 'mfa_recovery_code' },
    { kind: 'table', name: 'mfa_challenge' },
    { kind: 'table', name: 'step_up_grant' },
    { kind: 'constraint', name: 'uq_login_session_id_user' },
    { kind: 'function', name: 'enforce_mfa_method_transition' },
    { kind: 'function', name: 'maintain_mfa_enrolled_mirror' },
    { kind: 'function', name: 'enforce_mfa_enrolled_consistency' },
    { kind: 'function', name: 'enforce_mfa_recovery_batch_transition' },
    { kind: 'function', name: 'enforce_mfa_recovery_code_transition' },
    { kind: 'function', name: 'cascade_recovery_batch_invalidation' },
    { kind: 'function', name: 'enforce_mfa_challenge_transition' },
    { kind: 'function', name: 'enforce_step_up_grant_transition' },
  ],
  '0005_provider_organizations': [
    { kind: 'table', name: 'organization' },
    { kind: 'table', name: 'organization_public_profile' },
    { kind: 'table', name: 'branch' },
    { kind: 'constraint', name: 'uq_branch_id_organization' },
    { kind: 'function', name: 'enforce_organization_transition' },
    { kind: 'function', name: 'enforce_org_profile_row_rules' },
    { kind: 'function', name: 'enforce_branch_row_rules' },
  ],
  '0006_staff_memberships_and_invitations': [
    { kind: 'table', name: 'staff_invitation' },
    { kind: 'table', name: 'staff_membership' },
    { kind: 'table', name: 'staff_membership_branch' },
    { kind: 'constraint', name: 'uq_staff_invitation_token_digest' },
    { kind: 'constraint', name: 'uq_staff_membership_id_organization' },
    { kind: 'function', name: 'enforce_staff_invitation_transition' },
    { kind: 'function', name: 'enforce_staff_membership_transition' },
    { kind: 'function', name: 'enforce_last_active_owner' },
    { kind: 'function', name: 'enforce_staff_scope_row' },
    { kind: 'function', name: 'enforce_staff_scope_completeness' },
  ],
  '0010_search': [
    { kind: 'extension', name: 'pg_trgm' },
    { kind: 'table', name: 'program_search_document' },
    { kind: 'function', name: 'enforce_search_document_rules' },
  ],
  '0015_payment_foundation': [
    { kind: 'table', name: 'payment_intent' },
    { kind: 'table', name: 'payment_attempt' },
    { kind: 'table', name: 'payment_transaction' },
    { kind: 'table', name: 'gateway_event' },
    { kind: 'constraint', name: 'uq_booking_id_account_quote_hold' },
    { kind: 'constraint', name: 'uq_payment_intent_idempotency_key' },
    { kind: 'constraint', name: 'uq_gateway_event_provider_event' },
    { kind: 'constraint', name: 'uq_payment_transaction_gateway_id' },
    { kind: 'function', name: 'enforce_payment_intent_amount' },
    { kind: 'function', name: 'enforce_payment_intent_transition' },
    { kind: 'function', name: 'enforce_payment_attempt_transition' },
    { kind: 'function', name: 'enforce_gateway_event_transition' },
  ],
};

export interface VerificationReport {
  ok: boolean;
  appliedCount: number;
  pending: string[];
  problems: string[];
}

export async function verifyMigrations(
  config: BackendConfig,
  options: { dir?: string } = {},
): Promise<VerificationReport> {
  const dir = options.dir ?? defaultMigrationsDir();
  if (config.nodeEnv === 'test') assertSafeTestDatabase(config.database);
  const files = listMigrationFiles(dir);
  const problems: string[] = [];
  const client = await connect(config.database);
  try {
    await ensureChecksumTable(client);
    const applied = await appliedMigrations(client);
    const recorded = await recordedChecksums(client);
    const fileNames = files.map((f) => f.name);

    // 1. Applied rows must be exactly the first N committed files, in order.
    applied.forEach((name, index) => {
      if (fileNames[index] !== name) {
        problems.push(
          `Applied migration order drift at position ${index + 1}: database has "${name}", files have "${fileNames[index] ?? '(none)'}".`,
        );
      }
    });

    // 2. Checksums of applied files must match the recorded values.
    try {
      assertImmutableApplied(files, recorded);
    } catch (error) {
      problems.push((error as Error).message);
    }
    for (const name of applied) {
      if (!recorded.has(name)) {
        problems.push(
          `Applied migration "${name}" has no recorded checksum — run \`npm run db:migrate\` (which records checksums) instead of invoking node-pg-migrate directly.`,
        );
      }
    }

    // 3. Pending files (informational; verify fails when schema is behind).
    const pending = fileNames.filter((name) => !applied.includes(name));

    // 4. Expected schema objects exist for every applied migration we track.
    for (const migrationName of applied) {
      const checks = SCHEMA_CHECKS[migrationName];
      if (checks === undefined) continue;
      for (const check of checks) {
        const query =
          check.kind === 'domain'
            ? `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE t.typtype = 'd' AND t.typname = $1 AND n.nspname = 'public'`
            : check.kind === 'function'
              ? `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.proname = $1 AND n.nspname = 'public'`
              : check.kind === 'constraint'
                ? `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                   WHERE c.conname = $1 AND n.nspname = 'public'`
                : check.kind === 'extension'
                  ? `SELECT 1 FROM pg_extension WHERE extname = $1`
                  : `SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = $1`;
        const result = await client.query(query, [check.name]);
        if (result.rowCount === 0) {
          problems.push(`Missing foundation ${check.kind}: ${check.name}`);
        }
      }
    }

    return {
      ok: problems.length === 0 && pending.length === 0,
      appliedCount: applied.length,
      pending,
      problems,
    };
  } finally {
    await client.end();
  }
}
