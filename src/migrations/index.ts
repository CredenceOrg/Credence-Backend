/**
 * Migrations Module
 * 
 * Public API for the database migration system.
 * Provides programmatic access to migration operations.
 */

export { loadMigrationConfig, validateConfig, resolveMigrationsDir, MigrationConfig } from './config.js'
export {
  runMigration,
  getMigrationStatus,
  createMigration,
  MigrationOptions,
  MigrationResult,
} from './runner.js'
export {
  validateMigrationChecksums,
  recordAppliedMigrationChecksums,
  MigrationChecksumError,
  MigrationChecksumValidationOptions,
  MigrationChecksumValidationResult,
} from './checksumValidation.js'
