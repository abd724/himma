/**
 * Admin ↔ backend CONTRACT suite (W3-2 §37) — node environment.
 *
 * Runs the LIVE admin auth runtime and provider-read port against the REAL
 * in-repository backend (`buildApp` on a freshly migrated real PostgreSQL
 * database, exactly like the backend's own suite), reusing the portal's
 * deterministic fake-Cognito harness — the ONE simulated boundary. Every
 * Himma route, policy, session row, and outcome code is the real thing.
 *
 * Run with: npm run test:contract  (requires local PostgreSQL; the
 * deterministic jsdom suite stays `npm test`.)
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test-contract'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.[tj]sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: false },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(uuid|node-pg-migrate)/)'],
  moduleNameMapper: {
    // Backend-owned dependencies used directly by contract-test files —
    // resolved from the backend's own node_modules (single source of truth).
    '^kysely$': '<rootDir>/../backend/node_modules/kysely',
  },
  testTimeout: 90000,
  maxWorkers: 1,
};
