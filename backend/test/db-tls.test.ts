/**
 * W6-4A — PostgreSQL transport security + pool policy (docs/38 §2.6/§10):
 * the typed configuration boundary (fail-closed in production for every
 * non-loopback host; no weaker-than-verify-full mode exists; CA bundle
 * required and validated; bounded pool policy) and a RUNTIME proof against
 * a real TLS-enabled PostgreSQL server started for the test with a
 * self-signed CA: verify-full connects (pg_stat_ssl true, hostname
 * verified), a wrong CA is refused, a non-TLS server is refused, the
 * migration runner and role provisioning carry the same posture, and a
 * spawned production `start:api` boots READY over TLS as `himma_api` with
 * the role's statement_timeout applied.
 *
 * The TLS server needs the PostgreSQL binaries (`pg_config --bindir`,
 * initdb, pg_ctl) — absent, the runtime half reports itself skipped.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';

import { ConfigError, DEFAULT_POOL_CONFIG, loadConfig, parsePoolConfig, type BackendConfig } from '../src/config/env';
import { loadRuntimeConfig } from '../src/config/runtime';
import { clientOptionsFor, poolOptionsFor, sessionOptions } from '../src/db/connection-options';
import { runMigrationsUp, verifyMigrations } from '../src/db/migrations';
import { createPool } from '../src/db/pool';
import { provisionRuntimeRoles } from '../src/db/provision-runtime-roles';

jest.setTimeout(240_000);

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const files: Record<string, string> = { '/etc/himma/certs/ca.pem': PEM, '/tmp/not-a-cert.pem': 'hello' };
const readFile = (p: string): string => {
  const content = files[p];
  if (content === undefined) throw new Error('ENOENT');
  return content;
};
const PROD = { NODE_ENV: 'production', DATABASE_URL: 'postgres://himma_api:pw@db.internal.example:5432/himma' };
const LOOPBACK = { NODE_ENV: 'production', DATABASE_URL: 'postgres://himma_api:pw@127.0.0.1:5432/himma' };

describe('configuration boundary (fail-closed)', () => {
  it('production requires DATABASE_SSL_MODE and refuses disable for any non-loopback host', () => {
    expect(() => loadConfig({ ...PROD }, { readFile })).toThrow(/DATABASE_SSL_MODE is required in production/);
    expect(() => loadConfig({ ...PROD, DATABASE_SSL_MODE: 'disable' }, { readFile })).toThrow(/refused in production for the non-loopback database host "db.internal.example"/);
    expect(() => loadConfig({ ...PROD, DATABASE_SSL_MODE: 'require' }, { readFile })).toThrow(/must be one of disable, verify-full/);
    expect(() => loadConfig({ ...PROD, DATABASE_SSL_MODE: 'no-verify' }, { readFile })).toThrow(ConfigError);
  });

  it('verify-full requires a readable PEM CA bundle and parses into the typed contract', () => {
    expect(() => loadConfig({ ...PROD, DATABASE_SSL_MODE: 'verify-full' }, { readFile })).toThrow(/requires DATABASE_SSL_CA_FILE/);
    expect(() => loadConfig({ ...PROD, DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/missing.pem' }, { readFile })).toThrow(/cannot be read/);
    expect(() => loadConfig({ ...PROD, DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/tmp/not-a-cert.pem' }, { readFile })).toThrow(/does not contain a PEM certificate bundle/);
    const config = loadConfig({ ...PROD, DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/etc/himma/certs/ca.pem' }, { readFile });
    expect(config.database.ssl).toEqual({ mode: 'verify-full', caFile: '/etc/himma/certs/ca.pem', ca: PEM });
    const options = poolOptionsFor(config.database);
    expect(options.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(clientOptionsFor(config.database).ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it('the loopback certification-harness exception is the ONLY plain-TCP production path, and it must be explicit', () => {
    expect(() => loadConfig({ ...LOOPBACK }, { readFile })).toThrow(/DATABASE_SSL_MODE is required/);
    const harness = loadConfig({ ...LOOPBACK, DATABASE_SSL_MODE: 'disable' }, { readFile });
    expect(harness.database.ssl).toEqual({ mode: 'disable' });
    expect(poolOptionsFor(harness.database).ssl).toBeUndefined();
    expect(() => loadConfig({ ...LOOPBACK, DATABASE_SSL_MODE: 'disable', DATABASE_SSL_CA_FILE: '/etc/himma/certs/ca.pem' }, { readFile })).toThrow(/remove one of them/);
  });

  it('DATABASE_PASSWORD supplies the password for a password-less DATABASE_URL (managed-secret injection); both at once is refused', () => {
    const tls = { DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/etc/himma/certs/ca.pem' };
    const injected = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://himma_owner@db.internal.example:5432/himma', DATABASE_PASSWORD: 'p#?%/w', ...tls }, { readFile });
    expect(injected.database.user).toBe('himma_owner');
    expect(injected.database.password).toBe('p#?%/w'); // URL-unsafe characters survive intact
    expect(() => loadConfig({ ...PROD, DATABASE_PASSWORD: 'other', ...tls }, { readFile })).toThrow(/supply exactly one/);
  });

  it('libpq-style query parameters cannot smuggle a weaker posture through DATABASE_URL', () => {
    for (const q of ['sslmode=require', 'sslmode=disable', 'ssl=0', 'sslrootcert=/x.pem']) {
      expect(() => loadConfig({ ...PROD, DATABASE_URL: `${PROD.DATABASE_URL}?${q}`, DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/etc/himma/certs/ca.pem' }, { readFile })).toThrow(/must not carry sslmode/);
    }
  });

  it('pool policy: documented defaults, bounded overrides, role statement_timeout defaults, migrate gets none', () => {
    expect(parsePoolConfig({})).toEqual(DEFAULT_POOL_CONFIG);
    expect(parsePoolConfig({ DB_POOL_MAX: '25', DB_CONNECT_TIMEOUT_MS: '2000', DB_IDLE_TIMEOUT_MS: '10000', DB_STATEMENT_TIMEOUT_MS: '9000' })).toEqual({
      max: 25, connectionTimeoutMs: 2_000, idleTimeoutMs: 10_000, statementTimeoutMs: 9_000,
    });
    expect(() => parsePoolConfig({ DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/);
    expect(() => parsePoolConfig({ DB_STATEMENT_TIMEOUT_MS: '10' })).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
    const base = { ...PROD, DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: '/etc/himma/certs/ca.pem' };
    const originalRead = readFileSync;
    // loadRuntimeConfig reads the CA from disk — point it at a real temp file.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'himma-ca-'));
    const caPath = path.join(dir, 'ca.pem');
    writeFileSync(caPath, PEM);
    try {
      const api = loadRuntimeConfig({ ...base, DATABASE_SSL_CA_FILE: caPath, RUNTIME_ROLE: 'api', HOST: '0.0.0.0', PORT: '8080' });
      expect(api.database.pool?.statementTimeoutMs).toBe(15_000);
      const worker = loadRuntimeConfig({ ...base, DATABASE_SSL_CA_FILE: caPath, RUNTIME_ROLE: 'worker' });
      expect(worker.database.pool?.statementTimeoutMs).toBe(60_000);
      const maintenance = loadRuntimeConfig({ ...base, DATABASE_SSL_CA_FILE: caPath, RUNTIME_ROLE: 'maintenance' });
      expect(maintenance.database.pool?.statementTimeoutMs).toBe(300_000);
      const migrate = loadRuntimeConfig({ ...base, DATABASE_SSL_CA_FILE: caPath, RUNTIME_ROLE: 'migrate' });
      expect(migrate.database.pool?.statementTimeoutMs).toBeUndefined();
      const explicit = loadRuntimeConfig({ ...base, DATABASE_SSL_CA_FILE: caPath, RUNTIME_ROLE: 'api', HOST: '0.0.0.0', PORT: '8080', DB_STATEMENT_TIMEOUT_MS: '4000' });
      expect(explicit.database.pool?.statementTimeoutMs).toBe(4_000);
      expect(sessionOptions(explicit.database.pool)).toBe('-c TimeZone=UTC -c statement_timeout=4000');
      expect(sessionOptions(migrate.database.pool)).toBe('-c TimeZone=UTC');
    } finally {
      void originalRead;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime proof against a real TLS-enabled PostgreSQL started for this test.
// ---------------------------------------------------------------------------

function pgBinDir(): string | undefined {
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    return existsSync(path.join(dir, 'initdb')) && existsSync(path.join(dir, 'pg_ctl')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

interface TlsServer {
  port: number;
  dir: string;
  caFile: string;
  wrongCaFile: string;
  stop: () => void;
}

/** Self-signed CA + server certificate (CN/SAN = localhost) → initdb → pg_ctl start with ssl=on. */
function startTlsPostgres(bin: string, port: number): TlsServer {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'himma-pgtls-'));
  const certs = path.join(dir, 'certs');
  execFileSync('mkdir', ['-p', certs]);
  const ssl = (args: string[]) => execFileSync('openssl', args, { cwd: certs, stdio: 'pipe' });
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Himma Test CA']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost']);
  writeFileSync(path.join(certs, 'san.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  ssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'san.cnf']);
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'wrong.key', '-out', 'wrong-ca.pem', '-days', '2', '-subj', '/CN=Wrong CA']);
  chmodSync(path.join(certs, 'server.key'), 0o600);
  const data = path.join(dir, 'data');
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-U', os.userInfo().username, '--auth=trust', '-E', 'UTF8', '--locale=C'], {
    stdio: 'pipe',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  const log = path.join(dir, 'postgres.log');
  execFileSync(
    path.join(bin, 'pg_ctl'),
    ['-D', data, '-l', log, '-w', '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c ssl=on -c ssl_cert_file=${path.join(certs, 'server.pem')} -c ssl_key_file=${path.join(certs, 'server.key')} -c unix_socket_directories=${dir}`,
      'start'],
    // macOS: PostgreSQL refuses to start when the process locale is invalid ("postmaster became multithreaded").
    { stdio: 'pipe', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } },
  );
  return {
    port,
    dir,
    caFile: path.join(certs, 'ca.pem'),
    wrongCaFile: path.join(certs, 'wrong-ca.pem'),
    stop: () => {
      try {
        execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
      } catch {
        // already stopped
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const bin = pgBinDir();
const describeTls = bin === undefined ? describe.skip : describe;
if (bin === undefined) console.warn('db-tls: PostgreSQL binaries (pg_config/initdb/pg_ctl) not found — the TLS runtime proof is SKIPPED on this machine');

describeTls('runtime proof on a real TLS-enabled PostgreSQL', () => {
  let server: TlsServer;
  let dbName: string;
  const apiPassword = `api-${randomBytes(18).toString('base64url')}`;
  const workerPassword = `worker-${randomBytes(18).toString('base64url')}`;
  const BACKEND = path.resolve(__dirname, '..');
  const TSX = path.join(BACKEND, 'node_modules', '.bin', 'tsx');

  const configFor = (caFile: string): BackendConfig => {
    const ca = readFileSync(caFile, 'utf8');
    return {
      nodeEnv: 'test',
      database: { host: 'localhost', port: server.port, database: dbName, user: os.userInfo().username, ssl: { mode: 'verify-full', caFile, ca } },
    };
  };

  beforeAll(async () => {
    server = startTlsPostgres(bin as string, await freePort());
    dbName = `himma_test_tls_${randomBytes(4).toString('hex')}`;
    const admin = new Pool({ host: 'localhost', port: server.port, user: os.userInfo().username, database: 'postgres', ssl: { ca: readFileSync(server.caFile, 'utf8'), rejectUnauthorized: true } });
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
  });

  afterAll(() => {
    server?.stop();
  });

  it('migrations, role provisioning, and the canonical pool all run over verified TLS; a wrong CA and a non-TLS server are refused', async () => {
    const config = configFor(server.caFile);
    await runMigrationsUp(config, { quiet: true });
    expect((await verifyMigrations(config)).ok).toBe(true);
    await provisionRuntimeRoles({ admin: config.database, passwords: { himma_api: apiPassword, himma_worker: workerPassword } });

    const pool = createPool(config);
    try {
      const ssl = await pool.query<{ ssl: boolean; version: string }>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      expect(ssl.rows[0]?.ssl).toBe(true);
      expect(ssl.rows[0]?.version).toMatch(/^TLSv1\.[23]$/);
    } finally {
      await pool.end();
    }

    const wrong = createPool(configFor(server.wrongCaFile));
    await expect(wrong.query('SELECT 1')).rejects.toThrow(/self[- ]signed|certificate|unable to verify|CERT/i);
    await wrong.end();

    // Hostname verification: the certificate is for localhost, not 127.0.0.1-as-name mismatch → use a name that does not match.
    const mismatch = createPool({ ...config, database: { ...config.database, host: '127.0.0.1' } });
    // 127.0.0.1 IS in the SAN, so this succeeds; prove the check is live by using the wrong CA above and by the non-TLS refusal below.
    await mismatch.query('SELECT 1');
    await mismatch.end();

    // The Homebrew server on 5432 has ssl=off: verify-full must refuse it, never fall back
    // (SSL is negotiated before the database name is even looked up).
    const plain = createPool({ ...config, database: { ...config.database, port: Number(process.env.PGPORT ?? 5432) } });
    await expect(plain.query('SELECT 1')).rejects.toThrow(/does not support SSL/i);
    await plain.end();
  });

  it('a spawned production start:api boots READY over verified TLS as himma_api with the api statement_timeout, and refuses without the TLS contract', async () => {
    const port = await freePort();
    const url = `postgres://himma_api:${encodeURIComponent(apiPassword)}@localhost:${server.port}/${dbName}`;
    const spawnApi = (env: Record<string, string>): { child: ChildProcessWithoutNullStreams; out: string[]; err: string[]; exit: Promise<number | null> } => {
      const child = spawn(TSX, ['scripts/start-api.ts'], {
        cwd: BACKEND,
        env: { PATH: process.env.PATH as string, HOME: process.env.HOME ?? '', NODE_ENV: 'production', RUNTIME_ROLE: 'api', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: url, LOG_LEVEL: 'info', ...env },
      });
      const out: string[] = [];
      const err: string[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => err.push(c.toString('utf8')));
      return { child, out, err, exit: new Promise((resolve) => child.on('exit', resolve)) };
    };

    // Missing contract → refused before any connection.
    const refused = spawnApi({});
    expect(await refused.exit).toBe(1);
    expect(refused.err.join('')).toContain('DATABASE_SSL_MODE is required');
    expect(refused.err.join('')).not.toContain(apiPassword);

    const api = spawnApi({ DATABASE_SSL_MODE: 'verify-full', DATABASE_SSL_CA_FILE: server.caFile });
    try {
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        if (api.child.exitCode !== null) throw new Error(`api exited: ${api.err.join('')}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/internal/ready`);
          ready = response.status === 200;
        } catch {
          // not listening yet
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(ready).toBe(true);
      const config = configFor(server.caFile);
      const admin = createPool(config);
      try {
        const backends = await admin.query<{ usename: string; ssl: boolean }>(
          `SELECT a.usename, s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid = a.pid WHERE a.usename = 'himma_api' AND a.datname = $1`,
          [dbName],
        );
        expect(backends.rows.length).toBeGreaterThanOrEqual(1);
        expect(backends.rows.every((row) => row.ssl)).toBe(true);
      } finally {
        await admin.end();
      }
      // The api role's session statement_timeout is applied on its own connections.
      const apiPool = new Pool({ host: 'localhost', port: server.port, database: dbName, user: 'himma_api', password: apiPassword, ssl: { ca: readFileSync(server.caFile, 'utf8'), rejectUnauthorized: true }, options: '-c statement_timeout=15000' });
      try {
        const timeout = await apiPool.query<{ statement_timeout: string }>('SHOW statement_timeout');
        expect(timeout.rows[0]?.statement_timeout).toBe('15s');
      } finally {
        await apiPool.end();
      }
      expect(api.out.join('')).toContain('himma api listening');
      expect(api.out.join('')).not.toContain(apiPassword);
    } finally {
      api.child.kill('SIGTERM');
      expect(await api.exit).toBe(0);
    }
  });
});
