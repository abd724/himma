/**
 * W4 Slice 5 · S5-2 — the MULTI-PROCESS final-seat gate (docs/32 §15 test
 * 10; owner ruling D-1). Four independent OS processes — distinct event
 * loops, distinct PostgreSQL backend connections — hammer one session's
 * capacity simultaneously. If any layer of the claim path relied on
 * same-process serialization (a mutex, a queue, an in-memory check), this
 * gate would oversell; only the database's row locks + CHECK can pass it.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql } from 'kysely';

import { newId } from '../src/db/ids';
import {
  createBookingFixture,
  createCustomer,
  createQuote,
  createSession,
  reconcileUnit,
  type BookingFixture,
} from './helpers/booking-fixtures';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(120_000);

const WORKERS = 4;
const CONTENDERS_PER_WORKER = 10;
const CAPACITY = 5;

let testDb: TestDb;
let f: BookingFixture;

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  f = await createBookingFixture(testDb.db);
});

afterAll(async () => {
  await testDb.drop();
});

interface WorkerOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runWorker(fixturePath: string): Promise<WorkerOutput> {
  const workerPath = path.join(__dirname, 'helpers', 'hold-race-worker.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--require', require.resolve('tsx/cjs'), workerPath, fixturePath],
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

it(`${WORKERS} OS processes × ${CONTENDERS_PER_WORKER} contenders vs capacity ${CAPACITY}: the DATABASE is the serializer — zero oversell across processes`, async () => {
  const sessionId = await createSession(f, { capacity: CAPACITY });
  const unit = { kind: 'session' as const, id: sessionId };

  const dir = mkdtempSync(path.join(os.tmpdir(), 'himma-hold-race-'));
  const fixturePaths: string[] = [];
  // Barrier: give every worker time to boot (tsx transform + pool) first.
  const goAt = Date.now() + 6_000;
  for (let w = 0; w < WORKERS; w += 1) {
    const contenders = [];
    for (let i = 0; i < CONTENDERS_PER_WORKER; i += 1) {
      const customer = await createCustomer(testDb.db);
      contenders.push({
        ...customer,
        quoteId: await createQuote(f, { customer, unit }),
        idempotencyKey: newId(),
      });
    }
    const fixturePath = path.join(dir, `worker-${w}.json`);
    writeFileSync(
      fixturePath,
      JSON.stringify({ database: testDb.config.database, unit, goAt, contenders }),
    );
    fixturePaths.push(fixturePath);
  }

  const outputs = await Promise.all(fixturePaths.map((fixturePath) => runWorker(fixturePath)));
  for (const output of outputs) {
    if (output.code !== 0) {
      throw new Error(`worker failed (${output.code}): ${output.stderr}`);
    }
  }
  const results = outputs.flatMap(
    (output) => (JSON.parse(output.stdout) as { results: string[] }).results,
  );
  expect(results).toHaveLength(WORKERS * CONTENDERS_PER_WORKER);
  const succeeded = results.filter((kind) => kind === 'holdClaimed').length;
  const refused = results.filter((kind) => kind === 'sessionFull').length;
  expect(succeeded).toBe(CAPACITY);
  expect(refused).toBe(WORKERS * CONTENDERS_PER_WORKER - CAPACITY);

  const rec = await reconcileUnit(testDb.db, unit);
  expect(rec.heldCount).toBe(CAPACITY);
  expect(rec.activeHolds).toBe(CAPACITY);
  expect(rec.bookedCount).toBe(0);
  expect(rec.state).toBe('full');
  const holdRows = await sql<{ n: string }>`
    SELECT count(*) AS n FROM capacity_hold WHERE session_id = ${sessionId}`.execute(testDb.db);
  expect(Number(holdRows.rows[0]!.n)).toBe(CAPACITY);
  const inProgress = await sql<{ n: string }>`
    SELECT count(*) AS n FROM idempotency_key WHERE status = 'in_progress'`.execute(testDb.db);
  expect(Number(inProgress.rows[0]!.n)).toBe(0);
});
