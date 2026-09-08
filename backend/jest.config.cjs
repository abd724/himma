/**
 * Backend Jest — Node environment, real PostgreSQL (docs/25 §8).
 * Transformer: @swc/jest (chosen for Jest 30 + Node 24 compatibility; type
 * checking is `npm run typecheck`, never the test transform).
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.[tj]s$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
  },
  // uuid and node-pg-migrate ship ESM entry points that Node 24 can
  // require() natively but Jest's CJS runtime cannot — transform just those.
  transformIgnorePatterns: ['/node_modules/(?!(uuid|node-pg-migrate)/)'],
  // Database tests share one local PostgreSQL server; serial execution keeps
  // runs deterministic (each file still provisions its own himma_test_* db).
  testTimeout: 30000,
  // Parallel runs (`npx jest` without --runInBand) are bounded by the server's
  // connection capacity, not by CPU: every suite may burst to a 10-connection
  // pool and the process-spawning suites add their children's pools, so the
  // default one-worker-per-core topology was MEASURED at 91–100 client
  // backends against a default max_connections=100 (intermittent "too many
  // clients" in unrelated suites). Four workers keep the peak well under the
  // cap while remaining a genuinely concurrent topology (the W6-4A
  // provisioning-concurrency proof runs alongside other suites).
  maxWorkers: 4,
};
