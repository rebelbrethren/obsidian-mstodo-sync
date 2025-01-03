module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.js', '**/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  setupFilesAfterEnv: [
    './jest-setup.js',
  ],  
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};
