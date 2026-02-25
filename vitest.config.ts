import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: __dirname,
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      include: ['src/services/governance/**/*.ts'],
      exclude: ['src/services/governance/index.ts', 'src/services/governance/types.ts'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
})
