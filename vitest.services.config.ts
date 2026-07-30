import { defineConfig } from 'vitest/config'

/**
 * Coverage gate for services/ directory
 * Enforces 80% coverage on audit-sensitive flows and core business logic
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/reportTestEnv.ts'],
    include: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      'src/**/__tests__/**/*.ts',
      'tests/integration/**/*.test.ts',
      'tests/repositories/**/*.test.ts',
      'tests/routes/**/*.test.ts',
      'monitoring/**/*.test.ts',
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/services/**/*.ts'],
      exclude: [
        'src/services/**/*.test.ts',
        'src/services/**/*.spec.ts',
        'src/services/**/__tests__/**',
        'src/services/index.ts',
        // Type-only files – no executable code to cover
        'src/services/**/types.ts',
        'src/services/**/*.d.ts',
      ],
      // 80% coverage gate on services/ directory to lock audit-sensitive flows
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    extensions: ['.ts', '.js', '.json'],
  },
})
