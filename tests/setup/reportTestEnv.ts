/**
 * Vitest setup file executed before any test module is imported.
 * Sets the REPORT_STORAGE_SIGNING_SECRET env var so that
 * ReportStorageService can be instantiated at module scope inside
 * src/routes/report.ts without throwing.
 */

if (!process.env.REPORT_STORAGE_SIGNING_SECRET) {
  process.env.REPORT_STORAGE_SIGNING_SECRET = 'test-secret-32chr-1234567890123456';
}
