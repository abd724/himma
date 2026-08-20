/**
 * Multi-process race worker (docs/32 §15 test 10). Spawned as an independent
 * OS process (own event loop, own PostgreSQL backends) by
 * hold-concurrency-multiprocess.test.ts; proves the DATABASE serializes
 * contenders — not JavaScript scheduling. Reads its fixture from argv[2],
 * fires every contender's claim concurrently after the shared barrier
 * timestamp, and reports outcome kinds as JSON on stdout.
 */
import { readFileSync } from 'node:fs';

import type { BackendConfig } from '../../src/config/env';
import { createDb } from '../../src/db/kysely';
import { createPool } from '../../src/db/pool';
import { claimHold } from '../../src/modules/booking/services/hold-claim';
import type { UnitRef } from '../../src/modules/booking/services/booking-shared';

interface WorkerFixture {
  database: BackendConfig['database'];
  unit: UnitRef;
  goAt: number;
  contenders: Array<{
    accountId: string;
    participantId: string;
    quoteId: string;
    idempotencyKey: string;
  }>;
}

async function main(): Promise<void> {
  const fixture = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as WorkerFixture;
  const config: BackendConfig = { nodeEnv: 'test', database: fixture.database };
  const pool = createPool(config); // re-asserts the himma_test safety guards
  const db = createDb(pool);
  const deps = { db };

  try {
    // Cross-process barrier: all workers release at the same wall-clock tick.
    while (Date.now() < fixture.goAt) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const runs = await Promise.all(
      fixture.contenders.map((contender) =>
        claimHold(deps, { accountId: contender.accountId }, {
          unit: fixture.unit,
          participantId: contender.participantId,
          quoteId: contender.quoteId,
          idempotencyKey: contender.idempotencyKey,
        }),
      ),
    );
    process.stdout.write(JSON.stringify({ results: runs.map((run) => run.outcome.kind) }));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
