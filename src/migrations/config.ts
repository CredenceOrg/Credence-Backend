/**
 * Migration configuration loader
 * 
 * This module provides configuration for the database migration system.
 * It loads settings from environment variables and provides sensible defaults.
 */

export interface MigrationConfig {
  /** PostgreSQL connection string */
  databaseUrl: string
  /** Directory containing migration files */
  migrationsDir: string
  /** Table name for tracking applied migrations */
  migrationsTable: string
  /** Schema name for the migrations table */
  migrationsSchema: string
  /** Whether to run migrations in a transaction */
  transactional: boolean
  /** Whether to create the schema if it doesn't exist */
  createSchema: boolean
}

/**
 * Loads migration configuration from environment variables
 * @returns MigrationConfig object with all settings
 * @throws Error if DATABASE_URL is not set
 */
export function loadMigrationConfig(): MigrationConfig {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required for migrations.\n' +
      'Please set it to your PostgreSQL connection string, e.g.:\n' +
      'DATABASE_URL=postgres://user:password@localhost:5432/credence'
    )
  }

  return {
    databaseUrl,
    migrationsDir: process.env.MIGRATIONS_DIR ?? 'src/migrations',
    migrationsTable: process.env.MIGRATIONS_TABLE ?? 'pgmigrations',
    migrationsSchema: process.env.MIGRATIONS_SCHEMA ?? 'public',
    transactional: process.env.MIGRATIONS_TRANSACTIONAL !== 'false',
    createSchema: process.env.MIGRATIONS_CREATE_SCHEMA !== 'false',
  }
}

/**
 * Validates that the migration configuration is complete and valid
 * @param config The configuration to validate
 * @returns true if valid, throws Error otherwise
 */
export function validateConfig(config: MigrationConfig): boolean {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }

  // Basic URL validation for PostgreSQL
  if (!config.databaseUrl.startsWith('postgres://') && 
      !config.databaseUrl.startsWith('postgresql://') &&
      !config.databaseUrl.startsWith('pg-mem://')) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection string starting with postgres://, postgresql:// or pg-mem://')
  }

  if (!config.migrationsDir) {
    throw new Error('Migrations directory is required')
  }

  return true
}
