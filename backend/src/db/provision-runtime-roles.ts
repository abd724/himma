/**
 * W6-1 — runtime LOGIN provisioning boundary (docs/37 §19/§28; owner
 * directive §8).
 *
 * Why NOT a schema migration: PostgreSQL roles are CLUSTER-GLOBAL while
 * migrations run per-database (the test harness provisions many
 * `himma_test_*` databases against one cluster — role DDL inside a
 * migration would collide across them); `CREATE ROLE … LOGIN` needs
 * CREATEROLE authority the schema-migration credential may not hold on a
 * managed provider; and LOGIN passwords are SECRETS — they arrive only by
 * environment injection at provisioning time and may never live in a
 * committed migration file. The existing `himma_app` NOLOGIN privilege
 * role stays where it is (migration 0001) because it is grant-target-only
 * and carries no secret.
 *
 * Contract (provider-neutral, idempotent, certifiable on local PostgreSQL):
 * - creates/updates `himma_api` and `himma_worker` as LOGIN roles with the
 *   injected passwords; NOSUPERUSER NOCREATEDB NOCREATEROLE; INHERIT;
 * - grants `himma_app` membership (the whole application privilege set —
 *   docs/37 §28: the two sets are provably identical; the split exists for
 *   independent credential rotation);
 * - defensively REVOKES any maintenance-role membership if such a role
 *   exists (the API/worker logins must be structurally unable to assume
 *   maintenance authority — the W6-0 owner correction);
 * - W6-3: when a maintenance password is injected, creates/updates
 *   `himma_maintenance_runner` as the ONLY member of the `himma_maintenance`
 *   privilege role (migration 0023) and REVOKES `himma_app` from it — the
 *   maintenance login holds the bounded retention/repair authority and no
 *   general application DML;
 * - never logs or returns password material.
 *
 * Driven by an ADMIN-capable connection (the same authority that runs
 * migrations locally; the cloud provider's admin credential later). The
 * runtime processes themselves never hold this authority.
 *
 * Concurrency (W6-4A final correction): the roles are CLUSTER-GLOBAL but a
 * PostgreSQL advisory lock is DATABASE-SCOPED (pg_locks records the
 * database the session acquired it in), so a lock taken on the caller's own
 * database serializes nothing across callers connected to different
 * databases of the same cluster — concurrent `ALTER ROLE`/`GRANT` on the same
 * pg_authid / pg_auth_members tuples then fail with `tuple concurrently
 * updated` (SQLSTATE XX000). The lock is therefore taken on a SEPARATE
 * session to ONE canonical coordination database of the cluster (default
 * `postgres`, the maintenance database every PostgreSQL cluster and every
 * RDS instance has; `HIMMA_PROVISION_LOCK_DATABASE` overrides), held for the
 * whole provisioning run, and released with the session. Any number of
 * concurrent legitimate provisioners — across any databases of the cluster —
 * converge on the exact intended topology; if the coordination session
 * cannot be opened the run fails closed (never a silent database-local lock).
 */
import { Client } from 'pg';

import type { DatabaseConfig } from '../config/env';
import { clientOptionsFor } from './connection-options';

export const RUNTIME_LOGIN_ROLES = ['himma_api', 'himma_worker'] as const;
export type RuntimeLoginRole = (typeof RUNTIME_LOGIN_ROLES)[number];

/** W6-3: the maintenance LOGIN (sole member of the maintenance privilege role). */
export const MAINTENANCE_LOGIN_ROLE = 'himma_maintenance_runner' as const;
export const MAINTENANCE_PRIVILEGE_ROLE = 'himma_maintenance' as const;

export type ProvisionedLoginRole = RuntimeLoginRole | typeof MAINTENANCE_LOGIN_ROLE;

/** Roles the API/worker logins must NEVER be members of (defense in depth). */
const FORBIDDEN_MEMBERSHIPS = [MAINTENANCE_PRIVILEGE_ROLE] as const;

/** The cluster's maintenance database — present on local PostgreSQL, CI, and RDS. */
export const DEFAULT_PROVISION_COORDINATION_DATABASE = 'postgres';
/** Cluster-wide advisory key (identical for every caller; one lock space via the coordination database). */
export const PROVISION_LOCK_KEY_SQL = `hashtextextended('himma:provision-roles', 42)`;

