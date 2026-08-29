/**
 * Vitest setup file executed before any test module is imported.
 * Sets the REPORT_STORAGE_SIGNING_SECRET env var so that
 * ReportStorageService can be instantiated at module scope inside
 * src/routes/report.ts without throwing.
 */

if (!process.env.REPORT_STORAGE_SIGNING_SECRET) {
  process.env.REPORT_STORAGE_SIGNING_SECRET = 'test-secret-32chr-1234567890123456';
}
if (!process.env.DB_URL) {
  process.env.DB_URL = 'postgresql://credence:credence@localhost:5432/credence';
}
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = 'redis://localhost:6379';
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret-12345678901234567890123456789012';
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}
