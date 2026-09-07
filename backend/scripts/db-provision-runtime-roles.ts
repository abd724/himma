/**
 * W6-1 — provision the production runtime LOGIN roles (docs/37 §19/§28):
 * `npm run db:provision-roles`
 *
 * Runs under an ADMIN-capable connection (the standard PG* / DATABASE_URL
 * conventions — locally the schema owner; in a managed environment the
 * provider's admin credential). Passwords are INJECTED, never committed:
 *   HIMMA_API_DB_PASSWORD, HIMMA_WORKER_DB_PASSWORD
 *   HIMMA_MAINTENANCE_DB_PASSWORD (W6-3, optional — provisions the
 *   `himma_maintenance_runner` login as the sole member of the migration-
 *   created `himma_maintenance` privilege role; requires 0023 applied)
 * Nothing secret is ever printed.
 */
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import { cliConfig, fail } from './cli-env';

async function main(): Promise<void> {
  const config = cliConfig();
  const api = process.env.HIMMA_API_DB_PASSWORD;
  const worker = process.env.HIMMA_WORKER_DB_PASSWORD;
  if (api === undefined || api === '' || worker === undefined || worker === '') {
    throw new Error(
      'HIMMA_API_DB_PASSWORD and HIMMA_WORKER_DB_PASSWORD must be injected (≥16 chars each); values are never committed or printed.',
    );
  }
  const maintenance = process.env.HIMMA_MAINTENANCE_DB_PASSWORD;
  const result = await provisionRuntimeRoles({
    admin: config.database,
    passwords: {
      himma_api: api,
      himma_worker: worker,
      ...(maintenance !== undefined && maintenance !== '' ? { himma_maintenance_runner: maintenance } : {}),
    },
  });
  console.log(
    `Runtime roles provisioned on "${config.database.database}"@${config.database.host}: created=[${result.created.join(', ')}] updated=[${result.updated.join(', ')}]`,
  );
}

main().catch(fail);
