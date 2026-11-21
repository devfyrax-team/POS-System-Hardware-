module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false, isolatedModules: true }] },
};
