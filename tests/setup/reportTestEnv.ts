/**
 * Vitest setup file executed before any test module is imported.
 * Sets the REPORT_STORAGE_SIGNING_SECRET env var so that
 * ReportStorageService can be instantiated at module scope inside
 * src/routes/report.ts without throwing.
 */

if (!process.env.REPORT_STORAGE_SIGNING_SECRET) {
  process.env.REPORT_STORAGE_SIGNING_SECRET = 'test-secret-32chr-1234567890123456';
}

/**
 * src/db/pool.ts now sources its settings from loadConfig() (#887), which
 * validates the entire app config — not just DB vars. Any test that imports
 * pool.ts, even indirectly (repositories, workers, the outbox publisher),
 * needs these three required vars present or module load throws
 * ConfigValidationError before a single test runs. Set only if unset, so a
 * test file that already defines its own values isn't overridden.
 */
if (!process.env.DB_URL) {
  process.env.DB_URL = 'postgresql://user:pass@localhost:5432/credence_test';
}
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = 'redis://localhost:6379';
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret-32-characters-long!';
}
