import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
        'src/index.ts',
        // Type-only files – no executable code to cover
        'src/types/**',
        'src/**/*.d.ts',
        'src/**/types.ts',
        // Re-export barrel files – all they do is re-export
        'src/**/index.ts',
        // Infrastructure utilities that require live dependencies
        'src/utils/**',
      ],
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 65,
        lines: 75,
      },
    },
  },
})
