/**
 * Test-database safety guards and configuration separation (owner ruling 7).
 */
import { loadConfig, ConfigError, parseDatabaseUrl } from '../src/config/env';
import { createPool } from '../src/db/pool';
import {
  assertSafeTestDatabase,
  TestDatabaseSafetyError,
  TEST_DATABASE_PREFIX,
} from '../src/db/safety';

describe('test-database safety guards', () => {
  it('accepts localhost with the mandatory prefix', () => {
    expect(() =>
      assertSafeTestDatabase({ host: 'localhost', database: `${TEST_DATABASE_PREFIX}_x` }),
    ).not.toThrow();
    expect(() =>
      assertSafeTestDatabase({ host: '127.0.0.1', database: TEST_DATABASE_PREFIX }),
    ).not.toThrow();
  });

  it('rejects non-local hosts', () => {
    for (const host of ['db.example.com', '10.0.0.5', 'himma-prod.internal']) {
      expect(() =>
        assertSafeTestDatabase({ host, database: `${TEST_DATABASE_PREFIX}_x` }),
      ).toThrow(TestDatabaseSafetyError);
    }
  });

  it('rejects database names without the himma_test prefix', () => {
    for (const database of ['himma_backend_dev', 'postgres', 'himma', 'test_himma']) {
      expect(() => assertSafeTestDatabase({ host: 'localhost', database })).toThrow(
        TestDatabaseSafetyError,
      );
    }
  });

  it('refuses to create a pool for an unsafe target in the test environment', () => {
    expect(() =>
      createPool({
        nodeEnv: 'test',
        database: { host: 'localhost', port: 5432, database: 'postgres', user: 'x' },
      }),
    ).toThrow(TestDatabaseSafetyError);
  });

  it('loadConfig in test env applies the guard', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', PGDATABASE: 'himma_backend_dev' }),
    ).toThrow(TestDatabaseSafetyError);
    const config = loadConfig({ NODE_ENV: 'test', PGDATABASE: 'himma_test_ok' });
    expect(config.database.database).toBe('himma_test_ok');
  });
});

describe('configuration separation', () => {
  it('production fails closed without an explicit DATABASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', PGHOST: 'localhost', PGDATABASE: 'x' }),
    ).toThrow(ConfigError);
  });

  it('production accepts only a valid postgres DATABASE_URL', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://a@b/c' }),
    ).toThrow(ConfigError);
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://app:secret@db.internal:6432/himma',
    });
    expect(config.database).toEqual({
      host: 'db.internal',
      port: 6432,
      database: 'himma',
      user: 'app',
      password: 'secret',
    });
  });

  it('rejects unknown NODE_ENV values', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging-ish' })).toThrow(ConfigError);
  });

  it('parses DATABASE_URL defaults', () => {
    const db = parseDatabaseUrl('postgresql://user@host/dbname');
    expect(db.port).toBe(5432);
    expect(db.database).toBe('dbname');
  });
});
