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
};
