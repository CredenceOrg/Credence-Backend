import pg from 'pg'
import {
  DEFAULT_TEST_DATABASE_NAME,
  resolveTestDatabaseUrl,
} from '../config/testDatabase.js'
import type { MigrationConfig } from '../migrations/config.js'
import { runMigration } from '../migrations/runner.js'

const { Pool } = pg

export interface ResetTestDatabaseResult {
  databaseUrl: string
  migrationApplied: string[]
}

export interface ResetTestDatabaseOptions {
  testDatabaseUrl?: string
  skipMigrations?: boolean
  verbose?: boolean
  migrationConfig?: MigrationConfig
}

/** Splits a PostgreSQL URL into an admin connection (postgres DB) and target database name. */
export function parseTestDatabaseTarget(connectionString: string): {
  adminConnectionString: string
  databaseName: string
} {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection string')
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!databaseName) {
    throw new Error('TEST_DATABASE_URL must include a database name in the path')
  }

  url.pathname = '/postgres'
  return {
    adminConnectionString: url.toString(),
    databaseName,
  }
}

/** Blocks accidental resets of non-test databases. */
export function assertResetAllowedDatabaseName(databaseName: string): void {
  if (databaseName !== DEFAULT_TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to reset database "${databaseName}". Only "${DEFAULT_TEST_DATABASE_NAME}" may be reset.`,
    )
  }
}

export async function dropAndRecreateDatabase(
  adminPool: pg.Pool,
  databaseName: string,
): Promise<void> {
  assertResetAllowedDatabaseName(databaseName)

  await adminPool.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName],
  )
  await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
  await adminPool.query(`CREATE DATABASE "${databaseName}"`)
}

function migrationConfigForTestDatabase(databaseUrl: string): MigrationConfig {
  return {
    databaseUrl,
    migrationsDir: process.env.MIGRATIONS_DIR ?? 'dist/migrations',
    migrationsTable: process.env.MIGRATIONS_TABLE ?? 'pgmigrations',
    migrationsSchema: process.env.MIGRATIONS_SCHEMA ?? 'public',
    transactional: process.env.MIGRATIONS_TRANSACTIONAL !== 'false',
    createSchema: process.env.MIGRATIONS_CREATE_SCHEMA !== 'false',
  }
}

/**
 * Drops and recreates the local test database, then applies migrations.
 * Uses `TEST_DATABASE_URL` when set, otherwise {@link DEFAULT_TEST_DATABASE_URL}.
 */
export async function resetTestDatabase(
  options: ResetTestDatabaseOptions = {},
): Promise<ResetTestDatabaseResult> {
  const databaseUrl = options.testDatabaseUrl ?? resolveTestDatabaseUrl()
  const { adminConnectionString, databaseName } = parseTestDatabaseTarget(databaseUrl)
  assertResetAllowedDatabaseName(databaseName)

  const adminPool = new Pool({ connectionString: adminConnectionString })
  try {
    await dropAndRecreateDatabase(adminPool, databaseName)
  } finally {
    await adminPool.end()
  }

  if (options.skipMigrations) {
    return { databaseUrl, migrationApplied: [] }
  }

  const migrationConfig =
    options.migrationConfig ?? migrationConfigForTestDatabase(databaseUrl)

  const result = await runMigration({
    direction: 'up',
    config: migrationConfig,
    skipPreflight: true,
    verbose: options.verbose ?? true,
  })

  if (!result.success) {
    throw new Error(result.error ?? 'Migration failed after test database reset')
  }

  return { databaseUrl, migrationApplied: result.applied }
}
