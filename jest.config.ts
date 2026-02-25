import type { Config } from 'jest'

const config: Config = {
     preset: 'ts-jest',
     testEnvironment: 'node',
     testMatch: ['**/tests/**/*.test.ts'],
     collectCoverage: true,
     coverageDirectory: 'coverage',
     coverageThreshold: {
          global: {
               branches: 95,
               functions: 95,
               lines: 95,
               statements: 95,
          },
     },
     coveragePathIgnorePatterns: ['/node_modules/', '/src/index.ts'],
}

export default config