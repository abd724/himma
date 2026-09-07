/**
 * W6-2 — the PRODUCTION WORKER executable (docs/37 §4): `npm run start:worker`.
 *
 * Thin by design: config validation → the canonical worker composer
 * (src/worker/worker-runtime.ts) → durable loops → signals → bounded
 * graceful shutdown. Same artifact as the API, explicit role, its OWN
 * restricted credential (`himma_worker`) — never the API login, never the
 * schema owner, never maintenance authority.
 */
import { loadRuntimeConfig } from '../src/config/runtime';
import { composeWorkerRuntime, createWorkerShutdown } from '../src/worker/worker-runtime';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.role !== 'worker') {
    throw new Error(`start:worker requires RUNTIME_ROLE=worker — received "${config.role}"`);
  }
  const runtime = await composeWorkerRuntime(config);
  const controller = createWorkerShutdown(runtime, { drainMs: config.shutdownDrainMs });

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      runtime.log.error({ signal }, 'second signal — forcing exit');
      controller.forceExit();
    }
    signalled = true;
    runtime.log.info({ signal }, 'shutdown signal received — draining');
    void controller.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        runtime.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  runtime.start();
  runtime.log.info(
    {
      role: 'worker',
      loops: runtime.loops.map((loop) => loop.name),
      paymentAvailable: runtime.paymentAvailable,
      scheduledJobs: runtime.scheduledJobs,
      unavailableJobs: runtime.unavailableJobs.map((job) => job.name),
      disabledJobs: runtime.disabledJobs,
      migrationHead: runtime.requiredMigrationHead,
    },
    'himma worker running',
  );
}

main().catch((error: unknown) => {
  // Bounded startup failure line — messages name variables, never values.
  console.error(`[himma:start-worker] startup refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
