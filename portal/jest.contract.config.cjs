/**
 * Portal ↔ backend CONTRACT suite (W2-12A §18) — node environment.
 *
 * These tests run the LIVE portal auth adapter and provider-access port
 * against the REAL in-repository backend (`buildApp` on a freshly migrated
 * real PostgreSQL database, exactly like the backend's own test suite).
 * ONLY the external Cognito boundary is simulated (a deterministic fake
 * Cognito HTTP endpoint minting tokens through the backend's own
 * FakeAccessTokenVerifier / FakeAuthProviderAdapter) — every Himma route,
 * policy, session row, and outcome code is the real thing.
 *
 * Run with: npm run test:contract  (requires local PostgreSQL, like the
 * backend suite; the deterministic jsdom suite stays `npm test`.)
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
  // Same ESM-only backend dependencies the backend suite transforms.
  transformIgnorePatterns: ['/node_modules/(?!(uuid|node-pg-migrate)/)'],
  moduleNameMapper: {
    // Backend-owned dependencies used directly by contract-test files —
    // resolved from the backend's own node_modules (single source of truth).
    '^kysely$': '<rootDir>/../backend/node_modules/kysely',
  },
  testTimeout: 90000,
  maxWorkers: 1,
};
