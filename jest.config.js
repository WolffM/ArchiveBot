module.exports = {
  testEnvironment: 'node',
  // @wolffm/logger is ESM-only. Node requires it natively (22.12+), but Jest's
  // CJS runtime cannot, so @wolffm/* alone is transformed — everything else in
  // node_modules is still skipped.
  //
  // The lookahead spans the whole remaining path rather than the next segment,
  // because pnpm resolves to
  // node_modules/.pnpm/@wolffm+logger@x/node_modules/@wolffm/logger/dist/…
  // — two `node_modules/` occurrences. A next-segment lookahead is satisfied at
  // the second one, which silently re-ignores the file.
  transformIgnorePatterns: ['/node_modules/(?!.*@wolffm)'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'lib/**/*.js',
    'utils/**/*.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  verbose: true,
  testTimeout: 10000
};
