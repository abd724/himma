/**
 * Test-database safety guards (owner ruling 7; docs/25 §8).
 *
 * Test runs must be structurally unable to touch production or an
 * uncontrolled developer database:
 * - localhost-only hosts;
 * - a mandatory `himma_test` database-name prefix;
 * - anything else is rejected before a connection is attempted.
 */
export const TEST_DATABASE_PREFIX = 'himma_test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface DatabaseTarget {
  host: string;
  database: string;
}

export class TestDatabaseSafetyError extends Error {}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

export function assertSafeTestDatabase(target: DatabaseTarget): void {
  if (!isLocalHost(target.host)) {
    throw new TestDatabaseSafetyError(
      `Test runs may only target localhost — refused host "${target.host}".`,
    );
  }
  if (!target.database.startsWith(TEST_DATABASE_PREFIX)) {
    throw new TestDatabaseSafetyError(
      `Test databases must be named with the "${TEST_DATABASE_PREFIX}" prefix — refused database "${target.database}".`,
    );
  }
}
