import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
<<<<<<< HEAD
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts", "tests/**/*.test.ts"],
    exclude: [
      "node_modules",
      "src/clients/soroban.test.ts",
      "tests/integration/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        // Test files
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/__tests__/**",
        // App entry point
        "src/index.ts",
        // Barrel re-export files
        "src/**/index.ts",
        // Type-only files (no executable code)
        "src/**/*.d.ts",
        "src/listeners/types.ts",
        "src/jobs/types.ts",
        "src/services/bond/types.ts",
        "src/services/governance/types.ts",
        "src/services/health/types.ts",
        "src/services/reputation/types.ts",
        // DB layer — tested via integration tests (node:test + Postgres)
        "src/db/**",
        // Soroban client — tested via node:test (separate CI step)
        "src/clients/soroban.ts",
        // Infrastructure not yet unit-tested
        "src/utils/logger.ts",
        "src/middleware/apiKey.ts",
        // Redis cache layer — integration dependency
        "src/cache/**",
=======
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
>>>>>>> upstream/main
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
