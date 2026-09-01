/**
 * W6-1 — the PRODUCTION API executable (docs/37 §2): `npm run start:api`.
 *
 * Thin by design: config validation → the one canonical bootstrap
 * (src/app/production-runtime.ts) → listener → signals → graceful
 * shutdown. The development server remains development-only and refuses
 * production; production never composes through it (source-locked).
 *
 * Startup failure = one structured line naming the problem (never a
 * secret value) + non-zero exit. The platform restarts; readiness gating
 * withholds traffic until the process is genuinely serviceable.
 */
import { loadRuntimeConfig } from '../src/config/runtime';
import { composeProductionRuntime, createShutdown } from '../src/app/production-runtime';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  if (config.role !== 'api') {
    throw new Error(`start:api requires RUNTIME_ROLE=api — received "${config.role}"`);
  }
  const runtime = await composeProductionRuntime(config);
  const controller = createShutdown(runtime, { drainMs: config.shutdownDrainMs });

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) {
      runtime.app.log.error({ signal }, 'second signal — forcing exit');
      controller.forceExit();
    }
    signalled = true;
    runtime.app.log.info({ signal }, 'shutdown signal received — draining');
    void controller.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        runtime.app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  await runtime.app.ready();
  await runtime.app.listen({ host: config.host, port: config.port });
  const address = runtime.app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : config.port;
  runtime.app.log.info(
    { role: config.role, host: config.host, port: boundPort, migrationHead: runtime.requiredMigrationHead },
    'himma api listening',
  );
}

main().catch((error: unknown) => {
  // Bounded startup failure line — messages name variables, never values.
  console.error(`[himma:start-api] startup refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
