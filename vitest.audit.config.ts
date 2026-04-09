import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'src/routes/disputes.ts',
        'src/routes/governance.ts',
        'src/routes/evidence.ts',
        'src/routes/admin/index.ts',
        'src/services/admin/index.ts',
        'src/services/audit/index.ts',
        'src/db/repositories/auditLogsRepository.ts',
      ],
      thresholds: {
        statements: 95,
        lines: 95,
      },
    },
  },
})
