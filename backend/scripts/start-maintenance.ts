/**
 * W6-3 — the bounded MAINTENANCE executable (docs/37 §4/§19):
 *   `npm run start:maintenance -- <job> [--event-id=<uuid>]`
 *
 * Same artifact as the API/worker, explicit role (`RUNTIME_ROLE=
 * maintenance`), its OWN credential (`himma_maintenance_runner`) — never
 * the API/worker login, never the schema owner. Not a resident process: it
 * runs exactly the one allow-listed job it was given and exits. SIGTERM/
 * SIGINT stop the batch loop at its next boundary (each batch is one
 * committed statement); a second signal or exceeded drain budget force-
 * exits non-zero.
 *
 * Exit codes: 0 = job ran (or was skipped because another invocation holds
 * its lock) · 1 = job failed / startup refused · 2 = usage error.
 */
import { loadRuntimeConfig } from '../src/config/runtime';
import {
  composeMaintenanceRuntime,
  listMaintenanceJobs,
  MaintenanceUsageError,
  RETENTION_ALL,
  runMaintenance,
  type MaintenanceArgs,
} from '../src/maintenance/maintenance-runtime';

function usage(): string {
  const names = [RETENTION_ALL, ...listMaintenanceJobs().map((job) => job.name)];
  return `Usage: npm run start:maintenance -- <job> [--event-id=<uuid>]\nAllow-listed jobs: ${names.join(', ')}`;
}

function parseArgs(argv: string[]): { job: string; args: MaintenanceArgs } {
  let job: string | undefined;
  const args: MaintenanceArgs = {};
  for (const raw of argv) {
    if (raw.startsWith('--event-id=')) {
      args.eventId = raw.slice('--event-id='.length);
    } else if (raw.startsWith('--')) {
      throw new MaintenanceUsageError(`unknown option "${raw}"\n${usage()}`);
    } else if (job === undefined) {
      job = raw;
    } else {
      throw new MaintenanceUsageError(`exactly one job may be named\n${usage()}`);
    }
  }
  if (job === undefined) throw new MaintenanceUsageError(usage());
  return { job, args };
}

async function main(): Promise<void> {
  const { job, args } = parseArgs(process.argv.slice(2));
  const config = loadRuntimeConfig();
  if (config.role !== 'maintenance') {
    throw new Error(`start:maintenance requires RUNTIME_ROLE=maintenance — received "${config.role}"`);
  }
  const runtime = await composeMaintenanceRuntime(config);

  let signalled = false;
  const forceTimer = { handle: undefined as NodeJS.Timeout | undefined };
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      runtime.log.error({ signal }, 'second signal — forcing exit');
      process.exit(1);
    }
    signalled = true;
    runtime.log.info({ signal }, 'stop requested — finishing the current batch');
    runtime.requestStop();
    forceTimer.handle = setTimeout(() => {
      runtime.log.error('drain budget exceeded — forcing exit');
      process.exit(1);
    }, config.shutdownDrainMs);
    forceTimer.handle.unref();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  runtime.log.info({ role: 'maintenance', job, migrationHead: runtime.requiredMigrationHead }, 'himma maintenance starting');
  let exitCode: number;
  try {
    const result = await runMaintenance(runtime, job, args);
    runtime.log.info({ role: 'maintenance', job, outcomes: result.outcomes }, 'himma maintenance finished');
    exitCode = result.exitCode;
  } finally {
    if (forceTimer.handle !== undefined) clearTimeout(forceTimer.handle);
    await runtime.pool.end();
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  // Bounded failure line — messages name variables/jobs, never secret values.
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof MaintenanceUsageError) {
    console.error(`[himma:start-maintenance] usage error: ${message}`);
    process.exit(2);
  }
  console.error(`[himma:start-maintenance] refused: ${message}`);
  process.exit(1);
});
