/**
 * Portal Jest — jsdom environment for React component/route tests.
 * Transformer: @swc/jest (backend convention — Jest 30 compatible; type
 * checking is `npm run typecheck`, never the test transform).
 */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  setupFiles: ['<rootDir>/test/support/polyfills.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/support/setup-tests.ts'],
  transform: {
    '^.+\\.[tj]sx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: { react: { runtime: 'automatic' } },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  // Some UI dependencies ship ESM-first entry points Jest's CJS runtime
  // cannot require — transform just those.
  transformIgnorePatterns: ['/node_modules/(?!(react-router|react-router-dom|@tanstack|lucide-react)/)'],
  moduleNameMapper: {
    '\\.module\\.css$': 'identity-obj-proxy',
    '\\.css$': '<rootDir>/test/support/style-stub.cjs',
  },
  testTimeout: 15000,
};
