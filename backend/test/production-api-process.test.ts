/**
 * W6-1 — the REAL production API executable, spawned as separate OS
 * processes against one PostgreSQL database (docs/37 §36/§38; owner items
 * 27/33/34/36/37): two replicas boot as himma_api with NODE_ENV=production
 * and the genuine production composition (no dev identity, no
 * deterministic gateway, no fixtures), share the PostgreSQL security rate
 * limit, serve public reads, fail auth closed, and shut down gracefully —
 * and a mispasted credential/role combination refuses startup.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';
import type { TestDb } from './helpers/test-db';
import { createMigratedTestDb } from './helpers/test-db';

jest.setTimeout(60_000);

const BACKEND = path.resolve(__dirname, '..');
const TSX = path.join(BACKEND, 'node_modules', '.bin', 'tsx');

let testDb: TestDb;
const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;

interface ApiProcess {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stdout: string[];
  stderr: string[];
  exit: Promise<number | null>;
}

function databaseUrlFor(user: string, password: string): string {
  const db = testDb.config.database;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${db.host}:${db.port}/${db.database}`;
}

function spawnApi(env: Record<string, string>): {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exit: Promise<number | null>;
} {
  const child = spawn(TSX, ['scripts/start-api.ts'], {
    cwd: BACKEND,
    env: {
      PATH: process.env.PATH as string,
      HOME: process.env.HOME ?? '',
      ...env,
    },
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  const exit = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, stdout, stderr, exit };
}

async function startReadyApi(): Promise<ApiProcess> {
  const spawned = spawnApi({
    NODE_ENV: 'production',
    RUNTIME_ROLE: 'api',
    DATABASE_URL: databaseUrlFor('himma_api', apiPassword),
    HOST: '127.0.0.1',
    PORT: '0',
    LOG_LEVEL: 'info',
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`api did not report listening.\nstdout:\n${spawned.stdout.join('')}\nstderr:\n${spawned.stderr.join('')}`)),
      60_000,
    );
    const check = () => {
      const joined = spawned.stdout.join('');
      const match = joined.match(/"msg":"himma api listening".*?"port":(\d+)|"port":(\d+).*?"msg":"himma api listening"/);
      const line = joined
        .split('\n')
        .find((candidate) => candidate.includes('himma api listening'));
      if (line !== undefined) {
        const portMatch = line.match(/"port":(\d+)/);
        if (portMatch !== null) {
          clearTimeout(timer);
          resolve(Number(portMatch[1]));
          return;
        }
      }
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1] ?? match[2]));
        return;
      }
      setTimeout(check, 200);
    };
    check();
    void spawned.exit.then((code) => {
      clearTimeout(timer);
      reject(
        new Error(`api exited early (${code}).\nstdout:\n${spawned.stdout.join('')}\nstderr:\n${spawned.stderr.join('')}`),
      );
    });
  });
  return { ...spawned, port };
}

async function getJson(port: number, pathname: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown, headers: response.headers };
}

beforeAll(async () => {
  testDb = await createMigratedTestDb();
  await provisionRuntimeRoles({
    admin: testDb.config.database,
    passwords: { himma_api: apiPassword, himma_worker: workerPassword },
  });
});

afterAll(async () => {
  await testDb.drop();
});

describe('two production API processes on one database', () => {
  let a: ApiProcess;
  let b: ApiProcess;

  beforeAll(async () => {
    a = await startReadyApi();
    b = await startReadyApi();
  });

  afterAll(async () => {
    for (const proc of [a, b]) {
      if (proc !== undefined && proc.child.exitCode === null) {
        proc.child.kill('SIGKILL');
        await proc.exit;
      }
    }
  });

  it('both replicas are live and READY as himma_api under the genuine production composition', async () => {
    for (const proc of [a, b]) {
      expect((await getJson(proc.port, '/internal/live')).status).toBe(200);
      const ready = await getJson(proc.port, '/internal/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ready' });
    }
  });

  it('serves a public read; auth fails CLOSED (no dev identity surface exists); request ids are canonical and independent', async () => {
    const search = await getJson(a.port, '/search?q=padel');
    expect(search.status).toBe(200);

    // The dev identity provider cannot exist in this composition.
    expect((await getJson(a.port, '/dev/identity/signin')).status).toBe(404);
    const me = await getJson(b.port, '/me', { authorization: 'Bearer forged-token' });
    expect(me.status).toBe(401);

    const first = await getJson(a.port, '/internal/live');
    const second = await getJson(b.port, '/internal/live');
    const idA = first.headers.get('x-request-id') as string;
    const idB = second.headers.get('x-request-id') as string;
    expect(idA).toMatch(/^[0-9a-f-]{36}$/);
    expect(idB).toMatch(/^[0-9a-f-]{36}$/);
    expect(idA).not.toBe(idB);
  });

  it('the PostgreSQL security rate limit SPANS both processes (one shared window, docs/37 §9)', async () => {
    // invalidBearer: limit 10/60s keyed by the caller IP digest — the same
    // key from both replicas. The previous test already consumed ONE
    // failure from this window (its forged-bearer 401), which is itself
    // proof the window is shared across tests and processes: exactly 9
    // more rejections remain before the shared budget denies.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const proc = i % 2 === 0 ? a : b;
      const response = await getJson(proc.port, '/me', {
        authorization: `Bearer forged-${i}`,
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 9)).toEqual(Array.from({ length: 9 }, () => 401));
    expect(statuses.slice(9)).toEqual([429, 429, 429]);
  });

  it('SIGTERM shuts one replica down cleanly (exit 0, port closed) without corrupting the other', async () => {
    b.child.kill('SIGTERM');
    expect(await b.exit).toBe(0);
    await expect(fetch(`http://127.0.0.1:${b.port}/internal/live`)).rejects.toThrow();
    const stillReady = await getJson(a.port, '/internal/ready');
    expect(stillReady.status).toBe(200);
  });
});

describe('startup refusals (docs/37 §6/§28)', () => {
  it('a role/credential mismatch refuses startup with a bounded message (worker credential under RUNTIME_ROLE=api)', async () => {
    const spawned = spawnApi({
      NODE_ENV: 'production',
      RUNTIME_ROLE: 'api',
      DATABASE_URL: databaseUrlFor('himma_worker', workerPassword),
      HOST: '127.0.0.1',
      PORT: '0',
    });
    expect(await spawned.exit).toBe(1);
    const err = spawned.stderr.join('');
    expect(err).toContain('startup refused');
    expect(err).toContain('himma_api');
    expect(err).not.toContain(workerPassword);
  });

  it('missing mandatory production configuration refuses with the variable name', async () => {
    const spawned = spawnApi({
      NODE_ENV: 'production',
      RUNTIME_ROLE: 'api',
      DATABASE_URL: databaseUrlFor('himma_api', apiPassword),
      PORT: '0',
    });
    expect(await spawned.exit).toBe(1);
    expect(spawned.stderr.join('')).toContain('HOST');
  });
});