export interface ProvisionRuntimeRolesInput {
  admin: DatabaseConfig;
  passwords: Record<RuntimeLoginRole, string> & { [MAINTENANCE_LOGIN_ROLE]?: string };
  /**
   * Database on the SAME cluster (same host/port/admin credential) whose
   * advisory-lock space coordinates every provisioner. Default `postgres`.
   */
  coordinationDatabase?: string;
}

export interface ProvisionRuntimeRolesResult {
  created: ProvisionedLoginRole[];
  updated: ProvisionedLoginRole[];
}

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(name: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`unsafe role identifier: "${name}"`);
  }
  return `"${name}"`;
}

export async function provisionRuntimeRoles(
  input: ProvisionRuntimeRolesInput,
): Promise<ProvisionRuntimeRolesResult> {
  const maintenancePassword = input.passwords[MAINTENANCE_LOGIN_ROLE];
  const roles: ProvisionedLoginRole[] =
    maintenancePassword !== undefined ? [...RUNTIME_LOGIN_ROLES, MAINTENANCE_LOGIN_ROLE] : [...RUNTIME_LOGIN_ROLES];
  for (const role of roles) {
    const password = input.passwords[role];
    if (typeof password !== 'string' || password.length < 16) {
      throw new Error(
        `a password of at least 16 characters must be injected for ${role} (never committed, never logged)`,
      );
    }
  }
  const coordinationDatabase = input.coordinationDatabase ?? DEFAULT_PROVISION_COORDINATION_DATABASE;
  // Cluster-wide serialization: ONE lock space for every caller, whatever
  // database its admin connection targets (see the module comment).
  const coordinator = new Client(clientOptionsFor({ ...input.admin, database: coordinationDatabase }));
  try {
    await coordinator.connect();
  } catch (error) {
    throw new Error(
      `cannot open the cluster-wide provisioning coordination session on database "${coordinationDatabase}" ` +
        `(the cluster's maintenance database; override with HIMMA_PROVISION_LOCK_DATABASE): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const created: ProvisionedLoginRole[] = [];
  const updated: ProvisionedLoginRole[] = [];
  let client: Client | undefined;
  try {
    await coordinator.query(`SELECT pg_advisory_lock(${PROVISION_LOCK_KEY_SQL})`);
    client = new Client(clientOptionsFor(input.admin));
    await client.connect();
    const appRole = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'himma_app'`);
    if (appRole.rowCount === 0) {
      throw new Error(
        'himma_app does not exist — run migrations before provisioning runtime logins',
      );
    }
    const maintenanceRoleExists =
      ((await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [MAINTENANCE_PRIVILEGE_ROLE])).rowCount ?? 0) > 0;
    if (maintenancePassword !== undefined && !maintenanceRoleExists) {
      throw new Error(
        `${MAINTENANCE_PRIVILEGE_ROLE} does not exist — run migrations (0023) before provisioning the maintenance login`,
      );
    }
    for (const role of roles) {
      const ident = quoteIdentifier(role);
      const literal = client.escapeLiteral(input.passwords[role] as string);
      const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (exists.rowCount === 0) {
        await client.query(
          `CREATE ROLE ${ident} LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
        );
        created.push(role);
      } else {
        await client.query(
          `ALTER ROLE ${ident} LOGIN PASSWORD ${literal} NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT`,
        );
        updated.push(role);
      }
      if (role === MAINTENANCE_LOGIN_ROLE) {
        // The maintenance login: bounded authority ONLY — never the
        // application DML set (docs/37 §28).
        await client.query(`GRANT ${quoteIdentifier(MAINTENANCE_PRIVILEGE_ROLE)} TO ${ident}`);
        await client.query(`REVOKE himma_app FROM ${ident}`);
        continue;
      }
      await client.query(`GRANT himma_app TO ${ident}`);
      for (const forbidden of FORBIDDEN_MEMBERSHIPS) {
        const forbiddenExists = await client.query(
          `SELECT 1 FROM pg_roles WHERE rolname = $1`,
          [forbidden],
        );
        if (forbiddenExists.rowCount !== 0) {
          await client.query(`REVOKE ${quoteIdentifier(forbidden)} FROM ${ident}`);
        }
      }
    }
    return { created, updated };
  } finally {
    await client?.end();
    // The session lock dies with the session; unlock explicitly anyway so a
    // slow socket teardown never extends the critical section.
    await coordinator.query(`SELECT pg_advisory_unlock(${PROVISION_LOCK_KEY_SQL})`).catch(() => undefined);
    await coordinator.end();
  }
}
